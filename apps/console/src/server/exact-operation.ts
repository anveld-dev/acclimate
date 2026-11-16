import { createHash } from 'node:crypto';
import { ApiError } from '@acclimate/sdk';
import { requireSession, type Environment } from './selection';
export type ExactRequest = { projectId: string; operationPath: string; key: string; body: string };
export type OperationOutcome =
  | { status: 'not_observed' | 'closed'; operationId: string }
  | {
      status: 'committed';
      operationId: string;
      path: string;
      requestFingerprint?: string;
      result: Record<string, any>;
    };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function canonical(env: Environment, projectId: string, path: string) {
  if (
    !/^[A-Za-z0-9_.-]{1,128}$/.test(projectId) ||
    projectId === '.' ||
    projectId === '..' ||
    typeof path !== 'string' ||
    /[%?#\\]/.test(path)
  )
    throw Error('Unsupported durable operation.');
  const prefix = `/v1/projects/${projectId}/`;
  if (!path.startsWith(prefix)) throw Error('Operation scope changed.');
  const parts = path.slice(prefix.length).split('/');
  let allowed = parts.length === 1 && parts[0] === 'bundle-setups';
  if (parts[0] === 'bundles' && UUID.test(parts[1] || '')) {
    allowed ||= parts.length === 3 && ['proposals', 'evaluation-requests'].includes(parts[2]);
    if (parts[2] === 'channels' && /^[A-Za-z0-9_-]{1,64}$/.test(parts[3] || '')) {
      allowed ||= parts.length === 5 && ['promotions', 'drafts'].includes(parts[4]);
      allowed ||=
        parts.length === 7 &&
        parts[4] === 'drafts' &&
        UUID.test(parts[5]) &&
        ['save', 'publish', 'discard'].includes(parts[6]);
    }
  }
  if (!allowed || new URL(path, 'http://operation.invalid').pathname !== path)
    throw Error('Unsupported durable operation.');
  if (env.CONSOLE_PROJECT && env.CONSOLE_PROJECT !== projectId)
    throw Error('Operation scope changed.');
  if (parts[0] === 'bundles' && env.CONSOLE_BUNDLE && env.CONSOLE_BUNDLE !== parts[1])
    throw Error('Operation bundle changed.');
  if (parts[2] === 'channels' && env.CONSOLE_CHANNEL && env.CONSOLE_CHANNEL !== parts[3])
    throw Error('Operation channel changed.');
}
function validateKey(key: string) {
  if (!UUID.test(key)) throw Error('Invalid operation ID.');
}
function edits(env: Environment) {
  if (env.CONSOLE_ALLOW_EDITS !== 'true')
    throw new ApiError(403, 'denied', 'Editing is disabled for this console.', '');
}

async function request(
  env: Environment,
  path: string,
  method: string,
  key: string | undefined,
  body: string | undefined,
  fetcher: typeof fetch,
) {
  requireSession(env);
  if (!env.CONSOLE_SERVICE_TOKEN) throw Error('Service is not configured.');
  const response = await fetcher(new URL(path, env.CONSOLE_SERVICE_URL!), {
    method,
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${env.CONSOLE_SERVICE_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Acclimate-Session': env.CONSOLE_SESSION_TOKEN!,
      ...(key ? { 'Idempotency-Key': key, 'X-Acclimate-Durable-Operation': 'true' } : {}),
    },
    body,
    signal: AbortSignal.timeout(10000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      value.error?.code || 'request_failed',
      value.error?.message || 'Operation rejected',
      response.headers.get('x-request-id') || '',
      value.error?.details,
    );
  return value;
}
export async function lookupOperation(
  env: Environment,
  input: { projectId: string; key: string; operationPath?: string },
  fetcher: typeof fetch = fetch,
): Promise<OperationOutcome> {
  validateKey(input.key);
  canonical(
    env,
    input.projectId,
    input.operationPath || `/v1/projects/${input.projectId}/bundle-setups`,
  );
  return request(
    env,
    `/v1/projects/${encodeURIComponent(input.projectId)}/operations/${encodeURIComponent(input.key)}${input.operationPath ? `?operationPath=${encodeURIComponent(input.operationPath)}` : ''}`,
    'GET',
    undefined,
    undefined,
    fetcher,
  );
}
export async function closeOperation(
  env: Environment,
  input: { projectId: string; key: string; operationPath?: string },
  fetcher: typeof fetch = fetch,
): Promise<OperationOutcome> {
  edits(env);
  validateKey(input.key);
  canonical(
    env,
    input.projectId,
    input.operationPath || `/v1/projects/${input.projectId}/bundle-setups`,
  );
  return request(
    env,
    `/v1/projects/${encodeURIComponent(input.projectId)}/operations/${encodeURIComponent(input.key)}/close`,
    'POST',
    input.key,
    JSON.stringify({ operationPath: input.operationPath }),
    fetcher,
  );
}
export async function exactOperation<T>(
  env: Environment,
  input: ExactRequest,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  edits(env);
  canonical(env, input.projectId, input.operationPath);
  if (
    !/^[a-f0-9-]{36}$/i.test(input.key) ||
    typeof input.body !== 'string' ||
    new TextEncoder().encode(input.body).length > 2 * 1024 * 1024
  )
    throw Error('Invalid frozen request.');
  JSON.parse(input.body);
  // Receipt precedes every fresh client preflight. The server checks revisions only on first execution.
  const known = await lookupOperation(env, input, fetcher);
  if (known.status === 'committed') {
    const fingerprint = `sha256:${createHash('sha256').update('POST\0').update(input.operationPath).update('\0').update(input.body).digest('hex')}`;
    if (
      known.path !== input.operationPath ||
      (known.requestFingerprint && known.requestFingerprint !== fingerprint)
    )
      throw new ApiError(
        409,
        'idempotency_conflict',
        'Key was used with different request bytes',
        '',
      );
    if (known.requestFingerprint) return known.result as T;
    // Older services omit fingerprints: use the same POST to verify exact bytes under the server lock.
  }
  if (known.status === 'closed')
    throw new ApiError(
      409,
      'operation_closed',
      'This operation was closed. Review a new request.',
      '',
    );
  return request(env, input.operationPath, 'POST', input.key, input.body, fetcher);
}
