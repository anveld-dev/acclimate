import { createHash } from 'node:crypto';
import path from 'node:path';
import { TaskExecutionError } from '../compare.js';
import type { CasePair, Outcome, VerifiedVersion } from '../types.js';
import type { CapturedDefinition } from './definition.js';
import {
  assertEvaluationOutput,
  assertJson,
  MAX_ARTIFACT,
  MAX_PRIVATE,
  OutputValidationError,
} from './definition.js';
import { CallbackCancelled, ExecutionUncertainError } from './errors.js';
import { canonicalEvaluationJson } from './manifest.js';
import { atomicPrivateWrite, privateDirectory } from './private-state.js';
import {
  CONTROL_ERRORS,
  selectedCaseIds,
  validateRunControls,
  type RunControls,
  type RunSummary,
  type StopReason,
} from './controls.js';

type Side = 'parent' | 'candidate';
export interface TrialArtifact {
  sha256: string;
  bytes: number;
}
export interface ArtifactIdentity {
  requestId: string;
  attemptId: string;
  caseId: string;
  repetition: number;
  side: Side;
  versionId: string;
  digest: string;
  role: 'output' | 'grader-explanation';
}

/** Storage and lifecycle seams. The live runner binds them to its journal and service. */
export interface TrialHooks {
  /** Runs before each execute and each grade. The live runner re-reads the request here. */
  checkpoint(): Promise<void>;
  assertOwned(): void;
  writeArtifact(identity: ArtifactIdentity, value: unknown): Promise<TrialArtifact>;
  /** Drop artifacts from an attempt that a retry replaces. */
  discardArtifacts(entries: readonly TrialArtifact[]): Promise<void>;
  /** Record an output validation failure privately. Return the diagnostic file, if any. */
  recordOutputError(directory: string, error: OutputValidationError): Promise<string | void>;
  /** Keep a callback's redacted diagnostics privately. Return the diagnostic file, if any. */
  saveCallbackError(
    directory: string,
    phase: 'execute' | 'grade',
    error: unknown,
  ): Promise<string | void>;
  /** Errors that must stop the whole run instead of becoming a trial outcome. */
  isFatal(error: unknown): boolean;
  onCallbackStarted(): void;
}

export interface TrialRunOptions {
  captured: CapturedDefinition<any, any, any>;
  requestId: string;
  attemptId: string;
  bundles: readonly [VerifiedVersion, VerifiedVersion];
  jobsRoot: string;
  signal: AbortSignal;
  controls?: RunControls;
  retryMissingTrial?: boolean;
  captureCallbackErrors?: boolean;
  /** Reused parent outcomes keyed by JSON [caseId, repetition]; parent arms are skipped. */
  cachedParent?: ReadonlyMap<string, Outcome>;
  hooks: TrialHooks;
}

export interface TrialRunResult {
  results: CasePair[];
  summary: RunSummary;
  /** The first callback that failed, in completion order. */
  firstCallbackFailure?: FirstCallbackFailure;
}

export interface FirstCallbackFailure {
  caseId: string;
  repetition: number;
  side: Side;
  stage: 'execute' | 'grade';
  reason:
    | 'execution_failed'
    | 'task_failed'
    | 'output_invalid'
    | 'grading_failed'
    | 'execution_uncertain';
  diagnosticFile?: string;
}

export const unavailable = (error = 'cancelled'): Outcome => ({
  executionStatus: 'infrastructure_failed',
  gradingStatus: 'missing',
  reward: null,
  outputRef: null,
  error,
  usage: null,
});

