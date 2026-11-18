import type { BundleScope } from '../server/selection';
export function draftRequest(
  input: Record<string, any>,
  scope: BundleScope,
): { operationPath: string; body: string } {
  const root = `/v1/workspaces/${encodeURIComponent(scope.projectId)}/bundles/${encodeURIComponent(scope.bundleId)}/channels/${encodeURIComponent(scope.channel)}/drafts`;
  if (input.action === 'create')
    return {
      operationPath: root,
      body: JSON.stringify({
        baseVersionId: input.baseVersionId,
        baseRevision: input.baseRevision,
        payload: input.payload,
      }),
    };
  const operationPath = `${root}/${encodeURIComponent(input.id)}/${input.action}`;
  if (input.action === 'save')
    return {
      operationPath,
      body: JSON.stringify({
        expectedGeneration: input.expectedGeneration,
        payload: input.payload,
      }),
    };
  if (input.action === 'discard')
    return {
      operationPath,
      body: JSON.stringify({ expectedGeneration: input.expectedGeneration }),
    };
  if (input.action === 'publish')
    return {
      operationPath,
      body: JSON.stringify({
        expectedGeneration: input.expectedGeneration,
        expectedRevision: input.expectedRevision,
        ...(input.comparisonId
          ? { comparisonId: input.comparisonId }
          : { unevaluatedReason: input.unevaluatedReason || '' }),
      }),
    };
  throw Error('Unsupported draft operation.');
}
export function restoreRequest(
  input: { versionId: string; expectedRevision: string; reason: string },
  scope: BundleScope,
) {
  return {
    operationPath: `/v1/workspaces/${encodeURIComponent(scope.projectId)}/bundles/${encodeURIComponent(scope.bundleId)}/channels/${encodeURIComponent(scope.channel)}/releases`,
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
