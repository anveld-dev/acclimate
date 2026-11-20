import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fixture } from './support.mjs';
import { ambientConfigDigest, isolatedEnvironment, loadHarness } from '../harnesses.mjs';
import { discoverSourceFiles } from '../repository-job.mjs';

const run = promisify(execFile);
const starter = fileURLToPath(new URL('..', import.meta.url));
const example = JSON.parse(await readFile(path.join(starter, 'native.replay.json'), 'utf8'));

async function scratch(callback) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'native-app-test-')));
  try {
    return await callback(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
async function describeApp(configFile) {
  const script = `const app = await import(${JSON.stringify(path.join(starter, 'application.mjs'))});
    console.log(JSON.stringify({ cases: app.cases, revisionFiles: app.revisionFiles, settings: app.runtime.settings }));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ACCLIMATE_NATIVE_CONFIG: configFile },
  });
  return JSON.parse(stdout);
}

test('the shipped offline smoke compares two versions with the replay harness and real tests', { timeout: 60_000 }, async () => {
  const { stdout } = await run(process.execPath, [path.join(starter, 'smoke.mjs')]);
  const result = JSON.parse(stdout);
  assert.equal(result.evidence, 'offline-replay-no-model');
  assert.equal(result.parent['request-scoped-retry'].reward, 0);
  assert.deepEqual(result.parent['request-scoped-retry'].undeclaredChanges, ['docs/retry-notes.md']);
  assert.equal(result.candidate['request-scoped-retry'].reward, 1);
  assert.deepEqual(result.candidate['request-scoped-retry'].tests, { total: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 });
});

test('several harnesses make the harness part of each case key and of the runtime identity', async () => {
  await scratch(async (base) => {
    const configFile = path.join(base, 'native.json');
    await writeFile(configFile, JSON.stringify({
      ...example, stateRoot: base, harness: undefined,
      harnesses: ['replay', { name: 'my-agent', module: './test/custom-harness.mjs' }], model: 'model-a',
    }));
    const app = await describeApp(configFile);
    assert.deepEqual(app.cases.map((item) => [item.caseId, item.input.harness]), [
      ['request-scoped-retry@replay', 'replay'], ['request-scoped-retry@my-agent', 'my-agent'],
    ]);
    assert.ok(app.revisionFiles.includes('test/custom-harness.mjs'));
    assert.ok(app.revisionFiles.includes('harness-child.mjs'));
    assert.equal(app.settings.harness, 'replay,my-agent');
    assert.deepEqual(app.settings.harnesses['my-agent'].custom, { agent: 'my-agent', version: '1' });
    assert.equal(app.settings.harnesses['my-agent'].model, 'model-a');
    assert.equal(app.settings.isolation, 'isolated-home-v1');
    assert.match(app.settings.harnesses.replay.ambientConfig, /^sha256:[a-f0-9]{64}$/);
  });
});

test('a symlinked stateRoot alias (macOS /tmp) is resolved before strict checks', async () => {
  await scratch(async (base) => {
    const real = path.join(base, 'state');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, path.join(base, 'alias'));
    const configFile = path.join(base, 'native.json');
    await writeFile(configFile, JSON.stringify({ ...example, stateRoot: path.join(base, 'alias') }));
    const app = await describeApp(configFile);
    assert.equal(app.cases.length, 1);
    await writeFile(configFile, JSON.stringify({ ...example, stateRoot: path.join(base, 'missing') }));
    await assert.rejects(describeApp(configFile), /stateRoot ".*missing" does not exist. Create it with mkdir -p -m 700/);
  });
});

test('custom harness modules must stay inside the starter and export defineHarness', async () => {
  await assert.rejects(loadHarness({ module: '../native-integration.md' }), /native.harness_module: "..\/native-integration.md" \(must be inside the starter directory\)/);
  await assert.rejects(loadHarness({ module: './harnesses.mjs', export: 'nothing' }), /export nothing = defineHarness/);
  await assert.rejects(loadHarness('gemini'), /native.unsupported_harness: "gemini"/);
  const custom = await loadHarness({ name: 'my-agent', module: './test/custom-harness.mjs' });
  assert.equal(custom.name, 'my-agent');
  assert.equal(custom.moduleFile, 'test/custom-harness.mjs');
});

test('each job gets a HOME and CODEX_HOME containing only authentication', async () => {
  await scratch(async (base) => {
    const home = path.join(base, 'home');
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex', 'auth.json'), '{"token":"secret"}');
    await writeFile(path.join(home, '.codex', 'config.toml'), '[mcp_servers.x]\ncommand="x"\n');
    await writeFile(path.join(home, '.codex', 'AGENTS.md'), 'global guidance');
    const cwd = path.join(base, 'workspace');
    await mkdir(cwd);
    const isolated = await isolatedEnvironment({
      harness: 'codex', cwd, sourceEnv: { HOME: home, PATH: '/usr/bin', OPENAI_API_KEY: 'sk-test-value', UNRELATED: 'x' },
    });
    assert.equal(isolated.env.HOME, path.join(cwd, '.acclimate', 'home'));
    assert.equal(isolated.env.CODEX_HOME, path.join(cwd, '.acclimate', 'home', '.codex'));
    assert.deepEqual(await readdir(isolated.env.CODEX_HOME), ['auth.json']);
    assert.equal(isolated.env.OPENAI_API_KEY, 'sk-test-value');
    assert.equal(isolated.env.UNRELATED, undefined);
    assert.deepEqual(isolated.secrets, ['sk-test-value']);
    const plain = await ambientConfigDigest('codex', { home });
    const inherited = await ambientConfigDigest('codex', { home, inheritHome: true });
    await writeFile(path.join(home, '.codex', 'config.toml'), 'model="other"\n');
    assert.equal(await ambientConfigDigest('codex', { home }), plain);
    assert.notEqual(await ambientConfigDigest('codex', { home, inheritHome: true }), inherited);
  });
});

test('git ls-files inventories honor globs and allowDotPaths and report skipped paths', async () => {
  await scratch(async (base) => {
    const git = (...args) => run('git', ['-C', base, ...args]);
    await git('init', '-q');
    await mkdir(path.join(base, 'src'));
    for (const [name, text] of [['src/a.js', 'a'], ['src/b.md', 'b'], ['.eslintrc', '{}'], ['.gitignore', 'x'], ['AGENTS.md', 'g'], ['notes.txt', 'n']])
      await writeFile(path.join(base, name), text);
    await git('add', '.');
    const all = await discoverSourceFiles({ sourceRoot: base, allowDotPaths: ['.eslintrc'] });
    assert.deepEqual(all.files, ['.eslintrc', 'notes.txt', 'src/a.js', 'src/b.md']);
    assert.deepEqual(all.skipped.map((item) => [item.path, item.code]), [['.gitignore', 'native.control_path'], ['AGENTS.md', 'native.control_path']]);
    const selected = await discoverSourceFiles({ sourceRoot: base, include: ['src/**'], exclude: ['**/*.md'] });
    assert.deepEqual(selected.files, ['src/a.js']);
  });
});

test('the jobs CLI lists, inspects and cleans a quarantined job only after explicit confirmation', async () => {
  await fixture(async ({ base, source, run: runJob, options }) => {
    await assert.rejects(runJob({ runHarness: async ({ acknowledge }) => {
      await acknowledge({ kind: 'fake', value: 'lost' });
      return { stopped: false };
    } }), { name: 'ExecutionUncertainError' });
    const configFile = path.join(base, 'native.json');
    await writeFile(configFile, JSON.stringify({ sourceRoot: source, stateRoot: base }));
    const cli = (...args) => run(process.execPath, [path.join(starter, 'native.mjs'), ...args], {
      env: { ...process.env, ACCLIMATE_NATIVE_CONFIG: configFile },
    });
    const listed = JSON.parse((await cli('jobs', 'list')).stdout);
    assert.equal(listed[0].state, 'quarantined');
    const inspected = JSON.parse((await cli('jobs', 'inspect', options.context.jobId)).stdout);
    assert.equal(inspected.record.externalHandle.value, 'lost');
    await assert.rejects(cli('jobs', 'cleanup', options.context.jobId), (error) =>
      error.code === 2 && /pass --confirm-stopped/.test(error.stderr) && error.stderr.trim().split('\n').length === 1);
    const cleaned = JSON.parse((await cli('jobs', 'cleanup', options.context.jobId, '--confirm-stopped')).stdout);
    assert.equal(cleaned.cleaned, true);
    assert.equal(JSON.parse((await cli('jobs', 'list')).stdout)[0].state, 'cleaned');
  });
});

test('check-bundle names each compatibility rule before a live run', async () => {
  await scratch(async (base) => {
    const configFile = path.join(base, 'native.json');
    await writeFile(configFile, JSON.stringify({ stateRoot: base, sourceRoot: base, harnesses: ['codex', 'claude'] }));
    const payload = path.join(base, 'payload.json');
    await writeFile(payload, JSON.stringify({ schemaVersion: 1, files: [
      { path: 'a.md', kind: 'instruction', text: 'A' }, { path: 'b.md', kind: 'instruction', text: 'B' },
    ] }));
    const cli = () => run(process.execPath, [path.join(starter, 'native.mjs'), 'check-bundle', payload], {
      env: { ...process.env, ACCLIMATE_NATIVE_CONFIG: configFile },
    });
    await assert.rejects(cli(), (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.compatible, false);
      assert.deepEqual(result.issues.map((issue) => [issue.target, issue.code]), [['codex', 'instruction_count'], ['claude', 'instruction_count']]);
      assert.match(result.issues[0].message, /a\.md, b\.md/);
      return error.code === 1;
    });
  });
});
