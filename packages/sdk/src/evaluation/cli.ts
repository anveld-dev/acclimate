import { dirname, join } from 'node:path';
import { analyzeComparison, type MetricAnalysis } from './analysis.js';
import { recordPolicyReceipt } from './policy-receipt.js';
import { AcclimateClient } from '../client.js';
import type { Evaluation, EvaluationDescriptor, EvaluationHandoff, Comparison } from '../types.js';
import {
  validateEvaluationHandoff,
  evaluationDescriptorDifferences,
  assertGuidedTarget,
} from '../validation.js';
import { preflightEvaluation, runEvaluation } from './index.js';
import type { EvaluationApp } from './types.js';
import { assertUnaliasedPath } from './private-state.js';
import { readEvaluatorConfig, readReaderConfig } from './config.js';
import { EvaluationError, toSafeDiagnostic } from './errors.js';
import { checkComparison, parseEvaluationPolicy, PolicyError, type PolicyVerdict } from './policy.js';
import {
  exportReviewEvidence,
  verifyReviewExport,
  parseArtifactSelection,
  type ReviewMapper,
} from './artifacts.js';
import {
  createRequestFromIntent,
  interruptFromIntent,
  readCommandJson,
  readCommandText,
} from './cli-intents.js';

type Command =
  | 'compare'
  | 'describe'
  | 'doctor'
  | 'request'
  | 'run'
  | 'check'
  | 'status'
  | 'interrupt'
  | 'export'
  | 'verify-export';
const allowed: Record<Command, readonly string[]> = {
  compare: ['config', 'handoff', 'bundle', 'channel', 'payload', 'name', 'retry-after', 'live', 'policy', 'json'],
  describe: [],
  doctor: ['config', 'bundle', 'handoff', 'policy', 'name'],
  request: ['config', 'bundle', 'channel', 'payload', 'intent', 'out', 'policy'],
  run: ['config', 'handoff', 'live', 'name'],
  check: ['config', 'read-config', 'handoff', 'policy', 'name'],
  status: ['config', 'read-config', 'handoff', 'name'],
  interrupt: ['config', 'handoff', 'reason', 'name'],
  export: ['config', 'read-config', 'handoff', 'out', 'selection', 'name'],
  'verify-export': ['manifest', 'read-config', 'handoff'],
};
interface Parsed {
  command: Command;
  flags: Record<string, string | boolean>;
}
function parse(argv: readonly string[]): Parsed {
  const command = argv[0] as Command;
  if (!Object.hasOwn(allowed, command)) throw new EvaluationError('config.schema');
  const flags: Record<string, string | boolean> = {};
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (
      !flag.startsWith('--') ||
      !allowed[command].includes(flag.slice(2)) ||
      Object.hasOwn(flags, flag.slice(2))
    )
      throw new EvaluationError('config.schema');
    const name = flag.slice(2);
    if (name === 'live' || name === 'json') flags[name] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new EvaluationError('config.schema');
      flags[name] = value;
    }
  }
  return { command, flags };
}
function required(flags: Parsed['flags'], name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || !value) throw new EvaluationError('config.schema');
  return value;
}
const compareUsage = [
  'compare --config CONFIG --handoff HANDOFF [--live] [--policy POLICY] [--json]',
  'compare --config CONFIG --bundle ID --channel CHANNEL --payload FILE (--name RUN_NAME | --retry-after PRIOR_NAME) [--live] [--policy POLICY] [--json]',
  'Live evaluators require --live. Use one input form and supply each flag once.',
].join('\n');
class CompareUsageError extends EvaluationError {
  constructor(readonly hint: string) {
    super('config.schema');
  }
}

function validateCompareFlags(flags: Parsed['flags'], live: boolean) {
  if (live !== (flags.live === true))
    throw new CompareUsageError(
      live ? 'This evaluator requires --live.' : 'Omit --live for this evaluator.',
    );
  const creation = ['bundle', 'channel', 'payload', 'name', 'retry-after'];
  if (flags.handoff && creation.some((key) => flags[key]))
    throw new CompareUsageError('--handoff cannot be combined with candidate creation flags.');
  if (!flags.handoff && !!flags.name === !!flags['retry-after'])
    throw new CompareUsageError('Choose --name for a run or --retry-after for a fresh attempt.');
  for (const key of flags.handoff ? ['config'] : ['config', 'bundle', 'channel', 'payload'])
    if (!flags[key]) throw new CompareUsageError(`Missing --${key}.`);
  if (flags.name && !/^[a-zA-Z0-9_-]{1,80}$/.test(String(flags.name)))
    throw new CompareUsageError('--name requires 1–80 letters, digits, underscores or hyphens.');
}

