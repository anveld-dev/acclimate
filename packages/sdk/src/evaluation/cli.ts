import { lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { analyzeComparison, type MetricAnalysis } from './analysis.js';
import { recordPolicyReceipt } from './policy-receipt.js';
import { AcclimateClient } from '../client.js';
import type {
  BundlePayload,
  Evaluation,
  EvaluationDescriptor,
  EvaluationHandoff,
  Comparison,
} from '../types.js';
import {
  validateEvaluationHandoff,
  evaluationDescriptorDifferences,
  assertGuidedTarget,
  validatePayload,
} from '../validation.js';
import { preflightEvaluation, runEvaluation } from './index.js';
import type { EvaluationApp, EvaluationRunResult } from './types.js';
import { assertUnaliasedPath } from './private-state.js';
import { readEvaluatorConfig, readReaderConfig } from './config.js';
import {
  EVALUATION_ERROR_CODES,
  EXIT_CODES,
  EvaluationError,
  EvaluationUsageError,
  exitCodeFor,
  toSafeDiagnostic,
  type ExitCode,
  type SafeCode,
} from './errors.js';
import {
  checkComparison,
  describePolicyInference,
  formatStatistic,
  parseEvaluationPolicy,
  type PolicyVerdict,
} from './policy.js';
import {
  exportReviewEvidence,
  verifyReviewExport,
  parseArtifactSelection,
  type ReviewMapper,
} from './artifacts.js';
import {
  assertSettledPredecessor,
  createRequestFromIntent,
  interruptFromIntent,
  readCommandJson,
  readCommandText,
} from './cli-intents.js';
import { pullCommand, pullHelp } from './pull.js';
import { assertPayloadCompatible, payloadCompatibility } from './compatibility-check.js';
import {
  compareLocalCommand,
  LOCAL_COMPARE_USAGE,
  serviceRunNotices,
  TRY_USAGE,
  tryCommand,
} from './local-cli.js';
import {
  progressLine,
  RUN_CONTROL_FLAGS,
  runControlsFromFlags,
  selectedCaseIds,
  wantsProgress,
  type RunControls,
} from './controls.js';
import { PLAN_USAGE, planCommand, policyReadinessFor } from './plan-command.js';

type Command =
  | 'compare'
  | 'try'
  | 'coverage'
  | 'describe'
  | 'doctor'
  | 'request'
  | 'run'
  | 'check'
  | 'status'
  | 'interrupt'
  | 'export'
  | 'verify-export'
  | 'pull'
  | 'plan';
/** Run controls accepted by compare (service and local) and run. */
const runControlFlags: readonly string[] = [...RUN_CONTROL_FLAGS, 'progress', 'quiet'];
/** compare --local flags that the service form rejects. */
const localCompareFlags: readonly string[] = ['local', 'parent', 'candidate', 'out'];
const allowed: Record<Command, readonly string[]> = {
  compare: [
    'config',
    'handoff',
    'bundle',
    'channel',
    'payload',
    'name',
    'retry-after',
    'live',
    'policy',
    ...localCompareFlags,
    ...runControlFlags,
  ],
  try: ['case', 'payload', 'live', 'case-timeout'],
  coverage: [],
  describe: [],
  doctor: ['config', 'bundle', 'handoff', 'policy', 'name', 'payload'],
  request: ['config', 'bundle', 'channel', 'payload', 'intent', 'out', 'policy'],
  run: ['config', 'handoff', 'live', 'name', ...runControlFlags],
  check: ['config', 'read-config', 'handoff', 'policy', 'name'],
  status: ['config', 'read-config', 'handoff', 'name'],
  interrupt: ['config', 'handoff', 'reason', 'name'],
  export: ['config', 'read-config', 'handoff', 'out', 'selection', 'name'],
  'verify-export': ['manifest', 'read-config', 'handoff'],
  pull: ['config', 'bundle', 'channel', 'out'],
  plan: ['policy', 'aa', 'effects', 'simulations', 'seed'],
};
/** Flags every command accepts. */
const globalFlags = ['json', 'verbose'];
const booleanFlags = new Set(['live', 'json', 'verbose', 'local', 'progress', 'quiet']);
/** Flags whose values are file or directory paths, resolved against the working directory. */
const pathFlags = new Set([
  'config',
  'read-config',
  'handoff',
  'payload',
  'aa',
  'parent',
  'candidate',
  'intent',
  'out',
  'policy',
  'selection',
  'manifest',
]);
/** Commands that never import the application module. */
export const ADAPTER_FREE_COMMANDS: readonly string[] = ['status', 'verify-export', 'interrupt', 'pull'];
export const EVALUATOR_COMMANDS = Object.keys(allowed) as readonly Command[];
interface Parsed {
  command: Command;
  flags: Record<string, string | boolean>;
}
const commandList = () => EVALUATOR_COMMANDS.join(', ');
const flagList = (command: Command) =>
  [...allowed[command], ...globalFlags].map((name) => '--' + name).join(', ');
const printable = (value: string) => JSON.stringify(value.slice(0, 80));

/** The installed SDK version. */
export function sdkVersion(): string {
  try {
    return String(createRequire(import.meta.url)('../../package.json').version);
  } catch {
    return 'unknown';
  }
}

/** Parse evaluator arguments without loading application code or reading files. */
export function parseEvaluatorArguments(argv: readonly string[], cwd = process.cwd()): Parsed {
  if (!argv.length)
    throw new EvaluationUsageError('usage.missing_command', {
      hint: `Choose a command: ${commandList()}. Run with --help for usage.`,
    });
  const command = argv[0] as Command;
  if (!Object.hasOwn(allowed, command))
    throw new EvaluationUsageError('usage.unknown_command', {
      field: printable(String(argv[0])),
      hint: `Choose a command: ${commandList()}. Run with --help for usage.`,
    });
  const flags: Record<string, string | boolean> = {};
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (typeof flag !== 'string' || !flag.startsWith('--'))
      throw new EvaluationUsageError('usage.invalid_flag', {
        field: printable(String(flag)),
        reason: 'Unexpected argument. Values must follow their flag.',
        hint: `${command} accepts ${flagList(command)}.`,
      });
    const name = flag.slice(2);
    if (!allowed[command].includes(name) && !globalFlags.includes(name))
      throw new EvaluationUsageError('usage.unknown_flag', {
        field: printable(flag),
        hint: `${command} accepts ${flagList(command)}.`,
      });
    if (Object.hasOwn(flags, name))
      throw new EvaluationUsageError('usage.invalid_flag', {
        field: flag,
        reason: `Supply ${flag} once.`,
      });
    if (booleanFlags.has(name)) flags[name] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--'))
        throw new EvaluationUsageError('usage.missing_flag', {
          field: flag,
          reason: `${flag} needs a value.`,
        });
      flags[name] = pathFlags.has(name) ? resolve(cwd, value) : value;
    }
  }
  return { command, flags };
}
function required(flags: Parsed['flags'], name: string, hint?: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || !value)
    throw new EvaluationUsageError('usage.missing_flag', {
      field: '--' + name,
      ...(hint ? { hint } : {}),
    });
  return value;
}
function exactlyOne(flags: Parsed['flags'], first: string, second: string) {
  if (!flags[first] && !flags[second])
    throw new EvaluationUsageError('usage.missing_flag', {
      field: `--${first}`,
      reason: `Supply --${first} or --${second}.`,
    });
  if (flags[first] && flags[second])
    throw new EvaluationUsageError('usage.conflicting_flags', {
      field: `--${first}`,
      reason: `Supply --${first} or --${second}, not both.`,
    });
}
const compareUsage = [
  'compare --config CONFIG --handoff HANDOFF [--live] [--policy POLICY] [--json]',
  'compare --config CONFIG --bundle ID --channel CHANNEL --payload FILE (--name RUN_NAME | --retry-after PRIOR_NAME [--name RUN_NAME]) [--live] [--policy POLICY] [--json]',
  'compare --local --parent PAYLOAD --candidate PAYLOAD [--live] [--policy POLICY] [--out DIR] [--json]  (no service; advisory)',
  'Run controls: [--deadline DURATION] [--case-timeout DURATION] [--max-cost-usd USD] [--cases ID,ID | --shard I/N] [--progress | --quiet]',
  'Live evaluators require --live. Use one input form and supply each flag once.',
].join('\n');
// Resolved lazily: local-cli imports this module, so its constants are read at call time.
const usageFor = (command: string): string | undefined =>
  command === 'compare'
    ? `${compareUsage}\n${LOCAL_COMPARE_USAGE}`
    : command === 'try'
      ? TRY_USAGE
      : command === 'pull'
        ? pullHelp
        : command === 'plan'
          ? PLAN_USAGE
          : undefined;

