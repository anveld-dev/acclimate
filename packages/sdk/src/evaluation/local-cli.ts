import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Evaluation } from '../types.js';
import { comparisonText } from './cli.js';
import {
  describeSelection,
  extractRunControlFlags,
  progressLine,
  RUN_CONTROL_FLAGS,
  RunControlError,
  runControlsFromFlags,
  runWarnings,
  type RunControls,
  type RunSummary,
  wantsProgress,
} from './controls.js';
import { bindRunControls } from './definition.js';
import { EvaluationError, toSafeDiagnostic } from './errors.js';
import {
  createLocalRunDirectory,
  loadLocalPayload,
  localReport,
  LOCAL_NOTICE,
  LocalRunError,
  readLocalText,
  runLocalComparison,
  scoreLocalComparison,
  tryEvaluation,
  writeLocalReport,
  type TryResult,
} from './local.js';
import { parseEvaluationPolicy, PolicyError } from './policy.js';
import type { EvaluationApp, EvaluationRunResult } from './types.js';

export const LOCAL_COMPARE_USAGE = [
  'compare --local --parent PAYLOAD --candidate PAYLOAD [--live] [--policy POLICY] [--out DIR] [--json]',
  '        [--cases ID,ID | --shard I/N] [--deadline DURATION] [--case-timeout DURATION] [--max-cost-usd USD] [--progress | --quiet]',
  'PAYLOAD is a payload JSON file or a folder: skills/** become skill files, memory/** memory files, and other files instructions.',
  'Local runs need no service or config. Their report is advisory and never a release receipt.',
].join('\n');
export const TRY_USAGE = [
  'try [--case ID[,ID...]] [--payload PAYLOAD] [--live] [--case-timeout DURATION] [--json]',
  'Runs execute and grade once for each case (default: the first case) and checks every returned shape.',
].join('\n');

const LOCAL_FLAGS = {
  compare: ['local', 'parent', 'candidate', 'live', 'policy', 'out', 'json', 'quiet', 'progress', ...RUN_CONTROL_FLAGS],
  try: ['case', 'payload', 'live', 'json', 'case-timeout'],
} as const;
const BOOLEAN = new Set(['local', 'live', 'json', 'quiet', 'progress']);

export function isLocalCommand(argv: readonly string[]): boolean {
  return argv[0] === 'try' || (argv[0] === 'compare' && argv.includes('--local'));
}

function parseLocal(argv: readonly string[]) {
  const command = argv[0] as 'compare' | 'try';
  const allowed: readonly string[] = LOCAL_FLAGS[command];
  const flags: Record<string, string | boolean> = {};
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    const name = argument.startsWith('--') ? argument.slice(2) : '';
    if (!allowed.includes(name))
      throw new LocalRunError(
        `${name ? '--' + name : JSON.stringify(argument)} is not a ${command === 'try' ? 'try' : 'local compare'} flag.`,
      );
    if (Object.hasOwn(flags, name)) throw new LocalRunError(`Supply --${name} once.`);
    if (BOOLEAN.has(name)) flags[name] = true;
    else {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new LocalRunError(`--${name} needs a value.`);
      flags[name] = value;
    }
  }
  return { command, flags };
}

const text = (flags: Record<string, string | boolean>, name: string) =>
  typeof flags[name] === 'string' ? (flags[name] as string) : undefined;

function withSignals<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  return work(controller.signal).finally(() => {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  });
}

function shorten(value: unknown, limit = 1200): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value, null, 2) ?? 'undefined';
  } catch {
    rendered = String(value);
  }
  return rendered.length > limit ? rendered.slice(0, limit) + `\n… (${rendered.length - limit} more characters)` : rendered;
}

export function summaryLines(summary: RunSummary): string[] {
  const cost =
    summary.costUsd === null
      ? 'not reported'
      : `$${summary.costUsd.toFixed(4)}${summary.maxCostUsd !== null ? ` of $${summary.maxCostUsd} limit` : ''}`;
  return [
    `Run                 ${summary.stopReason}${summary.partial ? ' (partial)' : ''} · ${summary.pairs.started}/${summary.pairs.selected} pairs started · concurrency ${summary.concurrency}${summary.gradeRetries ? ` · grade retries ${summary.gradeRetries}` : ''}`,
    `Reported cost       ${cost}`,
    ...(summary.selection ? [`Selection           ${describeSelection(summary.selection)}`] : []),
  ];
}

