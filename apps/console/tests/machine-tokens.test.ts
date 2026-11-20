import assert from 'node:assert/strict';
import { test } from 'node:test';
import { machineTokenCommand } from '../src/server/machine-token-core';
import { evaluatorConfig, validJournalRoot } from '../src/lib/evaluator-config';
import { consoleEnvironment } from './console-fixture';

const id = '12345678-1234-4234-8234-123456789012';
const env = {
  ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'transport-fixture',
  CONSOLE_SESSION_TOKEN: 'session-fixture',
};
const token = {
  id,
  name: 'ci',
  principalId: 'machine:ci',
  rights: ['evaluate'],
  secretPrefix: 'acm_12345678',
  status: 'active',
};

test('issuing sends only name, rights, expiry and reason over the admin session', async () => {
  const result = await machineTokenCommand(
    env,
    {
      kind: 'issue',
      workspaceId: 'p',
      name: ' ci ',
      rights: ['evaluate'],
      expiresInDays: 30,
      reason: ' CI ',
    },
    async (url, init) => {
      assert.equal(new URL(String(url)).pathname, '/v1/workspaces/p/machine-tokens');
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer transport-fixture');
      assert.equal(new Headers(init?.headers).get('x-acclimate-session'), 'session-fixture');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        name: 'ci',
        rights: ['evaluate'],
        expiresInDays: 30,
        reason: 'CI',
      });
      return Response.json({ token, secret: 'acm_secret' }, { status: 201 });
    },
  );
  assert.deepEqual(result, { ok: true, secret: 'acm_secret', token });
});

test('list, rotate and revoke use the workspace token routes', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path} ${init?.body ?? ''}`);
    if (path.endsWith('/machine-token-events')) return Response.json({ items: [] });
    if (path.endsWith('/rotate')) return Response.json({ token, secret: 'acm_next' });
    if (path.endsWith('/revoke')) return Response.json({ token: { ...token, status: 'revoked' } });
    return Response.json({ items: [token] });
  };
  const listed = await machineTokenCommand(env, { kind: 'list', workspaceId: 'p' }, fetcher);
  assert.equal(listed.ok && listed.items?.length, 1);
  assert.equal(listed.ok && listed.publicApiUrl, env.CONSOLE_PUBLIC_API_URL);
  await machineTokenCommand(
    env,
    { kind: 'rotate', workspaceId: 'p', id, overlapSeconds: 3600 },
    fetcher,
  );
  await machineTokenCommand(
    env,
    { kind: 'revoke', workspaceId: 'p', id, reason: ' moved ' },
    fetcher,
  );
  assert.deepEqual(calls.slice(2), [
    `POST /v1/workspaces/p/machine-tokens/${id}/rotate {"overlapSeconds":3600}`,
    `POST /v1/workspaces/p/machine-tokens/${id}/revoke {"reason":"moved"}`,
  ]);
});

test('invalid input never reaches the service and service messages surface', async () => {
  let calls = 0;
  const never: typeof fetch = async () => {
    calls++;
    throw new Error();
  };
  for (const input of [
    { kind: 'list', workspaceId: '..' },
    { kind: 'revoke', workspaceId: 'p', id: '../x', reason: 'r' },
    { kind: 'revoke', workspaceId: 'p', id, reason: ' ' },
    { kind: 'issue', workspaceId: 'p', name: 'ci', rights: ['admin'], expiresInDays: 1 },
    { kind: 'issue', workspaceId: 'p', name: 'ci', rights: [], expiresInDays: 1 },
  ] as const)
    assert.equal((await machineTokenCommand(env, input as never, never)).ok, false);
  assert.equal(calls, 0);
  const refused = await machineTokenCommand(
    env,
    { kind: 'issue', workspaceId: 'p', name: 'CI', rights: ['evaluate'], expiresInDays: 1 },
    async () =>
      Response.json(
        { error: { code: 'invalid_content', message: 'Name must be lowercase', requestId: 'r' } },
        { status: 400 },
      ),
  );
  assert.deepEqual(refused, { ok: false, message: 'Name must be lowercase' });
  const denied = await machineTokenCommand(env, { kind: 'list', workspaceId: 'p' }, async () =>
    Response.json({ error: { code: 'denied', message: 'no', requestId: 'r' } }, { status: 403 }),
  );
  assert.equal(denied.ok === false && denied.denied, true);
});

test('the downloaded evaluator.json is ready for the SDK evaluator', () => {
  const file = evaluatorConfig({
    publicApiUrl: 'https://api.example.test',
    workspaceId: 'p',
    principalId: 'machine:ci',
    journalRoot: '/home/ci/.acclimate/journal',
    token: 'acm_secret',
  });
  assert.deepEqual(JSON.parse(file), {
    schemaVersion: 1,
    serviceUrl: 'https://api.example.test',
    workspaceId: 'p',
    evaluatorPrincipalId: 'machine:ci',
    evaluatorToken: 'acm_secret',
    journalRoot: '/home/ci/.acclimate/journal',
  });
  // Without an embedded token the SDK reads ACCLIMATE_EVALUATOR_TOKEN.
  const tokenless = JSON.parse(
    evaluatorConfig({
      publicApiUrl: 'https://api.example.test/',
      workspaceId: 'p',
      principalId: 'machine:ci',
      journalRoot: '/j',
    }),
  );
  assert.equal('evaluatorToken' in tokenless, false);
  for (const value of ['relative/journal', ' /padded', '/new\nline', ''])
    assert.equal(validJournalRoot(value), false);
  assert.throws(() =>
    evaluatorConfig({
      publicApiUrl: 'https://a.test',
      workspaceId: 'p',
      principalId: 'm',
      journalRoot: 'x',
    }),
  );
});
