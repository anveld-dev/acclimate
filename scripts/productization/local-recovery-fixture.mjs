// Real processes and public HTTP; all configuration belongs to a disposable test cluster.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForChildren } from '../local-processes.ts';
const c = JSON.parse(await readFile(process.argv[2], 'utf8'));
const children = new Set();
const start = (command, args, env, cwd = c.root) => {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'inherit'] });
  child.on('error', () => {});
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
};
let stopping = false;
function stop() {
  for (const child of children) child.kill('SIGTERM');
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    stop();
  });
async function ready(url, child) {
  for (let i = 0; i < 150; i++) {
    if (stopping || child.exitCode !== null || child.signalCode !== null)
      throw Error('Fixture process stopped');
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await delay(50);
  }
  throw Error('Fixture readiness timed out');
}
const backend = () => start(c.root + '/target/debug/acclimate-service', [], process.env);
try {
  const service = backend();
  await ready(c.baseUrl + '/ready', service);
  console.log(JSON.stringify({ event: 'ready' }));
  await waitForChildren([service], () => stopping, stop, {
    service,
    start: backend,
    delayMs: 100,
    onRestart: (attempt) => console.log(JSON.stringify({ event: 'restart', attempt })),
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  stop();
}
