import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createIdentityHandler } from '../../apps/console/src/server/identity.ts';
const c = JSON.parse(await readFile(process.argv[2], 'utf8'));
const env = {
  CONSOLE_ORIGIN: 'https://console.example.invalid',
  CONSOLE_OIDC_ISSUER: c.issuer,
  CONSOLE_OIDC_CLIENT_ID: 'bdd-console',
  CONSOLE_OIDC_CLIENT_SECRET: 'fixture-client-secret',
  CONSOLE_LOGIN_TOKEN: c.loginToken,
  CONSOLE_SERVICE_TOKEN: c.consoleToken,
  CONSOLE_SERVICE_URL: c.baseUrl,
  CONSOLE_PUBLIC_API_URL: 'https://api.example.invalid',
};
let state,
  clock = 0;
const provider = {
  authorization: async (_env, value) => {
    state = value;
    return c.issuer + '/authorize?state=' + state;
  },
  claims: async () => {
    if (c.invalid === 'rejected provider claims') throw Error('Rejected fixture claims');
    return { iss: c.issuer, sub: 'browser-person' };
  },
};
const handle = createIdentityHandler(provider, fetch, () => clock);
const sessionCookie = (response) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith('acclimate_session='))
    ?.split(';')[0];
async function begin(prior) {
  const login = await handle(new Request(env.CONSOLE_ORIGIN + '/auth/login'), env);
  assert.equal(login.status, 303);
  const binding = login.headers
    .getSetCookie()
    .find((value) => value.startsWith('acclimate_oidc_flow='))
    ?.split(';')[0];
  const callback = new Request(
    env.CONSOLE_ORIGIN + '/auth/callback?state=' + state + '&code=fixture',
    { headers: { cookie: binding + (prior ? '; ' + prior : '') } },
  );
  return { callback, binding };
}
async function identity(cookie) {
  const response = await fetch(c.baseUrl + '/v1/auth/session', {
    headers: {
      Authorization: 'Bearer ' + c.consoleToken,
      'X-Acclimate-Session': cookie.split('=')[1],
    },
  });
  return { status: response.status, user: response.ok ? await response.json() : null };
}
const first = await begin();
if (c.invalid) {
  let callback = first.callback;
  if (c.invalid === 'a different browser') callback = new Request(callback.url);
  if (c.invalid === 'an unknown state')
    callback = new Request(env.CONSOLE_ORIGIN + '/auth/callback?state=unknown&code=fixture', {
      headers: { cookie: first.binding },
    });
  if (c.invalid === 'an expired transaction') clock = 300001;
  const result = await handle(callback, env);
  console.log(
    JSON.stringify({
      status: result.status,
      sessionIssued: Boolean(sessionCookie(result)),
      replay: (await handle(callback, env)).status,
    }),
  );
} else {
  const result = await handle(first.callback, env);
  const cookie = sessionCookie(result);
  assert.equal(result.status, 303);
  assert.ok(cookie);
  const initial = await identity(cookie);
  if (c.action === 'identityLogin')
    console.log(
      JSON.stringify({
        status: result.status,
        secure: result.headers
          .getSetCookie()
          .some(
            (value) =>
              value.startsWith('acclimate_session=') &&
              value.includes('HttpOnly; Secure; SameSite=Lax; Max-Age=28800'),
          ),
        sessionStatus: initial.status,
        subject: initial.user.subject,
        replay: (await handle(first.callback, env)).status,
      }),
    );
  else {
    const origin =
      c.action === 'identityCrossSite' ? 'https://other.example.invalid' : env.CONSOLE_ORIGIN;
    const logout = await handle(
      new Request(env.CONSOLE_ORIGIN + '/auth/logout', {
        method: 'POST',
        headers: { Origin: origin, cookie },
      }),
      env,
    );
    const after = await identity(cookie);
    if (c.action === 'identityRenew') {
      const next = await begin(cookie);
      const renewed = await handle(next.callback, env);
      const newCookie = sessionCookie(renewed);
      const nextIdentity = await identity(newCookie);
      console.log(
        JSON.stringify({
          oldStatus: after.status,
          status: renewed.status,
          changed: newCookie !== cookie,
          sessionStatus: nextIdentity.status,
          samePerson: nextIdentity.user.userId === initial.user.userId,
        }),
      );
    } else console.log(JSON.stringify({ status: logout.status, sessionStatus: after.status }));
  }
}
