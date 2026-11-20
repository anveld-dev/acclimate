import type { BundleScope } from './server/selection';

export type WorkspaceView = 'bundles' | 'connections' | 'delivery' | 'members';
export type BundleView = 'content' | 'releases' | 'learning' | 'connect';
export type ConsoleLocation = {
  workspaceId: string;
  bundleId?: string;
  channel?: string;
  view: WorkspaceView | BundleView;
};
const part = (value: string) => encodeURIComponent(value);
/** Revisions are persisted as positive PostgreSQL BIGINT values. */
export function releaseRevision(value: unknown): string | undefined {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value)))
    return;
  const revision = String(value);
  if (/^[1-9][0-9]{0,18}$/.test(revision) && BigInt(revision) <= 9223372036854775807n)
    return revision;
}

export function workspaceHref(workspaceId: string, view: WorkspaceView = 'bundles') {
  return `/w/${part(workspaceId)}/${view === 'members' ? 'settings/members' : view}`;
}
export function bundleHref(
  scope: BundleScope,
  view: BundleView,
  search: Record<string, string | number | undefined> = {},
) {
  const base = `/w/${part(scope.workspaceId)}/bundles/${part(scope.bundleId)}`;
  const path =
    view === 'learning' ? `${base}/learning` : `${base}/channels/${part(scope.channel)}/${view}`;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search))
    if (value !== undefined && value !== '') query.set(key, String(value));
  return path + (query.size ? `?${query}` : '');
}
export function parseConsoleLocation(path: string): ConsoleLocation | null {
  try {
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'w' || !parts[1] || parts.some((p) => !/^[^\x00-\x20\x7f/]{1,200}$/.test(p)))
      return null;
    const workspaceId = parts[1];
    if (parts.length === 3 && ['bundles', 'connections', 'delivery'].includes(parts[2]))
      return { workspaceId, view: parts[2] as WorkspaceView };
    if (parts.length === 4 && parts[2] === 'settings' && parts[3] === 'members')
      return { workspaceId, view: 'members' };
    if (parts[2] !== 'bundles' || !parts[3]) return null;
    const bundleId = parts[3];
    if (parts.length === 5 && parts[4] === 'learning')
      return { workspaceId, bundleId, view: 'learning' };
    if (
      parts.length === 7 &&
      parts[4] === 'channels' &&
      ['content', 'releases', 'connect'].includes(parts[6])
    )
      return { workspaceId, bundleId, channel: parts[5], view: parts[6] as BundleView };
    return null;
  } catch {
    return null;
  }
}

export function channelSwitchSearch(view: BundleView, search: Record<string, unknown>) {
  const keys = view === 'content' ? ['q', 'query', 'kind', 'path'] : [];
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = search[key];
      return typeof value === 'string' || typeof value === 'number' ? [[key, value]] : [];
    }),
  ) as Record<string, string | number>;
}

export const bundleViewLabels: Record<Exclude<BundleView, 'connect'>, string> = {
  content: 'Content',
  releases: 'Releases',
  learning: 'Learning',
};

/** Short breadcrumb only; the detail surface retains the complete path or identity. */
export function bundleDetailLabel(view: BundleView, search: Record<string, unknown>) {
  if (view === 'content' && typeof search.path === 'string')
    return search.path.split('/').filter(Boolean).at(-1) || undefined;
  return undefined;
}
