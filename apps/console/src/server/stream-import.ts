import { request as send } from 'undici';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeStream } from 'node:stream/web';
import { mediaTypes } from '../lib/central-learning';
import { requireSession, type Environment } from './selection';

const timeout = 610_000;
// Node fetch has a shorter response-header deadline than the import handler.
async function sendImport(
  url: URL,
  init: { headers: Record<string, string>; signal: AbortSignal; body: ReadableStream<Uint8Array> },
) {
  const response = await send(url, {
    method: 'POST',
    headers: init.headers,
    signal: init.signal,
    body: Readable.fromWeb(init.body as NodeStream<Uint8Array>),
    headersTimeout: timeout,
    bodyTimeout: timeout,
  });
  return new Response(Readable.toWeb(response.body) as ReadableStream<Uint8Array>, {
    status: response.statusCode,
  });
}

export async function streamImport(request: Request, env: Environment, fetcher = sendImport) {
  if (
    !env.CONSOLE_ORIGIN ||
    request.headers.get('origin') !== env.CONSOLE_ORIGIN ||
    env.CONSOLE_ALLOW_EDITS !== 'true'
  )
    return new Response('Import denied.', { status: 403 });
  if (!env.CONSOLE_SESSION_TOKEN) return new Response('Sign in to import.', { status: 401 });
  requireSession(env);
  const params = new URL(request.url).searchParams;
  const scope = ['workspaceId', 'bundleId'].map((key) => params.get(key) ?? '');
  const media = request.headers.get('content-type') ?? '';
  if (
    scope.some((value) => !/^[a-zA-Z0-9_:-][a-zA-Z0-9_.:-]{0,199}$/.test(value)) ||
    !Object.values(mediaTypes).includes(media) ||
    !request.body
  )
    return new Response('Invalid learning import.', { status: 400 });
  const url = new URL(
    '/v1/workspaces/' + scope[0] + '/bundles/' + scope[1] + '/learning/tasks/import',
    env.CONSOLE_SERVICE_URL,
  );
  url.searchParams.set('filename', params.get('filename') || 'conversations.txt');
  const init = {
    body: request.body,
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]),
    headers: {
      'content-type': media,
      authorization: 'Bearer ' + env.CONSOLE_SERVICE_TOKEN,
      'x-acclimate-session': env.CONSOLE_SESSION_TOKEN!,
    },
  };
  const result = await fetcher(url, init);
  return new Response(result.body, {
    status: result.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });
}