async function compareLocal(app: EvaluationApp<any, any, any>, flags: Record<string, string | boolean>, directory: string) {
  const parentPath = text(flags, 'parent'),
    candidatePath = text(flags, 'candidate');
  if (!parentPath || !candidatePath)
    throw new LocalRunError('Supply --parent and --candidate, each a payload JSON file or a folder of bundle files.');
  const controls: RunControls = runControlsFromFlags(flags as Record<string, string>);
  const policyText = text(flags, 'policy') ? await readLocalText(text(flags, 'policy')!) : undefined;
  const sources = { parent: await loadLocalPayload(parentPath), candidate: await loadLocalPayload(candidatePath) };
  // Parse the policy before any callback runs so a typo costs nothing.
  if (policyText !== undefined) parseEvaluationPolicy(policyText, app.descriptor);
  const runDirectory = await createLocalRunDirectory(text(flags, 'out'), directory);
  const terminal = process.stdout.isTTY && !flags.json;
  if (flags.quiet && flags.progress) throw new LocalRunError('Use --progress or --quiet, not both.');
  const progress = wantsProgress(flags.quiet ? 'off' : flags.progress ? 'on' : 'auto');
  if (progress) process.stderr.write(`Local comparison in ${runDirectory}\n`);
  const result = await withSignals((signal) =>
    runLocalComparison({
      app,
      parent: sources.parent.payload,
      candidate: sources.candidate.payload,
      allowLive: flags.live === true,
      controls: {
        ...controls,
        ...(progress ? { progress: (event) => process.stderr.write(progressLine(event) + '\n') } : {}),
      },
      signal,
      directory: runDirectory,
    }),
  );
  const scored = scoreLocalComparison(result, policyText);
  const report = localReport(result, scored, sources, runDirectory);
  const reportFile = await writeLocalReport(runDirectory, report, sources);
  // Terminal output already shows warnings; JSON output also flags them on stderr.
  if (!terminal) for (const warning of result.warnings) process.stderr.write(`WARNING: ${warning}\n`);
  const verdict = scored.policy?.verdict;
  const status = verdict
    ? verdict === 'pass'
      ? 0
      : verdict === 'fail'
        ? 2
        : 3
    : ['deadline', 'cost_limit', 'cancelled'].includes(result.summary.stopReason)
      ? 3
      : 0;
  if (!terminal)
    return {
      status,
      result: {
        schemaVersion: 1,
        kind: report.kind,
        authoritative: false,
        notice: LOCAL_NOTICE,
        report: reportFile,
        parent: report.parent,
        candidate: report.candidate,
        run: result.summary,
        invocation: { callbacksStarted: result.callbacksStarted },
        scores: scored.scores,
        policy: scored.policy,
        warnings: result.warnings,
        diagnostics: result.diagnostics,
      },
    };
  const pseudoRequest = {
    id: 'local',
    status: 'completed',
    expectedCases: result.descriptor.expectedCases,
  } as unknown as Evaluation;
  const table = comparisonText(pseudoRequest, result.comparison, scored.scores, scored.policy, policyText !== undefined)
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^Policy {14}/, 'Policy (advisory)   '));
  const lines = [
    'Local comparison · not a release receipt',
    ...table,
    ...summaryLines(result.summary),
    `Parent              ${result.versions.parent.digest}  ${sources.parent.source}`,
    `Candidate           ${result.versions.candidate.digest}  ${sources.candidate.source}`,
    `Execution callbacks started: ${result.callbacksStarted}.`,
  ];
  if (result.diagnostics.length) {
    lines.push(`Callback problems   showing ${Math.min(result.diagnostics.length, 10)} of ${result.diagnostics.length} (local only)`);
    for (const item of result.diagnostics.slice(0, 10))
      lines.push(`  ${JSON.stringify(item.caseId)} [${item.repetition}] ${item.side} · ${item.phase} · ${item.detail}`);
  }
  for (const warning of result.warnings) lines.push(`WARNING: ${warning}`);
  lines.push(`Report              ${reportFile}`);
  lines.push(
    `To gate a release, replay the candidate against the service:\n  acclimate-eval ${report.replay.command}${flags.live ? ' --live' : ''}`,
  );
  return { status, result: lines.join('\n') };
}

function tryText(result: TryResult): string {
  const lines = [
    `Try · payload ${result.payload.source ?? 'placeholder (pass --payload to use your files)'} · ${result.payload.digest}`,
  ];
  for (const row of result.cases) {
    lines.push(`Case ${JSON.stringify(row.caseId)}`);
    const execute = row.execute;
    lines.push(
      `  execute  ${execute.status}${execute.error ? '' : ` in ${execute.durationMs} ms`}${execute.executionStatus ? ` · ${execute.executionStatus}` : ''}`,
    );
    if (execute.error) lines.push(`    ${execute.error}`);
    for (const issue of execute.issues) lines.push(`    ${issue.severity}  ${issue.field}: ${issue.message}`);
    if (execute.output !== undefined) lines.push(...shorten(execute.output).split('\n').map((line) => '    │ ' + line));
    if (execute.usage !== undefined) lines.push(`    usage ${JSON.stringify(execute.usage)}`);
    const grade = row.grade;
    lines.push(
      `  grade    ${grade.status}${grade.status === 'skipped' ? ' (execute did not return a usable result)' : grade.error ? '' : ` in ${grade.durationMs} ms`}${grade.reward !== undefined ? ` · reward ${grade.reward}` : ''}`,
    );
    if (grade.error) lines.push(`    ${grade.error}`);
    for (const issue of grade.issues) lines.push(`    ${issue.severity}  ${issue.field}: ${issue.message}`);
    if (grade.explanation !== undefined)
      lines.push(...shorten(grade.explanation, 600).split('\n').map((line) => '    │ ' + line));
  }
  lines.push(
    result.ok
      ? 'All shapes are valid. Next: compare --local --parent PAYLOAD --candidate PAYLOAD.'
      : 'Fix the errors above; a real run records them as evidence gaps.',
  );
  return lines.join('\n');
}

