import { consoleEnvironment } from './console-fixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessCommand, readAccessState } from '../src/server/access-core';
const env = {
  ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'fixture-transport',
  CONSOLE_SESSION_TOKEN: 'fixture-session',
};
const userId = '12345678-1234-4234-8234-123456789012';
function fixture() {
  const calls: { path: string; method: string; body?: string }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init?.method || 'GET', body: init?.body as string | undefined });
    assert.equal(new Headers(init?.headers).get('x-acclimate-session'), 'fixture-session');
    if (path === '/v1/auth/session')
      return Response.json({
        userId,
        issuer: 'https://issuer.example',
        subject: 'person',
        secret: 'MUST-NOT-LEAK',
        sessionId: 'private-session',
      });
    if (path.endsWith('/users/' + userId))
      return Response.json({
        id: userId,
        issuer: 'https://issuer.example',
        subject: 'person',
        secret: 'MUST-NOT-LEAK',
      });
    if (path.endsWith('/memberships/' + userId)) return new Response(null, { status: 204 });
    if (path.endsWith('/memberships'))
      return Response.json({
        items: [{ id: userId, issuer: 'https://issuer.example', subject: 'person', role: 'admin' }],
        nextCursor: null,
      });
    if (init?.method === 'POST')
      return Response.json({ id: 'new', name: 'New', role: 'admin', secret: 'MUST-NOT-LEAK' });
    return Response.json({
      items: [{ id: 'p', name: 'Project', role: 'admin' }],
      nextCursor: null,
    });
  }) as typeof fetch;
  return { calls, fetcher };
}
test('hosted read exposes only safe verified identity and project fields', async () => {
  const f = fixture();
  const state = await readAccessState(env, f.fetcher);
  assert.equal(state.ok, true);
  assert.equal(JSON.stringify(state).includes('MUST-NOT-LEAK'), false);
  assert.equal(JSON.stringify(state).includes('fixture-session'), false);
  assert.deepEqual(state.identity, { userId, issuer: 'https://issuer.example', subject: 'person' });
});

test('only absent or typed expired sessions request sign-in; outages and denial do not create login loops', async () => {
  const absent = await readAccessState({ ...env, CONSOLE_SESSION_TOKEN: undefined }, async () => {
    throw new Error('An anonymous request must not call the service');
  });
  assert.equal(!absent.ok && absent.requiresSignIn, true);
  for (const [status, code, shouldSignIn] of [
    [401, 'invalid_session', true],
    [401, 'unauthenticated', false],
    [403, 'denied', false],
    [503, 'unavailable', false],
  ] as const) {
    const state = await readAccessState(env, async () =>
      Response.json({ error: { code } }, { status }),
    );
    assert.equal(state.ok, false);
    assert.equal(Boolean(state.requiresSignIn), shouldSignIn);
  }
  const offline = await readAccessState(env, async () => {
    throw new Error('offline');
  });
  assert.equal(offline.ok, false);
  assert.equal(Boolean(offline.requiresSignIn), false);
});
test('retired local mode denies access and workspace creation before transport', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({ items: [], nextCursor: null });
  };
  const local = await readAccessState(
    { ...env, CONSOLE_MODE: 'local', CONSOLE_SESSION_TOKEN: undefined },
    fetcher,
  );
  assert.equal(local.identity, null);
  assert.equal(local.ok, false);
  assert.equal(
    (
      await accessCommand(
        { ...env, CONSOLE_MODE: 'local' },
        { kind: 'createProject', id: 'new', name: 'New' },
        fetcher,
      )
    ).ok,
    false,
  );
  assert.equal(calls, 0);
});
test('lookup confirms identity; mismatched confirmation never mutates', async () => {
  const f = fixture();
  const lookup = await accessCommand(
    env,
    { kind: 'userLookup', projectId: 'p', userId },
    f.fetcher,
  );
  assert.deepEqual(lookup, {
    ok: true,
    kind: 'userLookup',
    user: { id: userId, issuer: 'https://issuer.example', subject: 'person', role: null },
  });
  const result = await accessCommand(
    env,
    {
      kind: 'setMembership',
      projectId: 'p',
      userId,
      role: 'admin',
      confirmedIdentity: { issuer: 'https://issuer.example', subject: 'another-person' },
    },
    f.fetcher,
  );
  assert.equal(result.ok, false);
  assert.equal(
    f.calls.some((c) => c.method === 'PUT'),
    false,
  );
});
test('membership command rechecks verified identity and leaves actor to session authority', async () => {
  const f = fixture();
  const result = await accessCommand(
    env,
    {
      kind: 'setMembership',
      projectId: 'p',
      userId,
      role: 'viewer',
      confirmedIdentity: { issuer: 'https://issuer.example', subject: 'person' },
    },
    f.fetcher,
  );
  assert.equal(result.ok, true);
  const write = f.calls.find((c) => c.method === 'PUT');
  assert.deepEqual(JSON.parse(write!.body!), { role: 'viewer' });
  assert.equal(JSON.stringify(result).includes('MUST-NOT-LEAK'), false);
});
test('service denials are sanitized and do not repeat mutations', async () => {
  const fetcher = (async () =>
    new Response('private fixture error', { status: 403 })) as typeof fetch;
  const result = await accessCommand(
    env,
    { kind: 'createProject', id: 'new', name: 'New' },
    fetcher,
  );
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('private fixture'), false);
});
test('operator creation and confirmed removal use session authority without actor fields', async () => {
  const f = fixture();
  const created = await accessCommand(
    env,
    { kind: 'createProject', id: 'new', name: 'New' },
    f.fetcher,
  );
  assert.deepEqual(created, {
    ok: true,
    kind: 'createProject',
    project: { id: 'new', name: 'New', role: 'admin' },
  });
  assert.deepEqual(JSON.parse(f.calls.find((c) => c.method === 'POST')!.body!), {
    id: 'new',
    name: 'New',
  });
  const removed = await accessCommand(
    env,
    {
      kind: 'removeMembership',
      projectId: 'p',
      userId,
      confirmedIdentity: { issuer: 'https://issuer.example', subject: 'person' },
    },
    f.fetcher,
  );
  assert.equal(removed.ok, true);
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 1);
  assert.equal(f.calls.find((c) => c.method === 'DELETE')!.body, undefined);
});

