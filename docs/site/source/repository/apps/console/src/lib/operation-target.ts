/** Canonical targets shared by browser recovery and server replay. Authorization stays server-owned. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateOperationTarget(
  workspaceId: string,
  path: string,
  scope: { workspaceId?: string; bundleId?: string; channel?: string } = {},
) {
  if (
    !/^[A-Za-z0-9_.-]{1,128}$/.test(workspaceId) ||
    workspaceId === '.' ||
    workspaceId === '..' ||
    typeof path !== 'string' ||
    /[%?#\\]/.test(path)
  )
    throw Error('Unsupported durable operation.');
  // The service accepts only the canonical route. Stored records are canonicalised when read.
  const prefix = `/v1/workspaces/${workspaceId}/`;
  if (!path.startsWith(prefix)) throw Error('Operation scope changed.');
  const parts = path.slice(prefix.length).split('/');
  let allowed = parts.length === 1 && parts[0] === 'bundle-setups';
  if (parts[0] === 'bundles' && UUID.test(parts[1] || '')) {
    allowed ||= parts.length === 3 && ['proposals', 'evaluation-requests'].includes(parts[2]);
    if (parts[2] === 'channels' && /^[A-Za-z0-9_-]{1,64}$/.test(parts[3] || '')) {
      allowed ||= parts.length === 5 && ['releases', 'drafts'].includes(parts[4]);
      allowed ||=
        parts.length === 7 &&
        parts[4] === 'drafts' &&
        UUID.test(parts[5]) &&
        ['save', 'publish', 'discard'].includes(parts[6]);
    }
  }
  if (!allowed || new URL(path, 'http://operation.invalid').pathname !== path)
    throw Error('Unsupported durable operation.');
  if (scope.workspaceId && scope.workspaceId !== workspaceId)
    throw Error('Operation scope changed.');
  if (parts[0] === 'bundles' && scope.bundleId && scope.bundleId !== parts[1])
    throw Error('Operation bundle changed.');
  if (parts[2] === 'channels' && scope.channel && scope.channel !== parts[3])
    throw Error('Operation channel changed.');
}