/** Parse run-control flags and attach stderr progress unless --quiet. */
function runControls(flags: Parsed['flags']): RunControls {
  if (flags.quiet && flags.progress)
    throw new EvaluationUsageError('usage.conflicting_flags', {
      field: '--progress',
      reason: 'Use --progress or --quiet, not both.',
    });
  const controls = runControlsFromFlags(flags);
  const progress = wantsProgress(flags.quiet ? 'off' : flags.progress ? 'on' : 'auto');
  return {
    ...controls,
    ...(progress
      ? { progress: (event) => process.stderr.write(progressLine(event) + '\n') }
      : {}),
  };
}

function validateCompareFlags(flags: Parsed['flags'], live: boolean) {
  const local = localCompareFlags.filter((key) => key !== 'local' && flags[key]);
  if (local.length)
    throw new EvaluationUsageError('usage.unknown_flag', {
      field: '--' + local[0],
      reason: `--${local[0]} belongs to compare --local.`,
      hint: compareUsage,
    });
  if (live !== (flags.live === true))
    throw new EvaluationUsageError(live ? 'usage.missing_flag' : 'usage.invalid_flag', {
      field: '--live',
      reason: live
        ? 'This evaluator is live. Add --live to authorize model calls.'
        : 'This evaluator is model-free. Omit --live.',
    });
  const creation = ['bundle', 'channel', 'payload', 'name', 'retry-after'];
  const used = creation.filter((key) => flags[key]);
  if (flags.handoff && used.length)
    throw new EvaluationUsageError('usage.conflicting_flags', {
      field: '--' + used[0],
      reason: '--handoff cannot be combined with candidate creation flags.',
      hint: compareUsage,
    });
  if (!flags.config)
    throw new EvaluationUsageError('usage.missing_flag', { field: '--config', hint: compareUsage });
  if (flags.handoff) return;
  if (!used.length)
    throw new EvaluationUsageError('usage.missing_flag', {
      field: '--handoff',
      reason:
        'Supply --handoff FILE, or create a run with --bundle, --channel, --payload and --name RUN_NAME.',
      hint: compareUsage,
    });
  for (const key of ['bundle', 'channel', 'payload'])
    if (!flags[key])
      throw new EvaluationUsageError('usage.missing_flag', { field: '--' + key, hint: compareUsage });
  if (!flags.name && !flags['retry-after'])
    throw new EvaluationUsageError('usage.missing_flag', {
      field: '--name',
      reason:
        'Name the run with --name RUN_NAME, or repeat a finished run with --retry-after PRIOR_NAME.',
      hint: compareUsage,
    });
  if (flags.name && flags.name === flags['retry-after'])
    throw new EvaluationUsageError('usage.conflicting_flags', {
      field: '--name',
      reason: 'Give the retry a new --name, or omit --name to use after-<request ID>.',
      hint: compareUsage,
    });
  if (flags.name && !/^[a-zA-Z0-9_-]{1,80}$/.test(String(flags.name)))
    throw new EvaluationUsageError('usage.invalid_flag', {
      field: '--name',
      reason: 'Use 1–80 letters, digits, underscores or hyphens.',
    });
}

