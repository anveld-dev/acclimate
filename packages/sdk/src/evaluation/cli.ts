import { AcclimateClient } from '../client.js';
import type { Evaluation, EvaluationHandoff, Comparison } from '../types.js';
import {
  validateEvaluationHandoff,
  evaluationDescriptorDifferences,
  assertGuidedTarget,
} from '../validation.js';
import { preflightEvaluation, runEvaluation } from './index.js';
import type { EvaluationApp } from './types.js';
import { readEvaluatorConfig, readReaderConfig } from './config.js';
import { EvaluationError, toSafeDiagnostic } from './errors.js';
import { checkComparison, parseEvaluationPolicy } from './policy.js';
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
  describe: [],
  doctor: ['config', 'bundle', 'handoff', 'policy'],
  request: ['config', 'bundle', 'channel', 'payload', 'intent', 'out', 'policy'],
  run: ['config', 'handoff', 'live'],
  check: ['config', 'read-config', 'handoff', 'policy'],
  status: ['config', 'read-config', 'handoff'],
  interrupt: ['config', 'handoff', 'reason'],
  export: ['config', 'read-config', 'handoff', 'out', 'selection'],
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
    if (name === 'live') flags[name] = true;
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
const optional = (flags: Parsed['flags'], name: string) =>
  typeof flags[name] === 'string' ? (flags[name] as string) : undefined;

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
  app?: EvaluationApp<any, any, any>,
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
    !['requested', 'running', 'completed', 'failed', 'interrupted'].includes(request.status) ||
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

async function dispatch(
  app: EvaluationApp<any, any, any>,
  parsed: Parsed,
  options: EvaluationMainOptions,
): Promise<{ status: number; result: unknown }> {
  const { command, flags } = parsed;
  if (command === 'describe') return { status: 0, result: app.descriptor };
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
  if (command === 'request') {
    if (flags.policy)
      parseEvaluationPolicy(await readCommandText(required(flags, 'policy')), app.descriptor);
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
    });
    return { status: 0, result };
  }
  const handoff = await handoffFile(flags);
  if (command === 'run') {
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
  if (command === 'check') {
    const parsedPolicy = parseEvaluationPolicy(
      await readCommandText(required(flags, 'policy')),
      app.descriptor,
    );
    const { client, projectId } = await readConnection(flags, handoff);
    const request = await client.getEvaluation(projectId, handoff.bundleId, handoff.requestId);
    assertRequest(request, handoff, app);
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
      expectedDescriptor: app.descriptor,
      expectedBinding: {
        parentVersionId: request.parentVersionId,
        candidateVersionId: request.candidateVersionId,
        parentDigest: request.parentDigest,
        candidateDigest: request.candidateDigest,
        requestId: request.id,
        attemptId: request.attemptId!,
        comparisonId: request.comparisonId,
        submitter: request.evaluatorPrincipal!,
      },
      policy: parsedPolicy.policy,
      policyDigest: parsedPolicy.sha256,
    });
    return {
      status: verdict.verdict === 'pass' ? 0 : verdict.verdict === 'fail' ? 2 : 3,
      result: verdict,
    };
  }
  const { client, projectId } = await readConnection(flags, handoff);
  const request = await client.getEvaluation(projectId, handoff.bundleId, handoff.requestId);
  assertRequest(request, handoff);
  return { status: 0, result: safeRequest(request) };
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
  let command: Command | 'invalid' = 'invalid';
  try {
    const parsed = parse(argv);
    command = parsed.command;
    const { status, result } = await dispatch(app, parsed, options);
    const output = JSON.stringify(result);
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
    process.stderr.write(JSON.stringify({ schemaVersion: 1, command, error: diagnostic }) + '\n');
    if (
      [
        'execution.uncertain',
        'submission.unconfirmed',
        'legacy.submission_unconfirmed',
        'journal.busy',
        'journal.foreign',
        'journal.missing',
        'journal.relocated',
        'journal.ownership_lost',
        'request.interrupted',
        'request.base_conflict',
      ].includes(diagnostic.code) ||
      diagnostic.executionState === 'may_have_started' ||
      diagnostic.executionState === 'report_saved'
    )
      return 3;
    if (command === 'export' && diagnostic.code === 'artifact.missing') return 3;
    return 1;
  }
}