function comparisonText(
  request: Evaluation,
  comparison: Comparison | null,
  scores: Pick<MetricAnalysis, 'counts' | 'summary' | 'cases' | 'evidenceGaps'> | null,
  policy: PolicyVerdict | null,
  policyRequested: boolean,
) {
  const value = (number: number | null | undefined) =>
    number == null ? 'unknown' : String(number);
  // JSON quoting keeps line breaks and escape sequences out of terminal control flow.
  const label = (id: string) =>
    JSON.stringify(id).replace(
      /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
      (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'),
    );
  const counts = scores?.counts;
  const lines = [
    `Request ${request.id} · ${request.status}`,
    `Equal-case means    parent ${value(scores?.summary?.parentMean)}    candidate ${value(scores?.summary?.candidateMean)}`,
    counts
      ? `Pair coverage       ${counts.comparablePairs}/${counts.expectedPairs}${counts.missingPairs ? ' (partial)' : ''}`
      : `Pair coverage       unknown/${request.expectedCases.length}`,
    `Policy              ${policy?.verdict ?? (policyRequested ? 'indeterminate' : 'not supplied')}`,
  ];
  for (const check of policy?.checks ?? [])
    if (check.result !== 'pass') lines.push(`  ${check.result}  ${check.code}`);
  const gaps = policy?.evidenceGaps ?? scores?.evidenceGaps;
  if (gaps) {
    lines.push(`Evidence gaps       showing ${gaps.rows.length} of ${gaps.total}`);
    for (const gap of gaps.rows)
      lines.push(
        `  ${label(gap.caseId)} [${gap.repetition}] ${gap.side} · ${gap.stage} · ${gap.reason}`,
      );
  }
  if (scores?.cases.length) {
    lines.push(scores.summary ? 'Per-case means' : 'Means for fully scored cases');
    for (const row of scores.cases)
      lines.push(
        `  ${label(row.caseId)}    parent ${value(row.parentMean)}    candidate ${value(row.candidateMean)}`,
      );
  }
  if (!scores?.summary && comparison) {
    lines.push('Available scores by case and repetition');
    for (const row of comparison.results) {
      const score = (side: 'parent' | 'candidate') =>
        value(
          row[side].gradingStatus === 'scored' &&
            row[side].executionStatus !== 'infrastructure_failed'
            ? row[side].reward
            : null,
        );
      lines.push(
        `  ${label(row.caseId)} [${row.repetition}]    parent ${score('parent')}    candidate ${score('candidate')}`,
      );
    }
  } else if (!comparison) {
    lines.push('Per-case scores     unknown');
  }
  return lines.join('\n');
}
const optional = (flags: Parsed['flags'], name: string) =>
  typeof flags[name] === 'string' ? (flags[name] as string) : undefined;

async function namedHandoff(journalRoot: string, name: string) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new EvaluationError('config.schema');
  await assertUnaliasedPath(journalRoot, 'journalAlias');
  return join(journalRoot, 'comparisons', name, 'request.json');
}

async function handoffFile(flags: Parsed['flags']): Promise<EvaluationHandoff> {
  return validateEvaluationHandoff(await readCommandJson(required(flags, 'handoff')));
}

async function readConnection(flags: Parsed['flags'], handoff: EvaluationHandoff) {
  if (!!flags.config === !!flags['read-config']) throw new EvaluationError('config.schema');
  if (flags['read-config']) {
    const config = await readReaderConfig(required(flags, 'read-config'));
    if (config.serviceUrl !== handoff.serviceUrl || config.projectId !== handoff.projectId)
      throw new EvaluationError('version.binding_mismatch');
    return {
      client: new AcclimateClient({
        baseUrl: config.serviceUrl,
        token: config.readToken,
        scope: 'review-reader',
      }),
      projectId: config.projectId,
    };
  }
  const config = await readEvaluatorConfig(required(flags, 'config'));
  if (config.serviceUrl !== handoff.serviceUrl || config.projectId !== handoff.projectId)
    throw new EvaluationError('version.binding_mismatch');
  return {
    client: new AcclimateClient({
      baseUrl: config.serviceUrl,
      token: config.evaluatorToken,
      scope: config.evaluatorPrincipalId,
    }),
    projectId: config.projectId,
  };
}