export function comparisonText(
  request: Evaluation,
  comparison: Comparison | null,
  scores: Pick<MetricAnalysis, 'counts' | 'summary' | 'cases' | 'evidenceGaps'> | null,
  policy: PolicyVerdict | null,
  policyRequested: boolean,
) {
  const value = formatStatistic;
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
  if (policy?.inference) lines.push(...describePolicyInference(policy.inference));
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

async function namedHandoff(journalRoot: string, name: string, flag = '--name') {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name))
    throw new EvaluationUsageError('usage.invalid_flag', {
      field: flag,
      reason: 'Use 1–80 letters, digits, underscores or hyphens.',
    });
  await assertUnaliasedPath(journalRoot, 'journalAlias');
  return join(journalRoot, 'comparisons', name, 'request.json');
}

/** Read a handoff file. A missing file is `handoff.missing`, not a config problem. */
async function readHandoff(filename: string, flag: string, name?: string): Promise<EvaluationHandoff> {
  let value: unknown;
  try {
    const exists = await lstat(filename).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code !== 'ENOENT' && error.code !== 'ENOTDIR',
    );
    if (!exists) throw new EvaluationError('config.missing');
    value = await readCommandJson(filename);
  } catch (error) {
    if (error instanceof EvaluationError && error.code === 'config.missing')
      throw new EvaluationError('handoff.missing', {
        field: flag,
        ...(name ? { reason: `No run named ${JSON.stringify(name)} in the journal.` } : {}),
        hint: name
          ? 'Check the run name, or create the run with compare --name.'
          : 'Download the handoff from the console, or create one with request --out.',
      });
    if (error instanceof EvaluationError && !error.diagnostic.field)
      throw new EvaluationError(error.code, { ...error.diagnostic, field: flag });
    throw error;
  }
  return validateEvaluationHandoff(value);
}

