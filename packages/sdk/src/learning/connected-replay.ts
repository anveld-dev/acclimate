import { createHash } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { EvaluationError, ExecutionUncertainError } from '../evaluation/errors.js';
import { acquireFileLock } from '../evaluation/journal.js';
import {
  atomicPrivateWrite,
  privateDirectory,
  readPrivateJson,
} from '../evaluation/private-state.js';

export type ReplayExecution = 'live' | 'model-free';

interface ReplayOptions<Verdict extends string> {
  root: string;
  kind: 'learning-rechecks' | 'learning-field-replays' | 'learning-incident-replays';
  identity: readonly string[];
  execution?: ReplayExecution;
  allowLive?: boolean;
  verdicts: readonly Verdict[];
  signal: AbortSignal;
  /** Query fresh service authority after acquiring ownership and just before execution. */
  assigned(): Promise<boolean>;
  execute(signal: AbortSignal): Promise<Verdict>;
}

/** The result outlives HTTP acknowledgements. An unfinished execution requires external reconciliation. */
export async function replayVerdict<Verdict extends string>(
  options: ReplayOptions<Verdict>,
): Promise<Verdict | undefined> {
  const identity = createHash('sha256').update(JSON.stringify(options.identity)).digest('hex');
  const directory = join(options.root, options.kind, identity);
  await privateDirectory(directory);
  const lock = await acquireFileLock(join(directory, 'ownership.lock'));
  try {
    const signal = AbortSignal.any([options.signal, lock.signal]);
    const record = join(directory, 'replay.json');
    const exists = await lstat(record).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (exists) {
      const saved = await readPrivateJson(record, 1024);
      if (saved.identity !== identity) throw new EvaluationError('journal.invalid');
      if (saved.state === 'started') throw new ExecutionUncertainError();
      if (saved.state !== 'completed' || !options.verdicts.includes(saved.verdict as Verdict))
        throw new EvaluationError('journal.invalid');
      return saved.verdict as Verdict;
    }
    // A private replay may use an entirely different executor from either paired app.
    if (
      options.execution !== undefined &&
      options.execution !== 'model-free' &&
      options.execution !== 'live'
    )
      throw new EvaluationError('config.schema');
    if (options.execution !== 'model-free' && options.allowLive !== true)
      throw new EvaluationError('config.schema');
    if (signal.aborted || !(await options.assigned())) return;
    signal.throwIfAborted();
    lock.assertOwned();
    await atomicPrivateWrite(record, JSON.stringify({ identity, state: 'started' }));
    if (signal.aborted) {
      lock.assertOwned();
      await unlink(record);
      signal.throwIfAborted();
    }
    let verdict: Verdict;
    try {
      verdict = await options.execute(signal);
    } catch (error) {
      throw new ExecutionUncertainError({ cause: error });
    }
    if (!options.verdicts.includes(verdict)) throw new EvaluationError('config.schema');
    // A completed callback remains recoverable even when a stop coincides with its return.
    lock.assertOwned();
    await atomicPrivateWrite(record, JSON.stringify({ identity, state: 'completed', verdict }));
    lock.assertOwned();
    return verdict;
  } finally {
    await lock.close();
  }
}
