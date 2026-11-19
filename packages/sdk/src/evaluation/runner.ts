import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { AcclimateClient, ApiError } from '../client.js';
import { resolveAndCache } from '../cache.js';
import { TaskExecutionError } from '../compare.js';
import type {
  CachedLearningParent,
  Comparison,
  ComparisonRequest,
  Evaluation,
  EvaluationDescriptor,
  EvaluationHandoff,
  Outcome,
  VerifiedVersion,
} from '../types.js';
import {
  assertGuidedTarget,
  evaluationDescriptorDifferences,
  validateEvaluationHandoff,
} from '../validation.js';
import { createEvaluationTransport } from '../internal/evaluation-transport.js';
import {
  assertJson,
  assertEvaluationOutput,
  OutputValidationError,
  captureDefinition,
  deepFreeze,
  MAX_ARTIFACT,
  MAX_PRIVATE,
  MAX_REQUEST,
} from './definition.js';
import type { CapturedDefinition } from './definition.js';
import { readEvaluatorConfig } from './config.js';
import {
  CallbackCancelled,
  EvaluationError,
  ExecutionUncertainError,
  toSafeDiagnostic,
} from './errors.js';
import type { ExecutionState, EvaluationPhase } from './errors.js';
import { acquireFileLock, openJournal, sha256 } from './journal.js';
import type { ArtifactIndex, AttemptJournal, EvaluationJournal, JournalScope } from './journal.js';
import { atomicPrivateWrite, privateDirectory } from './private-state.js';
import type {
  EvaluationRunResult,
  EvaluatorConfig,
  PreflightOptions,
  PreflightResult,
  RunEvaluationOptions,
} from './types.js';

const frozen = (request: Evaluation): AttemptJournal['request'] =>
  structuredClone({
    parentVersionId: request.parentVersionId,
    candidateVersionId: request.candidateVersionId,
    parentDigest: request.parentDigest,
    candidateDigest: request.candidateDigest,
    datasetRevision: request.datasetRevision,
    graderRevision: request.graderRevision,
    runtime: request.runtime,
    expectedCases: request.expectedCases,
  });

/** Remove credentials that commonly appear in provider error messages. */
export function redactDiagnosticText(value: string, secrets: readonly string[] = []): string {
  let text = value.slice(0, 16384);
  for (const secret of secrets)
    if (secret && secret.length >= 8) text = text.split(secret).join('[redacted]');
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, '$1 [redacted]')
    .replace(/\b(sk|pk|rk|ghp|gho|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{8,}/gu, '[redacted]')
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/giu,
      '$1[redacted]',
    );
}

/**
 * Keep the callback's exception type, redacted message and stack in the private job
 * directory. The file never leaves this machine. Set captureCallbackErrors: false to opt out.
 */