async function handoffFile(flags: Parsed['flags']): Promise<EvaluationHandoff> {
  const named = typeof flags['run-name'] === 'string' ? flags['run-name'] : undefined;
  return readHandoff(required(flags, 'handoff'), named ? '--name' : '--handoff', named);
}

async function readConnection(flags: Parsed['flags'], handoff: EvaluationHandoff) {
  exactlyOne(flags, 'config', 'read-config');
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
  return verdict === 'pass'
    ? EXIT_CODES.ok
    : verdict === 'fail'
      ? EXIT_CODES.gateFailed
      : EXIT_CODES.indeterminate;
}
/** completed → 0, failed (execution or infrastructure failure) → 4, interrupted or abandoned → 5. */
function runStatus(request: Evaluation) {
  return request.status === 'completed'
    ? EXIT_CODES.ok
    : request.status === 'failed'
      ? EXIT_CODES.infrastructure
      : request.status === 'interrupted' || request.status === 'abandoned'
        ? EXIT_CODES.recovery
        : EXIT_CODES.indeterminate;
}
/** ready → 0. An unreachable or unverified service → 4. Any setup problem → 1. */
function readinessStatus(result: {
  status: string;
  authorization: string;
  checks?: Array<{ status: string; code?: string }>;
}) {
  if (result.status === 'ready') return EXIT_CODES.ok;
  const failed = result.checks?.filter((check) => check.code) ?? [];
  if (
    failed.some((check) => check.code === 'service.unavailable' || check.status === 'unverified')
  )
    return EXIT_CODES.infrastructure;
  return EXIT_CODES.usage;
}

/** Read a payload for a pre-run check. Invalid payloads are left for request creation to report. */
async function readPayloadFile(file: string): Promise<BundlePayload | undefined> {
  try {
    const value = await readCommandJson(file);
    validatePayload(value);
    return value;
  } catch (error) {
    if (error instanceof EvaluationError && error.code === 'config.missing')
      throw new EvaluationError('config.missing', { field: '--payload' });
    return undefined;
  }
}

