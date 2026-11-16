import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startupCommand } from './start-production.js';

const env = {
  CONSOLE_ORIGIN: 'https://console.example.com',
  CONSOLE_OIDC_ISSUER: 'https://identity.example.com',
  CONSOLE_OIDC_CLIENT_ID: 'client', CONSOLE_OIDC_CLIENT_SECRET: 'private-client-fixture',
  CONSOLE_LOGIN_TOKEN: 'private-login-fixture', CONSOLE_SERVICE_TOKEN: 'private-transport-fixture',
  CONSOLE_SERVICE_URL: 'http://127.0.0.1:3000', CONSOLE_PUBLIC_API_URL: 'https://api.example.com',
};
test('development and built commands share required production configuration', () => {
  for (const target of ['console', 'dev', 'check']) {
    assert.throws(() => startupCommand(target, {}), /CONSOLE_ORIGIN/);
    assert.throws(() => startupCommand(target, { ...env, CONSOLE_MODE: 'local' }), /obsolete/);
    assert.throws(() => startupCommand(target, { ...env, ACCLIMATE_MODE: 'hosted' }), /obsolete/);
    assert.throws(() => startupCommand(target, { ...env, CONSOLE_LOGIN_TOKEN: env.CONSOLE_SERVICE_TOKEN }), /distinct/);
    const command = startupCommand(target, env);
    assert.equal(command.env.HOST, '127.0.0.1');
    assert.equal(command.env.PORT, '3100');
    assert.ok(!command.args.some((value) => value.includes('--env-file')));
  }
});
test('explicit container bind and installed service path are preserved without inference', () => {
  const command = startupCommand('console', { ...env, HOST: '0.0.0.0', PORT: '4321' });
  assert.equal(command.env.HOST, '0.0.0.0');
  assert.equal(command.env.PORT, '4321');
  assert.match(command.args[0], /\.output\/server\/index\.mjs$/);
  assert.throws(() => startupCommand('dev', { ...env, PORT: 'no' }), /PORT/);
  assert.throws(() => startupCommand('service', { ACCLIMATE_SERVICE_BINARY: './relative' }), /absolute/);
  assert.equal(startupCommand('service', { ACCLIMATE_SERVICE_BINARY: '/opt/acclimate/service' }).command, '/opt/acclimate/service');
});
test('configuration check is process-free and redacts secret values on rejection', () => {
  for (const extra of [{}, { CONSOLE_MODE: 'private-mode-sentinel' }]) {
    const result = spawnSync(process.execPath,
      ['--import', 'tsx', resolve(import.meta.dirname, 'start-production.ts'), 'check'],
      { env: { PATH: process.env.PATH, ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, 'CONSOLE_MODE' in extra ? 1 : 0, result.stderr);
    const output = `${result.stdout}${result.stderr}`;
    for (const secret of [env.CONSOLE_LOGIN_TOKEN, env.CONSOLE_SERVICE_TOKEN, env.CONSOLE_OIDC_CLIENT_SECRET, 'private-mode-sentinel'])
      assert.ok(!output.includes(secret));
  }
});


test('service startup preserves the runtime ownership-loss exit code for supervisors', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'acclimate-startup-exit-')));
  try {
    const binary = join(directory, 'service');
    await writeFile(binary, '#!/bin/sh\nexit 75\n', { mode: 0o700 });
    const result = spawnSync(process.execPath,
      ['--import', 'tsx', resolve(import.meta.dirname, 'start-production.ts'), 'service'],
      { env: { PATH: process.env.PATH, ACCLIMATE_SERVICE_BINARY: binary }, encoding: 'utf8' });
    assert.equal(result.status, 75);
    assert.match(result.stderr, /Process exited unsuccessfully/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
