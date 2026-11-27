import { consoleEnvironment } from './console-fixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { openSelection, sealSelection, selectedEnvironment } from '../src/server/selection';
import {
  createSetup,
  listSetup,
  setupFailure,
  SetupValidationError,
} from '../src/server/setup';
import type { BundlePayload } from '@anveld/acclimate-sdk';
const env = {
  ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'server-secret',
  CONSOLE_ALLOW_EDITS: 'true',
};
const selection = { workspaceId: 'one', bundleId: 'bundle-one', channel: 'stable' };
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
test('creating supplied instructions uses one atomic command and trusted session transport', async () => {
  let calls = 0;
  await createSetup(
    { ...env, CONSOLE_SESSION_TOKEN: 'session' },
    {
      workspaceId: 'one',
      name: 'Team instructions',
      channel: 'stable',
      origin: 'created',
      payload: suppliedPayload,
      key: '11111111-1111-4111-8111-111111111111',
    },
    async (url, init) => {
      calls++;
      if (!init?.method || init.method === 'GET')
        return Response.json({ status: 'not_observed', operationId: 'key' });
      assert.match(String(url), /workspaces\/one\/bundle-setups$/);
      assert.equal((init?.headers as Record<string, string>)['X-Acclimate-Session'], 'session');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.origin, 'created');
      assert.deepEqual(body.payload, suppliedPayload);
      assert.match(body.reason, /no model evaluation/i);
      return Response.json({});
    },
  );
  assert.equal(calls, 2);
});

const suppliedPayload: BundlePayload = {
  schemaVersion: 1,
  files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'Review café\r\n確認\n' }],
};
for (const fixture of [
  { label: 'created content', origin: 'created', payload: suppliedPayload },
  {
    label: 'imported content with an explicit target',
    origin: 'imported',
    payload: suppliedPayload,
    compatibilityTarget: 'codex',
  },
] as const) {
  test(`setup preserves exact request bytes for ${fixture.label}`, async () => {
    const compatibilityTarget =
      'compatibilityTarget' in fixture ? fixture.compatibilityTarget : undefined;
    const key = '11111111-1111-4111-8111-111111111111';
    const expected = JSON.stringify({
      name: 'Reviewed bundle',
      channel: 'stable',
      origin: fixture.origin,
      payload: fixture.payload,
      compatibilityTarget: compatibilityTarget ?? 'generic',
      reason: 'Initial content setup; no model evaluation was run.',
    });
    const methods: string[] = [];
    await createSetup(
      env,
      { workspaceId: 'one', name: 'Reviewed bundle', channel: 'stable', key, ...fixture },
      async (url, init) => {
        methods.push(init?.method ?? 'GET');
        if (init?.method === 'GET')
          return Response.json({ status: 'not_observed', operationId: key });
        assert.equal(new URL(String(url)).pathname, '/v1/workspaces/one/bundle-setups');
        assert.equal(new Headers(init?.headers).get('Idempotency-Key'), key);
        assert.equal(init?.body, expected);
        return Response.json({});
      },
    );
    assert.deepEqual(methods, ['GET', 'POST']);
  });
}

test('created and imported setups without content retain definitive empty-payload rejection', async () => {
  let calls = 0;
  for (const origin of ['created', 'imported'] as const) {
    await assert.rejects(
      createSetup(
        env,
        {
          workspaceId: 'one',
          name: 'Reviewed bundle',
          channel: 'stable',
          origin,
          key: '11111111-1111-4111-8111-111111111111',
        },
        async () => {
          calls++;
          throw new Error('Unexpected transport');
        },
      ),
      (error) => {
        assert.ok(error instanceof SetupValidationError);
        assert.equal(setupFailure(error).uncertain, false);
        return true;
      },
    );
  }
  assert.equal(calls, 0);
});

test('the console rejects requests to create sample content before transport', async () => {
  let calls = 0;
  await assert.rejects(
    createSetup(
      env,
      {
        workspaceId: 'one',
        name: 'Sample',
        channel: 'stable',
        origin: 'example' as 'created',
        payload: suppliedPayload,
        key: '11111111-1111-4111-8111-111111111111',
      },
      async () => {
        calls++;
        return Response.json({});
      },
    ),
    /Invalid origin/,
  );
  assert.equal(calls, 0);
});

test('invalid imported payload is a definitive validation failure before transport', async () => {
  let calls = 0;
  await assert.rejects(
    createSetup(
      env,
      {
        workspaceId: 'one',
        name: 'Reviewed bundle',
        channel: 'stable',
        origin: 'imported',
        key: '11111111-1111-4111-8111-111111111111',
        payload: {
          schemaVersion: 1,
          files: [{ path: '../escape', kind: 'instruction', text: '' }],
        },
      },
      async () => {
        calls++;
        throw new Error('Unexpected transport');
      },
    ),
    (error) => {
      assert.ok(error instanceof SetupValidationError);
      assert.equal(setupFailure(error).uncertain, false);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('invalid setup is a definitive rejection while lost responses stay uncertain', async () => {
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
    workspaceId: 'one',
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
