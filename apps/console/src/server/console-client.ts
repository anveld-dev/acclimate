import '@tanstack/react-start/server-only';
import { AcclimateClient } from '@anveld/sdk';
import { requireSession, type Environment } from './selection';
/** Server-only browser transport: never substitute a machine token for a browser session. */
export function consoleClient(env: Environment, fetcher: typeof fetch = fetch) {
  requireSession(env);
  return new AcclimateClient({
    baseUrl: env.CONSOLE_SERVICE_URL!,
    token: env.CONSOLE_SERVICE_TOKEN!,
    sessionToken: env.CONSOLE_SESSION_TOKEN!,
    scope: 'console',
    fetch: fetcher,
    retries: 0,
    timeoutMs: 5000,
  });
}
