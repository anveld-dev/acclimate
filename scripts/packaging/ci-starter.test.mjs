import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const language of ['javascript', 'python']) {
  for (const [statuses, expected, commands] of [
    [{}, 0, 'doctor request run check export verify-export'],
    [{ export: 1 }, 1, 'doctor request run check export'],
    [{ 'verify-export': 3 }, 3, 'doctor request run check export verify-export'],
    [{ run: 3, export: 1 }, 3, 'doctor request run export'],
    [{ check: 2, export: 1 }, 2, 'doctor request run check export'],
    [{ run: 2, 'verify-export': 1 }, 2, 'doctor request run export verify-export'],
    [{ request: 3 }, 3, 'doctor request'],
  ]) {
    test(`CI ${language} preserves category ${expected} for ${JSON.stringify(statuses)}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'acclimate-ci-test-'));
      try {
        await copyFile(new URL('../../examples/ci/ci.sh', import.meta.url), join(root, 'ci.sh'));
        const bin = join(root, 'bin');
        await mkdir(bin);
        const executable = join(bin, 'node');
        await writeFile(executable, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst command=process.argv[3];\nappendFileSync(process.env.CI_COMMAND_LOG,command+'\\n');\nprocess.exit(JSON.parse(process.env.CI_STATUSES)[command]??0);\n`);
        await chmod(executable, 0o755);
        const result = spawnSync('sh', [join(root, 'ci.sh'), '--language', language,
          '--config', join(root, 'config.json'), '--bundle', 'fixture-bundle',
          '--intent', join(root, 'intent.json'), '--output-dir', join(root, 'results')], {
          env: { PATH: `${bin}:/usr/bin:/bin`, ACCLIMATE_CI_PYTHON: executable,
            CI_COMMAND_LOG: join(root, 'commands'), CI_STATUSES: JSON.stringify(statuses) },
          encoding: 'utf8',
        });
        assert.equal(result.status, expected, result.stderr);
        assert.equal((await readFile(join(root, 'commands'), 'utf8')).trim().split('\n').join(' '), commands);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}

test('CI missing flag value exits with a bounded diagnostic', () => {
  const result = spawnSync('sh', [new URL('../../examples/ci/ci.sh', import.meta.url).pathname, '--config'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'CI starter arguments require values');
});
