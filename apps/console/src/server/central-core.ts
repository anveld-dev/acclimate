import { requireSession, type Environment } from './selection';
import { mediaTypes, type CentralRequest } from '../lib/central-learning';

function segment(value?: string) {
  if (!value || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value) || value === '.' || value === '..')
    throw Error('Invalid learning identifier.');
  return encodeURIComponent(value);
}
export async function centralRequest(env: Environment, data: CentralRequest, fetcher = fetch) {
  requireSession(env);
  let path = '/v1/workspaces/' + segment(data.workspaceId);
  let method = 'GET';
  let body: BodyInit | undefined;
  let contentType = 'application/json';
  if (data.action === 'provider' || data.action === 'saveProvider') {
    path += '/model-provider';
    if (data.action === 'saveProvider') method = 'PUT';
  } else {
    path += '/bundles/' + segment(data.bundleId) + '/learning';
    switch (data.action) {
      case 'configure':
        method = 'PUT';
        break;
      case 'pause':
      case 'start':
      case 'rollback':
        method = 'POST';
        path += '/' + data.action;
        break;
      case 'create':
        method = 'POST';
        path += '/tasks';
        break;
      case 'edit':
      case 'retire':
      case 'try':
        method = { edit: 'PATCH', retire: 'DELETE', try: 'POST' }[data.action];
        path += '/tasks/' + segment(data.id) + (data.action === 'try' ? '/try' : '');
        break;
      case 'evidence':
        path +=
          '/rounds/' +
          segment(data.id) +
          (data.evaluation ? '?evaluation=' + segment(data.evaluation) : '');
        break;
      case 'tasks':
        path += '/tasks?limit=100' + (data.id ? '&after=' + segment(data.id) : '');
        break;
      case 'progress':
        path += '/tasks/imports/' + segment(data.id);
        break;
      case 'trial':
        path += '/trials/' + segment(data.id);
        break;
      case 'export':
        path += '/held-out-tasks/export';
        break;
      case 'usage':
        path += '/usage';
        break;
      case 'import':
        method = 'POST';
        path +=
          '/tasks/import?filename=' + encodeURIComponent(data.filename || 'conversations.txt');
        if (!data.mediaType || !Object.values(mediaTypes).includes(data.mediaType))
          throw Error('Unsupported file format.');
        contentType = data.mediaType;
        body = Buffer.from(data.payload || '', 'base64');
        break;
      default:
        throw Error('Unknown learning action.');
    }
  }
  if (method !== 'GET' && env.CONSOLE_ALLOW_EDITS !== 'true')
    throw Error('Console edits are disabled.');
  if (method !== 'GET') body ??= data.payload;
  const response = await fetcher(env.CONSOLE_SERVICE_URL!.replace(/\/$/, '') + path, {
    method,
    body,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
    headers: {
      authorization: 'Bearer ' + env.CONSOLE_SERVICE_TOKEN,
      'x-acclimate-session': env.CONSOLE_SESSION_TOKEN!,
      ...(body === undefined ? {} : { 'content-type': contentType }),
    },
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    throw Error(
      data.action === 'saveProvider'
        ? 'Could not save the workspace model provider.'
        : problem?.error?.message || 'Learning service request failed (' + response.status + ').',
    );
  }
  return response.text();
}
