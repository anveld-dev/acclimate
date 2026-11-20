// Harness adapters for process-group tests. They run in the harness child process.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

async function edit(context) {
  await writeFile(path.join(context.cwd, 'src/retry.js'), 'export const key = "partial";\n');
  await writeFile(path.join(context.cwd, 'added.txt'), 'partial\n');
}

export async function hangIgnoringAbort({ context, policy, progress, acknowledge }) {
  await acknowledge({ kind: 'fake-session', value: 'hang' });
  await edit(context);
  // A grandchild in the same process group must die with the harness.
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  await writeFile(policy.pidFile, String(sleeper.pid));
  progress('partial answer');
  await new Promise(() => {});
}

export async function crash({ context }) {
  await edit(context);
  process.exit(9);
}

export async function providerFailure({ context }) {
  await edit(context);
  throw Object.assign(new Error('upstream 500 for key sk-test-1234567890abcdef; Authorization: Bearer abcdefghijklmnop'), { code: 'fake.provider' });
}

export async function complete({ context }) {
  await edit(context);
  return { stopped: true, output: 'done', usage: { inputTokens: 3, outputTokens: 1 } };
}

export async function unconfirmed() {
  return { stopped: false, output: 'adapter lost track of its job' };
}
