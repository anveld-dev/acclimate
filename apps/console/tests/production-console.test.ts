import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertConsoleConfiguration, canonicalRequestUrl } from '../src/server/configuration';
import { consoleClient } from '../src/server/console-client';
import { accessCommand, readAccessState } from '../src/server/access-core';
import { readinessResponse } from '../src/server/probes';
import { consoleEnvironment as env } from './console-fixture';

const userId = '12345678-1234-4234-8234-123456789012';
const identity = { userId, issuer: env.CONSOLE_OIDC_ISSUER, subject: 'operator' };

test('pure production validation requires every setting, exact HTTPS public origins and separate authorities', () => {
  assert.deepEqual(assertConsoleConfiguration(env), {
    origin: env.CONSOLE_ORIGIN,
    issuer: env.CONSOLE_OIDC_ISSUER,
    serviceUrl: env.CONSOLE_SERVICE_URL,
    publicApiUrl: env.CONSOLE_PUBLIC_API_URL,
  });
  for (const name of Object.keys(env).filter((name) => name !== 'CONSOLE_SESSION_TOKEN'))
    assert.throws(
      () => assertConsoleConfiguration({ ...env, [name]: undefined }),
      new RegExp(name),
    );
  for (const [name, value] of [
    ['CONSOLE_MODE', 'hosted'],
    ['ACCLIMATE_MODE', 'local'],
    ['CONSOLE_MODE', ''],
    ['CONSOLE_ORIGIN', 'http://console.example'],
    ['CONSOLE_ORIGIN', 'https://console.example/'],
    ['CONSOLE_ORIGIN', 'https://user:pass@console.example'],
    ['CONSOLE_PUBLIC_API_URL', 'http://api.example'],
    ['CONSOLE_SERVICE_URL', 'ftp://api.example'],
    ['CONSOLE_OIDC_ISSUER', 'https://issuer.example/?query=1'],
    ['CONSOLE_OIDC_ISSUER', 'https://issuer.example/#fragment'],
    ['CONSOLE_OIDC_ISSUER', ' https://issuer.example'],
    ['CONSOLE_LOGIN_TOKEN', env.CONSOLE_SERVICE_TOKEN],
  ])
    assert.throws(() => assertConsoleConfiguration({ ...env, [name]: value }));
  assert.equal(
    assertConsoleConfiguration({ ...env, CONSOLE_OIDC_ISSUER: 'https://identity.example/tenant/' })
      .issuer,
    'https://identity.example/tenant/',
  );
});

test('canonical Host determines public URL; forwarding headers have no authority', () => {
  const request = new Request('http://console.example/auth/callback?state=one', {
    headers: {
      host: 'console.example',
      forwarded: 'host=evil.example;proto=http',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
    },
  });
  assert.equal(
    canonicalRequestUrl(request, env).href,
    'https://console.example/auth/callback?state=one',
  );
  assert.throws(() =>
    canonicalRequestUrl(
      new Request(request, {
        headers: { host: 'evil.example', 'x-forwarded-host': 'console.example' },
      }),
      env,
    ),
  );
});

test('console SDK transport has no machine fallback and always carries current session', async () => {
  assert.throws(() => consoleClient({ ...env, CONSOLE_SESSION_TOKEN: undefined }));
  assert.throws(() => consoleClient({ ...env, CONSOLE_SERVICE_URL: undefined }));
  assert.throws(() => consoleClient({ ...env, CONSOLE_MODE: 'local' }));
  let headers: Headers | undefined;
  const client = consoleClient(env, async (_url, init) => {
    headers = new Headers(init?.headers);
    return Response.json({ items: [], nextCursor: null });
  });
  await client.listProjects();
  assert.equal(headers?.get('authorization'), `Bearer ${env.CONSOLE_SERVICE_TOKEN}`);
  assert.equal(headers?.get('x-acclimate-session'), env.CONSOLE_SESSION_TOKEN);
});

test('anonymous access is denied without network and operator capability never manufactures memberships', async () => {
  let calls = 0;
  assert.equal(
    (
      await readAccessState({ ...env, CONSOLE_SESSION_TOKEN: undefined }, async () => {
        calls++;
        throw Error();
      })
    ).ok,
    false,
  );
  assert.equal(calls, 0);
  const state = await readAccessState(env, async (url) =>
    String(url).endsWith('/auth/session')
      ? Response.json({ ...identity, canCreateWorkspace: true })
      : Response.json({ items: [], nextCursor: null }),
  );
  assert.equal(state.ok, true);
  assert.deepEqual(state.projects, []);
  assert.equal(state.ok && state.canCreateWorkspace, true);
  assert.equal('mode' in state, false);
});

test('adoption rechecks reviewed operator and sends only exact ID and reason to authority', async () => {
  const writes: unknown[] = [];
  const command = {
    kind: 'adoptWorkspace' as const,
    projectId: 'old-project',
    reason: ' Reviewed legacy ownership ',
    confirmedIdentity: identity,
  };
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/auth/session')) return Response.json(identity);
    assert.equal(String(url), `${env.CONSOLE_SERVICE_URL}/v1/auth/workspace-adoptions`);
    writes.push(JSON.parse(String(init?.body)));
    return Response.json({
      projectId: 'old-project',
      userId,
      reason: 'Reviewed legacy ownership',
      createdAt: '2026-11-14T00:00:00Z',
      alreadyAdopted: true,
      currentRole: null,
      secret: 'DO-NOT-EXPOSE',
    });
  };
  const result = await accessCommand(env, command, fetcher);
  assert.deepEqual(writes, [{ projectId: 'old-project', reason: 'Reviewed legacy ownership' }]);
  assert.equal(result.ok && result.adoption?.currentRole, null);
  assert.equal(JSON.stringify(result).includes('DO-NOT-EXPOSE'), false);
  const changed = await accessCommand(
    env,
    { ...command, confirmedIdentity: { ...identity, subject: 'another' } },
    fetcher,
  );
  assert.equal(changed.ok, false);
  assert.equal(writes.length, 1);
});

test('readiness is bounded, sanitizes failure and never calls identity discovery', async () => {
  let calls = 0;
  assert.equal(
    (
      await readinessResponse(env, async (url, init) => {
        calls++;
        assert.equal(String(url), `${env.CONSOLE_SERVICE_URL}/ready`);
        assert.ok(init?.signal);
        assert.equal(init?.redirect, 'error');
        return Response.json({ status: 'ready' });
      })
    ).status,
    200,
  );
  assert.equal(calls, 1);
  assert.equal(
    (await readinessResponse(env, async () => new Response('private-error', { status: 503 })))
      .status,
    503,
  );
  assert.equal(
    (
      await readinessResponse({ ...env, CONSOLE_LOGIN_TOKEN: undefined }, async () => {
        throw Error('must not call');
      })
    ).status,
    503,
  );
});

test('workspace creation refuses unaddressable dot IDs before mutation', async () => {
  let writes = 0;
  for (const id of ['.', '..']) {
    const result = await accessCommand(
      env,
      { kind: 'createProject', id, name: 'Workspace' },
      async (_url, init) => {
        if (init?.method === 'POST') writes++;
        return Response.json(identity);
      },
    );
    assert.equal(result.ok, false);
  }
  assert.equal(writes, 0);
});