async function createRequest(app: EvaluationApp<any, any, any>, flags: Parsed['flags'], predecessor?: { handoffFile: string; request: Evaluation }) {
  const configPath = required(flags, 'config');
  const config = await readEvaluatorConfig(configPath);
  const bundleId = required(flags, 'bundle'),
    channel = required(flags, 'channel');
  assertGuidedTarget({ projectId: config.projectId, bundleId });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(channel))
    throw new EvaluationError('guided_target_unsupported', {
      field: '--channel',
      reason: 'Use 1–64 letters, digits, underscores or hyphens.',
    });
  const preflight = await preflightEvaluation({ app, configPath, target: { bundleId } });
  if (preflight.status !== 'ready') return { status: readinessStatus(preflight), result: preflight };
  const result = await createRequestFromIntent({
    app,
    config,
    bundleId,
    channel,
    payloadFile: required(flags, 'payload'),
    intentPath: required(flags, 'intent'),
    outputFile: required(flags, 'out'),
    predecessor,
    runName: typeof flags.name === 'string' ? flags.name : undefined,
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
  if (command === 'try') return tryCommand(app, flags);
  if (command === 'plan') return planCommand(app.descriptor, flags);
  if (command === 'compare' && flags.local) return compareLocalCommand(app, flags, options.cwd);
  if (ADAPTER_FREE_COMMANDS.includes(command)) return readEvidence(parsed);
  if (command === 'coverage')
    throw new EvaluationUsageError('usage.unknown_command', {
      field: '"coverage"',
      hint: 'Run coverage through acclimate-eval or python -m acclimate.',
    });
  if (command === 'doctor') {
    exactlyOne(flags, 'bundle', 'handoff');
    const policyReadiness = flags.policy
      ? policyReadinessFor(
          parseEvaluationPolicy(await readCommandText(required(flags, 'policy')), app.descriptor)
            .policy,
          app.descriptor,
        )
      : undefined;
    // A payload is checked against the native harnesses the application declares.
    const payload = flags.payload ? await readPayloadFile(required(flags, 'payload')) : undefined;
    if (flags.payload && !payload)
      throw new EvaluationUsageError('usage.invalid_flag', {
        field: '--payload',
        reason: 'Supply a bundle payload JSON file: {"schemaVersion":1,"files":[{"path","kind","text"}]}.',
      });
    const compatibility = payload ? payloadCompatibility(app, payload) : undefined;
    const target = flags.handoff
      ? { handoff: await handoffFile(flags) }
      : { bundleId: required(flags, 'bundle') };
    const result = await preflightEvaluation({
      app,
      configPath: required(flags, 'config'),
      target,
    });
    const status = readinessStatus(result);
    return {
      status: status || (compatibility?.issues.length ? EXIT_CODES.usage : EXIT_CODES.ok),
      result: {
        ...result,
        ...(policyReadiness ? { policyReadiness } : {}),
        ...(compatibility ? { compatibility } : {}),
      },
    };
  }
  const comparing = command === 'compare';
  if (comparing) validateCompareFlags(flags, app.descriptor.runtime.execution === 'live');
  // Parse run controls before any request is created or callback starts.
  const controls = command === 'run' || comparing ? runControls(flags) : undefined;
  if (controls?.selection)
    selectedCaseIds(
      controls.selection,
      [...new Set(app.descriptor.expectedCases.map((item) => item.caseId))],
    );
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
    // Incompatible skills fail here, naming the rule, before a request or a paid run.
    const payload = await readPayloadFile(required(flags, 'payload'));
    if (payload) assertPayloadCompatible(app, payload, '--payload');
    const config = await readEvaluatorConfig(required(flags, 'config'));
    let predecessor;
    if (flags['retry-after']) {
      const priorName = required(flags, 'retry-after');
      const handoffFile = await namedHandoff(config.journalRoot, priorName, '--retry-after');
      const prior = await readHandoff(handoffFile, '--retry-after', priorName);
      if (prior.bundleId !== flags.bundle)
        throw new EvaluationError('request.intent_mismatch', {
          field: '--bundle',
          reason: 'The prior run used a different bundle.',
        });
      const { client, projectId } = await readConnection(flags, prior);
      const request = await client.getEvaluation(projectId, prior.bundleId, prior.requestId);
      assertRequest(request, prior);
      assertSettledPredecessor(request);
      predecessor = { handoffFile, request };
      if (!flags.name) flags.name = 'after-' + request.id;
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
        controls,
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
        const notices = serviceRunNotices(result, {
          parent: request.parentDigest,
          candidate: request.candidateDigest,
        });
        const execution = result.reusedEvidence
          ? 'Reused saved evidence. No execution callbacks started.'
          : `Execution callbacks started this time: ${result.callbacksStarted}.`;
        const failure = result.firstCallbackFailure;
        return {
          status:
            status ||
            (receipt?.status === 'unconfirmed' ? EXIT_CODES.infrastructure : 0) ||
            notices.exitStatus,
          result: terminal
            ? [comparisonText(request, result.comparison, scores, policyResult, !!policy), ...notices.lines, execution,
                ...(failure ? [failureText(failure)] : []),
                ...(receipt ? [receipt.status === 'recorded' ? 'Policy receipt recorded for release review.' : 'Policy receipt unconfirmed. Retry check with the evaluator config.'] : []),
                ...(runName ? ['Run handle: --name ' + runName] : [])].join('\n')
            : {
                ...safeRequest(request),
                invocation,
                ...(failure ? { firstCallbackFailure: failure } : {}),
                ...(runName ? { runName } : {}),
                parentVersionId: request.parentVersionId,
                candidateVersionId: request.candidateVersionId,
                candidateDigest: request.candidateDigest,
                scores,
                policy: policyResult,
                ...(receipt ? { policyReceipt: receipt } : {}),
                ...notices.json,
              },
        };
      }
      return {
        status: runStatus(result.evaluation),
        result: {
          ...safeRequest(result.evaluation),
          executionState: result.executionState,
          ...(result.firstCallbackFailure
            ? { firstCallbackFailure: result.firstCallbackFailure }
            : {}),
          ...(result.runSummary ? { run: result.runSummary } : {}),
        },
      };
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  }
  if (command === 'export') {
    exactlyOne(flags, 'config', 'read-config');
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
  if (command === 'check') return checkPolicyCommand(app.descriptor, flags, handoff);
  throw new EvaluationUsageError('usage.unknown_command', { field: JSON.stringify(command) });
}

async function readEvidence({ command, flags }: Parsed) {
  if (command === 'pull') return pullCommand(flags);
  if (command === 'interrupt') {
    // Check every flag before reading any file.
    const configPath = required(flags, 'config');
    const reason = required(flags, 'reason');
    const handoff = await handoffFile(flags);
    const config = await readEvaluatorConfig(configPath);
    if (config.serviceUrl !== handoff.serviceUrl || config.projectId !== handoff.projectId)
      throw new EvaluationError('version.binding_mismatch', {
        field: '--handoff',
        reason: 'The handoff names a different service or workspace than the config.',
      });
    return {
      status: 0,
      result: safeRequest(await interruptFromIntent(config, handoff, reason)),
    };
  }
  if (command === 'verify-export') {
    const online = flags['read-config'] || flags.handoff;
    if (online && !(flags['read-config'] && flags.handoff))
      throw new EvaluationUsageError('usage.missing_flag', {
        field: flags.handoff ? '--read-config' : '--handoff',
        reason: 'Online verification needs both --read-config and --handoff.',
      });
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
  if (command !== 'status')
    throw new EvaluationUsageError('usage.unknown_command', { field: JSON.stringify(command) });
  exactlyOne(flags, 'config', 'read-config');
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

/** Reader and control operations (status, verify-export, interrupt) never import agent code. */
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
  // A policy pinned on the request before the run flags policies chosen after seeing results.
  const policyPin = !request.policyDigest
    ? 'unpinned'
    : request.policyDigest === parsedPolicy.sha256
      ? 'matched'
      : 'mismatched';
  return {
    status: policyExit(verdict.verdict) || (receipt.status === 'unconfirmed' ? EXIT_CODES.infrastructure : 0),
    result: { ...verdict, policyPin, policyReceipt: receipt },
  };
}

export interface EvaluationMainOptions {
  review?: { toReviewArtifact: ReviewMapper };
  /** Directory that relative paths and the default local report folder resolve against. */
  cwd?: string;
}

/** Statically installed app command adapter. It never exits or discovers executable modules. */
export async function evaluationMain(
  app: EvaluationApp<any, any, any>,
  argv: readonly string[],
  options: EvaluationMainOptions = {},
): Promise<number> {
  return runCommand(argv, (parsed) => dispatch(app, parsed, options), options.cwd);
}

/** Verify a recorded comparison using the installed descriptor and the caller's policy. */
export async function evaluationCheckMain(
  descriptor: EvaluationDescriptor,
  argv: readonly string[],
) {
  return runCommand(argv, async (parsed) => {
    if (parsed.command !== 'check')
      throw new EvaluationUsageError('usage.unknown_command', {
        field: JSON.stringify(parsed.command),
        hint: 'This entry point runs check only.',
      });
    return checkPolicyCommand(descriptor, parsed.flags, await handoffFile(parsed.flags));
  });
}

const recoveryHints: Partial<Record<SafeCode, string>> = {
  'request.intent_mismatch':
    'Restore the original evaluator and candidate to recover this run. To measure a changed evaluator on the same settled candidate, replace --name with --retry-after and the prior name.',
  'request.base_conflict':
    'The published parent changed. Review the new parent and choose a new name for a comparison against it.',
  'evidence.not_terminal':
    'Check status with the prior name and inspect the original worker. A fresh attempt requires a completed or failed comparison, or an interrupted or abandoned request.',
  'request.channel_empty':
    'The channel has no release yet. Publish a baseline release to this channel, then run the comparison again.',
  'policy.invalid':
    'Use the editable quality-policy.example.json from the evaluator starter or copy the policy in the getting-started guide.',
  'config.missing': 'Check the --config path. Relative paths resolve against the current directory.',
};
const safeForwardedCodes = new Set([
  'policy.invalid',
  'policy.inventory_incompatible',
  'evidence.identity_mismatch',
  'evidence.malformed',
  'evidence.reward_out_of_range',
  'artifact.missing',
  'artifact.hash_mismatch',
  'artifact.integrity',
  'artifact.selection_invalid',
  'artifact.mapper_failed',
]);

/** True when --verbose was passed or ACCLIMATE_DEBUG is set to a truthy value. */
export function verboseRequested(argv: readonly string[]): boolean {
  const debug = process.env.ACCLIMATE_DEBUG;
  return argv.includes('--verbose') || (!!debug && !['0', 'false', 'no'].includes(debug.toLowerCase()));
}

/** The first line of an exception, without control characters. */
function describeCause(cause: unknown): { name: string; message: string; code?: string } | undefined {
  if (cause === undefined || cause === null) return undefined;
  const name =
    cause instanceof Error && /^[A-Za-z_$][\w$]{0,127}$/.test(cause.name) ? cause.name : typeof cause;
  const message = String(cause instanceof Error ? cause.message : cause)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ' ')
    .split('\n')[0]
    .slice(0, 1000);
  const code = (cause as { code?: unknown })?.code;
  return {
    name,
    message,
    ...(typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? { code } : {}),
  };
}
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = (error as { cause?: unknown })?.cause;
  while (current !== undefined && chain.length < 5) {
    chain.push(current);
    current = (current as { cause?: unknown })?.cause;
  }
  return chain;
}

