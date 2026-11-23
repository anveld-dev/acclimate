import { requireSession, type Environment } from './selection';

type BlockedVersion = { digest: string; removedBy: string; note: string | null; createdAt: string };

// This endpoint is newer than the public SDK. Keep its optional listing isolated here.
export async function blockedVersions(
  env: Environment,
  ws: string,
  bundle: string,
  fetcher = fetch,
  digest?: string,
): Promise<BlockedVersion[]> {
  requireSession(env);
  const parts = [ws, bundle, ...(digest === undefined ? [] : [digest])];
  if (parts.some((p) => !p || p === '.' || p === '..')) throw Error('Invalid learning identifier.');
  const path =
    '/v1/workspaces/' +
    encodeURIComponent(ws) +
    '/bundles/' +
    encodeURIComponent(bundle) +
    '/learning/blocked-versions';
  const url = new URL(
    path + (digest === undefined ? '' : '/' + encodeURIComponent(digest)),
    env.CONSOLE_SERVICE_URL,
  );
  const response = await fetcher(url, {
    method: digest === undefined ? 'GET' : 'DELETE',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      authorization: 'Bearer ' + env.CONSOLE_SERVICE_TOKEN,
      'x-acclimate-session': env.CONSOLE_SESSION_TOKEN!,
    },
  });
  if (digest === undefined && response.status === 404) return [];
  if (!response.ok)
    throw Error(
      'Could not ' +
        (digest === undefined
          ? 'list blocked versions.'
          : 'unblock this version. Refresh and check your access.'),
    );
  return digest === undefined ? await response.json() : [];
}