async function tryCommand(app: EvaluationApp<any, any, any>, flags: Record<string, string | boolean>) {
  const controls = runControlsFromFlags({ cases: text(flags, 'case'), 'case-timeout': text(flags, 'case-timeout') });
  const payload = text(flags, 'payload') ? await loadLocalPayload(text(flags, 'payload')!) : undefined;
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-try-'));
  try {
    const result = await withSignals((signal) =>
      tryEvaluation({
        app,
        payload,
        selection: controls.selection,
        caseTimeoutMs: controls.caseTimeoutMs,
        allowLive: flags.live === true,
        directory,
        signal,
      }),
    );
    const terminal = process.stdout.isTTY && !flags.json;
    return { status: result.ok ? 0 : 1, result: terminal ? tryText(result) : result };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** `compare --local` and `try`: no service, no config, no handoff. */
export async function localMain(
  app: EvaluationApp<any, any, any>,
  argv: readonly string[],
  directory = process.cwd(),
): Promise<number> {
  const json = argv.includes('--json') || !process.stdout.isTTY;
  try {
    const { command, flags } = parseLocal(argv);
    const { status, result } =
      command === 'try' ? await tryCommand(app, flags) : await compareLocal(app, flags, directory);
    process.stdout.write((typeof result === 'string' ? result : JSON.stringify(result)) + '\n');
    return status;
  } catch (error) {
    const message =
      error instanceof LocalRunError || error instanceof RunControlError
        ? error.message
        : error instanceof PolicyError
          ? `The policy is invalid or does not fit this evaluator's cases (${(error as PolicyError).code}).`
          : undefined;
    const usage = argv[0] === 'try' ? TRY_USAGE : LOCAL_COMPARE_USAGE;
    if (message) {
      if (json)
        process.stderr.write(
          JSON.stringify({ schemaVersion: 1, command: argv[0], error: { code: 'local.invalid', message } }) + '\n',
        );
      else process.stderr.write(`${message}\n\n${usage}\n`);
      return 1;
    }
    const diagnostic = toSafeDiagnostic(error);
    process.stderr.write(JSON.stringify({ schemaVersion: 1, command: argv[0], error: diagnostic }) + '\n');
    return 1;
  }
}

/** Notices appended to a service `compare`: run summary and warnings. */
export function serviceRunNotices(result: EvaluationRunResult, digests: { parent: string; candidate: string }) {
  const summary = result.runSummary;
  const warnings = runWarnings(summary, digests);
  // Service compare keeps stderr a single JSON diagnostic; warnings ride in the result.
  if (warnings.length && process.stderr.isTTY)
    for (const warning of warnings) process.stderr.write(`WARNING: ${warning}\n`);
  return { lines: [...(summary ? summaryLines(summary) : []), ...warnings.map((w) => `WARNING: ${w}`)], json: summary ? { run: summary, warnings } : {} };
}

/**
 * Hook for the installed command: route local commands, then strip and bind
 * run-control flags so the service command parser keeps its grammar.
 */
export async function routeEvaluationCommand(
  app: EvaluationApp<any, any, any>,
  argv: readonly string[],
  service: (app: EvaluationApp<any, any, any>, argv: string[]) => Promise<number>,
): Promise<number> {
  if (isLocalCommand(argv)) return localMain(app, argv);
  let extracted;
  try {
    extracted = extractRunControlFlags(argv);
  } catch (error) {
    if (!(error instanceof RunControlError)) throw error;
    process.stderr.write(
      JSON.stringify({
        schemaVersion: 1,
        command: argv[0] ?? 'invalid',
        error: { ...toSafeDiagnostic(new EvaluationError('config.schema')), hint: error.message },
      }) + '\n',
    );
    return 1;
  }
  const controls: RunControls = {
    ...extracted.controls,
    ...(['compare', 'run'].includes(argv[0]) && wantsProgress(extracted.progress)
      ? { progress: (event) => process.stderr.write(progressLine(event) + '\n') }
      : {}),
  };
  return service(Object.keys(controls).length ? bindRunControls(app, controls) : app, extracted.argv);
}
