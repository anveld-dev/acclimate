import * as oidc from 'openid-client';
import { randomBytes } from 'node:crypto';
import type { Environment } from './selection';
import { assertConsoleConfiguration, canonicalRequestUrl } from './configuration';
import { validateReturnDestination } from '../lib/return-destination';

const FLOW_COOKIE = 'acclimate_oidc_flow';
const SESSION_COOKIE = 'acclimate_session';
const TTL = 300_000;
type Flow = { binding: string; verifier: string; nonce: string; expires: number; returnTo: string };
export type IdentityProvider = {
  authorization(
    env: Environment,
    state: string,
    verifier: string,
    nonce: string,
    forceLogin?: boolean,
  ): Promise<string>;
  claims(
    env: Environment,
    url: URL,
    state: string,
    verifier: string,
    nonce: string,
  ): Promise<{
    iss: string;
    sub: string;
    displayName?: string;
    email?: string;
    emailVerified?: boolean;
  }>;
};
async function configuration(env: Environment) {
  const config = await oidc.discovery(
    new URL(env.CONSOLE_OIDC_ISSUER!),
    env.CONSOLE_OIDC_CLIENT_ID!,
    env.CONSOLE_OIDC_CLIENT_SECRET!,
  );
  oidc.enableNonRepudiationChecks(config);
  return config;
}
export function createOidcProvider(discover = configuration): IdentityProvider {
  return {
    async authorization(env, state, verifier, nonce, forceLogin) {
      const config = await discover(env);
      return oidc.buildAuthorizationUrl(config, {
        redirect_uri: `${env.CONSOLE_ORIGIN}/auth/callback`,
        scope: 'openid profile email',
        response_type: 'code',
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        ...(forceLogin ? { prompt: 'login' } : {}),
      }).href;
    },
    async claims(env, url, state, verifier, nonce) {
      const tokens = await oidc.authorizationCodeGrant(await discover(env), url, {
        expectedState: state,
        expectedNonce: nonce,
        pkceCodeVerifier: verifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.iss !== 'string' || typeof claims.sub !== 'string')
        throw new Error('Invalid identity');
      const name = [claims.name, claims.preferred_username].find(
        (value): value is string =>
          typeof value === 'string' && Boolean(value.trim()) && value.trim().length <= 200,
      );
      return {
        iss: claims.iss,
        sub: claims.sub,
        ...(name ? { displayName: name.trim() } : {}),
        ...(typeof claims.email === 'string'
          ? { email: claims.email, emailVerified: claims.email_verified === true }
          : {}),
      };
    },
  };
}
const identityProvider = createOidcProvider();
function cookie(request: Request, name: string) {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function setCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function response(status: number, message: string) {
  return new Response(message, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
function expiredSignIn(request: Request) {
  if (!request.headers.get('accept')?.includes('text/html'))
    return response(400, 'Sign-in expired or could not be verified. Start again.');
  // Fixed markup keeps callback parameters out of the recovery page and its retry link.
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in again · Acclimate</title>
<style>
:root { color-scheme: light dark; font: 100%/1.5 system-ui, sans-serif; }
main { max-width: 28rem; margin: 15vh auto; padding: 1.5rem; }
h1 { font-size: 1.65rem; line-height: 1.2; }
a { display: inline-block; padding: .65rem 1rem; border-radius: .45rem; background: CanvasText; color: Canvas; font-weight: 600; text-decoration: none; }
a:focus-visible { outline: 3px solid Highlight; outline-offset: 3px; }
</style></head><body><main><h1>Sign in again</h1>
<p>Acclimate could not verify this sign-in attempt. Start a new one to open your workspace.</p>
<a href="/auth/login">Restart sign-in</a></main></body></html>`,
    {
      status: 400,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );
}
function redirect(location: string, cookies: string[]) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}
/** Process-local, bounded, single-use login transactions. A restart invalidates pending logins. */
export function createIdentityHandler(
  provider: IdentityProvider = identityProvider,
  fetcher: typeof fetch = fetch,
  now = Date.now,
) {
  const flows = new Map<string, Flow>();
  return async (request: Request, env: Environment): Promise<Response> => {
    try {
      const config = assertConsoleConfiguration(env);
      let url: URL;
      try {
        url = canonicalRequestUrl(request, env);
      } catch {
        return response(400, 'Invalid request host.');
      }
      const action = url.pathname;
      if (url.origin !== env.CONSOLE_ORIGIN) return response(400, 'Invalid request origin.');
      for (const [state, flow] of flows) if (flow.expires <= now()) flows.delete(state);
      if (action === '/auth/login' && request.method === 'GET') {
        const destinations = url.searchParams.getAll('returnTo');
        const returnTo = destinations.length
          ? validateReturnDestination(destinations[0])
          : '/';
        if (!returnTo || destinations.length > 1)
          return response(400, 'Invalid sign-in destination.');
        if (flows.size >= 1000) return response(503, 'Sign-in is busy. Please retry shortly.');
        const state = randomBytes(32).toString('base64url');
        const binding = randomBytes(32).toString('base64url');
        const verifier = oidc.randomPKCECodeVerifier();
        const nonce = oidc.randomNonce();
        flows.set(state, { binding, verifier, nonce, expires: now() + TTL, returnTo });
        try {
          const location = await provider.authorization(
            env,
            state,
            verifier,
            nonce,
            url.searchParams.get('prompt') === 'login',
          );
          return redirect(location, [setCookie(FLOW_COOKIE, binding, TTL / 1000)]);
        } catch (error) {
          flows.delete(state);
          throw error;
        }
      }
      if (action === '/auth/callback' && request.method === 'GET') {
        const state = url.searchParams.get('state') || '';
        const flow = flows.get(state);
        flows.delete(state); // Consume before any asynchronous exchange, including failed callbacks.
        if (!flow || cookie(request, FLOW_COOKIE) !== flow.binding) return expiredSignIn(request);
        const claims = await provider.claims(env, url, state, flow.verifier, flow.nonce);
        if (claims.iss !== env.CONSOLE_OIDC_ISSUER || !claims.sub || claims.sub.length > 512)
          throw new Error('Invalid identity');
        const headers: Record<string, string> = {
          Authorization: `Bearer ${env.CONSOLE_LOGIN_TOKEN}`,
          'Content-Type': 'application/json',
        };
        const prior = cookie(request, SESSION_COOKIE);
        if (prior) headers['X-Acclimate-Session'] = prior;
        const result = await fetcher(`${config.serviceUrl}/v1/auth/sessions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            issuer: claims.iss,
            subject: claims.sub,
            displayName: claims.displayName,
            ...(claims.email
              ? { email: claims.email, emailVerified: claims.emailVerified === true }
              : {}),
          }),
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
        if (!result.ok) throw new Error('Session unavailable');
        const session = (await result.json()) as Record<string, unknown>;
        const seconds = Math.min(
          28_800,
          Math.floor((Date.parse(String(session.expiresAt)) - now()) / 1000),
        );
        if (
          typeof session.secret !== 'string' ||
          !/^[a-zA-Z0-9_-]{32,256}$/.test(session.secret) ||
          !Number.isFinite(seconds) ||
          seconds <= 0
        )
          throw new Error('Invalid session');
        return redirect(flow.returnTo, [
          setCookie(SESSION_COOKIE, session.secret, seconds),
          setCookie(FLOW_COOKIE, '', 0),
        ]);
      }
      if (action === '/auth/logout' && request.method === 'POST') {
        if (request.headers.get('origin') !== env.CONSOLE_ORIGIN)
          return response(403, 'Invalid request origin.');
        const secret = cookie(request, SESSION_COOKIE);
        if (secret) {
          const result = await fetcher(`${config.serviceUrl}/v1/auth/session`, {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${env.CONSOLE_SERVICE_TOKEN}`,
              'X-Acclimate-Session': secret,
            },
            signal: AbortSignal.timeout(10_000),
            redirect: 'error',
          });
          if (result.status !== 204) {
            const value = await result.json().catch(() => null);
            // Only the dedicated authenticated transport can produce this typed proof.
            if (result.status !== 401 || value?.error?.code !== 'invalid_session')
              return response(503, 'Could not sign out. Please retry.');
          }
        }
        return redirect('/auth/login?prompt=login', [setCookie(SESSION_COOKIE, '', 0)]);
      }
      return response(405, 'Method unavailable.');
    } catch {
      return response(
        503,
        'Sign-in could not be completed. Check server configuration or start again.',
      );
    }
  };
}
export const handleIdentity = createIdentityHandler();
