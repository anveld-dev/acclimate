import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runControlsFromFlags } from './controls.js';
import { EvaluationUsageError, EXIT_CODES } from './errors.js';
import { assertPayloadCompatible } from './compatibility-check.js';
import { loadLocalPayload, LocalRunError, tryEvaluation, type TryResult } from './local.js';
import type { EvaluationApp } from './types.js';

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

/** Live evaluators require --live. Model-free evaluators reject it. */
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
      ? 'All shapes are valid.'
      : 'Fix the errors above; a real run records them as evidence gaps.',
  );
  return lines.join('\n');
}

/** `try`: execute and grade selected cases once and check every returned shape. */
export async function tryCommand(app: EvaluationApp<any, any, any>, flags: Flags) {
  assertLiveFlag(app, flags);
  const controls = runControlsFromFlags({ cases: text(flags, 'case'), 'case-timeout': text(flags, 'case-timeout') });
  const payload = text(flags, 'payload') ? await payloadFrom(text(flags, 'payload')!, '--payload') : undefined;
  if (payload) assertPayloadCompatible(app, payload.payload, '--payload');
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
