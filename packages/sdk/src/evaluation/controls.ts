import { EvaluationError, EvaluationUsageError } from './errors.js';
import type { Outcome } from '../types.js';

/** Selects part of the inventory. Unselected pairs stay in the report as `not_selected`. */
export type CaseSelection =
  | { kind: 'cases'; caseIds: readonly string[] }
  | { kind: 'shard'; index: number; count: number };

export interface TrialProgress {
  /** Arms finished so far, including ones the runner skipped after a stop. */
  completed: number;
  /** Arms this invocation plans to run (selected pairs × arms). */
  total: number;
  caseId: string;
  repetition: number;
  side: 'parent' | 'candidate';
  outcome: Readonly<Outcome>;
  elapsedMs: number;
}

/**
 * Invocation controls. They change when the runner stops, not what a trial
 * measures, so they are not part of the descriptor. Concurrency and grade
 * retries are declared in the definition instead, where they are fingerprinted.
 */
export interface RunControls {
  /** Wall-clock budget for the whole run, from the first callback. */
  deadlineMs?: number;
  /** Budget for each execute call and each grade attempt. */
  caseTimeoutMs?: number;
  /** Stop starting new pairs once the summed reported `usage.costUsd` reaches this value. */
  maxCostUsd?: number;
  selection?: CaseSelection;
  /** Called after each arm settles. Exceptions are ignored. */
  progress?: (event: TrialProgress) => void;
}

export type StopReason = 'completed' | 'deadline' | 'cost_limit' | 'cancelled';

export interface RunSummary {
  schemaVersion: 1;
  /** Why the runner stopped scheduling work. Anything except `completed` leaves gaps. */
  stopReason: StopReason;
  /** True when any expected pair was skipped, stopped early, or not selected. */
  partial: boolean;
  concurrency: number;
  gradeRetries: number;
  selection: null | (CaseSelection & { selectedPairs: number; totalPairs: number });
  pairs: { expected: number; selected: number; started: number; notSelected: number };
  /** Sum of reported `usage.costUsd`; null when no arm reported cost. */
  costUsd: number | null;
  maxCostUsd: number | null;
  deadlineMs: number | null;
  caseTimeoutMs: number | null;
  timedOutCallbacks: number;
  /** Arms whose execute raised ExecutionUncertainError. Each left an `uncertain.json` marker. */
  uncertainArms: number;
  gradeRetriesUsed: number;
  /**
   * Pairs where both arms returned output and the canonical JSON was identical.
   * When every compared pair is identical, the adapter probably ignores `version`.
   */
  outputs: { comparedPairs: number; identicalPairs: number };
}

/** Outcome error codes the runner writes when it skips or stops a trial. */
export const CONTROL_ERRORS = {
  notSelected: 'not_selected',
  timeout: 'timeout',
  deadline: 'deadline_exceeded',
  costLimit: 'cost_limit_reached',
} as const;

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/;
/** Parse `90`, `90s`, `1.5m`, `2h` or `500ms` into milliseconds. Bare numbers are seconds. */
export function parseDuration(text: string, flag: string): number {
  const match = DURATION.exec(text.trim());
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
  const value = match ? Number(match[1]) * scale[(match[2] ?? 's') as keyof typeof scale] : NaN;
  if (!Number.isFinite(value) || value <= 0 || value > 7 * 24 * 3_600_000)
    throw controlError(`${flag} needs a positive duration such as 90s, 15m or 2h.`, flag);
  return Math.round(value);
}

export function parseCost(text: string): number {
  const value = /^\d+(?:\.\d+)?$/.test(text.trim()) ? Number(text) : NaN;
  if (!Number.isFinite(value) || value <= 0)
    throw controlError('--max-cost-usd needs a positive number of US dollars, such as 2.50.', '--max-cost-usd');
  return value;
}