function assertRequest(
  request: Evaluation,
  handoff: EvaluationHandoff,
  app?: Pick<EvaluationApp, 'descriptor'>,
) {
  if (request.requireBoundEvidence !== true)
    throw new EvaluationError('evidence.identity_mismatch', { phase: 'inspect' });
  if (
    [request.parentVersionId, request.candidateVersionId].some(
      (id) =>
        typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id),
    ) ||
    [request.parentDigest, request.candidateDigest].some(
      (digest) => typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest),
    )
  )
    throw new EvaluationError('version.binding_mismatch', { phase: 'inspect' });

  if (
    request.id !== handoff.requestId ||
    !['requested', 'running', 'completed', 'failed', 'interrupted', 'abandoned'].includes(request.status) ||
    (request.attemptId !== null &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.attemptId)) ||
    (request.comparisonId !== null &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        request.comparisonId,
      )) ||
    evaluationDescriptorDifferences(request, handoff.configuration).length ||
    (app && evaluationDescriptorDifferences(request, app.descriptor).length)
  )
    throw new EvaluationError('descriptor.mismatch', { phase: 'inspect' });
}
const safeRequest = (request: Evaluation) => ({
  schemaVersion: 1,
  requestId: request.id,
  status: request.status,
  comparisonId: request.comparisonId,
  attemptId: request.attemptId,
});
async function readProgress(
  client: AcclimateClient,
  projectId: string,
  bundleId: string,
  request: Evaluation,
) {
  const unknown = { activity: 'unknown', reason: 'unavailable' };
  const timestamp = (value: unknown) =>
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value);
  try {
    const view = await client.getEvaluationProgress(projectId, bundleId, request.id);
    if (
      view.schemaVersion !== 1 ||
      view.requestId !== request.id ||
      view.attemptId !== request.attemptId ||
      view.status !== request.status ||
      !timestamp(view.checkedAt)
    )
      return unknown;
    if (view.activity === 'absent' && view.observation === null)
      return { activity: 'unknown', reason: 'no_report', checkedAt: view.checkedAt };
    const report = view.observation;
    if (
      !report ||
      !request.attemptId ||
      report.attemptId !== request.attemptId ||
      !['fresh', 'stale'].includes(view.activity) ||
      !['preparing', 'executing', 'grading', 'submitting'].includes(report.phase) ||
      !timestamp(report.receivedAt) ||
      !Number.isInteger(report.completed) ||
      report.total !== request.expectedCases.length * 2 ||
      report.completed < 0 ||
      report.completed > report.total
    )
      return unknown;
    const current = report.case;
    if (
      current &&
      !request.expectedCases.some(
        (item) => item.caseId === current.caseId && item.repetition === current.repetition,
      )
    )
      return unknown;
    return {
      activity: view.activity,
      checkedAt: view.checkedAt,
      receivedAt: report.receivedAt,
      phase: report.phase,
      completed: report.completed,
      total: report.total,
      ...(current ? { case: { caseId: current.caseId, repetition: current.repetition } } : {}),
    };
  } catch {
    // Status remains available when an older service lacks optional progress.
    return unknown;
  }
}
function comparisonBinding(request: Evaluation) {
  if (!request.comparisonId || !request.attemptId || !request.evaluatorPrincipal)
    throw new EvaluationError('evidence.identity_mismatch', { phase: 'inspect' });
  return {
    parentVersionId: request.parentVersionId,
    candidateVersionId: request.candidateVersionId,
    parentDigest: request.parentDigest,
    candidateDigest: request.candidateDigest,
    requestId: request.id,
    attemptId: request.attemptId,
    comparisonId: request.comparisonId,
    submitter: request.evaluatorPrincipal,
  };
}

