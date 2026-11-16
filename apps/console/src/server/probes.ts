import { assertConsoleConfiguration, type ConsoleEnvironment } from './configuration';
const options = { headers: { 'Cache-Control': 'no-store' } };
export function healthResponse() {
  return Response.json({ status: 'ok' }, options);
}
/** Readiness proves configured console and bounded upstream readiness, never IdP availability. */
export async function readinessResponse(env: ConsoleEnvironment, fetcher: typeof fetch = fetch) {
  try {
    const config = assertConsoleConfiguration(env);
    const upstream = await fetcher(`${config.serviceUrl}/ready`, {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
      cache: 'no-store',
    });
    if (!upstream.ok) throw new Error('Upstream not ready');
    return Response.json({ status: 'ready' }, options);
  } catch {
    return Response.json({ status: 'not_ready' }, { ...options, status: 503 });
  }
}
