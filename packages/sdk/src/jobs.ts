import { randomUUID } from 'node:crypto';
import { AcclimateClient, type ClientOptions } from './client.js';
import { resolveAndCache } from './cache.js';
import { defaultCacheDir, prepareFiles, type PrepareOptions } from './prepare.js';
import { AcclimateUsageError } from './errors.js';
import { assertJson } from './json.js';
import type { Json } from './json.js';
import { createLearningOutcomeReporter, uuidPattern } from './outcomes.js';
import type { Bundle, LearningGrading, LearningOutcomeReceipt, LearningOutcomeRequest, VerifiedVersion } from './types.js';

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

export type JobOptions = {
  input?: Json;
  outcomeId?: string;
} & ({ channel: string; versionId?: never } | { channel?: never; versionId: string });

export interface AcclimateJob {
  version: VerifiedVersion;
  outcomeId: string;
  prepare<T>(nativePrepare: (version: VerifiedVersion) => T): T;
  prepare(destination: string, options?: PrepareOptions): ReturnType<typeof prepareFiles>;
  expect(expected: Json, options?: { input?: Json; output?: Json; grading?: LearningGrading }): Promise<LearningOutcomeReceipt>;
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
    async job(bundle: string, options: JobOptions): Promise<AcclimateJob> {
      const { input, outcomeId = randomUUID(), channel, versionId } = options;
      if (!uuidPattern.test(outcomeId))
        throw new AcclimateUsageError('outcomeId must be a UUID', 'outcomeId');
      const { id: bundleId } = await findBundle(client, workspaceId, bundle);
      const target = { workspaceId, bundleId };
      const version = await resolveAndCache(
        client,
        channel !== undefined ? { ...target, channel } : { ...target, versionId: versionId! },
        { cacheDir: cacheDir ?? await defaultCacheDir() },
      );
      const verified = structuredClone(version);
      const originalInput = structuredClone(input);
      const report = createLearningOutcomeReporter({ client, ...target });
      function prepare<T>(nativePrepare: (version: VerifiedVersion) => T): T;
      function prepare(destination: string, options?: PrepareOptions): ReturnType<typeof prepareFiles>;
      function prepare<T>(destination: string | ((version: VerifiedVersion) => T), options?: PrepareOptions) {
        const snapshot = structuredClone(verified);
        return typeof destination === 'function'
          ? destination(snapshot)
          : prepareFiles(snapshot, destination, options);
      }
      let body: Pick<LearningOutcomeRequest, 'input' | 'expected' | 'output' | 'grading' | 'outcomeId'> | undefined;
      let pending: Promise<LearningOutcomeReceipt> | undefined;
      return {
        version,
        outcomeId,
        prepare,
        async expect(expected, { input = originalInput, output, grading } = {}) {
          if (!body) {
            if (grading !== undefined && grading !== 'exact' && grading !== 'criteria')
              throw new AcclimateUsageError('grading must be "exact" or "criteria"', 'grading');
            assertJson(input, 64 * 1024);
            assertJson(expected, 64 * 1024);
            if (output !== undefined) assertJson(output, 2 * 1024 * 1024);
            body = structuredClone({
              input, expected, outcomeId,
              ...(output === undefined ? {} : { output }),
              ...(grading === undefined ? {} : { grading }),
            });
          }
          if (!pending) {
            pending = report(verified, body).catch(error => {
              pending = undefined;
              throw error;
            });
          }
          return pending;
        },
      };
    },
  };
}
