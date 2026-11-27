import { AcclimateClient, type ClientOptions } from './client.js';
import { resolveAndCache } from './cache.js';
import { defaultCacheDir, prepareFiles, type PrepareOptions } from './prepare.js';
import { AcclimateUsageError } from './errors.js';
import { releasePayload, rollbackChannel, type ReleaseOptions, type ReleaseResult, type RollbackOptions } from './release.js';
import type { Bundle, BundlePayload, VerifiedVersion } from './types.js';

export async function findBundle(client: Pick<AcclimateClient, 'listBundles'>, workspaceId: string, name: string) {
  let cursor: string | undefined;
  let match: Bundle | undefined;
  do {
    const page = await client.listBundles(workspaceId, { cursor, limit: 100 });
    for (const bundle of page.items) {
      if (bundle.name !== name) continue;
      if (match)
        throw new AcclimateUsageError('Multiple bundles share that name. Use a unique bundle name', 'bundle');
      match = bundle;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  if (!match) throw new AcclimateUsageError('No bundle with that name exists in the workspace', 'bundle');
  return match;
}

export interface AcclimateOptions extends Partial<ClientOptions> {
  workspaceId?: string;
  cacheDir?: string;
}

export type JobOptions =
  | { channel: string; versionId?: never }
  | { channel?: never; versionId: string };

export interface AcclimateJob {
  version: VerifiedVersion;
  prepare<T>(nativePrepare: (version: VerifiedVersion) => T): T;
  prepare(destination: string, options?: PrepareOptions): ReturnType<typeof prepareFiles>;
}

export function createAcclimate(options: AcclimateOptions = {}) {
  const {
    baseUrl = process.env.ACCLIMATE_URL,
    token = process.env.ACCLIMATE_TOKEN,
    workspaceId = process.env.ACCLIMATE_WORKSPACE,
    scope = workspaceId,
    cacheDir,
    ...clientOptions
  } = options;
  if (!baseUrl || !token || !workspaceId || !scope)
    throw new AcclimateUsageError('Set ACCLIMATE_URL, ACCLIMATE_WORKSPACE and ACCLIMATE_TOKEN', 'configuration');
  const client = new AcclimateClient({ ...clientOptions, baseUrl, token, scope });
  return {
    /**
     * Upload `payload` as a new version of the named bundle and release it on the channel.
     * A payload identical to the channel's current version changes nothing and returns it.
     * A channel that moved during the call is refused with `ApiError` code `revision_conflict`.
     */
    async release(bundle: string, payload: BundlePayload, options: ReleaseOptions): Promise<ReleaseResult> {
      const { id } = await findBundle(client, workspaceId, bundle);
      return releasePayload(client, workspaceId, id, payload, options);
    },
    /** Release the version the channel served before its latest release. */
    async rollback(bundle: string, options: RollbackOptions): Promise<ReleaseResult> {
      const { id } = await findBundle(client, workspaceId, bundle);
      return rollbackChannel(client, workspaceId, id, options);
    },
    async job(bundle: string, options: JobOptions): Promise<AcclimateJob> {
      const { channel, versionId } = options;
      const { id: bundleId } = await findBundle(client, workspaceId, bundle);
      const target = { workspaceId, bundleId };
      const version = await resolveAndCache(
        client,
        channel !== undefined ? { ...target, channel } : { ...target, versionId: versionId! },
        { cacheDir: cacheDir ?? await defaultCacheDir() },
      );
      const verified = structuredClone(version);
      function prepare<T>(nativePrepare: (version: VerifiedVersion) => T): T;
      function prepare(destination: string, options?: PrepareOptions): ReturnType<typeof prepareFiles>;
      function prepare<T>(destination: string | ((version: VerifiedVersion) => T), options?: PrepareOptions) {
        const snapshot = structuredClone(verified);
        return typeof destination === 'function'
          ? destination(snapshot)
          : prepareFiles(snapshot, destination, options);
      }
      return {
        version,
        prepare,
      };
    },
  };
}