function policyExit(verdict: string) {
  return verdict === 'pass' ? 0 : verdict === 'fail' ? 2 : 3;
}
function runStatus(request: Evaluation) {
  return request.status === 'completed' ? 0 : request.status === 'failed' ? 2 : 3;
}
function readinessStatus(result: {
  status: string;
  authorization: string;
  checks?: Array<{ status: string; code?: string }>;
}) {
  if (result.status === 'ready') return 0;
  if (
    result.checks?.some(
      (check) =>
        check.code?.startsWith('config.') ||
        [
          'guided_target_unsupported',
          'definition.report_budget_exceeded',
          'internal.error',
        ].includes(check.code ?? ''),
    )
  )
    return 1;
  return result.authorization === 'unverified' ||
    result.checks?.some((check) => check.status === 'unverified')
    ? 3
    : 2;
}

async function createRequest(app: EvaluationApp<any, any, any>, flags: Parsed['flags'], predecessor?: { handoffFile: string; request: Evaluation }) {
  const configPath = required(flags, 'config');
  const config = await readEvaluatorConfig(configPath);
  const bundleId = required(flags, 'bundle'),
    channel = required(flags, 'channel');
  assertGuidedTarget({ projectId: config.projectId, bundleId });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(channel))
    throw new EvaluationError('guided_target_unsupported');
  const preflight = await preflightEvaluation({ app, configPath, target: { bundleId } });
  if (preflight.status !== 'ready') return { status: 1, result: preflight };
  const result = await createRequestFromIntent({
    app,
    config,
    bundleId,
    channel,
    payloadFile: required(flags, 'payload'),
    intentPath: required(flags, 'intent'),
    outputFile: required(flags, 'out'),
    predecessor,
  });
  return { status: 0, result };
}