export function parseSelection(cases?: string, shard?: string): CaseSelection | undefined {
  if (cases !== undefined && shard !== undefined)
    throw controlError('Use --cases or --shard, not both.', '--cases');
  if (cases !== undefined) {
    const caseIds = cases.split(',').map((item) => item.trim());
    if (!caseIds.length || caseIds.some((id) => !id) || new Set(caseIds).size !== caseIds.length)
      throw controlError('--cases needs a comma-separated list of distinct case IDs.', '--cases');
    return { kind: 'cases', caseIds };
  }
  if (shard !== undefined) {
    const match = /^(\d+)\/(\d+)$/.exec(shard.trim());
    const index = match ? Number(match[1]) : NaN,
      count = match ? Number(match[2]) : NaN;
    if (!match || count < 1 || count > 1000 || index < 1 || index > count)
      throw controlError('--shard needs INDEX/COUNT with 1 <= INDEX <= COUNT, such as 2/4.', '--shard');
    return { kind: 'shard', index, count };
  }
  return undefined;
}

/** Resolve a selection against the inventory. Shards deal whole cases round-robin. */
export function selectedCaseIds(
  selection: CaseSelection | undefined,
  caseIds: readonly string[],
): Set<string> {
  if (!selection) return new Set(caseIds);
  if (selection.kind === 'cases') {
    const known = new Set(caseIds);
    const unknown = selection.caseIds.filter((id) => !known.has(id));
    if (unknown.length)
      throw controlError(
        `Unknown case ID${unknown.length > 1 ? 's' : ''}: ${unknown.slice(0, 5).map((id) => JSON.stringify(id)).join(', ')}. Run describe to list the expected cases.`,
        '--cases',
      );
    return new Set(selection.caseIds);
  }
  if (selection.count > caseIds.length)
    throw controlError(
      `--shard ${selection.index}/${selection.count} needs at least ${selection.count} cases; this evaluator has ${caseIds.length}.`,
      '--shard',
    );
  return new Set(caseIds.filter((_, position) => position % selection.count === selection.index - 1));
}

export function describeSelection(selection: RunSummary['selection']): string {
  if (!selection) return 'all cases';
  const scope =
    selection.kind === 'shard'
      ? `shard ${selection.index}/${selection.count}`
      : `${selection.caseIds.length} selected case${selection.caseIds.length === 1 ? '' : 's'}`;
  return `${scope} · ${selection.selectedPairs} of ${selection.totalPairs} pairs`;
}

/** Validate controls supplied by library callers, using the same rules as the flags. */
export function validateRunControls(controls: RunControls | undefined): RunControls {
  if (controls === undefined) return {};
  if (!controls || typeof controls !== 'object') throw new EvaluationError('config.schema');
  const positive = (value: unknown) =>
    value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0);
  if (
    !positive(controls.deadlineMs) ||
    !positive(controls.caseTimeoutMs) ||
    !positive(controls.maxCostUsd) ||
    (controls.progress !== undefined && typeof controls.progress !== 'function')
  )
    throw new EvaluationError('config.schema');
  const selection = controls.selection;
  if (
    selection !== undefined &&
    !(
      (selection.kind === 'cases' &&
        Array.isArray(selection.caseIds) &&
        selection.caseIds.length > 0 &&
        selection.caseIds.every((id) => typeof id === 'string' && id)) ||
      (selection.kind === 'shard' &&
        Number.isInteger(selection.index) &&
        Number.isInteger(selection.count) &&
        selection.index >= 1 &&
        selection.index <= selection.count)
    )
  )
    throw new EvaluationError('config.schema');
  return controls;
}

/** An invalid run-control flag. A usage error (exit 1) that names the flag. */
export class RunControlError extends EvaluationUsageError {
  constructor(message: string, field?: string) {
    super('usage.invalid_flag', { reason: message, ...(field ? { field } : {}) });
    this.message = message;
    this.name = 'RunControlError';
  }
}
const controlError = (message: string, field?: string) => new RunControlError(message, field);

const label = (id: string) =>
  JSON.stringify(id).replace(
    /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'),
  );

/**
 * Progress goes to stderr when it is a terminal, or when --progress asks for it
 * (CI logs). Without a terminal, stderr otherwise stays a single JSON diagnostic.
 */
export function wantsProgress(mode: 'auto' | 'on' | 'off', stream: { isTTY?: boolean } = process.stderr) {
  return mode === 'on' || (mode === 'auto' && stream.isTTY === true);
}

