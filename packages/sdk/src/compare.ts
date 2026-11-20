import { AcclimateError } from './errors.js';
import type {
  CaseKey,
  CasePair,
  ComparisonRequest,
  Outcome,
  Usage,
  VersionMetadata,
} from './types.js';
import type { AcclimateClient } from './client.js';

export interface ComparisonVersion {
  version: VersionMetadata;
}
export interface ComparisonCase<TSnapshot = unknown, TSettings = unknown> {
  caseId: string;
  snapshot: TSnapshot;
  settings: TSettings;
  repetitions?: number;
}
export interface ExecutionResult<TOutput = unknown> {
  /** Structured-cloneable data; each grade attempt receives its own copy. */
  output: TOutput;
  /** A task-level failure with a gradeable output (for example, a saved error response). */
  executionStatus?: 'completed' | 'task_failed';
  error?: string | null;
  outputRef?: string | null;
  usage?: Usage | null;
}
export interface GradeResult {
  reward: number;
  error?: string | null;
}
/** Throw from an execute callback when the task failed without gradeable output. */
export class TaskExecutionError extends AcclimateError<'task.failed'> {
  readonly kind = 'task';
  constructor(message = 'The task failed without gradeable output.', options?: ErrorOptions) {
    super('task.failed', message, options);
    this.name = 'TaskExecutionError';
  }
}
/** Throw from an execute callback when the environment, not the agent, failed. */
export class InfrastructureError extends AcclimateError<'infrastructure.failed'> {
  readonly kind = 'infrastructure';
  constructor(message = 'The execution environment failed.', options?: ErrorOptions) {
    super('infrastructure.failed', message, options);
    this.name = 'InfrastructureError';
  }
}
export interface CompareOptions<TSnapshot, TSettings, TOutput> {
  parent: ComparisonVersion;
  candidate: ComparisonVersion;
  cases: readonly ComparisonCase<TSnapshot, TSettings>[];
  datasetRevision: string;
  runtime: Record<string, string>;
  graderRevision: string;
  evaluation?: { requestId: string; attemptId: string };
  concurrency?: number;
  signal?: AbortSignal;
  /** Regrade saved outputs only. This never reruns execute or adds an inventory item. */
  gradeRetries?: number;
  execute: (input: {
    version: ComparisonVersion;
    caseId: string;
    repetition: number;
    snapshot: TSnapshot;
    settings: TSettings;
    signal?: AbortSignal;
  }) => Promise<ExecutionResult<TOutput>>;
  grade: (input: {
    output: TOutput;
    caseId: string;
    repetition: number;
    version: ComparisonVersion;
    signal?: AbortSignal;
  }) => Promise<GradeResult>;
}

