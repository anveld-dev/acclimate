import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { archiveStarters } from './starter-artifacts.mjs';
const inventories = JSON.parse(await readFile(new URL('./starter-files.json', import.meta.url), 'utf8'));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'acclimate-starter-archive-test-'));
  for (const [name, files] of Object.entries(inventories)) {
    for (const file of files) {
      const path = join(root, 'examples', name.endsWith('evaluation') ? `${name}-starter` : name, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file === 'package.json' ? '{}' : 'Public fixture\n');
    }
  }
  await writeFile(join(root, 'examples/evaluation-starter/package.json'), JSON.stringify({ private: true, version: '0.0.0', dependencies: { '@acclimate/sdk': '0.0.0' } }));
  const metadata = { version: '1.2.3', starters: ['evaluation', 'native-repository', 'python-evaluation'].map(name => ({ name, file: `acclimate-${name}-starter-1.2.3.tgz` })) };
  return { root, metadata, output: join(root, 'release') };
}

test('release archives contain installed-app source and native harnesses, excluding caches', async () => {
  const { root, metadata, output } = await fixture();
  try {
    await mkdir(join(root, 'examples/evaluation-starter/node_modules'), { recursive: true });
    await writeFile(join(root, 'examples/evaluation-starter/node_modules/private-cache.txt'), 'not distributable');
    await mkdir(join(root, 'examples/native-repository/test/fixture'), { recursive: true });
    await writeFile(join(root, 'examples/native-repository/test/fixture/input.txt'), 'test repository');
    await writeFile(join(root, 'examples/native-repository/QUALIFICATION.md'), 'internal evidence');
    const artifacts = await archiveStarters(root, output, metadata);
    assert.equal(artifacts.length, 3);
    const archive = join(output, metadata.starters[0].file);
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.ok(listing.includes('evaluation-starter/acclimate-eval.mjs'));
    const native = execFileSync('tar', ['-tzf', join(output, metadata.starters[1].file)], { encoding: 'utf8' });
    assert.ok(!native.includes('/test/'));
    assert.ok(!native.includes('QUALIFICATION.md'));
    // The offline replay harness and its fixture repository ship for consumers.
    for (const file of ['smoke.mjs', 'native.replay.json', 'fixture/replay.json', 'fixture/tests/retry.test.mjs', 'harness-template.mjs'])
      assert.ok(native.includes(`native-repository-starter/${file}`), file);
    const python = execFileSync('tar', ['-tzf', join(output, metadata.starters[2].file)], { encoding: 'utf8' });
    assert.ok(python.includes('python-evaluation-starter/acclimate_eval.py'));
    assert.ok(python.includes('python-evaluation-starter/application.example.py'));
    assert.ok(!/package\.json|\.m[jt]s\b/.test(python), 'the Python starter carries no Node files');
    assert.equal(listing.includes('node_modules'), false);
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'evaluation-starter/package.json'], { encoding: 'utf8' }));
    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.dependencies['@acclimate/sdk'], '1.2.3');
    assert.equal(JSON.parse(await readFile(join(root, 'examples/evaluation-starter/package.json'), 'utf8')).version, '0.0.0');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unlisted files cannot silently ship private local state', async () => {
  const { root, metadata, output } = await fixture();
  try {
    await writeFile(join(root, 'examples/evaluation-starter/provider-credentials.json'), 'secret-canary');
    await assert.rejects(archiveStarters(root, output, metadata), /Unreviewed file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('starter bytes are reproducible across source timestamps and output locations', async () => {
  const { root, metadata, output } = await fixture();
  try {
    await archiveStarters(root, output, metadata);
    await utimes(join(root, 'examples/evaluation-starter/acclimate-eval.mjs'), 123456789, 123456789);
    const other = join(root, 'other-release');
    await archiveStarters(root, other, metadata);
    for (const starter of metadata.starters)
      assert.deepEqual(await readFile(join(output, starter.file)), await readFile(join(other, starter.file)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a symlink cannot pull external state into a release starter', async () => {
  const { root, metadata, output } = await fixture();
  try {
    await writeFile(join(root, 'private-token.txt'), 'secret-canary');
    await symlink(join(root, 'private-token.txt'), join(root, 'examples/evaluation-starter/linked.txt'));
    await assert.rejects(archiveStarters(root, output, metadata), /unsupported filesystem entry/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const name of ['.env', 'evaluator.json', 'ownership.lock', 'signing.key', 'ci-intent.json.origin.json', 'handoff.json']) {
  test(`private state ${name} makes the archive fail closed`, async () => {
    const { root, metadata, output } = await fixture();
    try {
      await writeFile(join(root, 'examples/evaluation-starter', name), 'secret-canary');
      await assert.rejects(archiveStarters(root, output, metadata), /Private configuration or state/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('an artifact filename cannot escape the release directory', async () => {
  const { root, metadata, output } = await fixture();
  try {
    metadata.starters[0].file = '../escape.tgz';
    await assert.rejects(archiveStarters(root, output, metadata), /Invalid starter artifact identity/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