function failureText(failure: NonNullable<EvaluationRunResult['firstCallbackFailure']>): string {
  return (
    `First callback failure: ${JSON.stringify(failure.caseId)} [${failure.repetition}] ${failure.side} · ${failure.stage} · ${failure.reason}` +
    (failure.diagnosticFile ? `\n  Details (private, not uploaded): ${failure.diagnosticFile}` : '')
  );
}

/**
 * Print an error for a local evaluator command and return its exit code. On a terminal,
 * stderr gets readable text; otherwise, or with --json, one JSON line. Pass --verbose or
 * set ACCLIMATE_DEBUG=1 to include the stack and the chained cause.
 */
export function reportEvaluatorError(
  error: unknown,
  argv: readonly string[],
  command: string = 'invalid',
): ExitCode {
  const known =
    error !== null && (typeof error === 'object' || typeof error === 'function')
      ? (error as { code?: string })
      : {};
  const diagnostic = toSafeDiagnostic(
    !(error instanceof EvaluationError) && known.code && safeForwardedCodes.has(known.code)
      ? new EvaluationError(known.code as SafeCode, {
          phase: command === 'check' || known.code.startsWith('policy.') ? 'policy' : 'export',
        })
      : error,
  );
  const hint =
    diagnostic.hint ??
    ((command === 'compare' ||
      diagnostic.code === 'policy.invalid' ||
      diagnostic.code === 'request.channel_empty' ||
      diagnostic.code === 'config.missing') &&
      recoveryHints[diagnostic.code]) ??
    undefined;
  const message =
    error instanceof EvaluationError
      ? error.message
      : EVALUATION_ERROR_CODES[diagnostic.code].message;
  const verbose = verboseRequested(argv);
  // An unexpected exception is itself the cause; an evaluator error names its chained cause.
  const causes = error instanceof EvaluationError ? causeChain(error) : [error, ...causeChain(error)];
  const firstCause = describeCause(causes[0]);
  const publicDiagnostic = {
    ...diagnostic,
    message,
    ...(hint ? { hint } : {}),
    ...(firstCause ? { cause: firstCause } : {}),
  };
  const human = process.stderr.isTTY === true && !argv.includes('--json');
  if (human) {
    const lines = [`error[${diagnostic.code}]: ${message}`];
    if (diagnostic.field && !message.includes(diagnostic.field)) lines.push(`  field: ${diagnostic.field}`);
    if (diagnostic.reason && !message.includes(diagnostic.reason)) lines.push(`  reason: ${diagnostic.reason}`);
    if (diagnostic.missingFields?.length)
      lines.push(`  missing fields: ${diagnostic.missingFields.join(', ')}`);
    if (diagnostic.serviceUrl) lines.push(`  service: ${diagnostic.serviceUrl}`);
    if (firstCause)
      lines.push(
        `  caused by: ${firstCause.name}${firstCause.code ? ` [${firstCause.code}]` : ''}: ${firstCause.message}`,
      );
    if (hint) lines.push(`  hint: ${hint.split('\n').join('\n        ')}`);
    else if (usageFor(command) && diagnostic.code.startsWith('usage.'))
      lines.push('  usage:\n    ' + usageFor(command)!.split('\n').join('\n    '));
    lines.push(`  next: ${diagnostic.nextAction}`);
    if (verbose) {
      for (const item of new Set([error, ...causes]))
        if (item instanceof Error && item.stack) lines.push('', item.stack);
    } else if (firstCause) lines.push('  Rerun with --verbose or ACCLIMATE_DEBUG=1 for the stack trace.');
    process.stderr.write(lines.join('\n') + '\n');
  } else {
    process.stderr.write(
      JSON.stringify({
        schemaVersion: 1,
        command,
        error: publicDiagnostic,
        ...(verbose
          ? {
              stack: [...new Set([error, ...causes])]
                .filter((item): item is Error => item instanceof Error && !!item.stack)
                .map((item) => item.stack),
            }
          : {}),
      }) + '\n',
    );
  }
  return exitCodeFor(diagnostic);
}

