import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

for (const script of ['dev-console.ts', 'console-bridge.ts', 'compose-config.ts']) {
  test(`${script} is a retired alias and preserves existing private input`, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'acclimate-retired-start-')));
    const state = join(directory, 'state.json');
    const sentinel = 'private-fixture-sentinel-do-not-print';
    try {
      await writeFile(state, sentinel, { mode: 0o600 });
      const result = spawnSync(process.execPath,
        ['--import', import.meta.resolve('tsx'), resolve(import.meta.dirname, script), '--state-root', directory, '--example'],
        { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /retired.*production identity/);
      assert.ok(!`${result.stderr}${result.stdout}`.includes(sentinel));
      assert.equal(await readFile(state, 'utf8'), sentinel);
      assert.deepEqual(await readdir(directory), ['state.json']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
