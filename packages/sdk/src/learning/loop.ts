import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveAndCache, DeliveryError } from '../cache.js';
import { ApiError } from '../client.js';
import { readEvaluatorConfig } from '../evaluation/config.js';
import { EvaluationError, toSafeDiagnostic, type SafeDiagnostic } from '../evaluation/errors.js';
import {
  atomicPrivateWrite,
  privateDirectory,
  readPrivateJson,
} from '../evaluation/private-state.js';
import { acquireFileLock } from '../evaluation/journal.js';
import { redactDiagnosticText } from '../evaluation/runner.js';
import { withVersionHelpers } from '../evaluation/definition.js';
import { InfrastructureError } from '../compare.js';
import type { EvaluatorConfig, ExecuteInput, GradeInput, Json } from '../evaluation/types.js';
import { createEvaluatorClient } from '../internal/evaluation-transport.js';
import type {
  LearningEvaluationReportRequest,
  LearningEvolveCase,
  LearningRollout,
  LearningWorkItem,
  VerifiedVersion,
} from '../types.js';
import { TranscriptError } from './trace.js';
import { heldOutDigest } from './held-out.js';
import { caseIdPattern, uuidPattern } from './outcomes.js';

export interface LearningLoopApp<I = Json, E = Json, O = Json> {
  execution: 'live' | 'model-free';
  heldOut: readonly LearningEvolveCase<I, E>[];
  execute(
    input: Omit<ExecuteInput<I>, 'context' | 'repetition'> & { rollout: number },
  ): { output: O; trace?: string } | Promise<{ output: O; trace?: string }>;
  grade(
    input: Omit<GradeInput<E, O>, 'repetition'> & { rollout: number },
  ): { score: number; passed: boolean } | Promise<{ score: number; passed: boolean }>;
}

export type LearningLoopOptions<I = Json, E = Json, O = Json> = (
  | { configPath: string; config?: never }
  | { config: EvaluatorConfig; configPath?: never }
) & {
  bundleId: string;
  app: LearningLoopApp<I, E, O>;
  allowLive?: boolean;
  /** Maximum cases concurrently in flight within one evaluation. Defaults to 1. */
  caseConcurrency?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  shouldServeRound?: (roundId: string) => boolean;
  onDiagnostic?: (diagnostic: SafeDiagnostic) => void;
};

export function captureLearningApp<I, E, O>(app: LearningLoopApp<I, E, O>) {
  try {
    const { execution, execute, grade } = app;
    if (
      (execution !== 'live' && execution !== 'model-free') ||
      typeof execute !== 'function' ||
      typeof grade !== 'function' ||
      !Array.isArray(app.heldOut) ||
      app.heldOut.length > 10_000 ||
      Object.keys(app.heldOut).length !== app.heldOut.length ||
      app.heldOut.some(
        (item) => !item || typeof item.caseId !== 'string' || !caseIdPattern.test(item.caseId),
      ) ||
      new Set(app.heldOut.map(({ caseId }) => caseId)).size !== app.heldOut.length
    )
      throw new Error();
    const cases = structuredClone(app.heldOut);
    return {
      execution,
      execute: execute.bind(app),
      grade: grade.bind(app),
      cases,
      digest: heldOutDigest(cases),
    };
  } catch {
    throw new EvaluationError('learning.apps_invalid_export');
  }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const save = (filename: string, value: object) =>
  atomicPrivateWrite(filename, JSON.stringify(value) + '\n');
const exists = (filename: string) =>
  lstat(filename).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );

