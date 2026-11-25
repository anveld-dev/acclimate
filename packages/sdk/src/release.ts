import { createHash, randomUUID } from 'node:crypto';
import type { AcclimateClient } from './client.js';
import { AcclimateUsageError } from './errors.js';
import { validatePayload } from './validation.js';
import type { BundlePayload, VersionMetadata } from './types.js';

/** What a release, rollback or no-op left on the channel. */
export interface ReleaseResult {
  bundleId: string;
  channel: string;
  /** The channel's revision after the call. */
  revision: string;
  /** The version the channel serves after the call. */
  version: VersionMetadata;
  /** False when the channel already served this payload or version, so nothing was written. */
  changed: boolean;
}

export interface ReleaseOptions {
  /** The channel to release on. Default `stable`. */
  channel?: string;
  /** The reason recorded with the release. Required. */
  reason: string;
}

export interface RollbackOptions {
  channel?: string;
  reason: string;
}

type ReleaseClient = Pick<AcclimateClient, 'inspectSource' | 'createVersion' | 'createRelease' | 'listReleases'>;

/**
 * The digest the service stores for a payload: SHA-256 of its JSON with fields in schema order,
 * no whitespace, and a trailing newline.
 */
export function payloadDigest(payload: BundlePayload): string {
  const canonical = {
    schemaVersion: payload.schemaVersion,
    files: payload.files.map(({ path, kind, text }) => ({ path, kind, text })),
  };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(canonical) + '\n').digest('hex');
}

function requireReason(reason: unknown): string {
  if (typeof reason !== 'string' || !reason.trim())
    throw new AcclimateUsageError('reason is required. It is recorded with the release.', 'reason');
  return reason;
}

/** Upload a payload as a new version on top of the channel's current one and release it. */
export async function releasePayload(
  client: ReleaseClient,
  workspaceId: string,
  bundleId: string,
  payload: BundlePayload,
  { channel = 'stable', reason }: ReleaseOptions,
): Promise<ReleaseResult> {
  requireReason(reason);
  validatePayload(payload);
  const current = await client.inspectSource(workspaceId, bundleId, channel);
  if (current && current.version.digest === payloadDigest(payload))
    return { bundleId, channel, revision: current.revision, version: current.version, changed: false };
  const version = await client.createVersion(
    workspaceId,
    bundleId,
    { parentVersionId: current?.version.id ?? null, payload },
    randomUUID(),
  );
  const release = await client.createRelease(
    workspaceId,
    bundleId,
    channel,
    { versionId: version.id, expectedRevision: current?.revision ?? '0', unevaluatedReason: reason },
    randomUUID(),
  );
  return { bundleId, channel, revision: release.revision, version: release.version, changed: true };
}

/** Point the channel at an existing version of the bundle. */
export async function releaseVersion(
  client: ReleaseClient,
  workspaceId: string,
  bundleId: string,
  versionId: string,
  { channel = 'stable', reason }: ReleaseOptions,
): Promise<ReleaseResult> {
  requireReason(reason);
  const current = await client.inspectSource(workspaceId, bundleId, channel);
  if (current?.version.id === versionId)
    return { bundleId, channel, revision: current.revision, version: current.version, changed: false };
  const release = await client.createRelease(
    workspaceId,
    bundleId,
    channel,
    { versionId, expectedRevision: current?.revision ?? '0', unevaluatedReason: reason },
    randomUUID(),
  );
  return { bundleId, channel, revision: release.revision, version: release.version, changed: true };
}

/** Release the version the channel served before its latest release. */
export async function rollbackChannel(
  client: ReleaseClient,
  workspaceId: string,
  bundleId: string,
  { channel = 'stable', reason }: RollbackOptions,
): Promise<ReleaseResult> {
  requireReason(reason);
  const [latest] = (await client.listReleases(workspaceId, bundleId, channel, { limit: 1 })).items;
  if (!latest?.previousVersionId)
    throw new AcclimateUsageError('The channel has no earlier version to roll back to', 'channel');
  const release = await client.createRelease(
    workspaceId,
    bundleId,
    channel,
    {
      versionId: latest.previousVersionId,
      expectedRevision: latest.revision,
      unevaluatedReason: reason,
    },
    randomUUID(),
  );
  return { bundleId, channel, revision: release.revision, version: release.version, changed: true };
}