test('workspace creation visibility comes from the verified session capability, never admin membership', async () => {
  const f = fixture();
  const admin = await readAccessState(env, f.fetcher);
  assert.equal(admin.ok && admin.canCreateWorkspace, false);
  const operator = await readAccessState(env, async (url, init) => {
    if (new URL(String(url)).pathname === '/v1/auth/session')
      return Response.json({
        userId,
        issuer: 'https://issuer.example',
        subject: 'operator',
        canCreateWorkspace: true,
      });
    return f.fetcher(url, init);
  });
  assert.equal(operator.ok && operator.canCreateWorkspace, true);
  const unverified = await readAccessState(env, async (url, init) => {
    if (new URL(String(url)).pathname === '/v1/auth/session')
      return Response.json({
        userId,
        issuer: 'https://issuer.example',
        subject: 'person',
        canCreateWorkspace: 'true',
      });
    return f.fetcher(url, init);
  });
  assert.equal(unverified.ok && unverified.canCreateWorkspace, false);
  const local = await readAccessState({ ...env, CONSOLE_MODE: 'local' }, f.fetcher);
  assert.equal(local.ok && local.canCreateWorkspace, false);
});

test('member management reads only the explicitly requested authorized workspace', async () => {
  const { readWorkspaceAccessState } = await import('../src/server/access-core');
  const f = fixture();
  const state = await readWorkspaceAccessState(
    { ...env, CONSOLE_PROJECT: 'other-cookie-project' },
    'p',
    f.fetcher,
  );
  assert.equal(state.ok, true);
  assert.deepEqual(state.projects, [{ id: 'p', name: 'Project', role: 'admin' }]);
  const denied = await readWorkspaceAccessState(
    { ...env, CONSOLE_PROJECT: 'p' },
    'other',
    f.fetcher,
  );
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.projects, []);
});

test('membership commands keep their explicit workspace when the remembered selection changes', async () => {
  const f = fixture();
  const result = await accessCommand(
    { ...env, CONSOLE_PROJECT: 'another-workspace' },
    {
      kind: 'removeMembership',
      projectId: 'p',
      userId,
      confirmedIdentity: { issuer: 'https://issuer.example', subject: 'person' },
    },
    f.fetcher,
  );
  assert.equal(result.ok, true);
  const write = f.calls.find((call) => call.method === 'DELETE');
  assert.equal(write?.path, `/v1/projects/p/memberships/${userId}`);
});
