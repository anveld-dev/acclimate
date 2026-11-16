import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { atomicPrivateWrite, readPrivateJson, readPrivateText } from './private-state.js';
import {
  assertLocalPortsAvailable,
  LocalSetupError,
  localDiagnostic,
} from './local-diagnostics.js';

test('private JSON is atomic, private, explicit and never printed', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acclimate-private-test-')));
  try {
    const state = {
      schemaVersion: 1,
      serviceUrl: 'http://127.0.0.1:41234',
      projectId: 'fixture',
      evaluatorToken: 'secret-fixture-token',
      evaluatorPrincipalId: 'evaluator',
    };
    const path = join(root, 'state.json');
    await atomicPrivateWrite(path, JSON.stringify(state));
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readPrivateJson(path), state);
    await atomicPrivateWrite(path, '{invalid secret-fixture-token');
    await assert.rejects(readPrivateJson(join(root, 'state.json')), (error) => {
      assert.equal(localDiagnostic(error), localDiagnostic(new LocalSetupError('config_conflict')));
      assert.ok(!localDiagnostic(error).includes(state.evaluatorToken));
      return true;
    });
    await chmod(path, 0o644);
    await assert.rejects(atomicPrivateWrite(path, 'replacement'), LocalSetupError);
    assert.equal(await readFile(path, 'utf8'), '{invalid secret-fixture-token');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('private state refuses symlinks and redacts untrusted failure details', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acclimate-private-test-')));
  try {
    const target = join(root, 'target');
    await writeFile(target, 'untouched', { mode: 0o600 });
    await symlink(target, join(root, 'state.json'));
    await assert.rejects(readPrivateJson(join(root, 'state.json')), LocalSetupError);
    await assert.rejects(
      atomicPrivateWrite(join(root, 'state.json'), 'replacement'),
      LocalSetupError,
    );
    assert.equal(await readFile(target, 'utf8'), 'untouched');
    for (const error of [
      new Error('postgres://user:password@host/db?token=secret'),
      { message: 'secret' },
      'secret',
    ])
      assert.ok(!localDiagnostic(error).match(/password|token=secret|postgres:\/\//));
    for (const code of [
      'port_busy',
      'tools_missing',
      'database_unavailable',
      'private_path_unsafe',
      'config_conflict',
      'startup_failed',
    ] as const)
      assert.ok(localDiagnostic(new LocalSetupError(code)).includes(`[${code}]`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('occupied port reports an actionable category even for a non-HTTP listener', async () => {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  try {
    await assert.rejects(assertLocalPortsAvailable([port]), (error) => {
      assert.ok(error instanceof LocalSetupError && error.code === 'port_busy');
      return true;
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await assertLocalPortsAvailable([port]);
});

test('existing unreadable console configuration is rejected rather than treated as absent', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acclimate-config-test-')));
  const path = join(root, 'console.env');
  try {
    await writeFile(path, 'CONSOLE_SERVICE_TOKEN=private-fixture', { mode: 0o600 });
    assert.equal(await readPrivateText(path), 'CONSOLE_SERVICE_TOKEN=private-fixture');
    await chmod(path, 0o000);
    await assert.rejects(readPrivateText(path), LocalSetupError);
    await chmod(path, 0o600);
    assert.equal(await readFile(path, 'utf8'), 'CONSOLE_SERVICE_TOKEN=private-fixture');
  } finally {
    await chmod(path, 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});


test('private reads refuse oversized content without retaining it in diagnostics', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acclimate-private-size-test-')));
  try {
    const path = join(root, 'large.json');
    await writeFile(path, 'private-fixture'.repeat(8192), { mode: 0o600 });
    await assert.rejects(readPrivateText(path), (error) => {
      assert.ok(error instanceof LocalSetupError);
      assert.ok(!localDiagnostic(error).includes('private-fixture'));
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