/** One progress line for stderr. Never includes outputs or expected values. */
export function progressLine(event: TrialProgress): string {
  const { outcome } = event;
  const result =
    outcome.gradingStatus === 'scored'
      ? `reward ${outcome.reward}`
      : outcome.executionStatus === 'infrastructure_failed'
        ? (outcome.error ?? 'failed')
        : outcome.gradingStatus === 'failed'
          ? 'grading_failed'
          : (outcome.error ?? outcome.executionStatus);
  const cost =
    typeof outcome.usage?.costUsd === 'number' ? ` · $${outcome.usage.costUsd.toFixed(4)}` : '';
  const width = String(event.total).length;
  return `[${String(event.completed).padStart(width)}/${event.total}] ${label(event.caseId)} #${event.repetition} ${event.side.padEnd(9)} ${result}${cost} · ${(event.elapsedMs / 1000).toFixed(1)}s`;
}

/** Warnings shared by local and service comparisons. */
export function runWarnings(
  summary: RunSummary | undefined,
  digests?: { parent: string; candidate: string },
): string[] {
  const warnings: string[] = [];
  if (!summary) return warnings;
  const { comparedPairs, identicalPairs } = summary.outputs;
  if (comparedPairs > 0 && identicalPairs === comparedPairs) {
    warnings.push(
      digests && digests.parent === digests.candidate
        ? `Parent and candidate are the same payload (${digests.parent}), so identical outputs are expected. Supply a changed candidate to measure a difference.`
        : `Both arms returned identical output on all ${comparedPairs} compared pair${comparedPairs === 1 ? '' : 's'}. Check that execute uses the version it is given; an adapter that ignores it compares the agent with itself.`,
    );
  }
  if (summary.stopReason === 'deadline')
    warnings.push(`Stopped at the ${formatMs(summary.deadlineMs)} deadline. The result is partial and indeterminate.`);
  if (summary.stopReason === 'cost_limit')
    warnings.push(
      `Stopped starting pairs after reported cost reached $${(summary.costUsd ?? 0).toFixed(4)} (limit $${summary.maxCostUsd}). The result is partial and indeterminate.`,
    );
  if (summary.timedOutCallbacks)
    warnings.push(
      `${summary.timedOutCallbacks} callback${summary.timedOutCallbacks === 1 ? '' : 's'} exceeded the ${formatMs(summary.caseTimeoutMs)} case timeout. The SDK aborted their signal and stopped waiting; work that ignores the signal may still be running.`,
    );
  if (summary.uncertainArms)
    warnings.push(
      `${summary.uncertainArms} arm${summary.uncertainArms === 1 ? '' : 's'} could not confirm that execution stopped and ${summary.uncertainArms === 1 ? 'is' : 'are'} recorded as execution_uncertain. Inspect the quarantined jobs (uncertain.json) before reusing their resources.`,
    );
  if (summary.selection)
    warnings.push(
      `Ran ${describeSelection(summary.selection)}. Unselected pairs are reported as not_selected, so this result never claims full coverage.`,
    );
  return warnings;
}

function formatMs(value: number | null): string {
  if (value === null) return 'configured';
  if (value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  if (value % 1000 === 0) return `${value / 1000}s`;
  return `${value}ms`;
}

/** Flags shared by live and local runs. Values are strings unless noted. */
export const RUN_CONTROL_FLAGS = ['deadline', 'case-timeout', 'max-cost-usd', 'cases', 'shard'] as const;

/** Parse run-control flags into controls. Unknown names are the caller's concern. */
export function runControlsFromFlags(flags: Record<string, string | boolean | undefined>): RunControls {
  const text = (name: string) => {
    const value = flags[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value) throw controlError(`--${name} needs a value.`, `--${name}`);
    return value;
  };
  const deadline = text('deadline'),
    timeout = text('case-timeout'),
    cost = text('max-cost-usd');
  const selection = parseSelection(text('cases'), text('shard'));
  return {
    ...(deadline ? { deadlineMs: parseDuration(deadline, '--deadline') } : {}),
    ...(timeout ? { caseTimeoutMs: parseDuration(timeout, '--case-timeout') } : {}),
    ...(cost ? { maxCostUsd: parseCost(cost) } : {}),
    ...(selection ? { selection } : {}),
  };
}
