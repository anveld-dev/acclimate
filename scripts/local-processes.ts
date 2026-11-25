import type { ChildProcess } from 'node:child_process';

export type LocalServiceRecovery = {
  service: ChildProcess;
  start: () => ChildProcess;
  maxRestarts?: number;
  delayMs?: number;
  stableAfterMs?: number;
  onRestart?: (attempt: number, delayMs: number) => void;
};

/** Supervise the local stack; only the backend's explicit temporary failure is retried. */
export function waitForChildren(
  children: ChildProcess[],
  isStopping: () => boolean,
  stop: () => void,
  recovery?: LocalServiceRecovery,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let service = recovery?.service;
    let startedAt = performance.now();
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listeners = new Map<
      ChildProcess,
      { exit: (code: number | null, signal: NodeJS.Signals | null) => void; error: () => void }
    >();
    const detach = (child: ChildProcess) => {
      const listener = listeners.get(child);
      if (!listener) return;
      child.removeListener('exit', listener.exit);
      child.removeListener('error', listener.error);
      listeners.delete(child);
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const child of listeners.keys()) detach(child);
      stop();
      if (error) reject(error);
      else resolve();
    };
    const attach = (child: ChildProcess) => {
      const exited = (code: number | null, signal: NodeJS.Signals | null) => {
        detach(child);
        if (finished) return;
        if (isStopping()) {
          finish();
          return;
        }
        if (child === service && recovery && code === 75) {
          if (performance.now() - startedAt >= (recovery.stableAfterMs ?? 60_000)) attempts = 0;
          if (attempts < (recovery.maxRestarts ?? 3)) {
            attempts++;
            const wait = Math.min((recovery.delayMs ?? 1_000) * 2 ** (attempts - 1), 30_000);
            recovery.onRestart?.(attempts, wait);
            timer = setTimeout(() => {
              if (finished || isStopping()) {
                finish();
                return;
              }
              try {
                service = recovery.start();
                startedAt = performance.now();
                attach(service);
              } catch {
                finish(new Error('Local backend could not restart. Check the service log.'));
              }
            }, wait);
            return;
          }
          finish(
            new Error('Local backend recovery limit reached. Check PostgreSQL before restarting.'),
          );
          return;
        }
        finish(
          new Error(
            `Local process exited unexpectedly (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}).`,
          ),
        );
      };
      const failed = () =>
        finish(
          isStopping() ? undefined : new Error('Local process could not start. Check the log.'),
        );
      listeners.set(child, { exit: exited, error: failed });
      child.once('exit', exited);
      child.once('error', failed);
      if (child.exitCode !== null || child.signalCode !== null)
        exited(child.exitCode, child.signalCode);
    };
    for (const child of [...children]) {
      if (finished) break;
      attach(child);
    }
  });
}
