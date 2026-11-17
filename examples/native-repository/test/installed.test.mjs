import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
for (const harness of ['codex', 'claude', 'pi', 'cursor']) {
  test(`installed ${harness} preparation completes repository fixture without a provider`, async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'native-installed-')));
    try {
      const { stdout } = await run(process.execPath, [
        fileURLToPath(new URL('../demo.mjs', import.meta.url)),
        '--state-root',
        path.join(parent, 'run'),
        '--harness',
        harness,
      ]);
      const result = JSON.parse(stdout);
      assert.equal(result.harness, harness);
      assert.equal(result.retainedPatch, true);
      assert.equal(result.cleaned, true);
      assert.equal(result.evidence, 'deterministic-wiring-only');
      assert.match(result.sourceManifestSha256, /^[a-f0-9]{64}$/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
}