const validUsage = (usage: Usage | null | undefined): Usage | null => {
  if (usage == null) return null;
  for (const value of [usage.inputTokens, usage.outputTokens, usage.costUsd]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) return null;
  }
  return { ...usage };
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
function clone<T>(value: T, label: string): T {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw new Error(`${label} cannot be cloned for isolated comparison execution`, { cause });
  }
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Runs fixed, paired app-owned executions and returns the exact frozen wire request. */
export async function compare<TSnapshot, TSettings, TOutput>(
  options: CompareOptions<TSnapshot, TSettings, TOutput>,
): Promise<ComparisonRequest> {
  const { parent, candidate, execute, grade: gradeOutput, signal } = options;
  const evaluation = options.evaluation ? { ...options.evaluation } : undefined;
  if (
    evaluation &&
    (!evaluation.requestId?.trim() ||
      !evaluation.attemptId?.trim() ||
      evaluation.attemptId.length > 128)
  )
    throw new Error('evaluation requires requestId and attemptId');
  const digestPattern = /^sha256:[0-9a-f]{64}$/;
  if (
    !parent.version.id ||
    !candidate.version.id ||
    !digestPattern.test(parent.version.digest) ||
    !digestPattern.test(candidate.version.digest)
  )
    throw new Error('versions require IDs and valid sha256 digests');
  if (parent.version.bundleId !== candidate.version.bundleId)
    throw new Error('parent and candidate must belong to the same bundle');
  if (candidate.version.parentVersionId !== parent.version.id)
    throw new Error('candidate must be a child of parent');
  if (
    !options.datasetRevision ||
    !options.graderRevision ||
    Object.keys(options.runtime).length === 0 ||
    Object.entries(options.runtime).some(([k, v]) => !k || !v)
  )
    throw new Error('dataset, runtime, and grader identities are required');
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)
    throw new Error('concurrency must be between 1 and 64');
  const retries = options.gradeRetries ?? 0;
  if (!Number.isInteger(retries) || retries < 0 || retries > 3)
    throw new Error('gradeRetries must be between 0 and 3');

  // Freeze the complete inventory before the first callback can execute.
  const inventory: Array<{
    key: CaseKey;
    parent: { snapshot: TSnapshot; settings: TSettings };
    candidate: { snapshot: TSnapshot; settings: TSettings };
  }> = [];
  const seen = new Set<string>();
  for (const test of options.cases) {
    if (!test.caseId || seen.has(test.caseId))
      throw new Error(`duplicate or empty caseId: ${test.caseId}`);
    seen.add(test.caseId);
    const count = test.repetitions ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 1000)
      throw new Error(`invalid repetitions for ${test.caseId}`);
    if (inventory.length + count > 1000) throw new Error('comparison inventory exceeds 1000 pairs');
    for (let repetition = 0; repetition < count; repetition++)
      inventory.push({
        key: { caseId: test.caseId, repetition },
        parent: {
          snapshot: clone(test.snapshot, `${test.caseId} snapshot`),
          settings: clone(test.settings, `${test.caseId} settings`),
        },
        candidate: {
          snapshot: clone(test.snapshot, `${test.caseId} snapshot`),
          settings: clone(test.settings, `${test.caseId} settings`),
        },
      });
  }
  if (inventory.length === 0) throw new Error('comparison inventory must not be empty');
  const frozenParent = deepFreeze(clone(parent, 'parent version'));
  const frozenCandidate = deepFreeze(clone(candidate, 'candidate version'));
  const { datasetRevision, graderRevision } = options;
  const runtime = { ...options.runtime };
  const results: CasePair[] = new Array(inventory.length);
  let cursor = 0;
  let activeCallbacks = 0;
  const waiters: Array<() => void> = [];
  const limited = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (activeCallbacks >= concurrency) await new Promise<void>((resolve) => waiters.push(resolve));
    activeCallbacks++;
    try {
      return await fn();
    } finally {
      activeCallbacks--;
      waiters.shift()?.();
    }
  };
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= inventory.length) return;
      const { key } = inventory[index];
      const run = async (version: ComparisonVersion): Promise<Outcome> => {
        if (signal?.aborted)
          return {
            executionStatus: 'infrastructure_failed',
            gradingStatus: 'missing',
            reward: null,
            outputRef: null,
            error: 'aborted',
            usage: null,
          };
        let execution: ExecutionResult<TOutput>;
        try {
          const input =
            version === frozenParent ? inventory[index].parent : inventory[index].candidate;
          execution = await limited(() =>
            execute({
              version,
              ...key,
              snapshot: input.snapshot,
              settings: input.settings,
              signal: signal,
            }),
          );
        } catch (e) {
          const taskFailure = e instanceof TaskExecutionError;
          return {
            executionStatus: taskFailure ? 'task_failed' : 'infrastructure_failed',
            gradingStatus: 'missing',
            reward: null,
            outputRef: null,
            error: errText(e),
            usage: null,
          };
        }
        const usage = validUsage(execution.usage);
        let output: TOutput;
        try {
          output = clone(execution.output, 'execution output');
        } catch (e) {
          return {
            executionStatus: execution.executionStatus ?? 'completed',
            gradingStatus: 'failed',
            reward: null,
            outputRef: execution.outputRef ?? null,
            error: errText(e),
            usage,
          };
        }
        // Keep a private snapshot in memory; graders never receive this canonical copy.
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const grade = await limited(() =>
              gradeOutput({
                output: clone(output, 'grading output'),
                ...key,
                version,
                signal: signal,
              }),
            );
            if (!Number.isFinite(grade.reward))
              throw new Error('grader returned a non-finite reward');
            return {
              executionStatus: execution.executionStatus ?? 'completed',
              gradingStatus: 'scored',
              reward: grade.reward,
              outputRef: execution.outputRef ?? null,
              error: grade.error ?? execution.error ?? null,
              usage,
            };
          } catch (e) {
            if (attempt === retries || signal?.aborted)
              return {
                executionStatus: execution.executionStatus ?? 'completed',
                gradingStatus: 'failed',
                reward: null,
                outputRef: execution.outputRef ?? null,
                error: errText(e),
                usage,
              };
          }
        }
        return {
          executionStatus: 'completed',
          gradingStatus: 'missing',
          reward: null,
          outputRef: execution.outputRef ?? null,
          error: 'grade missing',
          usage,
        };
      };
      const [p, c] = await Promise.all([run(frozenParent), run(frozenCandidate)]);
      results[index] = { ...key, parent: p, candidate: c };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, inventory.length) }, worker));
  return {
    parentVersionId: frozenParent.version.id,
    candidateVersionId: frozenCandidate.version.id,
    parentDigest: frozenParent.version.digest,
    candidateDigest: frozenCandidate.version.digest,
    datasetRevision,
    runtime,
    graderRevision,
    ...(evaluation ? { evaluation } : {}),
    expectedCases: inventory.map(({ key }) => key),
    results,
  };
}

/** Uploads the complete machine-readable report using the SDK's idempotent endpoint. */
export function submitComparison(
  client: AcclimateClient,
  workspaceId: string,
  bundleId: string,
  report: ComparisonRequest,
  idempotencyKey: string,
) {
  return client.createComparison(workspaceId, bundleId, report, idempotencyKey);
}
