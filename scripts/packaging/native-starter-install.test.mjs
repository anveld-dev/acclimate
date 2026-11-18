import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

async function checkNativeApplication(app, scratch) {
  const sourceRoot = path.join(scratch, 'repository');
  await cp(path.join(app, 'test/fixture'), sourceRoot, { recursive: true });
  const config = {
    sourceRoot, stateRoot: path.join(scratch, 'state'), sourceRevision: 'retry-fixture-v1',
    sourceFiles: ['package.json', 'src/retry.js', 'tests/retry.test.mjs'],
    resultFiles: ['src/retry.js'], testFiles: ['tests/retry.test.mjs'], model: 'deployment-a',
    cases: [{ caseId: 'retry', input: { prompt: 'Preserve retry identity.' }, expected: null }],
  };
  const configure = () => writeFile(path.join(app, 'native.json'), JSON.stringify(config), { mode: 0o600 });
  const describe = async () => JSON.parse((await run(path.join(app, 'node_modules/.bin/acclimate-eval'), ['describe'], { cwd: app })).stdout);
  await assert.rejects(describe(), /Create native\.json beside the native starter/);
  await writeFile(path.join(app, 'native.json'), JSON.stringify({
    ...config, testFiles: ['tests/private-case-name.mjs'],
  }), { mode: 0o600 });
  await assert.rejects(describe(), error => {
    assert.match(error.stderr, /every testFiles entry is in sourceFiles and outside resultFiles/);
    assert.doesNotMatch(error.stderr, /private-case-name/);
    return true;
  });
  await configure();
  const original = await describe();
  assert.equal(original.runtime.configId, 'native-repository');
  assert.deepEqual(original.expectedCases, [{ caseId: 'retry', repetition: 0 }]);

  // Grade a real retained solution against the installed application's original Node tests.
  const [jobId] = await readdir(path.join(config.stateRoot, 'artifacts'));
  const bytes = await readFile(path.join(config.stateRoot, 'artifacts', jobId, 'manifest.json'));
  const repository = { jobId, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e',
    "import { grade } from './application.mjs'; console.log(JSON.stringify(await grade({output:{repository:JSON.parse(process.argv[1])},signal:new AbortController().signal})));",
    JSON.stringify(repository)], { cwd: app });
  assert.equal(JSON.parse(stdout).reward, 1);

  config.model = 'deployment-b';
  await configure();
  const changedModel = await describe();
  assert.notEqual(changedModel.runtime.configRevision, original.runtime.configRevision);
  assert.equal(changedModel.graderRevision, original.graderRevision);
  config.model = 'deployment-a';
  await configure();
  await writeFile(path.join(sourceRoot, 'src/retry.js'), 'export const retryKey = id => id;\n');
  const changedSource = await describe();
  assert.notEqual(changedSource.runtime.configRevision, original.runtime.configRevision);
  assert.notEqual(changedSource.graderRevision, original.graderRevision);
  await writeFile(path.join(sourceRoot, 'tests/retry.test.mjs'), 'import "node:test";\n');
  const changedTests = await describe();
  assert.notEqual(changedTests.graderRevision, changedSource.graderRevision);
  const helper = path.join(app, 'harnesses.mjs');
  await writeFile(helper, (await readFile(helper, 'utf8')) + '\n// A new harness build.\n');
  assert.notEqual((await describe()).runtime.configRevision, changedTests.runtime.configRevision);
}

async function checkCodexExecutable(app) {
  // Use this checkout's installed, pinned upstream packages in an isolated consumer.
  const sdkEntry = fileURLToPath(import.meta.resolve('@openai/codex-sdk'));
  const cliManifest = createRequire(sdkEntry).resolve('@openai/codex/package.json');
  const platformName = '@openai/codex-' + process.platform + '-' + process.arch;
  const platformManifest = createRequire(cliManifest).resolve(platformName + '/package.json');
  async function installPackage(name, source) {
    await cp(source, path.join(app, 'node_modules', name), {
      recursive: true, mode: constants.COPYFILE_FICLONE,
      filter: filename => !path.relative(source, filename).split(path.sep).includes('node_modules'),
    });
  }
  await installPackage('@openai/codex-sdk', path.dirname(path.dirname(sdkEntry)));
  await installPackage('@openai/codex', path.dirname(cliManifest));
  const verify = () => run(process.execPath, ['verify-install.mjs', 'codex', '--codex-sdk'], { cwd: app });
  await assert.rejects(verify(), /install.codex_cli_unavailable:.*--include=optional/);
  await installPackage(platformName, path.dirname(platformManifest));
  const { stdout } = await verify();
  assert.equal(JSON.parse(stdout).find(item => item.package === '@openai/codex-sdk').cliVersion, 'codex-cli 0.169.0');
}

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
      const publicFiles = await readdir(app);
      for (const name of ['demo.mjs', 'worker.mjs', 'fixture', 'test'])
        assert.ok(!publicFiles.includes(name), `test fixture shipped: ${name}`);
      await cp(path.join(root, 'examples/native-repository/test'), path.join(app, 'test'), { recursive: true });
      const { stdout: fixture } = await run(process.execPath, [path.join(app, 'test/run-fixture.mjs'), '--state-root', path.join(scratch, 'state'), '--harness', 'codex']);
      assert.equal(JSON.parse(fixture).cleaned, true);
      if (!nested) {
        await checkNativeApplication(app, scratch);
        await checkCodexExecutable(app);
      }

      // A checkout symlink must not be mistaken for an installed release artifact.
      await rm(path.join(app, 'node_modules/@acclimate/codex-plugin'), { recursive: true });
      await symlink(path.join(root, 'packages/codex-plugin'), path.join(app, 'node_modules/@acclimate/codex-plugin'));
      await assert.rejects(run(process.execPath, [path.join(app, 'verify-install.mjs'), 'codex']), /install.outside_consumer/);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
}
