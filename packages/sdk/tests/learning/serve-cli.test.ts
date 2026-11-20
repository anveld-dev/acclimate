import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { heldOutDigest } from '../../src/learning/index.js';

const bin = fileURLToPath(new URL('../../src/learning/serve-cli.ts', import.meta.url));
const run = (...args: string[]) =>
  promisify(execFile)(process.execPath, ['--import', 'tsx', bin, ...args]);

test('the learning bin documents startup and prints a local held-out commitment', async (t) => {
  const { stdout: help } = await run('--help');
  assert.match(help, /Default-export \{ execute, grade, heldOut \}/);
  assert.match(help, /--config .* --bundle UUID --app/);
  await assert.rejects(run('--connection', 'removed'), { code: 1 });

  const root = await mkdtemp(join(tmpdir(), 'learning-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = join(root, 'app.mjs');
  const cases = [{ caseId: 'fixture', input: 1, expected: 2 }];
  await writeFile(
    module,
    `export default {
    execution: 'model-free', heldOut: ${JSON.stringify(cases)},
    execute() { throw Error('unexpected execute'); }, grade() { throw Error('unexpected grade'); },
  };`,
  );
  const { stdout } = await run('held-out', '--app', module);
  assert.deepEqual(JSON.parse(stdout), { digest: heldOutDigest(cases), cases: 1 });
  await writeFile(module, 'export const execute = () => 1;');
  await assert.rejects(run('held-out', '--app', module), {
    code: 1,
    stderr: /learning\.apps_invalid_export/,
  });
});
