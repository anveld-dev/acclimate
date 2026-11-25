import type { BundleScope } from '../server/selection';
export function restoreRequest(
  input: { versionId: string; expectedRevision: string; reason: string },
  scope: BundleScope,
) {
  return {
    operationPath: `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/bundles/${encodeURIComponent(scope.bundleId)}/channels/${encodeURIComponent(scope.channel)}/releases`,
    body: JSON.stringify({
      versionId: input.versionId,
      expectedRevision: input.expectedRevision,
      unevaluatedReason: `Manual rollback (not evaluated): ${input.reason.trim()}`,
    }),
  };
}
export function setupRequest(input: {
  name: string;
  channel: string;
  origin: 'created' | 'imported';
  payload?: unknown;
  compatibilityTarget?: string;
}) {
  return {
    name: input.name,
    channel: input.channel,
    origin: input.origin,
    payload: input.payload,
    compatibilityTarget: input.compatibilityTarget || 'generic',
    reason: 'Initial content setup; no model evaluation was run.',
  };
}
