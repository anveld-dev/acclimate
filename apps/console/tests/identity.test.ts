import { consoleEnvironment } from './console-fixture';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityHandler, type IdentityProvider } from '../src/server/identity';
import { signInHref, validateReturnDestination } from '../src/lib/return-destination';

const env = {
  ...consoleEnvironment,
  CONSOLE_ORIGIN: 'https://console.example',
  CONSOLE_OIDC_ISSUER: 'https://identity.example',
  CONSOLE_OIDC_CLIENT_ID: 'console',
  CONSOLE_OIDC_CLIENT_SECRET: 'private-client',
  CONSOLE_LOGIN_TOKEN: 'login-only',
  CONSOLE_SERVICE_TOKEN: 'console-only',
};
function fixture(reject = false) {
  let state = '';
  let exchanges = 0;
  const calls: { url: string; init?: RequestInit }[] = [];
  const provider: IdentityProvider = {
    async authorization(_env, value, verifier, nonce) {
      state = value;
      assert.ok(verifier);
      assert.ok(nonce);
      return 'https://identity.example/authorize';
    },
    async claims(_env, _url, expected, verifier, nonce) {
      exchanges++;
      assert.equal(expected, state);
      assert.ok(verifier);
      assert.ok(nonce);
      if (reject) throw new Error('bad token secret');
      return { iss: env.CONSOLE_OIDC_ISSUER, sub: 'person' };
    },
  };
  const handler = createIdentityHandler(provider, (async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(
      JSON.stringify({
        sessionId: 'id',
        userId: 'user',
        secret: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 36_000_000).toISOString(),
      }),
    );
  }) as typeof fetch);
  return { handler, calls, state: () => state, exchanges: () => exchanges };
}
async function start(f: ReturnType<typeof fixture>, returnTo?: string) {
  const query = returnTo === undefined ? '' : `?${new URLSearchParams({ returnTo })}`;
  const login = await f.handler(new Request(`https://console.example/auth/login${query}`), env);
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  const binding = login.headers.get('set-cookie')!.split(';')[0];
  assert.match(login.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Lax; Max-Age=300/);
  return new Request(`https://console.example/auth/callback?state=${f.state()}&code=code`, {
    headers: { cookie: binding },
  });
}
test('missing and obsolete configuration fails closed', async () => {
  const f = fixture();
  assert.equal(
    (await f.handler(new Request('https://console.example/auth/login'), {})).status,
    503,
  );
  assert.equal(
    (await f.handler(new Request('https://console.example/auth/login'), { CONSOLE_MODE: 'hosted' }))
      .status,
    503,
  );
});
test('validated callback creates session with separate login token, secure bounded cookie, no browser tokens and rejects replay', async () => {
  const f = fixture();
  const initial = await start(f);
  const request = new Request(initial, {
    headers: { cookie: `${initial.headers.get('cookie')}; acclimate_session=stale-session` },
  });
  const result = await f.handler(request, env);
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), '/setup');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.match(
    result.headers.get('set-cookie')!,
    /acclimate_session=a+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800/,
  );
  assert.equal(new Headers(f.calls[0].init?.headers).get('authorization'), 'Bearer login-only');
  assert.equal(new Headers(f.calls[0].init?.headers).get('x-acclimate-session'), 'stale-session');
  assert.deepEqual(JSON.parse(String(f.calls[0].init?.body)), {
    issuer: env.CONSOLE_OIDC_ISSUER,
    subject: 'person',
  });
  assert.equal(await result.text(), '');
  assert.equal((await f.handler(request, env)).status, 400);
  assert.equal(f.exchanges(), 1);
});
test('sign-in preserves a scoped destination with search and fragment only from its server transaction', async () => {
  const f = fixture();
  const returnTo = '/w/shared-workspace/content?skill=review%20guide&tab=versions#current';
  const callback = await start(f, returnTo);
  const tampered = new URL(callback.url);
  tampered.searchParams.set('returnTo', 'https://attacker.example/');
  const result = await f.handler(new Request(tampered, callback), env);
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), returnTo);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.handler(callback, env)).status, 400);
});
test('callback returnTo cannot override the default destination', async () => {
  const f = fixture();
  const callback = await start(f);
  const url = new URL(callback.url);
  url.searchParams.set('returnTo', '/w/untrusted/content');
  const result = await f.handler(new Request(url, callback), env);
  assert.equal(result.headers.get('location'), '/setup');
});
test('unsafe, malformed, oversized, and auth-loop destinations fail before authorization', async () => {
  const destinations = [
    '',
    'https://attacker.example/',
    'https://console.example/w/shared/content',
    '//attacker.example/path',
    '/\\attacker.example/path',
    '/%2fattacker.example/path',
    '/%5cattacker.example/path',
    '/w/shared\ncontent',
    '/w/shared?query=%0d%0aLocation:https://attacker.example',
    '/w/shared?query=%00',
    '/w/shared?query=%7f',
    '/w/shared?query=%C2%85',
    '/w/%',
    '/w/%GG',
    '/w/%FF',
    '/auth',
    '/auth/login',
    '/auth/callback?state=other',
    '/auth/logout',
    '/w/../auth/login',
    '/w/%2e%2e/auth/login',
    '/%61uth/login',
    '/%2561uth/login',
    '/auth%2flogin',
    '/w/%2e%2e%2fauth/login',
    '/w/' + 'a'.repeat(2048),
  ];
  for (const returnTo of destinations) {
    const f = fixture();
    const result = await f.handler(
      new Request(`https://console.example/auth/login?${new URLSearchParams({ returnTo })}`),
      env,
    );
    assert.equal(result.status, 400, JSON.stringify(returnTo));
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.has('set-cookie'), false);
    assert.equal(f.state(), '');
    assert.equal(f.exchanges(), 0);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  const duplicate = await f.handler(
    new Request('https://console.example/auth/login?returnTo=/setup&returnTo=/w/shared/content'),
    env,
  );
  assert.equal(duplicate.status, 400);
  assert.equal(f.state(), '');
});
test('browser-safe sign-in links validate and encode the complete relative destination', () => {
  const destination = '/w/shared/content?filter=auth%2Flogin#details';
  assert.equal(validateReturnDestination(destination), destination);
  assert.equal(
    new URL(signInHref(destination), env.CONSOLE_ORIGIN).searchParams.get('returnTo'),
    destination,
  );
  assert.equal(signInHref(), '/auth/login');
  assert.equal(signInHref('//attacker.example'), '/auth/login');
  assert.equal(signInHref('/auth/login'), '/auth/login');
  assert.equal(validateReturnDestination('/w/a/../shared/content'), '/w/shared/content');
});
test('provider rejection consumes flow and never calls session authority or discloses error', async () => {
  const f = fixture(true);
  const request = await start(f);
  const result = await f.handler(request, env);
  assert.equal(result.status, 503);
  assert.doesNotMatch(await result.text(), /secret/);
  assert.equal((await f.handler(request, env)).status, 400);
  assert.equal(f.calls.length, 0);
});
test('callback browser binding and expired state are enforced', async () => {
  const f = fixture();
  await start(f);
  assert.equal(
    (await f.handler(new Request(`https://console.example/auth/callback?state=${f.state()}`), env))
      .status,
    400,
  );
  assert.equal(f.exchanges(), 0);
  let clock = 0;
  let expiredState = '';
  const expiry = createIdentityHandler(
    {
      authorization: async (_env, state) => {
        expiredState = state;
        return 'https://identity.example';
      },
      claims: async () => {
        throw Error('must not exchange');
      },
    },
    fetch,
    () => clock,
  );
  const login = await expiry(new Request('https://console.example/auth/login'), env);
  clock = 300001;
  assert.equal(
    (
      await expiry(
        new Request(`https://console.example/auth/callback?state=${expiredState}`, {
          headers: { cookie: login.headers.get('set-cookie')! },
        }),
        env,
      )
    ).status,
    400,
  );
});
test('logout requires POST and same origin, revokes using console transport and session', async () => {
  const f = fixture();
  assert.equal(
    (await f.handler(new Request('https://console.example/auth/logout'), env)).status,
    405,
  );
  assert.equal(
    (await f.handler(new Request('https://console.example/auth/logout', { method: 'POST' }), env))
      .status,
    403,
  );
  const result = await f.handler(
    new Request('https://console.example/auth/logout', {
      method: 'POST',
      headers: { origin: env.CONSOLE_ORIGIN, cookie: 'acclimate_session=browser-session' },
    }),
    env,
  );
  assert.equal(result.status, 303);
  assert.equal(f.calls[0].init?.method, 'DELETE');
  assert.equal(result.headers.get('location'), '/auth/login?prompt=login');
  assert.equal(new Headers(f.calls[0].init?.headers).get('authorization'), 'Bearer console-only');
  assert.equal(new Headers(f.calls[0].init?.headers).get('x-acclimate-session'), 'browser-session');
  assert.match(result.headers.get('set-cookie')!, /Max-Age=0/);
});
test('uncommitted success and generic service errors keep logout cookie', async () => {
  for (const status of [200, 202, 500, 401, 404]) {
    const handler = createIdentityHandler(
      undefined,
      (async () => new Response(null, { status })) as typeof fetch,
    );
    const result = await handler(
      new Request('https://console.example/auth/logout', {
        method: 'POST',
        headers: { origin: env.CONSOLE_ORIGIN, cookie: 'acclimate_session=browser-session' },
      }),
      env,
    );
    assert.equal(result.status, 503);
    assert.equal(result.headers.has('set-cookie'), false);
  }
});