async function dispatch(
  app: EvaluationApp<any, any, any>,
  parsed: Parsed,
  options: EvaluationMainOptions,
): Promise<{ status: number; result: unknown }> {
  const { command, flags } = parsed;
  if (command === 'describe') return { status: 0, result: app.descriptor };
  if (command === 'verify-export' || command === 'status') return readEvidence(parsed);
  if (command === 'doctor') {
    if (!!flags.bundle === !!flags.handoff) throw new EvaluationError('config.schema');
    if (flags.policy)
      parseEvaluationPolicy(await readCommandText(required(flags, 'policy')), app.descriptor);
    const target = flags.handoff
      ? { handoff: await handoffFile(flags) }
      : { bundleId: required(flags, 'bundle') };
    const result = await preflightEvaluation({
      app,
      configPath: required(flags, 'config'),
      target,
    });
    return { status: readinessStatus(result), result };
  }
  const comparing = command === 'compare';
  if (comparing) validateCompareFlags(flags, app.descriptor.runtime.execution === 'live');
  const terminal = comparing && process.stdout.isTTY && !flags.json;
  const policy =
    comparing && flags.policy
      ? parseEvaluationPolicy(await readCommandText(required(flags, 'policy')), app.descriptor)
      : null;
  if (command === 'request') {
    if (flags.policy)
      parseEvaluationPolicy(await readCommandText(required(flags, 'policy')), app.descriptor);
    return createRequest(app, flags);
  }
  if (comparing && !flags.handoff) {
    const config = await readEvaluatorConfig(required(flags, 'config'));
    let predecessor;
    if (flags['retry-after']) {
      const handoffFile = await namedHandoff(config.journalRoot, required(flags, 'retry-after'));
      const prior = validateEvaluationHandoff(await readCommandJson(handoffFile));
      if (prior.bundleId !== flags.bundle) throw new EvaluationError('request.intent_mismatch');
      const { client, projectId } = await readConnection(flags, prior);
      const request = await client.getEvaluation(projectId, prior.bundleId, prior.requestId);
      assertRequest(request, prior);
      // A settled predecessor, or one the service abandoned, may be retried. An
      // abandoned attempt's evidence never counts, so it needs no comparison.
      const settled =
        ['completed', 'failed'].includes(request.status) && request.attemptId && request.comparisonId;
      if (!settled && request.status !== 'abandoned')
        throw new EvaluationError('evidence.not_terminal', { phase: 'inspect', nextAction: 'inspect_external_app' });
      predecessor = { handoffFile, request };
      flags.name = 'after-' + request.id;
    }
    const handoff = await namedHandoff(config.journalRoot, required(flags, 'name'));
    const created = await createRequest(app, {
      ...flags,
      intent: join(dirname(handoff), 'intent.json'),
      out: handoff,
    }, predecessor);
    if (created.status !== 0) {
      if (terminal && 'checks' in created.result) {
        const failures = created.result.checks
          .filter((check) => check.code)
          .map((check) => [check.code, check.hint].filter(Boolean).join(' '));
        return {
          status: created.status,
          result: `Comparison blocked before request creation.\n${failures.join(', ')}\nNext action: ${created.result.nextAction}`,
        };
      }
      return created;
    }
    flags.handoff = handoff;
  }
  const handoff = await handoffFile(flags);
  if (command === 'run' || comparing) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    try {
      const result = await runEvaluation({
        app,
        configPath: required(flags, 'config'),
        handoff,
        allowLive: flags.live === true,
        signal: controller.signal,
      });
      if (comparing) {
        const request = result.evaluation;
        let policyResult = null;
        let scores = null;
        if (
          result.comparison &&
          request.attemptId &&
          request.comparisonId &&
          request.evaluatorPrincipal
        ) {
          const evidence = {
            comparison: result.comparison,
            expectedDescriptor: app.descriptor,
            expectedBinding: comparisonBinding(request),
          };
          const metric = policy?.policy.metric;
          const [analysis] = analyzeComparison({
            ...evidence,
            metrics: metric ? [{ ...metric, source: 'reward', id: 'reward' }] : undefined,
          }).metrics;
          scores = {
            counts: analysis.counts,
            summary: analysis.summary,
            cases: analysis.cases,
            ...(analysis.evidenceGaps ? { evidenceGaps: analysis.evidenceGaps } : {}),
          };
          if (policy)
            policyResult = checkComparison({
              ...evidence,
              policy: policy.policy,
              policyDigest: policy.sha256,
            });
        }
        const receipt = policyResult
          ? await recordPolicyReceipt((await readConnection(flags, handoff)).client, handoff, policyResult)
          : undefined;
        const status = policy ? policyExit(policyResult?.verdict ?? 'indeterminate') : runStatus(request);
        const runName = optional(flags, 'name');
        const invocation = { callbacksStarted: result.callbacksStarted, reusedEvidence: result.reusedEvidence };
        const execution = result.reusedEvidence
          ? 'Reused saved evidence. No execution callbacks started.'
          : `Execution callbacks started this time: ${result.callbacksStarted}.`;
        return {
          status: status || (receipt?.status === 'unconfirmed' ? 1 : 0),
          result: terminal
            ? [comparisonText(request, result.comparison, scores, policyResult, !!policy), execution,
                ...(receipt ? [receipt.status === 'recorded' ? 'Policy receipt recorded for release review.' : 'Policy receipt unconfirmed. Retry check with the evaluator config.'] : []),
                ...(runName ? ['Run handle: --name ' + runName] : [])].join('\n')
            : {
                ...safeRequest(request),
                invocation,
                ...(runName ? { runName } : {}),
                parentVersionId: request.parentVersionId,
                candidateVersionId: request.candidateVersionId,
                candidateDigest: request.candidateDigest,
                scores,
                policy: policyResult,
                ...(receipt ? { policyReceipt: receipt } : {}),
              },
        };
      }
      return {
        status: runStatus(result.evaluation),
        result: { ...safeRequest(result.evaluation), executionState: result.executionState },
      };
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  }
  if (command === 'export') {
    if (!!flags.config === !!flags['read-config']) throw new EvaluationError('config.schema');
    const selection = flags.selection
      ? parseArtifactSelection(await readCommandJson(required(flags, 'selection')))
      : undefined;
    const result = await exportReviewEvidence({
      configPath: optional(flags, 'config'),
      readConfigPath: optional(flags, 'read-config'),
      handoff,
      outputDirectory: required(flags, 'out'),
      selection,
      toReviewArtifact: options.review?.toReviewArtifact,
    });
    // The helper owns private paths, not the command's public result.
    return {
      status: 0,
      result: {
        schemaVersion: 1,
        status: result.status,
        localInspection: result.localInspection,
        selection: result.selection,
      },
    };
  }
  if (command === 'interrupt') {
    const config = await readEvaluatorConfig(required(flags, 'config'));
    if (config.serviceUrl !== handoff.serviceUrl || config.projectId !== handoff.projectId)
      throw new EvaluationError('version.binding_mismatch');
    return {
      status: 0,
      result: safeRequest(await interruptFromIntent(config, handoff, required(flags, 'reason'))),
    };
  }
  if (command === 'check') return checkPolicyCommand(app.descriptor, flags, handoff);
  throw new EvaluationError('config.schema');
}