function utf8Prefix(text: Buffer, limit: number) {
  let end = Math.min(text.length, limit);
  while (end < text.length && (text[end] & 0xc0) === 0x80) end--;
  return text.subarray(0, end).toString();
}
function traceExcerpt(value: string, token: string): string {
  const bytes = Buffer.from(value.split(token).join('[redacted]'));
  if (bytes.length <= 16 * 1024) return bytes.toString();
  const first = utf8Prefix(bytes, 8000);
  let lastStart = bytes.length - 8000;
  while ((bytes[lastStart] & 0xc0) === 0x80) lastStart++;
  const omitted = lastStart - Buffer.byteLength(first);
  return first + `\n[… ${omitted} bytes omitted …]\n` + bytes.subarray(lastStart).toString();
}
function reportKey(attemptId: string, body: LearningEvaluationReportRequest): string {
  const key = attemptId + ':' + (body.cases?.[0].caseId ?? 'error');
  // The HTTP key limit is shorter than the largest legal case ID plus the attempt ID.
  return key.length > 128 || body.cases?.[0].caseId === 'error' ? hash('case:' + key) : key;
}

function failure(heldOut: boolean, error: string): LearningRollout {
  return heldOut ? { score: 0, passed: false } : { score: 0, passed: false, trace: null, error };
}