test('typed invalid session clears stale cookie after dedicated transport response', async () => {
  const handler = createIdentityHandler(undefined, (async () =>
    Response.json({ error: { code: 'invalid_session' } }, { status: 401 })) as typeof fetch);
  const result = await handler(
    new Request('https://console.example/auth/logout', {
      method: 'POST',
      headers: { origin: env.CONSOLE_ORIGIN, cookie: 'acclimate_session=stale' },
    }),
    env,
  );
  assert.equal(result.status, 303);
  assert.match(result.headers.get('set-cookie')!, /Max-Age=0/);
});

test('maintained OIDC SDK rejects invalid token and mismatched state before identity is accepted', async () => {
  const oidc = await import('openid-client');
  const { createOidcProvider } = await import('../src/server/identity');
  const config = new oidc.Configuration(
    {
      issuer: env.CONSOLE_OIDC_ISSUER,
      authorization_endpoint: `${env.CONSOLE_OIDC_ISSUER}/authorize`,
      token_endpoint: `${env.CONSOLE_OIDC_ISSUER}/token`,
      jwks_uri: `${env.CONSOLE_OIDC_ISSUER}/jwks`,
    },
    env.CONSOLE_OIDC_CLIENT_ID,
    env.CONSOLE_OIDC_CLIENT_SECRET,
  );
  let tokenCalls = 0;
  config[oidc.customFetch] = async () => {
    tokenCalls++;
    return new Response(
      JSON.stringify({
        access_token: 'private-access',
        token_type: 'Bearer',
        id_token: 'invalid.jwt.signature',
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  const provider = createOidcProvider(async () => config);
  await assert.rejects(
    provider.claims(
      env,
      new URL(`${env.CONSOLE_ORIGIN}/auth/callback?state=wrong&code=code`),
      'expected',
      'verifier',
      'nonce',
    ),
  );
  assert.equal(tokenCalls, 0);
  await assert.rejects(
    provider.claims(
      env,
      new URL(`${env.CONSOLE_ORIGIN}/auth/callback?state=expected&code=code`),
      'expected',
      'verifier',
      'nonce',
    ),
  );
  assert.equal(tokenCalls, 1);
});

test('logout sign-in requests credentials while normal sign-in preserves provider SSO', async () => {
  const oidc = await import('openid-client');
  const { createOidcProvider } = await import('../src/server/identity');
  const config = new oidc.Configuration(
    {
      issuer: env.CONSOLE_OIDC_ISSUER,
      authorization_endpoint: `${env.CONSOLE_OIDC_ISSUER}/authorize`,
    },
    env.CONSOLE_OIDC_CLIENT_ID,
    env.CONSOLE_OIDC_CLIENT_SECRET,
  );
  const provider = createOidcProvider(async () => config);
  const standard = new URL(await provider.authorization(env, 'state', 'verifier', 'nonce'));
  const afterLogout = new URL(
    await provider.authorization(env, 'state', 'verifier', 'nonce', true),
  );
  assert.equal(standard.searchParams.get('prompt'), null);
  assert.equal(afterLogout.searchParams.get('prompt'), 'login');
  assert.equal(afterLogout.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(afterLogout.searchParams.get('redirect_uri'), env.CONSOLE_ORIGIN + '/auth/callback');
});
