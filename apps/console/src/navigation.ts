import type { BundleScope } from './server/selection';

export type WorkspaceView = 'bundles' | 'connections' | 'delivery' | 'members';
export type BundleView = 'content' | 'changes' | 'releases' | 'connect';
export type ConsoleLocation = {
  projectId: string;
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

export function workspaceHref(projectId: string, view: WorkspaceView = 'bundles') {
  return `/w/${part(projectId)}/${view === 'members' ? 'settings/members' : view}`;
}
export function bundleHref(
  scope: BundleScope,
  view: BundleView,
  search: Record<string, string | number | undefined> = {},
) {
  const base = `/w/${part(scope.projectId)}/bundles/${part(scope.bundleId)}`;
  const path =
    view === 'changes' ? `${base}/changes` : `${base}/channels/${part(scope.channel)}/${view}`;
  const query = new URLSearchParams();
  if (view === 'changes') query.set('channel', scope.channel);
  for (const [key, value] of Object.entries(search))
    if (value !== undefined && value !== '') query.set(key, String(value));
  return path + (query.size ? `?${query}` : '');
}
export function parseConsoleLocation(path: string): ConsoleLocation | null {
  try {
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'w' || !parts[1] || parts.some((p) => !/^[^\x00-\x20\x7f/]{1,200}$/.test(p)))
      return null;
    const projectId = parts[1];
    if (parts.length === 3 && ['bundles', 'connections', 'delivery'].includes(parts[2]))
      return { projectId, view: parts[2] as WorkspaceView };
    if (parts.length === 4 && parts[2] === 'settings' && parts[3] === 'members')
      return { projectId, view: 'members' };
    if (parts[2] !== 'bundles' || !parts[3]) return null;
    const bundleId = parts[3];
    if (parts.length === 5 && parts[4] === 'changes')
      return { projectId, bundleId, view: 'changes' };
    if (
      parts.length === 7 &&
      parts[4] === 'channels' &&
      ['content', 'releases', 'connect'].includes(parts[6])
    )
      return { projectId, bundleId, channel: parts[5], view: parts[6] as BundleView };
    return null;
  } catch {
    return null;
  }
}

/** Query context that is valid after changing the published channel.
 * Drafts belong to a channel; suggestion selection belongs to the bundle.
 * Callers must remount review state for the new channel so entered release reasons reset.
 */
export function channelSwitchSearch(view: BundleView, search: Record<string, unknown>) {
  if (view === 'changes' && !search.draft && !search.proposal && String(search.history) === '1') {
    const result: Record<string, string | number> = { history: 1 };
    for (const key of ['candidate', 'request']) {
      if (typeof search[key] === 'string' && search[key]) result[key] = search[key] as string;
    }
    if (search.tab === 'evaluations' || (search.tab === 'files' && result.candidate))
      result.tab = search.tab;
    if (
      result.candidate &&
      search.tab === 'files' &&
      typeof search.path === 'string' &&
      search.path
    )
      result.path = search.path;
    return result;
  }
  const keys =
    view === 'content'
      ? ['q', 'query', 'kind', 'path']
      : view === 'changes' && !search.draft
        ? ['proposal', 'candidate', 'generation', 'comparison', 'request']
        : [];
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = search[key];
      return typeof value === 'string' || typeof value === 'number' ? [[key, value]] : [];
    }),
  ) as Record<string, string | number>;
}

export const bundleViewLabels: Record<Exclude<BundleView, 'connect'>, string> = {
  content: 'Content',
  changes: 'Changes',
  releases: 'Releases',
};

/** Short breadcrumb only; the detail surface retains the complete path or identity. */
export function bundleDetailLabel(view: BundleView, search: Record<string, unknown>) {
  const short = (value: unknown) => (typeof value === 'string' && value ? value.slice(0, 12) : '');
  if (view === 'content' && typeof search.path === 'string')
    return search.path.split('/').filter(Boolean).at(-1) || undefined;
  if (view !== 'changes') return undefined;
  if (String(search.history) === '1' && !search.draft && !search.proposal) return undefined;
  const draft = short(search.draft),
    proposal = short(search.proposal),
    candidate = short(search.candidate),
    comparison = short(search.comparison);
  if (draft === 'new') return 'New draft';
  if (proposal === 'new') return 'New suggestion';
  if (comparison) return `Evidence ${comparison}`;
  if (candidate) return draft ? `Review draft ${draft}` : `Review ${candidate}`;
  if (draft) return `Draft ${draft}`;
  if (proposal) return `Suggestion ${proposal}`;
  return undefined;
}