async function readEvidence({ command, flags }: Parsed) {
  if (command === 'verify-export') {
    const online = flags['read-config'] || flags.handoff;
    if (online && !(flags['read-config'] && flags.handoff))
      throw new EvaluationError('config.schema');
    const result = await verifyReviewExport({
      manifestPath: required(flags, 'manifest'),
      ...(online
        ? {
            online: {
              readConfigPath: required(flags, 'read-config'),
              expectedHandoff: await handoffFile(flags),
            },
          }
        : {}),
    });
    return { status: 0, result };
  }
  if (command !== 'status') throw new EvaluationError('config.schema');
  const handoff = await handoffFile(flags);
  const { client, projectId } = await readConnection(flags, handoff);
  const request = await client.getEvaluation(projectId, handoff.bundleId, handoff.requestId);
  assertRequest(request, handoff);
  return {
    status: 0,
    result: {
      ...safeRequest(request),
      progress: await readProgress(client, projectId, handoff.bundleId, request),
    },
  };
}

/** Reader operations validate service or export evidence without importing agent code. */
export async function evaluationReadMain(argv: readonly string[]) {
  return runCommand(argv, readEvidence);
}

async function checkPolicyCommand(
  descriptor: EvaluationDescriptor,
  flags: Parsed['flags'],
  handoff: EvaluationHandoff,
) {
  const parsedPolicy = parseEvaluationPolicy(
    await readCommandText(required(flags, 'policy')),
    descriptor,
  );
  const { client, projectId } = await readConnection(flags, handoff);
  const request = await client.getEvaluation(projectId, handoff.bundleId, handoff.requestId);
  assertRequest(request, handoff, { descriptor });
  if (!['completed', 'failed'].includes(request.status) || !request.comparisonId)
    return {
      status: 3,
      result: {
        schemaVersion: 1,
        verdict: 'indeterminate',
        code: 'evidence.not_terminal',
        requestId: request.id,
      },
    };
  const [parent, candidate] = await Promise.all([
    client.getVersion(projectId, handoff.bundleId, request.parentVersionId),
    client.getVersion(projectId, handoff.bundleId, request.candidateVersionId),
  ]);
  if (
    parent.id !== request.parentVersionId ||
    candidate.id !== request.candidateVersionId ||
    parent.bundleId !== handoff.bundleId ||
    candidate.bundleId !== handoff.bundleId ||
    parent.digest !== request.parentDigest ||
    candidate.digest !== request.candidateDigest ||
    candidate.parentVersionId !== parent.id
  )
    throw new EvaluationError('version.binding_mismatch', { phase: 'inspect' });
  const comparison: Comparison = await client.getComparison(
    projectId,
    handoff.bundleId,
    request.comparisonId,
  );
  const verdict = checkComparison({
    comparison,
    expectedDescriptor: descriptor,
    expectedBinding: comparisonBinding(request),
    policy: parsedPolicy.policy,
    policyDigest: parsedPolicy.sha256,
  });
  const receipt = flags.config ? await recordPolicyReceipt(client, handoff, verdict) : { status: 'read_only' as const };
  return {
    status: policyExit(verdict.verdict) || (receipt.status === 'unconfirmed' ? 1 : 0),
    result: { ...verdict, policyReceipt: receipt },
  };
}

export interface EvaluationMainOptions {
  review?: { toReviewArtifact: ReviewMapper };
}

/** Statically installed app command adapter. It never exits or discovers executable modules. */
export async function evaluationMain(
  app: EvaluationApp<any, any, any>,
  argv: readonly string[],
  options: EvaluationMainOptions = {},
): Promise<number> {
  return runCommand(argv, (parsed) => dispatch(app, parsed, options));
}