const usageKeys = ['inputTokens', 'outputTokens', 'costUsd'] as const;
/** Validate reported usage. Malformed usage is an output error, never silently dropped. */
export function reportedUsage(value: unknown): Outcome['usage'] {
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

const pairKey = (caseId: string, repetition: number) => JSON.stringify([caseId, repetition]);

/** Thrown inside a bounded callback when the runner stops waiting for it. */
class Abandoned extends Error {
  constructor(readonly reason: 'timeout' | 'deadline') {
    super(reason);
  }
}

/** Read the declared concurrency and grade retries from the fingerprinted runtime. */
export function scheduling(captured: CapturedDefinition<any, any, any>) {
  const concurrency = Number(captured.descriptor.runtime.concurrency ?? '1');
  const gradeRetries = Number(captured.descriptor.runtime.gradeRetries ?? '0');
  return {
    concurrency: Number.isInteger(concurrency) && concurrency >= 1 ? concurrency : 1,
    gradeRetries: Number.isInteger(gradeRetries) && gradeRetries >= 0 ? gradeRetries : 0,
  };
}

/**
 * Execute and grade every expected pair with the definition's counterbalanced
 * arm order. Results keep inventory order regardless of concurrency.
 */
export async function runTrials(options: TrialRunOptions): Promise<TrialRunResult> {
  const { captured, hooks, bundles, requestId, attemptId } = options;
  const controls = validateRunControls(options.controls);
  const { concurrency, gradeRetries } = scheduling(captured);
  const schedule = new Map<string, { pairIndex: number; firstSide: Side }>();
  captured.collection?.pairs.forEach((pair, pairIndex) =>
    schedule.set(pairKey(pair.caseId, pair.repetition), { pairIndex, firstSide: pair.firstSide }),
  );
  const caseIds = captured.cases.map((item) => item.caseId as string);
  const selected = selectedCaseIds(controls.selection, caseIds);
  const plan: Array<{ item: (typeof captured.cases)[number]; repetition: number; pairIndex: number }> =
    [];
  for (const item of captured.cases)
    for (let repetition = 0; repetition < (item.repetitions ?? 1); repetition++)
      plan.push({ item, repetition, pairIndex: plan.length });
  const selectedPairs = plan.filter(({ item }) => selected.has(item.caseId)).length;
  const armsPerPair = options.cachedParent ? 1 : 2;
  const totalArms = selectedPairs * armsPerPair;

  // Run-wide stop state. `cancelled` mirrors the original sequential runner:
  // any cancellation, or exhausting private storage, stops every later trial.
  const deadline = new AbortController();
  const fatal = new AbortController();
  let cancelled = false;
  let stopReason: StopReason = 'completed';
  let costUsd: number | null = null;
  let artifactBytes = 0;
  let armsDone = 0;
  let timedOutCallbacks = 0;
  let uncertainArms = 0;
  let gradeRetriesUsed = 0;
  let pairsStarted = 0;
  let comparedPairs = 0;
  let identicalPairs = 0;
  let firstFatal: { error: unknown } | undefined;
  let firstCallbackFailure: FirstCallbackFailure | undefined;
  const started = Date.now();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const callbackSignal = AbortSignal.any([options.signal, deadline.signal, fatal.signal]);
  const halted = () => options.signal.aborted || cancelled || fatal.signal.aborted;
  const haltCode = () =>
    deadline.signal.aborted && !options.signal.aborted && !cancelled
      ? CONTROL_ERRORS.deadline
      : 'cancelled';

  const report = (caseId: string, repetition: number, side: Side, outcome: Outcome) => {
    armsDone++;
    try {
      controls.progress?.({
        completed: Math.min(armsDone, totalArms),
        total: totalArms,
        caseId,
        repetition,
        side,
        outcome: structuredClone(outcome),
        elapsedMs: Date.now() - started,
      });
    } catch {
      /* Progress is advisory; a failing observer must not change trial outcomes. */
    }
  };

  /** Bound one callback by the case timeout and the run deadline. */
  const bounded = async <T>(start: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const local = new AbortController();
    const signal = AbortSignal.any([callbackSignal, local.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onDeadline: (() => void) | undefined;
    const work = Promise.resolve().then(() => start(signal));
    const stops: Promise<never>[] = [];
    if (controls.caseTimeoutMs)
      stops.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            local.abort();
            reject(new Abandoned('timeout'));
          }, controls.caseTimeoutMs);
        }),
      );
    if (controls.deadlineMs)
      stops.push(
        new Promise<never>((_, reject) => {
          onDeadline = () => reject(new Abandoned('deadline'));
          if (deadline.signal.aborted) onDeadline();
          else deadline.signal.addEventListener('abort', onDeadline, { once: true });
        }),
      );
    if (!stops.length) return work;
    try {
      return await Promise.race([work, ...stops]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onDeadline) deadline.signal.removeEventListener('abort', onDeadline);
      // An abandoned callback may settle later. Its result is ignored.
      work.catch(() => undefined);
    }
  };

  const outputDigests = new Map<string, string>();
  const runArm = async (
    item: (typeof captured.cases)[number],
    repetition: number,
    side: Side,
    pairIndex: number,
    armIndex: number,
    firstSide: Side,
  ): Promise<Outcome> => {
    const attempts = options.retryMissingTrial ? 2 : 1;
    let result = unavailable();
    const noteFailure = (
      stage: FirstCallbackFailure['stage'],
      reason: FirstCallbackFailure['reason'],
      file?: string | void,
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
    const recordOutputError = async (directory: string, error: OutputValidationError) =>
      noteFailure('execute', 'output_invalid', await hooks.recordOutputError(directory, error));
    let armArtifacts: TrialArtifact[] = [];
    for (let retry = 0; retry < attempts; retry++) {
      if (halted() || deadline.signal.aborted) {
        result = unavailable(haltCode());
        break;
      }
      if (retry && armArtifacts.length) {
        await hooks.discardArtifacts(armArtifacts);
        armArtifacts = [];
      }
      await hooks.checkpoint();
      const bundle = bundles[side === 'parent' ? 0 : 1];
      const jobId = createHash('sha256')
        .update(
          JSON.stringify([
            requestId,
            attemptId,
            side,
            bundle.version.id,
            item.caseId,
            repetition,
            ...(retry ? [retry] : []),
          ]),
        )
        .digest('hex');
      const privateJobDirectory = path.join(options.jobsRoot, jobId);
      await privateDirectory(privateJobDirectory);
      const context = {
        requestId,
        attemptId,
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
      hooks.assertOwned();
      if (halted() || deadline.signal.aborted) {
        result = unavailable(haltCode());
        continue;
      }
      let execution;
      try {
        hooks.onCallbackStarted();
        execution = await bounded((signal) =>
          captured.execute({
            bundle: structuredClone(bundle),
            caseId: item.caseId,
            repetition,
            input: structuredClone(item.input),
            signal,
            context: Object.freeze(context),
          }),
        );
        hooks.assertOwned();
      } catch (error) {
        if (error instanceof ExecutionUncertainError) {
          // The application kept this job's work quarantined in its own private job
          // directory. Record the arm as uncertain, never retry it while the earlier
          // attempt may still run, and continue with the remaining pairs. This applies
          // to live and local runs alike; uncertainty from grade still stops the run.
          hooks.assertOwned();
          const marker = path.join(privateJobDirectory, 'uncertain.json');
          await atomicPrivateWrite(
            marker,
            JSON.stringify({ schemaVersion: 1, jobId, side, caseId: item.caseId, repetition }) + '\n',
          );
          noteFailure(
            'execute',
            'execution_uncertain',
            options.captureCallbackErrors
              ? await hooks.saveCallbackError(privateJobDirectory, 'execute', error)
              : marker,
          );
          uncertainArms++;
          result = unavailable('execution_uncertain');
          break;
        }
        if (hooks.isFatal(error)) throw error;
        if (error instanceof Abandoned) {
          if (error.reason === 'timeout') timedOutCallbacks++;
          result = unavailable(error.reason === 'timeout' ? CONTROL_ERRORS.timeout : CONTROL_ERRORS.deadline);
          continue;
        }
        if (error instanceof CallbackCancelled) {
          cancelled = true;
          result = unavailable();
          continue;
        }
        if (error instanceof OutputValidationError) {
          await recordOutputError(privateJobDirectory, error);
          result = unavailable('output_invalid');
          continue;
        }
        noteFailure(
          'execute',
          error instanceof TaskExecutionError ? 'task_failed' : 'execution_failed',
          options.captureCallbackErrors
            ? await hooks.saveCallbackError(privateJobDirectory, 'execute', error)
            : undefined,
        );
        result =
          error instanceof TaskExecutionError
            ? { ...unavailable('task_failed'), executionStatus: 'task_failed' }
            : unavailable('execution_failed');
        continue;
      }
      let entry: TrialArtifact;
      let capturedOutput: unknown;
      let capturedExecutionStatus: 'completed' | 'task_failed' = 'completed';
      let capturedReference: unknown;
      let capturedUsage: Outcome['usage'] = null;
      try {
        const returnedOutput = execution.output;
        assertEvaluationOutput(returnedOutput);
        capturedOutput = structuredClone(returnedOutput);
        const returnedStatus = execution.executionStatus;
        if (!['completed', 'task_failed', undefined].includes(returnedStatus)) throw new Error();
        capturedExecutionStatus = returnedStatus ?? 'completed';
        capturedReference = execution.outputRef;
        capturedUsage = reportedUsage(execution.usage);
        if (artifactBytes + Buffer.byteLength(JSON.stringify(capturedOutput)) + 16 * 1024 > MAX_PRIVATE) {
          cancelled = true;
          throw new Error();
        }
        entry = await hooks.writeArtifact(
          {
            requestId,
            attemptId,
            caseId: item.caseId,
            repetition,
            side,
            versionId: bundle.version.id,
            digest: bundle.version.digest,
            role: 'output',
          },
          capturedOutput,
        );
        armArtifacts.push(entry);
        artifactBytes += entry.bytes;
      } catch (error) {
        if (error instanceof OutputValidationError) await recordOutputError(privateJobDirectory, error);
        result = unavailable('output_invalid');
        continue;
      }
      if (typeof capturedUsage?.costUsd === 'number') costUsd = (costUsd ?? 0) + capturedUsage.costUsd;
      outputDigests.set(
        JSON.stringify([item.caseId, repetition, side]),
        createHash('sha256').update(canonicalEvaluationJson(capturedOutput)).digest('hex'),
      );
      const reference = capturedReference ?? `acclimate:artifact:${entry.sha256}`;
      if (
        typeof reference !== 'string' ||
        Buffer.byteLength(reference) > 1024 ||
        /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(reference)
      ) {
        result = unavailable('output_reference_invalid');
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
      const stoppedBeforeGrade = () =>
        halted() || deadline.signal.aborted
          ? { ...outcome, error: haltCode() === 'cancelled' ? 'cancelled' : CONTROL_ERRORS.deadline }
          : undefined;
      if (stoppedBeforeGrade()) {
        result = stoppedBeforeGrade()!;
        continue;
      }
      await hooks.checkpoint();
      hooks.assertOwned();
      if (stoppedBeforeGrade()) {
        result = stoppedBeforeGrade()!;
        continue;
      }
      let graded = false;
      for (let gradeAttempt = 0; gradeAttempt <= gradeRetries; gradeAttempt++) {
        if (gradeAttempt) {
          if (stoppedBeforeGrade()) break;
          gradeRetriesUsed++;
        }
        let gradeReturned = false;
        try {
          const grade = await bounded((signal) =>
            captured.grade({
              output: structuredClone(capturedOutput),
              expected: structuredClone(item.expected),
              caseId: item.caseId,
              repetition,
              signal,
            }),
          );
          gradeReturned = true;
          hooks.assertOwned();
          const reward = grade.reward;
          if (typeof reward !== 'number' || !Number.isFinite(reward)) throw new Error();
          const returnedExplanation = grade.explanation;
          if (returnedExplanation !== undefined) {
            assertJson(returnedExplanation, MAX_ARTIFACT);
            const capturedExplanation = structuredClone(returnedExplanation);
            if (
              artifactBytes + Buffer.byteLength(JSON.stringify(capturedExplanation)) + 16 * 1024 >
              MAX_PRIVATE
            ) {
              cancelled = true;
              throw new Error();
            }
            const explanation = await hooks.writeArtifact(
              {
                requestId,
                attemptId,
                caseId: item.caseId,
                repetition,
                side,
                versionId: bundle.version.id,
                digest: bundle.version.digest,
                role: 'grader-explanation',
              },
              capturedExplanation,
            );
            armArtifacts.push(explanation);
            artifactBytes += explanation.bytes;
          }
          result = { ...outcome, gradingStatus: 'scored', reward };
          graded = true;
          break;
        } catch (error) {
          if (hooks.isFatal(error)) throw error;
          if (error instanceof Abandoned) {
            if (error.reason === 'timeout') timedOutCallbacks++;
            result = {
              ...outcome,
              gradingStatus: 'failed',
              error: error.reason === 'timeout' ? CONTROL_ERRORS.timeout : CONTROL_ERRORS.deadline,
            };
            if (error.reason === 'deadline') break;
            continue;
          }
          if (error instanceof CallbackCancelled) cancelled = true;
          else
            noteFailure(
              'grade',
              'grading_failed',
              !gradeReturned && options.captureCallbackErrors
                ? await hooks.saveCallbackError(privateJobDirectory, 'grade', error)
                : undefined,
            );
          result = {
            ...outcome,
            gradingStatus: 'failed',
            error: error instanceof CallbackCancelled ? 'cancelled' : 'grading_failed',
          };
          if (error instanceof CallbackCancelled) break;
        }
      }
      if (graded) break;
    }
    return result;
  };

  const runPair = async (index: number): Promise<CasePair> => {
    const { item, repetition, pairIndex } = plan[index];
    const key = pairKey(item.caseId, repetition);
    const cached = options.cachedParent?.get(key);
    const pair: CasePair = {
      caseId: item.caseId,
      repetition,
      parent: cached ?? unavailable(),
      candidate: unavailable(),
    };
    if (!selected.has(item.caseId)) {
      if (!cached) pair.parent = unavailable(CONTROL_ERRORS.notSelected);
      pair.candidate = unavailable(CONTROL_ERRORS.notSelected);
      return pair;
    }
    const stop =
      halted() || deadline.signal.aborted
        ? haltCode()
        : controls.maxCostUsd !== undefined && (costUsd ?? 0) >= controls.maxCostUsd
          ? CONTROL_ERRORS.costLimit
          : undefined;
    if (stop) {
      if (stop === CONTROL_ERRORS.costLimit && stopReason === 'completed') stopReason = 'cost_limit';
      for (const side of ['parent', 'candidate'] as const)
        if (!(cached && side === 'parent')) {
          pair[side] = unavailable(stop);
          report(item.caseId, repetition, side, pair[side]);
        }
      return pair;
    }
    pairsStarted++;
    const scheduled = schedule.get(key);
    const firstSide = scheduled?.firstSide ?? 'parent';
    const order = firstSide === 'parent' ? (['parent', 'candidate'] as const) : (['candidate', 'parent'] as const);
    for (const [armIndex, side] of order.entries()) {
      if (cached && side === 'parent') continue;
      pair[side] = await runArm(item, repetition, side, scheduled?.pairIndex ?? pairIndex, armIndex, firstSide);
      report(item.caseId, repetition, side, pair[side]);
    }
    const parentDigest = outputDigests.get(JSON.stringify([item.caseId, repetition, 'parent']));
    const candidateDigest = outputDigests.get(JSON.stringify([item.caseId, repetition, 'candidate']));
    if (parentDigest && candidateDigest) {
      comparedPairs++;
      if (parentDigest === candidateDigest) identicalPairs++;
    }
    return pair;
  };

  const results: CasePair[] = new Array(plan.length);
  let next = 0;
  const worker = async () => {
    while (!firstFatal) {
      const index = next++;
      if (index >= plan.length) return;
      try {
        results[index] = await runPair(index);
      } catch (error) {
        firstFatal ??= { error };
        fatal.abort();
        return;
      }
    }
  };
  if (controls.deadlineMs)
    deadlineTimer = setTimeout(() => {
      if (stopReason === 'completed') stopReason = 'deadline';
      deadline.abort();
    }, controls.deadlineMs);
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, plan.length)) }, worker));
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
  if (firstFatal) throw firstFatal.error;
  if (stopReason === 'completed' && (options.signal.aborted || cancelled)) stopReason = 'cancelled';
  const notSelected = plan.length - selectedPairs;
  const selection = controls.selection
    ? { ...controls.selection, selectedPairs, totalPairs: plan.length }
    : null;
  return {
    results,
    ...(firstCallbackFailure ? { firstCallbackFailure } : {}),
    summary: {
      schemaVersion: 1,
      stopReason,
      partial: stopReason !== 'completed' || notSelected > 0,
      concurrency,
      gradeRetries,
      selection,
      pairs: { expected: plan.length, selected: selectedPairs, started: pairsStarted, notSelected },
      costUsd,
      maxCostUsd: controls.maxCostUsd ?? null,
      deadlineMs: controls.deadlineMs ?? null,
      caseTimeoutMs: controls.caseTimeoutMs ?? null,
      timedOutCallbacks,
      uncertainArms,
      gradeRetriesUsed,
      outputs: { comparedPairs, identicalPairs },
    },
  };
}
