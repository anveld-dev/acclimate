import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the learning worker diagnoses local module startup failures before reading service configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acclimate-apps-'));
  const sourceTest = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(
    new URL('../../src/learning/serve-cli.' + (sourceTest ? 'ts' : 'js'), import.meta.url),
  );
  const loader = sourceTest ? ['--import', 'tsx'] : [];
  try {
    for (const [body, code, hint] of [
      [null, 'learning.apps_module_missing', 'Point --apps'],
      ["throw new Error('private provider data')", 'learning.apps_module_load_failed', 'imports'],
      ['export const evaluations = {}', 'learning.apps_invalid_export', 'Default-export'],
      [
        'export default { development: {}, audit: [] }',
        'learning.apps_invalid_export',
        'defineEvaluation',
      ],
    ] as const) {
      const apps = join(directory, 'private-provider.mjs');
      if (body !== null) await writeFile(apps, body);
      const result = spawnSync(
        process.execPath,
        [
          ...loader,
          entry,
          '--apps',
          apps,
          '--config',
          join(directory, 'absent.json'),
          '--installation',
          'install',
          '--connection',
          'a7100000-0000-0000-0000-000000000001',
        ],
        { encoding: 'utf8', timeout: 15_000 },
      );
      assert.equal(result.status, 1, result.stderr);
      const line = JSON.parse(result.stderr);
      assert.equal(line.diagnostic.code, code);
      assert.equal(line.diagnostic.executionState, 'not_started');
      assert.equal(line.diagnostic.nextAction, 'fix_config');
      assert.ok(line.hint.includes(hint));
      assert.doesNotMatch(result.stderr, /private-provider|private provider data/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