async function saveCallbackError(
  directory: string,
  phase: 'execute' | 'grade',
  error: unknown,
  secrets: readonly string[],
): Promise<string> {
  let exceptionType = 'ThrownValue';
  let message = '';
  let code: string | undefined;
  let stack: string | undefined;
  const frames: Array<{ file: string; line: number; function: string }> = [];
  // Custom errors may override stack/name accessors. Diagnostics are optional.
  try {
    if (error instanceof Error) {
      const name = error.constructor.name;
      exceptionType = /^[A-Za-z_$][\w$]{0,127}$/.test(name) ? name : 'Error';
      message = redactDiagnosticText(String(error.message), secrets).slice(0, 4096);
      const errorCode = (error as { code?: unknown }).code;
      if (typeof errorCode === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(errorCode)) code = errorCode;
      const raw = error.stack;
      if (typeof raw === 'string') {
        stack = redactDiagnosticText(raw, secrets).slice(0, 16384);
        for (const frame of raw.split('\n').slice(1, 200)) {
          const match =
            /^\s*at (?:async )?(?:(.+?) \()?((?:file:\/\/\/|\/|[A-Za-z]:[\\/]).+?):(\d+):\d+\)?$/.exec(
              frame,
            );
          if (match)
            frames.push({
              file: match[2].slice(0, 1024),
              line: Number(match[3]),
              function: (match[1] ?? '<anonymous>').slice(0, 128),
            });
          if (frames.length === 8) break;
        }
      }
    } else if (['string', 'number', 'boolean'].includes(typeof error)) {
      message = redactDiagnosticText(String(error), secrets).slice(0, 4096);
    }
  } catch {
    /* Still retain the stage when application metadata is unreadable. */
  }
  const file = path.join(directory, 'callback-error.json');
  await atomicPrivateWrite(
    file,
    JSON.stringify({
      phase,
      exceptionType,
      ...(code ? { code } : {}),
      message,
      frames,
      ...(stack ? { stack } : {}),
    }) + '\n',
  );
  return file;
}
class ObservedInterruption extends Error {
  readonly request: Evaluation;
  constructor(request: Evaluation) {
    super('Interruption observed.');
    this.request = structuredClone(request);
  }
}
const descriptor = (value: EvaluationDescriptor): EvaluationDescriptor => ({
  datasetRevision: value.datasetRevision,
  graderRevision: value.graderRevision,
  runtime: value.runtime,
  expectedCases: value.expectedCases,
});
export function assertDescriptor(
  actual: EvaluationDescriptor,
  expected: EvaluationDescriptor,
): void {
  const differences = evaluationDescriptorDifferences(actual, expected);
  if (differences.length)
    throw new EvaluationError('descriptor.mismatch', { mismatchFields: differences });
}
export function assertFrozen(
  request: Evaluation,
  requestId: string,
  snapshot: AttemptJournal['request'],
): void {
  if (request.id !== requestId) throw new EvaluationError('version.binding_mismatch');
  assertDescriptor(request, snapshot);
  for (const key of [
    'parentVersionId',
    'candidateVersionId',
    'parentDigest',
    'candidateDigest',
  ] as const)
    if (request[key] !== snapshot[key])
      throw new EvaluationError('version.binding_mismatch', { mismatchFields: ['versions'] });
}
export function assertReport(
  report: ComparisonRequest,
  request: Evaluation,
  attemptId: string,
): void {
  assertDescriptor(report, request);
  for (const key of [
    'parentVersionId',
    'candidateVersionId',
    'parentDigest',
    'candidateDigest',
  ] as const)
    if (report[key] !== request[key]) throw new EvaluationError('version.binding_mismatch');
  if (report.evaluation?.requestId !== request.id || report.evaluation.attemptId !== attemptId)
    throw new EvaluationError('evidence.identity_mismatch');
  const keys = new Set(request.expectedCases.map((k) => JSON.stringify([k.caseId, k.repetition])));
  if (
    !Array.isArray(report.results) ||
    report.results.length !== keys.size ||
    keys.size !== request.expectedCases.length
  )
    throw new EvaluationError('evidence.malformed');
  for (const pair of report.results) {
    if (!keys.delete(JSON.stringify([pair.caseId, pair.repetition])))
      throw new EvaluationError('evidence.malformed');
    for (const o of [pair.parent, pair.candidate])
      if (
        !o ||
        !['completed', 'task_failed', 'infrastructure_failed'].includes(o.executionStatus) ||
        !['scored', 'missing', 'failed'].includes(o.gradingStatus) ||
        (o.gradingStatus === 'scored'
          ? typeof o.reward !== 'number' || !Number.isFinite(o.reward)
          : o.reward !== null)
      )
        throw new EvaluationError('evidence.malformed');
  }
}
/** Compare immutable wire assertions, ignoring only server metadata/key order. */
export function reportsEqual(left: ComparisonRequest, right: ComparisonRequest): boolean {
  const normalize = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, normalize(item)]),
          )
        : value;
  const key = (value: { caseId: string; repetition: number }) =>
    JSON.stringify([value.caseId, value.repetition]);
  const shape = (value: ComparisonRequest) => ({
    parentVersionId: value.parentVersionId,
    candidateVersionId: value.candidateVersionId,
    parentDigest: value.parentDigest,
    candidateDigest: value.candidateDigest,
    datasetRevision: value.datasetRevision,
    graderRevision: value.graderRevision,
    runtime: value.runtime,
    evaluation: value.evaluation,
    parentSourceComparisonId: value.parentSourceComparisonId,
    expectedCases: [...value.expectedCases].sort((a, b) =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
    ),
    results: [...value.results].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)),
  });
  return JSON.stringify(normalize(shape(left))) === JSON.stringify(normalize(shape(right)));
}
function assertTarget(config: EvaluatorConfig, handoff: EvaluationHandoff) {
  validateEvaluationHandoff(handoff);
  try {
    assertGuidedTarget({
      projectId: config.projectId,
      bundleId: handoff.bundleId,
      requestId: handoff.requestId,
      principalId: config.evaluatorPrincipalId,
    });
  } catch {
    throw new EvaluationError('guided_target_unsupported');
  }
  if (handoff.serviceUrl !== config.serviceUrl || handoff.projectId !== config.projectId)
    throw new EvaluationError('auth.principal_mismatch');
}
export async function verifyEvaluatorAuthority(
  api: AcclimateClient,
  config: Pick<EvaluatorConfig, 'projectId' | 'evaluatorPrincipalId'>,
) {
  let capabilities;
  try {
    capabilities = await api.getEvaluationCapabilities(config.projectId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404)
      throw new EvaluationError('capabilities.unsupported');
    throw error;
  }
  if (capabilities.schemaVersion !== 1 || capabilities.retainedEvaluationOperations !== true)
    throw new EvaluationError('capabilities.unsupported');
  if (
    capabilities.projectId !== config.projectId ||
    capabilities.principalId !== config.evaluatorPrincipalId
  )
    throw new EvaluationError('auth.principal_mismatch');
  if (capabilities.readUnpublished !== true || capabilities.writeEvaluation !== true)
    throw new EvaluationError('auth.denied');
}
async function verified(
  api: AcclimateClient,
  config: Pick<EvaluatorConfig, 'projectId'>,
  bundleId: string,
  request: Evaluation,
  cacheDir: string,
  cumulative = false,
): Promise<[VerifiedVersion, VerifiedVersion]> {
  const parent = await resolveAndCache(
    api,
    { projectId: config.projectId, bundleId, versionId: request.parentVersionId },
    { cacheDir },
  );
  const candidate = await resolveAndCache(
    api,
    { projectId: config.projectId, bundleId, versionId: request.candidateVersionId },
    { cacheDir },
  );
  if (
    parent.version.digest !== request.parentDigest ||
    candidate.version.digest !== request.candidateDigest
  )
    throw new EvaluationError('version.binding_mismatch');
  if (candidate.version.id !== parent.version.id) {
    let ancestor = candidate.version.parentVersionId;
    const seen = new Set([candidate.version.id]);
    while (ancestor && ancestor !== parent.version.id && cumulative && !seen.has(ancestor)) {
      seen.add(ancestor);
      const version = await api.getVersion(config.projectId, bundleId, ancestor);
      if (version.id !== ancestor || version.bundleId !== bundleId)
        throw new EvaluationError('version.binding_mismatch');
      ancestor = version.parentVersionId;
    }
    if (ancestor !== parent.version.id) throw new EvaluationError('version.binding_mismatch');
  }
  return [deepFreeze(parent), deepFreeze(candidate)];
}
/** An empty request/channel listing does not establish bundle existence. */
async function assertBundleExists(api: AcclimateClient, projectId: string, bundleId: string) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pages = 0; pages < 100; pages++) {
    const page = await api.listBundles(projectId, { limit: 100, ...(cursor ? { cursor } : {}) });
    if (
      !page ||
      !Array.isArray(page.items) ||
      page.items.length > 100 ||
      page.items.some((item) => !item || typeof item.id !== 'string') ||
      (page.nextCursor !== null &&
        (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 4096))
    )
      throw new EvaluationError('evidence.malformed', { phase: 'preflight' });
    if (page.items.some((item) => item.id === bundleId)) return;
    if (page.nextCursor === null)
      throw new EvaluationError('bundle.missing', { phase: 'preflight' });
    if (seen.has(page.nextCursor))
      throw new EvaluationError('evidence.malformed', { phase: 'preflight' });
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new EvaluationError('evidence.incomplete', {
    phase: 'preflight',
    nextAction: 'ask_operator',
  });
}
export async function preflightEvaluation<I, E, O>(
  options: PreflightOptions<I, E, O>,
): Promise<PreflightResult> {
  const captured = captureDefinition(options.app),
    config = await readEvaluatorConfig(options.configPath);
  const target = options.target;
  const bundleId = 'handoff' in target ? target.handoff.bundleId : target.bundleId;
  const requestId = 'handoff' in target ? target.handoff.requestId : target.requestId;
  if ('handoff' in target) {
    assertTarget(config, target.handoff);
    assertDescriptor(target.handoff.configuration, captured.descriptor);
  }
  try {
    assertGuidedTarget({
      projectId: config.projectId,
      bundleId,
      requestId,
      principalId: config.evaluatorPrincipalId,
    });
  } catch {
    throw new EvaluationError('guided_target_unsupported');
  }
  const result: PreflightResult = {
    schemaVersion: 1,
    status: 'ready',
    authorization: 'unverified',
    checkedAt: new Date().toISOString(),
    checks: [],
    nextAction: 'review_terminal_evidence',
  };
  const pass = (check: PreflightResult['checks'][number]['check']) =>
    result.checks.push({ check, status: 'passed' });
  let probe: string | undefined;
  let currentCheck: PreflightResult['checks'][number]['check'] = 'runtime';
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (process.platform === 'win32' || major < 22 || (major === 22 && minor < 22))
      throw new EvaluationError('runtime.unsupported');
    pass('runtime');
    pass('privateConfig');
    currentCheck = 'journalStorage';
    await privateDirectory(config.journalRoot, true);
    probe = await mkdtemp(path.join(config.journalRoot, '.preflight-'));
    pass('journalStorage');
    currentCheck = 'lock';
    const lock = await acquireFileLock(path.join(probe, 'ownership.lock'));
    await lock.close();
    pass('lock');
    const api = createEvaluationTransport(config).client;
    currentCheck = 'evaluatorAccess';
    await verifyEvaluatorAuthority(api, config);
    result.authorization = 'verified';
    pass('serviceIdentity');
    pass('evaluatorAccess');
    currentCheck = 'targetBundle';
    await assertBundleExists(api, config.projectId, bundleId);
    pass('targetBundle');
    if (requestId) {
      currentCheck = 'targetRequest';
      const request = await api.getEvaluation(config.projectId, bundleId, requestId);
      if (request.id !== requestId || request.requireBoundEvidence !== true)
        throw new EvaluationError('evidence.identity_mismatch');
      pass('targetRequest');
      currentCheck = 'descriptor';
      assertDescriptor(request, captured.descriptor);
      pass('descriptor');
      currentCheck = 'versions';
      await verified(api, config, bundleId, request, path.join(probe, 'cache'));
      pass('versions');
    } else {
      pass('descriptor');
      result.checks.push({ check: 'versions', status: 'not_applicable' });
    }
  } catch (error) {
    const missing =
      currentCheck === 'targetRequest'
        ? 'request.missing'
        : currentCheck === 'versions'
          ? 'version.missing'
          : undefined;
    const diagnostic = toSafeDiagnostic(
      error instanceof ApiError && error.status === 404 && missing
        ? new EvaluationError(missing, { phase: 'preflight', httpStatus: 404 })
        : error,
      'preflight',
    );
    result.status = 'blocked';
    result.nextAction = diagnostic.nextAction;
    if (diagnostic.code.startsWith('auth.')) result.authorization = 'denied';
    result.checks.push({
      check: currentCheck,
      status: diagnostic.code === 'capabilities.unsupported' ? 'unverified' : 'failed',
      code: diagnostic.code,
      ...(diagnostic.pathIssue && { pathIssue: diagnostic.pathIssue }),
      ...(diagnostic.field && { field: diagnostic.field }),
      ...(diagnostic.hint && { hint: diagnostic.hint }),
      ...(diagnostic.serviceUrl && { serviceUrl: diagnostic.serviceUrl }),
    });
  } finally {
    if (probe) await rm(probe, { recursive: true, force: true });
  }
  return result;
}
const unavailable = (error = 'cancelled'): Outcome => ({
  executionStatus: 'infrastructure_failed',
  gradingStatus: 'missing',
  reward: null,
  outputRef: null,
  error,
  usage: null,
});
const usageKeys = ['inputTokens', 'outputTokens', 'costUsd'] as const;
function usage(value: unknown): Outcome['usage'] {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new OutputValidationError('usage', 'Return usage as { inputTokens, outputTokens, costUsd }.');
  const unknown = Object.keys(value).find((key) => !(usageKeys as readonly string[]).includes(key));
  if (unknown)
    throw new OutputValidationError(
      `usage.${unknown.slice(0, 64)}`,
      'Unknown usage key. Use inputTokens, outputTokens and costUsd.',
    );
  const result: NonNullable<Outcome['usage']> = {};
  for (const key of usageKeys) {
    const n = (value as Record<string, unknown>)[key];
    if (n !== undefined) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
        throw new OutputValidationError(`usage.${key}`, 'Use a finite, nonnegative number.');
      result[key] = n;
    }
  }
  return result;
}
export async function runEvaluation<I, E, O>(
  options: RunEvaluationOptions<I, E, O>,
): Promise<EvaluationRunResult> {
  return runEvaluationRequest(options, false);
}

