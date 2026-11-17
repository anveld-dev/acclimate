import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const values = {};
let skipBuild = false;
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--skip-build' && !skipBuild) { skipBuild = true; continue; }
  if (!['--pg-bin', '--python', '--release', '--output'].includes(argument) || values[argument] || !process.argv[index + 1])
    throw new Error('Usage: qualify-dx.mjs --pg-bin /postgres/bin [--python /python3.11] [--release /verified/release] [--output /new/report.json] [--skip-build]');
  values[argument] = process.argv[++index];
}
if (!values['--pg-bin']) throw new Error('--pg-bin is required; an existing DATABASE_URL is never used.');
const python = values['--python'] ?? process.env.ACCLIMATE_PACKAGE_PYTHON ?? 'python3.11';
const temp = await realpath(await mkdtemp(join(tmpdir(), 'acclimate-dx-qualification-')));
const run = (command, args) => execFileSync(command, args, {
  cwd: root, stdio: 'inherit', env: { ...process.env, ACCLIMATE_PACKAGE_PYTHON: python },
});
try {
  if (!skipBuild) {
    run('npm', ['run', 'build:packages']);
    run('cargo', ['build', '--bin', 'acclimate-service']);
  }
  const release = values['--release'] ? resolve(values['--release']) : join(temp, 'release');
  if (!values['--release'])
    run(process.execPath, ['scripts/packaging/verify.mjs', '--skip-build', '--output', release]);
  const args = ['scripts/packaging/qualify_dx.py', '--pg-bin', resolve(values['--pg-bin']), '--release', release];
  if (values['--output']) args.push('--output', resolve(values['--output']));
  run(python, args);
} finally {
  await rm(temp, { recursive: true, force: true });
}