/** Verify a recorded comparison using the installed descriptor and the caller's policy. */
export async function evaluationCheckMain(
  descriptor: EvaluationDescriptor,
  argv: readonly string[],
) {
  return runCommand(argv, async (parsed) => {
    if (parsed.command !== 'check') throw new EvaluationError('config.schema');
    return checkPolicyCommand(descriptor, parsed.flags, await handoffFile(parsed.flags));
  });
}

async function runCommand(
  argv: readonly string[],
  execute: (parsed: Parsed) => Promise<{ status: number; result: unknown }>,
): Promise<number> {
  let command: Command | 'invalid' = 'invalid';
  try {
    const parsed = parse(argv);
    command = parsed.command;
    if (command !== 'compare' && parsed.flags.name) {
      if (parsed.flags.handoff || parsed.flags['read-config']) throw new EvaluationError('config.schema');
      const config = await readEvaluatorConfig(required(parsed.flags, 'config'));
      parsed.flags.handoff = await namedHandoff(config.journalRoot, required(parsed.flags, 'name'));
    }
    const { status, result } = await execute(parsed);
    const output =
      command === 'compare' && typeof result === 'string' ? result : JSON.stringify(result);
    if (Buffer.byteLength(output) > 4 * 1024 * 1024)
      throw new EvaluationError('transport.response_too_large');
    process.stdout.write(output + '\n');
    return status;
  } catch (error) {
    const known =
      error !== null && (typeof error === 'object' || typeof error === 'function')
        ? (error as { code?: string; diagnostic?: unknown })
        : {};
    const safePolicyCodes = new Set([
      'policy.invalid',
      'policy.inventory_incompatible',
      'evidence.identity_mismatch',
      'evidence.malformed',
      'artifact.missing',
      'artifact.hash_mismatch',
      'artifact.integrity',
      'artifact.selection_invalid',
      'artifact.mapper_failed',
    ]);
    const diagnostic = toSafeDiagnostic(
      !(error instanceof EvaluationError) && known.code && safePolicyCodes.has(known.code)
        ? new EvaluationError(known.code as any, {
            phase: command === 'check' || known.code.startsWith('policy.') ? 'policy' : 'export',
          })
        : error,
    );
    const missing = error instanceof PolicyError ? error.diagnostic.missingFields : undefined;
    const recoveryHints: Partial<Record<typeof diagnostic.code, string>> = {
      'request.intent_mismatch':
        'Restore the original evaluator and candidate to recover this run. To measure a changed evaluator on the same settled candidate, replace --name with --retry-after and the prior name.',
      'request.base_conflict':
        'The published parent changed. Review the new parent and choose a new name for a comparison against it.',
      'evidence.not_terminal':
        'Check status with the prior name and inspect the original worker. A fresh attempt requires a completed or failed comparison.',
      'policy.invalid':
        'Use the editable quality-policy.example.json from the evaluator starter or copy the policy in the getting-started guide.',
    };
    const hint = (command === 'compare' || diagnostic.code === 'policy.invalid') && recoveryHints[diagnostic.code];
    const publicDiagnostic = { ...diagnostic, ...(missing?.length && { missingFields: missing }), ...(hint && { hint }) };
    if (
      argv[0] === 'compare' &&
      process.stdout.isTTY &&
      !argv.includes('--json') &&
      (command === 'invalid' || error instanceof CompareUsageError)
    )
      process.stderr.write(
        (error instanceof CompareUsageError ? error.hint : 'Invalid compare flags.') +
          '\n' +
          compareUsage +
          '\n',
      );
    else
      process.stderr.write(JSON.stringify({ schemaVersion: 1, command, error: publicDiagnostic }) + '\n');
    if (
      [
        'execution.uncertain',
        'submission.unconfirmed',
        'journal.busy',
        'journal.foreign',
        'journal.missing',
        'journal.relocated',
        'journal.ownership_lost',
        'request.interrupted',
        'request.base_conflict',
        'evidence.not_terminal',
      ].includes(diagnostic.code) ||
      diagnostic.executionState === 'may_have_started' ||
      diagnostic.executionState === 'report_saved'
    )
      return 3;
    if (command === 'export' && diagnostic.code === 'artifact.missing') return 3;
    return 1;
  }
}