async function runRollout<I, E, O>(
  app: Pick<LearningLoopApp<I, E, O>, 'execute' | 'grade'>,
  version: VerifiedVersion,
  item: LearningEvolveCase<I, E>,
  rollout: number,
  heldOut: boolean,
  signal: AbortSignal,
  token: string,
): Promise<LearningRollout> {
  const { caseId, input, expected } = item;
  let stage = 'execution';
  try {
    const run = await retryInfrastructureOnce(() => {
      signal.throwIfAborted();
      return app.execute(
        withVersionHelpers({
          version: structuredClone(version),
          caseId,
          rollout,
          input: structuredClone(input),
          signal,
        }),
      );
    });
    signal.throwIfAborted();
    stage = 'grading';
    const { score, passed } = await app.grade({
      output: run.output,
      expected: structuredClone(expected),
      caseId,
      rollout,
      signal,
    });
    if (!Number.isFinite(score) || score < 0 || score > 1 || typeof passed !== 'boolean')
      throw new Error('Return a finite score between 0 and 1 and a boolean passed value.');
    if (heldOut) return { score, passed };
    return {
      score,
      passed,
      trace: typeof run.trace === 'string' ? traceExcerpt(run.trace, token) : null,
      error: null,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (heldOut) return failure(true, '');
    const message = error instanceof Error ? error.message : '';
    const text = redactDiagnosticText(`${stage}.failed ${message.split(token).join('[redacted]')}`);
    return {
      ...failure(false, utf8Prefix(Buffer.from(text), 4 * 1024)),
      trace: error instanceof TranscriptError ? traceExcerpt(error.trace, token) : null,
    };
  }
}

export async function serveLearningLoop<I, E, O>(
  options: LearningLoopOptions<I, E, O>,
): Promise<void> {
  const app = captureLearningApp(options.app);
  const {
    caseConcurrency = 1,
    pollIntervalMs = 1000,
    signal = new AbortController().signal,
  } = options;
  const bundleId = options.bundleId.toLowerCase();
  if (app.execution === 'live' && !options.allowLive)
    throw new EvaluationError('usage.conflicting_flags', {
      hint: 'Pass --live to run a live application.',
    });
  if (
    !uuidPattern.test(bundleId) ||
    !Number.isSafeInteger(caseConcurrency) ||
    caseConcurrency < 1 ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > 2_147_483_647
  )
    throw new EvaluationError('usage.invalid_flag');
  const config = options.config ?? await readEvaluatorConfig(options.configPath);
  const { workspaceId, journalRoot, evaluatorToken } = config;
  const client = createEvaluatorClient(config);
  const diagnostic = (error: unknown) => {
    try {
      options.onDiagnostic?.(toSafeDiagnostic(error, 'execute'));
    } catch {
      // Diagnostic observers are advisory.
    }
  };
  await privateDirectory(journalRoot, true);
  const root = path.join(journalRoot, 'learning', bundleId);
  const pause = (current: AbortSignal) => delay(pollIntervalMs, undefined, { signal: current });

  async function serve(item: LearningWorkItem) {
    if (
      !uuidPattern.test(item.evaluationId) ||
      (item.split !== 'evolve' && item.split !== 'heldOut')
    )
      throw new EvaluationError('evidence.malformed');
    const filename = path.join(root, item.evaluationId + '.json');
    const lock = await acquireFileLock(filename + '.lock');
    const stop = new AbortController();
    const current = AbortSignal.any([signal, lock.signal, stop.signal]);
    const assertActive = () => {
      lock.assertOwned();
      current.throwIfAborted();
    };
    let monitor: Promise<void> | undefined;
    try {
      assertActive();
      // Only bind immutable identity. Work status and deadline change on start.
      const identity = hash(
        JSON.stringify([
          config.serviceUrl,
          workspaceId,
          config.evaluatorPrincipalId,
          bundleId,
          item.evaluationId,
          item.versionId,
          item.digest,
          item.split,
          item.evolveRevision,
          item.heldOut?.digest,
          item.heldOut?.cases,
        ]),
      );
      const journal = (await exists(filename))
        ? await readPrivateJson(filename)
        : { attemptId: randomUUID(), identity };
      if (
        typeof journal.attemptId !== 'string' ||
        !uuidPattern.test(journal.attemptId) ||
        journal.identity !== identity
      )
        throw new EvaluationError('journal.invalid');
      const { attemptId } = journal;
      await save(filename, journal);
      assertActive();
      const assignment = await client.startLearningEvaluation(
        workspaceId,
        bundleId,
        item.evaluationId,
        { attemptId },
      );
      const { evaluation, heldOut, reportedCaseIds } = assignment;
      if (evaluation.id !== item.evaluationId) throw new EvaluationError('evidence.malformed');
      if (evaluation.status === 'scored') return;
      if (evaluation.status !== 'running') throw new EvaluationError('evidence.malformed');
      const report = async (body: LearningEvaluationReportRequest) => {
        assertActive();
        await client.reportLearningEvaluation(
          workspaceId,
          bundleId,
          item.evaluationId,
          body,
          reportKey(attemptId, body),
        );
      };
      monitor = (async () => {
        while (!current.aborted) {
          await pause(current);
          try {
            const work = await client.getLearningWork(workspaceId, bundleId);
            if (
              work.status === 'stopped' ||
              !work.items.some((workItem) => workItem.evaluationId === item.evaluationId)
            )
              stop.abort();
          } catch (error) {
            diagnostic(error);
            if (error instanceof ApiError && [401, 403, 404].includes(error.status)) stop.abort();
          }
        }
      })().catch((error) => {
        if (!current.aborted) {
          diagnostic(error);
          stop.abort();
        }
      });
      if (
        evaluation.versionId !== item.versionId ||
        evaluation.digest !== item.digest ||
        evaluation.split !== item.split ||
        evaluation.roundId !== item.roundId ||
        evaluation.evolveRevision !== item.evolveRevision
      ) {
        await report({ attemptId, error: 'evidence.identity_mismatch' });
        return;
      }
      const privateSplit = item.split === 'heldOut';
      if (
        privateSplit &&
        (!heldOut ||
          !item.heldOut ||
          heldOut.digest !== item.heldOut.digest ||
          heldOut.cases !== item.heldOut.cases ||
          heldOut.digest !== app.digest ||
          heldOut.cases !== app.cases.length)
      ) {
        await report({ attemptId, error: 'learning.held_out_mismatch' });
        diagnostic(new EvaluationError('learning.held_out_mismatch'));
        return;
      }
      let version: VerifiedVersion;
      try {
        version = await resolveAndCache(
          client,
          { workspaceId, bundleId, versionId: item.versionId },
          { cacheDir: path.join(root, 'cache') },
        );
      } catch (error) {
        if (!(error instanceof DeliveryError)) throw error;
        await report({ attemptId, error: 'evidence.identity_mismatch' });
        return;
      }
      if (version.version.digest !== item.digest || version.version.id !== item.versionId) {
        await report({ attemptId, error: 'evidence.identity_mismatch' });
        return;
      }
      const cases = privateSplit
        ? app.cases
        : (assignment.cases as LearningEvolveCase<I, E>[] | null);
      if (
        !Array.isArray(cases) ||
        cases.length !== evaluation.cases ||
        !Array.isArray(reportedCaseIds) ||
        cases.some((item) => !item || !caseIdPattern.test(item.caseId)) ||
        new Set(cases.map(({ caseId }) => caseId)).size !== cases.length
      )
        throw new EvaluationError('evidence.malformed');
      const reported = new Set(reportedCaseIds);
      const pending = cases.filter(({ caseId }) => !reported.has(caseId));
      const trialsRoot = path.join(root, item.evaluationId);
      await privateDirectory(trialsRoot);
      let nextCase = 0;
      let reportTail = Promise.resolve();
      const workers = Array.from(
        { length: Math.min(caseConcurrency, pending.length) },
        async () => {
          try {
            while (!current.aborted && nextCase < pending.length) {
              const testCase = pending[nextCase++];
              const rollouts: LearningRollout[] = [];
              for (let rollout = 0; rollout < 5; rollout++) {
                assertActive();
                const trial = path.join(
                  trialsRoot,
                  hash(JSON.stringify([attemptId, testCase.caseId, rollout])) + '.json',
                );
                let result: LearningRollout;
                if (await exists(trial)) {
                  const saved = await readPrivateJson(trial);
                  if (saved.state === 'started') {
                    result = failure(privateSplit, 'execution.uncertain');
                    await save(trial, { state: 'complete', result });
                  } else {
                    const value = saved.result as LearningRollout | undefined;
                    if (
                      saved.state !== 'complete' ||
                      !value ||
                      typeof value.score !== 'number' ||
                      !Number.isFinite(value.score) ||
                      value.score < 0 ||
                      value.score > 1 ||
                      typeof value.passed !== 'boolean'
                    )
                      throw new EvaluationError('journal.invalid');
                    result = privateSplit ? { score: value.score, passed: value.passed } : value;
                  }
                } else {
                  await save(trial, { state: 'started' });
                  assertActive();
                  result = await runRollout(
                    app,
                    version,
                    testCase,
                    rollout,
                    privateSplit,
                    current,
                    evaluatorToken,
                  );
                  assertActive();
                  await save(trial, { state: 'complete', result });
                }
                rollouts.push(result);
              }
              reportTail = reportTail.then(() =>
                report({ attemptId, cases: [{ caseId: testCase.caseId, rollouts }] }),
              );
              await reportTail;
            }
          } catch (error) {
            if (!current.aborted) {
              diagnostic(error);
              stop.abort();
            }
          }
        },
      );
      await Promise.all(workers);
    } finally {
      stop.abort();
      await monitor;
      await lock.close();
    }
  }

  while (!signal.aborted) {
    try {
      const work = await client.getLearningWork(workspaceId, bundleId);
      if (work.bundleId.toLowerCase() !== bundleId)
        throw new EvaluationError('evidence.identity_mismatch');
      if (work.status !== 'stopped') {
        for (const item of work.items) {
          if (signal.aborted) break;
          if (options.shouldServeRound && !options.shouldServeRound(item.roundId)) continue;
          try {
            await serve(item);
          } catch (error) {
            if (!signal.aborted) diagnostic(error);
          }
        }
      }
    } catch (error) {
      if (!signal.aborted) diagnostic(error);
    }
    try {
      await pause(signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

async function retryInfrastructureOnce<T>(execute: () => T | Promise<T>): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    if (!(error instanceof InfrastructureError)) throw error;
    return execute();
  }
}