async function runCommand(
  argv: readonly string[],
  execute: (parsed: Parsed) => Promise<{ status: number; result: unknown }>,
  cwd = process.cwd(),
): Promise<number> {
  let command: Command | 'invalid' = 'invalid';
  try {
    if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
      process.stdout.write(sdkVersion() + '\n');
      return EXIT_CODES.ok;
    }
    const parsed = parseEvaluatorArguments(argv, cwd);
    command = parsed.command;
    if (command !== 'compare' && parsed.flags.name) {
      if (parsed.flags.handoff || parsed.flags['read-config'])
        throw new EvaluationUsageError('usage.conflicting_flags', {
          field: '--name',
          reason: '--name uses the evaluator config and cannot be combined with --handoff or --read-config.',
        });
      const config = await readEvaluatorConfig(required(parsed.flags, 'config'));
      const name = required(parsed.flags, 'name');
      parsed.flags.handoff = await namedHandoff(config.journalRoot, name);
      parsed.flags['run-name'] = name;
    }
    const { status, result } = await execute(parsed);
    const output =
      (command === 'compare' || command === 'try') && typeof result === 'string'
        ? result
        : JSON.stringify(result);
    if (Buffer.byteLength(output) > 4 * 1024 * 1024)
      throw new EvaluationError('transport.response_too_large');
    process.stdout.write(output + '\n');
    return status;
  } catch (error) {
    return reportEvaluatorError(error, argv, command);
  }
}