/** Runs a bound request, including cumulative assignments from the managed work queue. */
export async function runEvaluationRequest<I, E, O>(
  options: RunEvaluationOptions<I, E, O>,
  cumulative: boolean,
): Promise<EvaluationRunResult> {
  const captured = captureDefinition(options.app),
    config = await readEvaluatorConfig(options.configPath),
    handoff = validateEvaluationHandoff(options.handoff);
  assertTarget(config, handoff);
  assertDescriptor(handoff.configuration, captured.descriptor);
  if ((captured.execution === 'live') !== (options.allowLive === true))
    throw new EvaluationError('config.schema', {
      field: 'allowLive',
      reason:
        captured.execution === 'live'
          ? 'This evaluation is live. Pass allowLive: true (--live on the CLI) to authorize model calls.'
          : 'This evaluation is model-free. Omit allowLive (--live on the CLI).',
    });
  const transport = createEvaluationTransport(config);
  await verifyEvaluatorAuthority(transport.client, config);
  return runCapturedEvaluation({
    captured,
    config,
    handoff,
    transport,
    signal: options.signal,
    retryMissingTrial: options.retryMissingTrial,
    cachedParent: options.cachedParent,
    cumulative,
  });
}

/** Source-internal integration seam. Not exported from the installed package interface. */
export async function runCapturedEvaluation(options: {
  captured: CapturedDefinition<any, any, any>;
  config: Pick<
    EvaluatorConfig,
    'serviceUrl' | 'projectId' | 'evaluatorPrincipalId' | 'journalRoot' | 'captureCallbackErrors'
  >;
  handoff: EvaluationHandoff;
  transport: ReturnType<typeof createEvaluationTransport>;
  signal?: AbortSignal;
  retryMissingTrial?: boolean;
  cachedParent?: () => Promise<CachedLearningParent | null | undefined>;
  cumulative?: boolean;
}): Promise<EvaluationRunResult> {
  const { captured, config, handoff, transport } = options,
    api = transport.client;
  const scope: JournalScope = {
    serviceUrl: config.serviceUrl,
    projectId: config.projectId,
    bundleId: handoff.bundleId,
    requestId: handoff.requestId,
    evaluatorPrincipalId: config.evaluatorPrincipalId,
  };
  const journal = await openJournal(config.journalRoot, scope);
  let state: AttemptJournal | undefined,
    phase: EvaluationPhase = 'verify',
    certainty: ExecutionState = 'not_started';
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), journal.signal]);
  let cancelled = false;
  let callbacksStarted = 0;
  let firstCallbackFailure: EvaluationRunResult['firstCallbackFailure'];
  const captureErrors = config.captureCallbackErrors !== false;
  const secrets = [(config as Partial<EvaluatorConfig>).evaluatorToken ?? ''];
  try {
    // Recovery diagnostics must reflect durable work even if the first
    // authoritative read fails before we can reconcile the remote lifecycle.
    state = await journal.read();
    certainty = state?.report
      ? 'report_saved'
      : state?.executionStarted
        ? 'may_have_started'
        : 'not_started';
    let request = await api.getEvaluation(scope.projectId, scope.bundleId, scope.requestId);
    if (request.id !== scope.requestId || request.requireBoundEvidence !== true)
      throw new EvaluationError('evidence.identity_mismatch');
    assertDescriptor(request, captured.descriptor);
    if (state) {
      assertFrozen(request, scope.requestId, state.request);
      if (
        request.attemptId &&
        (request.attemptId !== state.attemptId ||
          request.evaluatorPrincipal !== scope.evaluatorPrincipalId)
      )
        throw new EvaluationError('auth.principal_mismatch');
      if (state.comparisonId && request.comparisonId && state.comparisonId !== request.comparisonId)
        throw new EvaluationError('evidence.identity_mismatch');
    }
    if (request.status === 'interrupted')
      return {
        schemaVersion: 1,
        evaluation: request,
        comparison: null,
        executionState: 'interrupted',
        callbacksStarted,
        reusedEvidence: false,
      };
    if (['completed', 'failed'].includes(request.status)) {
      const result = await terminal(api, scope, request, callbacksStarted, true, state);
      if (state?.report) {
        state.comparisonId = request.comparisonId!;
        await journal.save(state);
        await reconcileArtifactIndex(journal, state);
      }
      return result;
    }
    if (!state) {
      if (request.status !== 'requested') throw new EvaluationError('journal.missing');
      state = {
        schemaVersion: 1,
        scope,
        request: frozen(request),
        attemptId: randomUUID(),
        keys: { start: randomUUID(), submit: randomUUID(), finish: randomUUID() },
        retainedOperations: true,
        wireBodies: {},
      };
      await journal.save(state);
    }
    if (state.executionStarted && !state.report) throw new ExecutionUncertainError();
    if (state.report) assertReport(state.report, request, state.attemptId);
    phase = 'claim';
    if (request.status === 'requested') {
      signal.throwIfAborted();
      const body = await ensureBody(
        journal,
        state,
        'start',
        JSON.stringify({ attemptId: state.attemptId }),
      );
      journal.assertOwned();
      const started = await transport.mutate<Evaluation>('start', scope, body, state.keys.start);
      assertFrozen(started, scope.requestId, state.request);
      if (
        started.attemptId !== state.attemptId ||
        started.evaluatorPrincipal !== scope.evaluatorPrincipalId
      )
        throw new EvaluationError('auth.principal_mismatch');
    }
    const check = async () => {
      journal.assertOwned();
      const latest = await api.getEvaluation(scope.projectId, scope.bundleId, scope.requestId);
      journal.assertOwned();
      assertFrozen(latest, scope.requestId, state!.request);
      if (
        latest.attemptId !== state!.attemptId ||
        latest.evaluatorPrincipal !== scope.evaluatorPrincipalId
      )
        throw new EvaluationError('auth.principal_mismatch');
      if (latest.status === 'interrupted') throw new ObservedInterruption(latest);
      if (latest.status !== 'running') throw new EvaluationError('evidence.identity_mismatch');
      return latest;
    };
    request = await check();
    const reusedEvidence = !!state.report;
    if (!state.report) {
      signal.throwIfAborted();
      phase = 'verify';
      const bundles = await verified(
        api,
        config,
        scope.bundleId,
        request,
        path.join(journal.directory, 'cache'),
        options.cumulative,
      );
      request = await check();
      signal.throwIfAborted();
      if (captured.collection) {
        await atomicPrivateWrite(
          path.join(journal.directory, 'collection.json'),
          JSON.stringify({ schemaVersion: 1, ...captured.collection }) + '\n',
        );
      }
      const source = await options.cachedParent?.();
      const cachedParent = source?.results.every(
        ({ parent }) =>
          parent.executionStatus !== 'infrastructure_failed' && Number.isFinite(parent.reward),
      )
        ? source
        : undefined;
      const cachedResults = new Map(
        cachedParent?.results.map((pair) => [
          JSON.stringify([pair.caseId, pair.repetition]),
          pair.parent,
        ]),
      );
      if (
        cachedParent &&
        (cachedResults.size !== request.expectedCases.length ||
          request.expectedCases.some(
            (key) => !cachedResults.has(JSON.stringify([key.caseId, key.repetition])),
          ))
      )
        throw new EvaluationError('evidence.identity_mismatch');
      state.executionStarted = true;
      await journal.save(state);
      certainty = 'may_have_started';
      phase = 'execute';
      const index: ArtifactIndex = {
        schemaVersion: 1,
        requestId: scope.requestId,
        attemptId: state.attemptId,
        reportSha256: '',
        entries: [],
      };
      let artifactBytes = 0;
      const report: ComparisonRequest = {
        ...frozen(request),
        evaluation: { requestId: scope.requestId, attemptId: state.attemptId },
        ...(cachedParent ? { parentSourceComparisonId: cachedParent.comparisonId } : {}),
        results: [],
      };
      let pairIndex = -1;
      for (const item of captured.cases)
        for (let repetition = 0; repetition < (item.repetitions ?? 1); repetition++) {
          pairIndex++;
          const pair = {
            caseId: item.caseId,
            repetition,
            parent: unavailable(),
            candidate: unavailable(),
          };
          if (cachedParent)
            pair.parent = cachedResults.get(JSON.stringify([item.caseId, repetition]))!;
          const firstSide = captured.collection?.pairs[pairIndex].firstSide ?? 'parent';
          const order =
            firstSide === 'parent'
              ? (['parent', 'candidate'] as const)
              : (['candidate', 'parent'] as const);
          for (const [armIndex, side] of order.entries()) {
            if (cachedParent && side === 'parent') continue;
            const attempts = options.retryMissingTrial ? 2 : 1;
            const firstArtifact = index.entries.length;
            for (let retry = 0; retry < attempts; retry++) {
              if (signal.aborted || cancelled) {
                pair[side] = unavailable();
                break;
              }
              if (retry && index.entries.length > firstArtifact) {
                index.entries.length = firstArtifact;
                await journal.saveArtifactIndex(index);
              }
              await check();
              const bundle = bundles[side === 'parent' ? 0 : 1];
              const jobId = createHash('sha256')
                .update(
                  JSON.stringify([
                    scope.requestId,
                    state.attemptId,
                    side,
                    bundle.version.id,
                    item.caseId,
                    repetition,
                    ...(retry ? [retry] : []),
                  ]),
                )
                .digest('hex');
              const privateJobDirectory = path.join(journal.directory, 'jobs', jobId);
              await privateDirectory(privateJobDirectory);
              const context = {
                requestId: scope.requestId,
                attemptId: state.attemptId,
                side,
                jobId,
                privateJobDirectory,
                ...(captured.collection
                  ? {
                      collection: Object.freeze({
                        protocol: captured.collection.protocol,
                        scheduleDigest: captured.collection.digest,
                        pairIndex,
                        armIndex,
                        firstSide,
                      }),
                    }
                  : {}),
              };
              await atomicPrivateWrite(
                path.join(privateJobDirectory, 'binding.json'),
                JSON.stringify({
                  ...context,
                  privateJobDirectory: undefined,
                  collection: undefined,
                  caseId: item.caseId,
                  repetition,
                  versionId: bundle.version.id,
                  digest: bundle.version.digest,
                }) + '\n',
              );
              if (context.collection) {
                await atomicPrivateWrite(
                  path.join(privateJobDirectory, 'collection-binding.json'),
                  JSON.stringify({
                    schemaVersion: 1,
                    jobId,
                    caseId: item.caseId,
                    repetition,
                    side,
                    ...context.collection,
                  }) + '\n',
                );
              }
              journal.assertOwned();
              if (signal.aborted || cancelled) {
                pair[side] = unavailable();
                continue;
              }
              const noteFailure = (
                stage: 'execute' | 'grade',
                reason: NonNullable<EvaluationRunResult['firstCallbackFailure']>['reason'],
                file?: string,
              ) => {
                firstCallbackFailure ??= {
                  caseId: item.caseId,
                  repetition,
                  side,
                  stage,
                  reason,
                  ...(file ? { diagnosticFile: file } : {}),
                };
              };
              const recordOutputError = async (error: OutputValidationError) => {
                journal.assertOwned();
                // Keep field names inside the application's private job.
                const file = path.join(privateJobDirectory, 'output-validation.json');
                await atomicPrivateWrite(
                  file,
                  JSON.stringify({ field: error.field, reason: error.reason }),
                );
                noteFailure('execute', 'output_invalid', file);
              };
              let execution;
              try {
                callbacksStarted++;
                execution = await captured.execute({
                  bundle: structuredClone(bundle),
                  caseId: item.caseId,
                  repetition,
                  input: structuredClone(item.input),
                  signal,
                  context: Object.freeze(context),
                });
                journal.assertOwned();
              } catch (error) {
                if (error instanceof ExecutionUncertainError) throw error;
                if (error instanceof CallbackCancelled) {
                  cancelled = true;
                  pair[side] = unavailable();
                  continue;
                }
                if (error instanceof EvaluationError && error.code === 'journal.ownership_lost')
                  throw error;
                if (error instanceof OutputValidationError) {
                  await recordOutputError(error);
                  pair[side] = unavailable('output_invalid');
                  continue;
                }
                noteFailure(
                  'execute',
                  error instanceof TaskExecutionError ? 'task_failed' : 'execution_failed',
                  captureErrors
                    ? await saveCallbackError(privateJobDirectory, 'execute', error, secrets)
                    : undefined,
                );
                pair[side] =
                  error instanceof TaskExecutionError
                    ? { ...unavailable('task_failed'), executionStatus: 'task_failed' }
                    : unavailable('execution_failed');
                continue;
              }
              let entry;
              let capturedOutput: unknown;
              let capturedExecutionStatus: 'completed' | 'task_failed' = 'completed';
              let capturedReference: unknown;
              let capturedUsage: Outcome['usage'] = null;
              try {
                const returnedOutput = execution.output;
                assertEvaluationOutput(returnedOutput);
                capturedOutput = structuredClone(returnedOutput);
                const returnedStatus = execution.executionStatus;
                if (!['completed', 'task_failed', undefined].includes(returnedStatus))
                  throw new Error();
                capturedExecutionStatus = returnedStatus ?? 'completed';
                capturedReference = execution.outputRef;
                capturedUsage = usage(execution.usage);
                if (
                  artifactBytes + Buffer.byteLength(JSON.stringify(capturedOutput)) + 16 * 1024 >
                  MAX_PRIVATE
                ) {
                  cancelled = true;
                  throw new Error();
                }
                entry = await journal.writeArtifact(
                  {
                    requestId: scope.requestId,
                    attemptId: state.attemptId,
                    caseId: item.caseId,
                    repetition,
                    side,
                    versionId: bundle.version.id,
                    digest: bundle.version.digest,
                    role: 'output',
                  },
                  capturedOutput,
                );
                artifactBytes += entry.bytes;
                index.entries.push(entry);
                await journal.saveArtifactIndex(index);
              } catch (error) {
                if (error instanceof OutputValidationError) {
                  await recordOutputError(error);
                }
                pair[side] = unavailable('output_invalid');
                continue;
              }
              const reference = capturedReference ?? `acclimate:artifact:${entry.sha256}`;
              if (
                typeof reference !== 'string' ||
                Buffer.byteLength(reference) > 1024 ||
                /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(reference)
              ) {
                pair[side] = unavailable('output_reference_invalid');
                continue;
              }
              const outcome: Outcome = {
                executionStatus: capturedExecutionStatus,
                gradingStatus: 'missing',
                reward: null,
                outputRef: reference,
                error: null,
                usage: capturedUsage,
              };
              if (signal.aborted || cancelled) {
                pair[side] = { ...outcome, error: 'cancelled' };
                continue;
              }
              await check();
              journal.assertOwned();
              if (signal.aborted || cancelled) {
                pair[side] = { ...outcome, error: 'cancelled' };
                continue;
              }
              let gradeReturned = false;
              try {
                const grade = await captured.grade({
                  output: structuredClone(capturedOutput),
                  expected: structuredClone(item.expected),
                  caseId: item.caseId,
                  repetition,
                  signal,
                });
                gradeReturned = true;
                journal.assertOwned();
                const reward = grade.reward;
                if (typeof reward !== 'number' || !Number.isFinite(reward)) throw new Error();
                const returnedExplanation = grade.explanation;
                let capturedExplanation: unknown;
                if (returnedExplanation !== undefined) {
                  assertJson(returnedExplanation, MAX_ARTIFACT);
                  capturedExplanation = structuredClone(returnedExplanation);
                  if (
                    artifactBytes +
                      Buffer.byteLength(JSON.stringify(capturedExplanation)) +
                      16 * 1024 >
                    MAX_PRIVATE
                  ) {
                    cancelled = true;
                    throw new Error();
                  }
                  const explanation = await journal.writeArtifact(
                    {
                      requestId: scope.requestId,
                      attemptId: state.attemptId,
                      caseId: item.caseId,
                      repetition,
                      side,
                      versionId: bundle.version.id,
                      digest: bundle.version.digest,
                      role: 'grader-explanation',
                    },
                    capturedExplanation,
                  );
                  artifactBytes += explanation.bytes;
                  index.entries.push(explanation);
                  await journal.saveArtifactIndex(index);
                }
                pair[side] = { ...outcome, gradingStatus: 'scored', reward };
                break;
              } catch (error) {
                if (error instanceof ExecutionUncertainError) throw error;
                if (error instanceof EvaluationError && error.code === 'journal.ownership_lost')
                  throw error;
                if (error instanceof CallbackCancelled) cancelled = true;
                else
                  noteFailure(
                    'grade',
                    'grading_failed',
                    !gradeReturned && captureErrors
                      ? await saveCallbackError(privateJobDirectory, 'grade', error, secrets)
                      : undefined,
                  );
                pair[side] = {
                  ...outcome,
                  gradingStatus: 'failed',
                  error: error instanceof CallbackCancelled ? 'cancelled' : 'grading_failed',
                };
              }
            }
          }
          report.results.push(pair);
        }
      journal.assertOwned();
      assertReport(report, request, state.attemptId);
      const body = JSON.stringify(report);
      if (Buffer.byteLength(body) > MAX_REQUEST)
        throw new EvaluationError('definition.report_budget_exceeded');
      state.report = report;
      state.wireBodies = { ...state.wireBodies, submit: await journal.saveBody('submit', body) };
      index.reportSha256 = sha256(body);
      await journal.saveArtifactIndex(index);
      await journal.save(state);
      certainty = 'report_saved';
    } else certainty = 'report_saved';
    phase = 'submit';
    await check();
    if (!state.comparisonId) {
      const body = await journal.readBody('submit', state);
      if (JSON.stringify(JSON.parse(body)) !== JSON.stringify(state.report))
        throw new EvaluationError('journal.invalid');
      journal.assertOwned();
      const comparison = await transport.mutate<Comparison>(
        'submit',
        scope,
        body,
        state.keys.submit,
      );
      assertReport(comparison, request, state.attemptId);
      if (!comparison.id || comparison.submitter !== scope.evaluatorPrincipalId)
        throw new EvaluationError('evidence.identity_mismatch');
      state.comparisonId = comparison.id;
      await journal.save(state);
    }
    await reconcileArtifactIndex(journal, state);
    phase = 'finish';
    await check();
    const body = await ensureBody(
      journal,
      state,
      'finish',
      JSON.stringify({ attemptId: state.attemptId, comparisonId: state.comparisonId }),
    );
    journal.assertOwned();
    const finished = await transport.mutate<Evaluation>('finish', scope, body, state.keys.finish);
    assertFrozen(finished, scope.requestId, state.request);
    if (
      finished.attemptId !== state.attemptId ||
      finished.evaluatorPrincipal !== scope.evaluatorPrincipalId ||
      finished.comparisonId !== state.comparisonId
    )
      throw new EvaluationError('evidence.identity_mismatch');
    request = await api.getEvaluation(scope.projectId, scope.bundleId, scope.requestId);
    assertFrozen(request, scope.requestId, state.request);
    if (request.status === 'interrupted')
      return {
        schemaVersion: 1,
        evaluation: request,
        comparison: null,
        executionState: 'interrupted',
        callbacksStarted,
        reusedEvidence: false,
      };
    const result = await terminal(api, scope, request, callbacksStarted, reusedEvidence, state);
    state.completed = true;
    await journal.save(state);
    return firstCallbackFailure ? { ...result, firstCallbackFailure } : result;
  } catch (error) {
    if (error instanceof ObservedInterruption) {
      return {
        schemaVersion: 1,
        evaluation: error.request,
        comparison: null,
        executionState: 'interrupted',
        callbacksStarted,
        reusedEvidence: false,
      };
    }
    const diagnostic = toSafeDiagnostic(error, phase, certainty);
    throw new EvaluationError(diagnostic.code, {
      ...diagnostic,
      phase,
      executionState: certainty,
      evaluationRequestId: scope.requestId,
    });
  } finally {
    await journal.close();
  }
}
async function reconcileArtifactIndex(
  journal: EvaluationJournal,
  state: AttemptJournal,
): Promise<void> {
  if (!state.comparisonId || !state.report) return;
  const index = await journal.readArtifactIndex();
  if (!index) return;
  const body = await journal.readBody('submit', state),
    reportHash = sha256(body);
  if (
    !reportsEqual(JSON.parse(body), state.report) ||
    index.requestId !== state.scope.requestId ||
    index.attemptId !== state.attemptId ||
    (index.comparisonId && index.comparisonId !== state.comparisonId) ||
    (index.reportSha256 && index.reportSha256 !== reportHash)
  )
    throw new EvaluationError('artifact.integrity');
  journal.assertOwned();
  if (index.comparisonId !== state.comparisonId || !index.reportSha256) {
    index.comparisonId = state.comparisonId;
    index.reportSha256 = reportHash;
    await journal.saveArtifactIndex(index);
  }
}
async function ensureBody(
  journal: EvaluationJournal,
  state: AttemptJournal,
  kind: 'start' | 'finish',
  body: string,
) {
  if (state.wireBodies[kind]) {
    const previous = await journal.readBody(kind, state);
    if (previous !== body) throw new EvaluationError('journal.invalid');
    return previous;
  }
  state.wireBodies = { ...state.wireBodies, [kind]: await journal.saveBody(kind, body) };
  await journal.save(state);
  return body;
}
async function terminal(
  api: AcclimateClient,
  scope: JournalScope,
  request: Evaluation,
  callbacksStarted: number,
  reusedEvidence: boolean,
  state?: AttemptJournal,
): Promise<EvaluationRunResult> {
  if (
    !['completed', 'failed'].includes(request.status) ||
    !request.comparisonId ||
    !request.attemptId ||
    request.evaluatorPrincipal !== scope.evaluatorPrincipalId
  )
    throw new EvaluationError('evidence.identity_mismatch');
  if (
    state &&
    (state.attemptId !== request.attemptId ||
      (state.comparisonId && state.comparisonId !== request.comparisonId))
  )
    throw new EvaluationError('evidence.identity_mismatch');
  const comparison = await api.getComparison(scope.projectId, scope.bundleId, request.comparisonId);
  assertReport(comparison, request, request.attemptId);
  if (comparison.id !== request.comparisonId || comparison.submitter !== request.evaluatorPrincipal)
    throw new EvaluationError('evidence.identity_mismatch');
  if (state?.report) {
    assertReport(state.report, request, state.attemptId);
    if (!reportsEqual(state.report, comparison))
      throw new EvaluationError('evidence.identity_mismatch');
  }
  return {
    schemaVersion: 1,
    evaluation: request,
    comparison,
    callbacksStarted,
    reusedEvidence,
    executionState: 'finished',
  };
}
