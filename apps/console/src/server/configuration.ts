/** Runtime-only configuration. Importing this module never reads environment or secrets. */
export type ConsoleEnvironment = Record<string, string | undefined>;
export type ConsoleConfiguration = {
  origin: string;
  issuer: string;
  serviceUrl: string;
  publicApiUrl: string;
};
function address(env: ConsoleEnvironment, name: string, https: boolean, originOnly = false) {
  const raw = env[name];
  if (!raw?.trim()) throw new Error(`Missing required console configuration: ${name}.`);
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error(`Invalid console configuration: ${name}.`);
  }
  if (
    !value.host ||
    raw.trim() !== raw ||
    !['https:', ...(https ? [] : ['http:'])].includes(value.protocol) ||
    value.username ||
    value.password ||
    value.search ||
    value.hash ||
    (originOnly && value.origin !== raw) ||
    (!originOnly && value.pathname !== '/' && name !== 'CONSOLE_OIDC_ISSUER')
  )
    throw new Error(`Invalid console configuration: ${name}.`);
  return name === 'CONSOLE_OIDC_ISSUER' ? raw : raw.replace(/\/$/, '');
}
export function rejectObsoleteConsoleModes(env: ConsoleEnvironment) {
  for (const name of ['CONSOLE_MODE', 'ACCLIMATE_MODE']) {
    if (env[name] !== undefined)
      throw new Error(
        `${name} is obsolete. Remove mode configuration and configure production OIDC identity.`,
      );
  }
}
export function assertConsoleConfiguration(env: ConsoleEnvironment): ConsoleConfiguration {
  rejectObsoleteConsoleModes(env);
  const origin = address(env, 'CONSOLE_ORIGIN', true, true);
  const issuer = address(env, 'CONSOLE_OIDC_ISSUER', true);
  const serviceUrl = address(env, 'CONSOLE_SERVICE_URL', false);
  const publicApiUrl = address(env, 'CONSOLE_PUBLIC_API_URL', true);
  for (const name of [
    'CONSOLE_OIDC_CLIENT_ID',
    'CONSOLE_OIDC_CLIENT_SECRET',
    'CONSOLE_LOGIN_TOKEN',
    'CONSOLE_SERVICE_TOKEN',
  ]) {
    if (!env[name]?.trim() || /[\r\n]/.test(env[name]!))
      throw new Error(`Missing or invalid required console configuration: ${name}.`);
  }
  if (env.CONSOLE_LOGIN_TOKEN === env.CONSOLE_SERVICE_TOKEN)
    throw new Error('Console login and service credentials must be distinct.');
  return { origin, issuer, serviceUrl, publicApiUrl };
}
/** Trust only the configured public Host; Forwarded and X-Forwarded-* are ignored. */
export function canonicalRequestUrl(request: Request, env: ConsoleEnvironment): URL {
  const { origin } = assertConsoleConfiguration(env);
  const received = new URL(request.url);
  const host = request.headers.get('host') ?? received.host;
  if (host.toLowerCase() !== new URL(origin).host.toLowerCase())
    throw new Error('Invalid request host.');
  const canonical = new URL(origin);
  canonical.pathname = received.pathname;
  canonical.search = received.search;
  return canonical;
}
