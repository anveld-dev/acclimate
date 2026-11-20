import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readEvaluatorConfig, EvaluatorConfigError } from './evaluator-config.js';
import { parseEvaluatorArguments, evaluatorErrorMessage } from './evaluate-app.js';

const ids = ['--bundleID', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '--requestID', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
test('explicit private app configuration has no missing config, adapter, legacy state-root or ambient fallback', () => {
  for (const args of [ids, ['--config', '/tmp/private.json', ...ids], ['--config', 'relative.json', ...ids, '--adapter', 'payment-retry'],
    ['--config', '/tmp/private.json', ...ids, '--adapter', 'payment-retry', '--state-root', '/tmp/old'],
    ['--config', '/tmp/private.json', ...ids, '--adapter', 'payment-retry', '--live'],
    ['--config', '/tmp/private.json', ...ids, '--adapter', 'codex-luna-review', '--live', '--live']])
    assert.throws(() => parseEvaluatorArguments(args));
});

test('private config enforces schema, bounds, ownership permissions, absolute paths and no symlinks', async () => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-private-evaluator-'));
  const filename = path.join(root, 'evaluator.json');
  const valid = { schemaVersion: 1, serviceUrl: 'https://api.example.test', workspaceId: 'project', evaluatorPrincipalId: 'evaluator',
    evaluatorToken: 'private-test-token', journalRoot: path.join(root, 'journals') };
  const save = async (value: unknown) => writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  try {
    await save(valid);
    assert.deepEqual(await readEvaluatorConfig(filename), valid);
    for (const serviceUrl of ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://[::1]:3000']) {
      await save({ ...valid, serviceUrl });
      assert.equal((await readEvaluatorConfig(filename)).serviceUrl, serviceUrl);
    }
    const invalid = [null, [], { ...valid, schemaVersion: 2 }, { ...valid, journalRoot: 'relative' }, { ...valid, stateRoot: root },
      { ...valid, evaluatorToken: '' }, { ...valid, evaluatorToken: 'x'.repeat(4097) },
      { ...valid, serviceUrl: 'https://user:secret@api.example.test' }, { ...valid, serviceUrl: 'https://api.example.test?secret=token' },
      { ...valid, serviceUrl: 'http://api.example.test' }, { ...valid, serviceUrl: 'http://192.168.0.20:3000' },
      { ...valid, serviceUrl: 'file:///tmp/runner' }];
    for (const value of invalid) { await save(value); await assert.rejects(readEvaluatorConfig(filename), EvaluatorConfigError); }
    await writeFile(filename, '{"private-test-token":', { mode: 0o600 });
    await assert.rejects(readEvaluatorConfig(filename), error => {
      assert.ok(error instanceof EvaluatorConfigError);
      assert.ok(!error.message.includes(valid.evaluatorToken) && !error.message.includes(root));
      return true;
    });
    await save(valid);
    await chmod(filename, 0o644);
    await assert.rejects(readEvaluatorConfig(filename), EvaluatorConfigError);
    await chmod(filename, 0o600);
    await chmod(root, 0o755);
    await assert.rejects(readEvaluatorConfig(filename), EvaluatorConfigError);
    await chmod(root, 0o700);
    const link = path.join(root, 'link.json');
    await symlink(filename, link);
    await assert.rejects(readEvaluatorConfig(link), EvaluatorConfigError);
    const linkedParent = path.join(root, 'linked-parent');
    const parent = path.join(root, 'private-parent');
    await mkdir(parent, { mode: 0o700 });
    await writeFile(path.join(parent, 'config.json'), JSON.stringify(valid), { mode: 0o600 });
    await symlink(parent, linkedParent);
    await assert.rejects(readEvaluatorConfig(path.join(linkedParent, 'config.json')), EvaluatorConfigError);
    await assert.rejects(readEvaluatorConfig(path.relative(process.cwd(), filename)), EvaluatorConfigError);
    await writeFile(filename, ' '.repeat(65537), { mode: 0o600 });
    await assert.rejects(readEvaluatorConfig(filename), EvaluatorConfigError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI errors never expose arbitrary service, provider, path or credential text', () => {
  for (const error of [new Error('private-test-token'), Object.assign(new Error('Request does not match installed private-test-token'), { status: 403 }),
    new Error('Request does not match installed private-test-token'), new SyntaxError('bad JSON contains private-test-token')])
    assert.ok(!evaluatorErrorMessage(error).includes('private-test-token'));
});
