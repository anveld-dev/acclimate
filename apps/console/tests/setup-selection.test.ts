import { consoleEnvironment } from './console-fixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { openSelection, sealSelection, selectedEnvironment } from '../src/server/selection';
import { authorizeSelection, createSetup, listSetup } from '../src/server/setup';
const env = {
  ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'server-secret',
  CONSOLE_ALLOW_EDITS: 'true',
};
const selection = { projectId: 'one', bundleId: 'bundle-one', channel: 'stable' };
test('opaque selection survives decoding, rejects tampering and does not carry credentials', () => {
  const sealed = sealSelection(env, selection);
  assert.deepEqual(openSelection(env, sealed), selection);
  assert.equal(openSelection(env, sealed.slice(0, -3) + 'bad'), null);
  assert.equal(openSelection({ CONSOLE_SERVICE_TOKEN: 'different' }, sealed), null);
  assert.ok(!sealed.includes('one'));
  assert.equal(
    selectedEnvironment(env, sealed, 'trusted-cookie').CONSOLE_SESSION_TOKEN,
    'trusted-cookie',
  );
  assert.equal(
    selectedEnvironment({ ...env, CONSOLE_SESSION_TOKEN: 'untrusted-env' }).CONSOLE_SESSION_TOKEN,
    undefined,
  );
});
test('hosted requests fail closed before a service request without a session', async () => {
  let calls = 0;
  const state = await listSetup({ ...env, CONSOLE_SESSION_TOKEN: undefined }, async () => {
    calls++;
    throw Error();
  });
  assert.equal(state.ok, false);
  if (!state.ok) {
    assert.equal(state.requiresSignIn, true);
    assert.match(state.message, /^Sign in to access your workspaces\./);
  }
  assert.equal(calls, 0);
  await assert.rejects(authorizeSelection({ ...env, CONSOLE_SESSION_TOKEN: undefined }, selection));
});
test('empty authorized project list is a successful empty state', async () => {
  const state = await listSetup(env, async () => Response.json({ items: [], nextCursor: null }));
  assert.equal(state.ok, true);
  if (state.ok) assert.deepEqual(state.entries, []);
});
test('expired sessions offer sign-in while missing workspace permission stays a denial', async () => {
  for (const status of [401, 403]) {
    const state = await listSetup(env, async () =>
      Response.json({ error: { code: 'denied', message: 'Access denied' } }, { status }),
    );
    assert.equal(state.ok, false);
    if (!state.ok) {
      assert.equal(state.requiresSignIn, status === 401);
      assert.match(state.message, /Access denied/);
    }
  }
});
test('example creation uses one atomic command and trusted session transport', async () => {
  let calls = 0;
  await createSetup(
    { ...env, CONSOLE_SESSION_TOKEN: 'session' },
    {
      projectId: 'one',
      name: 'Example',
      channel: 'stable',
      origin: 'example',
      key: '11111111-1111-4111-8111-111111111111',
    },
    async (url, init) => {
      calls++;
      if (!init?.method || init.method === 'GET')
        return Response.json({ status: 'not_observed', operationId: 'key' });
      assert.match(String(url), /projects\/one\/bundle-setups$/);
      assert.equal((init?.headers as Record<string, string>)['X-Acclimate-Session'], 'session');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.origin, 'example');
      assert.match(body.reason, /no model evaluation/i);
      return Response.json({});
    },
  );
  assert.equal(calls, 2);
});

test('selection rechecks the exact scoped channel with current session', async () => {
  const result = await authorizeSelection(
    { ...env, CONSOLE_SESSION_TOKEN: 'current' },
    selection,
    async (url, init) => {
      assert.match(String(url), /projects\/one\/bundles\/bundle-one\/channels\/stable$/);
      assert.equal((init?.headers as Record<string, string>)['X-Acclimate-Session'], 'current');
      return Response.json({ channel: 'stable', revision: '1', version: { id: 'v' } });
    },
  );
  assert.deepEqual(result, selection);
});

test('invalid setup is a definitive rejection while lost responses stay uncertain', async () => {
  const { setupFailure } = await import('../src/server/setup');
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    throw new TypeError('network response lost');
  };
  const request = {
    payload: {
      schemaVersion: 1 as const,
      files: [{ path: 'AGENTS.md', kind: 'instruction' as const, text: 'Review code.' }],
    },
    projectId: 'one',
    name: 'Valid',
    channel: 'stable',
    origin: 'created' as const,
    key: 'a20bcde0-0000-4000-8000-000000000000',
  };
  for (const invalid of [
    { ...request, name: ' ' },
    { ...request, channel: 'bad channel' },
  ]) {
    await assert.rejects(createSetup(env, invalid, fetcher), (error) => {
      assert.equal(setupFailure(error).uncertain, false);
      return true;
    });
  }
  assert.equal(calls, 0);
  await assert.rejects(createSetup(env, request, fetcher), (error) => {
    assert.equal(setupFailure(error).uncertain, true);
    return true;
  });
  assert.equal(calls, 1);
});
