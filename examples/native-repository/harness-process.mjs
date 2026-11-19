import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { processGroupAlive } from './repository-job.mjs';

const CHILD = fileURLToPath(new URL('./harness-child.mjs', import.meta.url));
const STDERR_TAIL_BYTES = 16 * 1024;

function killGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    // ESRCH: gone. EPERM: macOS reports it for a group of exiting processes;
    // groupGone() decides whether termination is confirmed.
    if (!['ESRCH', 'EPERM'].includes(error.code)) throw error;
  }
}

async function groupGone(pgid, waitMs) {
  const deadline = Date.now() + waitMs;
  while (processGroupAlive(pgid)) {
    if (Date.now() > deadline) return false;
    await delay(25);
  }
  return true;
}

/**
 * Run a harness adapter in its own process group and enforce `timeoutMs`.
 *
 * The child imports `module`, calls `exportName` (a function, or an object with a
 * `run` method) with `{ ...task, signal, acknowledge, progress }` and reports the
 * result over IPC. On timeout or cancellation the child is asked to stop, then the
 * whole group (the SDK and every tool process it started) is killed with SIGKILL.
 * Termination counts as confirmed only after the group no longer exists.
 *
 * Results follow the `runRepositoryJob` contract: a confirmed stop after a timeout
 * is `{ stopped: true, reason: 'timeout' }`, an unexpected exit is
 * `{ stopped: true, reason: 'crash' }`, an adapter error is
 * `{ stopped: true, infrastructureFailure: true, error }`, and a group that
 * survives SIGKILL is `{ stopped: false }` (quarantine).
 */
export async function runInProcessGroup({
  module,
  exportName = 'run',
  task,
  env,
  cwd,
  timeoutMs,
  signal,
  acknowledge,
  graceMs = 5_000,
  killWaitMs = 5_000,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
  const child = spawn(process.execPath, [CHILD], {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const pgid = child.pid;
  let stderr = Buffer.alloc(0);
  child.stderr.on('data', (chunk) => {
    stderr = Buffer.concat([stderr, chunk]).subarray(-STDERR_TAIL_BYTES);
  });
  // IPC messages are delivered before 'disconnect', which can follow 'exit'.
  const exited = new Promise((resolve) => child.once('exit', (code, killedBy) => {
    const done = () => setImmediate(() => resolve({ code, killedBy }));
    if (child.connected) child.once('disconnect', done);
    else done();
  }));
  const spawnError = new Promise((resolve) => child.once('error', resolve));
  let stopReason;
  let partial;
  let message;
  let graceTimer;
  const settled = new Promise((resolve) => {
    child.on('message', async (value) => {
      if (value?.type === 'acknowledge') {
        try {
          await acknowledge(value.handle);
          child.send({ type: 'acknowledged', id: value.id });
        } catch (error) {
          child.send({ type: 'acknowledged', id: value.id, error: String(error?.code ?? error?.message ?? error) });
        }
      } else if (value?.type === 'progress') partial = value.output;
      else if (value?.type === 'result' || value?.type === 'error') {
        message = value;
        resolve();
      }
    });
    void exited.then(resolve);
  });
  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    if (child.connected) child.send({ type: 'abort', reason });
    graceTimer = setTimeout(() => killGroup(pgid, 'SIGKILL'), graceMs);
  };
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const onAbort = () => stop('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (!pgid) {
      const error = await spawnError;
      return { stopped: true, infrastructureFailure: true, reason: 'spawn', error: { code: error?.code ?? 'native.spawn_failed', message: String(error?.message ?? error) } };
    }
    try {
      // Record the process group before any harness work starts.
      await acknowledge({ kind: 'process-group', value: String(pgid) });
    } catch (error) {
      killGroup(pgid, 'SIGKILL');
      await exited;
      if (!(await groupGone(pgid, killWaitMs))) return { stopped: false, error: { code: 'native.process_group_alive', message: 'harness process group survived SIGKILL' } };
      throw error;
    }
    if (signal?.aborted) stop('cancelled');
    else child.send({ type: 'run', module, exportName, task });
    await settled;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  // The adapter answered or the child exited: reap every remaining group member.
  if (message) {
    const wait = new AbortController();
    await Promise.race([exited, delay(graceMs, undefined, { signal: wait.signal }).catch(() => {})]);
    wait.abort();
  }
  killGroup(pgid, 'SIGKILL');
  const exit = await exited;
  clearTimeout(graceTimer);
  const confirmed = await groupGone(pgid, killWaitMs);
  const tail = stderr.toString('utf8');
  if (!confirmed)
    return {
      stopped: false,
      output: partial ?? null,
      error: { code: 'native.process_group_alive', message: `process group ${pgid} survived SIGKILL`, stderr: tail },
    };
  const value = message?.type === 'result' ? message.value : undefined;
  if (stopReason === 'cancelled') return { ...value, output: value?.output ?? partial ?? null, stopped: true, cancelled: true };
  if (stopReason === 'timeout')
    return {
      ...value,
      output: value?.output ?? partial ?? null,
      stopped: true,
      executionStatus: 'task_failed',
      reason: 'timeout',
      error: {
        code: 'native.turn_timeout',
        message: `harness stopped after the ${timeoutMs} ms turn timeout` + (message?.type === 'error' ? `: ${message.error.message}` : ''),
        stderr: tail,
      },
    };
  if (message?.type === 'error')
    return {
      stopped: true,
      infrastructureFailure: true,
      reason: 'provider_error',
      output: partial ?? null,
      error: { ...message.error, stderr: tail },
    };
  if (!message || value?.stopped !== true)
    return {
      ...value,
      output: value?.output ?? partial ?? null,
      stopped: true,
      executionStatus: 'task_failed',
      reason: 'crash',
      error: {
        code: 'native.harness_crash',
        message: message
          ? 'adapter could not confirm its own stop; its process group was killed'
          : `harness exited ${exit.killedBy ?? exit.code} without a result`,
        stderr: tail,
      },
    };
  return value;
}
