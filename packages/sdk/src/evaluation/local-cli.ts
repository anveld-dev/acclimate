import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Evaluation } from '../types.js';
import { comparisonText, evaluationMain } from './cli.js';
import {
  describeSelection,
  progressLine,
  runControlsFromFlags,
  runWarnings,
  type RunControls,
  type RunSummary,
  wantsProgress,
} from './controls.js';
import { EvaluationUsageError, EXIT_CODES } from './errors.js';
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
import { parseEvaluationPolicy } from './policy.js';
import type { EvaluationApp, EvaluationRunResult } from './types.js';

export const LOCAL_COMPARE_USAGE = [
  'compare --local --parent PAYLOAD --candidate PAYLOAD [--live] [--policy POLICY] [--out DIR] [--json]',
  '        [--cases ID,ID | --shard I/N] [--deadline DURATION] [--case-timeout DURATION] [--max-cost-usd USD] [--progress | --quiet]',
  'PAYLOAD is a payload JSON file or a folder: skills/** become skill files, memory/** memory files, and other files instructions.',
  'Local runs need no service or config. Their report is advisory and never a release receipt.',
].join('\n');
/** Service compare flags that compare --local rejects. */
const SERVICE_COMPARE_FLAGS = ['config', 'handoff', 'bundle', 'channel', 'payload', 'name', 'retry-after'];
export const TRY_USAGE = [
  'try [--case ID[,ID...]] [--payload PAYLOAD] [--live] [--case-timeout DURATION] [--json]',
  'Runs execute and grade once for each case (default: the first case) and checks every returned shape.',
].join('\n');

type Flags = Record<string, string | boolean>;
const text = (flags: Flags, name: string) =>
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

/** Local runs share compare's --live rule: live evaluators need it, model-free ones reject it. */
function assertLiveFlag(app: EvaluationApp<any, any, any>, flags: Flags) {
  const live = app.descriptor.runtime.execution === 'live';
  if (live !== (flags.live === true))
    throw new EvaluationUsageError(live ? 'usage.missing_flag' : 'usage.invalid_flag', {
      field: '--live',
      reason: live
        ? 'This evaluator is live. Add --live to authorize model calls.'
        : 'This evaluator is model-free. Omit --live.',
    });
}

/** Name the flag a payload came from when it cannot be read. */
async function payloadFrom(file: string, flag: string) {
  try {
    return await loadLocalPayload(file);
  } catch (error) {
    if (error instanceof LocalRunError && !error.diagnostic.field)
      throw new LocalRunError(error.message, flag);
    throw error;
  }
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

/** `compare --local`: run the trial schedule on two payloads without a service. */
export async function compareLocalCommand(
  app: EvaluationApp<any, any, any>,
  flags: Flags,
  directory = process.cwd(),
) {
  const service = SERVICE_COMPARE_FLAGS.filter((name) => flags[name] !== undefined);
  if (service.length)
    throw new EvaluationUsageError('usage.conflicting_flags', {
      field: '--' + service[0],
      reason: `--${service[0]} belongs to the service compare. compare --local needs no config or handoff.`,
      hint: LOCAL_COMPARE_USAGE,
    });
  const parentPath = text(flags, 'parent'),
    candidatePath = text(flags, 'candidate');
  if (!parentPath || !candidatePath)
    throw new EvaluationUsageError('usage.missing_flag', {
      field: parentPath ? '--candidate' : '--parent',
      reason: 'Supply --parent and --candidate, each a payload JSON file or a folder of bundle files.',
      hint: LOCAL_COMPARE_USAGE,
    });
  assertLiveFlag(app, flags);
  if (flags.quiet && flags.progress)
    throw new EvaluationUsageError('usage.conflicting_flags', {
      field: '--progress',
      reason: 'Use --progress or --quiet, not both.',
    });
  const controls: RunControls = runControlsFromFlags(flags);
  const policyText = text(flags, 'policy') ? await readLocalText(text(flags, 'policy')!) : undefined;
  const sources = {
    parent: await payloadFrom(parentPath, '--parent'),
    candidate: await payloadFrom(candidatePath, '--candidate'),
  };
  // Parse the policy before any callback runs so a typo costs nothing.
  if (policyText !== undefined) parseEvaluationPolicy(policyText, app.descriptor);
  const runDirectory = await createLocalRunDirectory(text(flags, 'out'), directory);
  const terminal = process.stdout.isTTY && !flags.json;
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
  // Advisory policy: pass 0, fail 2, indeterminate 3. Without a policy, a run
  // stopped by its deadline, cost limit or a signal is partial evidence: 3.
  const verdict = scored.policy?.verdict;
  const status = verdict
    ? verdict === 'pass'
      ? EXIT_CODES.ok
      : verdict === 'fail'
        ? EXIT_CODES.gateFailed
        : EXIT_CODES.indeterminate
    : result.summary.stopReason !== 'completed'
      ? EXIT_CODES.indeterminate
      : EXIT_CODES.ok;
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

/** `try`: execute and grade selected cases once and check every returned shape. */
export async function tryCommand(app: EvaluationApp<any, any, any>, flags: Flags) {
  assertLiveFlag(app, flags);
  const controls = runControlsFromFlags({ cases: text(flags, 'case'), 'case-timeout': text(flags, 'case-timeout') });
  const payload = text(flags, 'payload') ? await payloadFrom(text(flags, 'payload')!, '--payload') : undefined;
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
    // A shape error is the application's to fix: exit 1.
    return { status: result.ok ? EXIT_CODES.ok : EXIT_CODES.usage, result: terminal ? tryText(result) : result };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Run `compare --local` or `try` with paths resolved against `directory`. The
 * installed command reaches the same code through evaluationMain.
 */
export function localMain(
  app: EvaluationApp<any, any, any>,
  argv: readonly string[],
  directory = process.cwd(),
): Promise<number> {
  return evaluationMain(app, argv, { cwd: directory });
}

/** Notices appended to a service `compare`: run summary and warnings. */
export function serviceRunNotices(result: EvaluationRunResult, digests: { parent: string; candidate: string }) {
  const summary = result.runSummary;
  const warnings = runWarnings(summary, digests);
  // Service compare keeps stderr a single JSON diagnostic; warnings ride in the result.
  if (warnings.length && process.stderr.isTTY)
    for (const warning of warnings) process.stderr.write(`WARNING: ${warning}\n`);
  return {
    lines: [...(summary ? summaryLines(summary) : []), ...warnings.map((w) => `WARNING: ${w}`)],
    json: summary ? { run: summary, warnings } : {},
    /** A deadline, cost limit or interruption left pairs unrun: partial evidence is indeterminate. */
    exitStatus: summary && summary.stopReason !== 'completed' ? EXIT_CODES.indeterminate : EXIT_CODES.ok,
  };
}
