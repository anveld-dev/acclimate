import { consoleClient } from './console-client';
import { actorScope, creationRecoveryServiceIdentity, requireSession } from './selection';
import { allPages } from './listing';
import { createHash } from 'node:crypto';
import { ApiError, DeliveryError, verifyPayloadBytes } from '@acclimate/sdk';
import type {
  BundlePayload,
  ChannelResolution,
  PromotionPage,
  CompatibilityTarget,
} from '@acclimate/sdk';

export type ConsoleState =
  | { status: 'setup'; missing: string[] }
  | { status: 'error'; message: string; lastSuccessfulRead?: string }
  | {
      status: 'ready';
      canEdit: boolean;
      publicApiUrl: string;
      actorScope: string;
      serviceIdentity: string;
      creationRecoveryServiceIdentity: string;
      compatibilityTarget: CompatibilityTarget;
      lastSuccessfulRead: string;
      source: {
        kind: 'seeded-example' | 'configured-bundle' | 'imported';
        storage: 'postgresql';
        isWorkingTree: false;
      };
      projectId: string;
      bundleId: string;
      projectName?: string;
      bundleName?: string;
      channel: string;
      resolution: ChannelResolution;
      payload: BundlePayload;
      history: PromotionPage;
    };

const observations = new Map<string, string>();
const required = ['CONSOLE_SERVICE_TOKEN', 'CONSOLE_PROJECT', 'CONSOLE_BUNDLE'] as const;

// This module is imported only inside a server function. Never return env or raw errors.
export async function readChannel(
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch,
): Promise<ConsoleState> {
  const observationKey = createHash('sha256')
    .update(
      JSON.stringify([
        env.CONSOLE_SESSION_TOKEN,
        env.CONSOLE_PROJECT,
        env.CONSOLE_BUNDLE,
        env.CONSOLE_CHANNEL,
      ]),
    )
    .digest('hex');
  const priorRead = observations.get(observationKey);
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) return { status: 'setup', missing };
  try {
    requireSession(env);
    const projectId = env.CONSOLE_PROJECT!;
    const bundleId = env.CONSOLE_BUNDLE!;
    const channel = env.CONSOLE_CHANNEL || 'stable';
    const client = consoleClient(env, fetcher);
    const { resolution } = await client.resolveChannel(projectId, bundleId, channel);
    if (!resolution) throw new Error('Missing channel');
    const membership = (
      await allPages((cursor) => client.listProjects({ limit: 100, cursor }))
    ).find((project) => project.id === projectId)?.role;
    const [bytes, history, bundles] = await Promise.all([
      client.getPayload(projectId, bundleId, resolution.version.id),
      client.listPromotions(projectId, bundleId, channel, { limit: 20 }),
      allPages((cursor) => client.listBundles(projectId, { limit: 100, cursor })),
    ]);
    const payload = verifyPayloadBytes(bytes, resolution.version.digest);
    const bundle = bundles.find((entry) => entry.id === bundleId);
    if (!bundle) throw new Error('Missing bundle');
    const observedAt = new Date().toISOString();
    if (observations.size > 1000) observations.clear();
    observations.set(observationKey, observedAt);
    return {
      status: 'ready',
      publicApiUrl: env.CONSOLE_PUBLIC_API_URL!,
      actorScope: actorScope(env),
      creationRecoveryServiceIdentity: creationRecoveryServiceIdentity(env),
      serviceIdentity: createHash('sha256')
        .update(env.CONSOLE_SERVICE_URL || '')
        .digest('hex')
        .slice(0, 32),
      compatibilityTarget: bundle.compatibilityTarget,
      lastSuccessfulRead: observedAt,
      canEdit:
        env.CONSOLE_ALLOW_EDITS === 'true' && (membership === 'editor' || membership === 'admin'),
      source: {
        kind: bundle.origin === 'example'
          ? 'seeded-example'
          : bundle.origin === 'imported' ? 'imported' : 'configured-bundle',
        storage: 'postgresql',
        isWorkingTree: false,
      },
      projectId,
      bundleId,
      bundleName: bundle.name,
      channel,
      resolution,
      payload,
      history,
    };
  } catch (error) {
    if (error instanceof DeliveryError && error.code === 'digest_mismatch')
      return {
        status: 'error',
        lastSuccessfulRead: priorRead,
        message: 'Content verification failed. No files were displayed.',
      };
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403)
        return {
          status: 'error',
          lastSuccessfulRead: priorRead,
          message: 'Access denied. Sign in or ask your workspace administrator for access.',
        };
      if (error.status === 404)
        return {
          status: 'error',
          lastSuccessfulRead: priorRead,
          message: 'Bundle or channel not found. Check the configured project, bundle and channel.',
        };
    }
    return {
      status: 'error',
      lastSuccessfulRead: priorRead,
      message:
        'Could not read the service. Check the connection and server configuration, then retry.',
    };
  }
}
