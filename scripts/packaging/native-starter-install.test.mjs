import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { archiveStarters } from './starter-artifacts.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const release = process.env.ACCLIMATE_NATIVE_RELEASE_ROOT;
const names = ['sdk', 'codex-plugin', 'claude-plugin', 'pi-plugin', 'cursor-plugin'];

test('native archive establishes a private package boundary without implicit dependencies', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'examples/native-repository/package.json'), 'utf8'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.engines.node, '>=22.22.0');
  assert.equal(manifest.engines.npm, '>=10');
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'workspaces'])
    assert.equal(manifest[field], undefined, `starter must not resolve ${field} implicitly`);
});

for (const nested of [false, true]) {
  test(`offline native tarball installation ${nested ? 'beneath an enclosing npm workspace' : 'in an external directory'}`, { skip: !release && 'set ACCLIMATE_NATIVE_RELEASE_ROOT to an existing checksummed release' }, async () => {
    const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'native-install-boundary-')));
    try {
      const releaseRoot = await realpath(release);
      const metadata = JSON.parse(await readFile(path.join(releaseRoot, 'release-metadata.json'), 'utf8'));
      const sums = await readFile(path.join(releaseRoot, 'SHA256SUMS'), 'utf8');
      const archives = names.map(name => path.join(releaseRoot, metadata.artifacts.find(item => item.package === `@acclimate/${name}`).file));
      for (const archive of archives) {
        const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
        assert.ok(sums.split('\n').some(line => line.trim().split(/\s+/)[0] === digest && line.endsWith(path.basename(archive))), 'archive matches release checksums');
      }
      const enclosing = path.join(scratch, 'enclosing');
      await mkdir(enclosing);
      const parentManifest = JSON.stringify({ name: 'enclosing-private-app', private: true, workspaces: ['packages/*'] }) + '\n';
      const parentLock = '{"enclosing-lock-canary":true}\n';
      await writeFile(path.join(enclosing, 'package.json'), parentManifest);
      await writeFile(path.join(enclosing, 'package-lock.json'), parentLock);
      await mkdir(path.join(enclosing, 'node_modules'));
      await writeFile(path.join(enclosing, 'node_modules/canary'), 'unchanged');
      const destination = nested ? path.join(enclosing, 'packages') : path.join(scratch, 'external');
      const output = path.join(scratch, 'archives');
      const [{ file, directory }] = await archiveStarters(root, output, { version: metadata.version, starters: [{ name: 'native-repository', file: `acclimate-native-repository-starter-${metadata.version}.tgz` }] });
      await mkdir(destination, { recursive: true });
      await run('tar', ['-xzf', path.join(output, file), '-C', destination]);
      const app = path.join(destination, directory);
      assert.equal(JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8')).version, metadata.version);
      await run('npm', ['install', '--prefix', app, '--workspaces=false', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...archives], { cwd: nested ? enclosing : scratch, timeout: 90_000 });
      const { stdout } = await run(process.execPath, [path.join(app, 'verify-install.mjs'), '--all'], { cwd: enclosing });
      const imports = JSON.parse(stdout);
      assert.equal(imports.length, 5);
      for (const item of imports) {
        assert.equal(item.version, metadata.version);
        assert.ok(item.entrypoint.startsWith('node_modules/'));
      }
      assert.equal(await readFile(path.join(enclosing, 'package.json'), 'utf8'), parentManifest);
      assert.equal(await readFile(path.join(enclosing, 'package-lock.json'), 'utf8'), parentLock);
      assert.deepEqual(await readdir(path.join(enclosing, 'node_modules')), ['canary']);
      const { stdout: fixture } = await run(process.execPath, [path.join(app, 'demo.mjs'), '--state-root', path.join(scratch, 'state'), '--harness', 'codex']);
      assert.equal(JSON.parse(fixture).cleaned, true);

      // A checkout symlink must not be mistaken for an installed release artifact.
      await rm(path.join(app, 'node_modules/@acclimate/codex-plugin'), { recursive: true });
      await symlink(path.join(root, 'packages/codex-plugin'), path.join(app, 'node_modules/@acclimate/codex-plugin'));
      await assert.rejects(run(process.execPath, [path.join(app, 'verify-install.mjs'), 'codex']), /install.outside_consumer/);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
}
