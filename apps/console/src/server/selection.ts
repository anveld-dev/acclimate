import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { rejectObsoleteConsoleModes } from './configuration';
import { getCookie, setCookie } from '@tanstack/react-start/server';
export type Selection = { projectId: string; bundleId: string; channel: string };
export type BundleScope = Selection;
export type ResourceScope = { projectId: string; bundleId?: string; channel?: string };
export type Environment = Record<string, string | undefined>;
// Scope is supplied by the rendered URL/form, never borrowed from another tab's cookie.
export function scopedEnvironment(env: Environment, scope: ResourceScope): Environment {
  if (
    !scope ||
    typeof scope.projectId !== 'string' ||
    !/^[^\x00-\x20\x7f/]{1,200}$/.test(scope.projectId) ||
    [scope.bundleId, scope.channel].some(
      (value) =>
        value !== undefined &&
        (typeof value !== 'string' || !/^[^\x00-\x20\x7f/]{1,200}$/.test(value)),
    )
  )
    throw new Error('Invalid resource scope.');
  return {
    ...env,
    CONSOLE_PROJECT: scope.projectId,
    CONSOLE_BUNDLE: scope.bundleId,
    CONSOLE_CHANNEL: scope.channel,
  };
}
export function bundleEnvironment(env: Environment, scope: BundleScope): Environment {
  if (!validSelection(scope)) throw new Error('Choose an explicit bundle and channel.');
  return scopedEnvironment(env, scope);
}
export const SESSION_COOKIE = 'acclimate_session';
const COOKIE = 'acclimate_selection';
function key(env: Environment) {
  return createHash('sha256')
    .update(`acclimate-selection:${env.CONSOLE_SERVICE_TOKEN || ''}`)
    .digest();
}
export function sealSelection(env: Environment, selection: Selection): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(env), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(selection)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
export function openSelection(env: Environment, cookie?: string): Selection | null {
  try {
    if (!cookie || !env.CONSOLE_SERVICE_TOKEN) return null;
    const bytes = Buffer.from(cookie, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(env), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const value = JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
    );
    return validSelection(value) ? value : null;
  } catch {
    return null;
  }
}
export function validSelection(value: unknown): value is Selection {
  return (
    !!value &&
    typeof value === 'object' &&
    ['projectId', 'bundleId', 'channel'].every(
      (k) =>
        typeof (value as Record<string, unknown>)[k] === 'string' &&
        /^[^\x00-\x20\x7f/]{1,200}$/.test((value as Record<string, string>)[k]),
    )
  );
}
export function selectedEnvironment(
  env: Environment,
  cookie?: string,
  session?: string,
): Environment {
  const selection = openSelection(env, cookie);
  return {
    ...env,
    CONSOLE_SESSION_TOKEN: session,
    ...(selection
      ? {
          CONSOLE_PROJECT: selection.projectId,
          CONSOLE_BUNDLE: selection.bundleId,
          CONSOLE_CHANNEL: selection.channel,
        }
      : {}),
  };
}
export async function requestEnvironment(): Promise<Environment> {
  return selectedEnvironment(process.env, getCookie(COOKIE), getCookie(SESSION_COOKIE));
}
export function storeSelection(env: Environment, selection: Selection) {
  setCookie(COOKIE, sealSelection(env, selection), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
}
export class SessionRequiredError extends Error {
  constructor() {
    super('Sign in to access your workspaces.');
  }
}
export function requireSession(env: Environment) {
  rejectObsoleteConsoleModes(env);
  if (!env.CONSOLE_SESSION_TOKEN) throw new SessionRequiredError();
  if (!env.CONSOLE_SERVICE_TOKEN || !env.CONSOLE_SERVICE_URL)
    throw new Error('Console service transport is not configured.');
}

export function actorScope(env: Environment): string {
  return createHash('sha256')
    .update(`${env.CONSOLE_SERVICE_URL || ''}\0${env.CONSOLE_SESSION_TOKEN || ''}`)
    .digest('hex')
    .slice(0, 32);
}

export function creationRecoveryServiceIdentity(env: Environment): string {
  return actorScope({ ...env, CONSOLE_SESSION_TOKEN: undefined });
}
