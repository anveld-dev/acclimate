import { workspaceHref } from '../navigation';

/** Keep the originating bundle/channel view when a connection is selected. */
export function connectionHref(
  projectId: string,
  search: { bundleId?: unknown; channel?: unknown; q?: unknown; access?: unknown } = {},
  integrationId?: string,
) {
  const query = new URLSearchParams();
  if (integrationId) query.set('integration', integrationId);
  for (const key of ['bundleId', 'channel'] as const) {
    const value = search[key];
    if (typeof value === 'string' && value) query.set(key, value);
  }
  if (typeof search.q === 'string' && search.q.trim()) query.set('q', search.q.trim());
  if (search.access === 'enabled' || search.access === 'revoked')
    query.set('access', search.access);
  return `${workspaceHref(projectId, 'connections')}${query.size ? `?${query}` : ''}`;
}
