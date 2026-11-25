// Template: grade in a container instead of with the host's `node --test`.
//
// Pass it to gradeRepositoryTests in place of nodeTestRunner:
//   import { containerTestRunner } from './container-grader.mjs';
//   runTests: containerTestRunner({
//     image: 'registry.example/app-ci@sha256:...', // pin a digest; it is part of the grader identity
//     command: ['npm', 'test', '--', '--reporter=tap'],
//     timeoutMs: testTimeoutMs,
//   }),
// and record the image digest with each grade so a new image is never mistaken for the old one.
import { spawn } from 'node:child_process';

export function containerTestRunner({ image, command, timeoutMs, engine = 'docker', maxLogBytes = 256 * 1024 }) {
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('container-grader: pin image by @sha256 digest');
  return ({ cwd, signal }) =>
    new Promise((resolve, reject) => {
      const name = `acclimate-grade-${process.pid}-${Date.now()}`;
      const child = spawn(engine, [
        'run', '--rm', '--name', name, '--network', 'none', '--read-only', '--tmpfs', '/tmp',
        '--volume', `${cwd}:/work`, '--workdir', '/work', image, ...command,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      let bytes = 0;
      const collect = (chunk) => {
        if (bytes < maxLogBytes) chunks.push(chunk.subarray(0, maxLogBytes - bytes));
        bytes += chunk.length;
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      let stopped;
      const stop = (why) => {
        stopped ??= why;
        spawn(engine, ['kill', name], { stdio: 'ignore' }).once('error', () => {});
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      signal?.addEventListener('abort', () => stop('aborted'), { once: true });
      child.once('error', reject);
      child.once('close', (status) => {
        clearTimeout(timer);
        if (stopped === 'aborted') return reject(signal.reason);
        const log = Buffer.concat(chunks);
        if (stopped === 'timeout') return resolve({ passed: false, outcome: 'test_timeout', log, truncated: bytes > maxLogBytes });
        resolve({ passed: status === 0, outcome: status === 0 ? 'passed' : 'failed', log, truncated: bytes > maxLogBytes });
      });
    });
}
