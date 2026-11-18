import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

async function main() {
  const values = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    if (!['--state-root', '--harness'].includes(name) || values[name] || !process.argv[index + 1])
      throw new Error(
        'Usage: node test/run-fixture.mjs --state-root /absolute/private/new-directory --harness codex|claude|pi|cursor',
      );
    values[name] = process.argv[index + 1];
  }
  const root = values['--state-root'];
  const harness = values['--harness'] ?? 'codex';
  if (!root || !path.isAbsolute(root) || !['codex', 'claude', 'pi', 'cursor'].includes(harness))
    throw new Error('native.invalid_demo_arguments');
  const parent = path.dirname(root);
  if ((await realpath(parent)) !== parent) throw new Error('native.noncanonical_demo_parent');
  await mkdir(root, { mode: 0o700 }); // Refuse an existing run; no journal or artifact reuse.
  for (const child of ['workspaces', 'jobs', 'artifacts'])
    await mkdir(path.join(root, child), { mode: 0o700 });
  const info = await lstat(root);
  if (info.mode & 0o077) throw new Error('native.private_demo_root_required');
  const worker = spawn(
    process.execPath,
    [fileURLToPath(new URL('./worker.mjs', import.meta.url)), root, harness],
    {
      env: { ...process.env, TMPDIR: path.join(root, 'workspaces') },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  worker.once('error', () => {
    process.exitCode = 1;
  });
  worker.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

main().catch(() => {
  console.error(JSON.stringify({ error: { code: 'native.demo_configuration_failed' } }));
  process.exitCode = 1;
});
