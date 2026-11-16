import { consoleClient } from './console-client';
import { allPages } from './listing';
import { ApiError, validatePayload } from '@acclimate/sdk';
import { exactOperation } from './exact-operation';
import { setupRequest } from '../lib/content-operation';
import type { BundleSetup, CompatibilityTarget, BundlePayload } from '@acclimate/sdk';
import {
  actorScope,
  requireSession,
  SessionRequiredError,
  validSelection,
  scopedEnvironment,
  type Environment,
  type Selection,
} from './selection';
export function setupClient(env: Environment, fetcher: typeof fetch = fetch) {
  requireSession(env);
  return consoleClient(env, fetcher);
}
export function setupError(error: unknown) {
  if (error instanceof SessionRequiredError) return error.message;
  if (error instanceof ApiError && [401, 403].includes(error.status))
    return 'Access denied. Sign in or ask your workspace administrator for access.';
  return 'Could not confirm the service response. Current state is unknown. Refresh to retry; check Releases before repeating a creation.';
}
export async function listSetup(
  env: Environment,
  fetcher: typeof fetch = fetch,
  workspaceOnly = false,
) {
  try {
    const client = setupClient(env, fetcher);
    const projects = await allPages((cursor) => client.listProjects({ limit: 100, cursor }));
    if (workspaceOnly && !projects.some((p) => p.id === env.CONSOLE_PROJECT))
      throw new ApiError(403, 'denied', 'Workspace unavailable', '');
    const selectedProject = projects.some((p) => p.id === env.CONSOLE_PROJECT)
      ? env.CONSOLE_PROJECT
      : projects[0]?.id;
    const channels = (
      await Promise.all(
        projects
          .filter((p) => !workspaceOnly || p.id === selectedProject)
          .map(async (project) => {
            const bundles = await allPages((cursor) =>
              client.listBundles(project.id, { limit: 100, cursor }),
            );
            return Promise.all(
              bundles.map(async (bundle) => ({
                projectId: project.id,
                bundle,
                channels: await allPages((cursor) =>
                  client.listChannels(project.id, bundle.id, { limit: 100, cursor }),
                ),
              })),
            );
          }),
      )
    ).flat();
    return {
      ok: true as const,
      actorScope: actorScope(env),
      serviceIdentity: actorScope({
        ...env,
        CONSOLE_SESSION_TOKEN: undefined,
        CONSOLE_SERVICE_TOKEN: undefined,
      }),
      projects,
      projectId: selectedProject,
      entries: channels,
      canEdit:
        env.CONSOLE_ALLOW_EDITS === 'true' &&
        projects.some((p) => p.id === selectedProject && ['editor', 'admin'].includes(p.role)),
    };
  } catch (error) {
    return {
      ok: false as const,
      requiresSignIn:
        error instanceof SessionRequiredError ||
        (error instanceof ApiError && error.status === 401),
      message: setupError(error),
    };
  }
}
export async function authorizeSelection(
  env: Environment,
  input: unknown,
  fetcher: typeof fetch = fetch,
): Promise<Selection> {
  if (!validSelection(input)) throw new Error('Invalid selection.');
  const client = setupClient(env, fetcher);
  const resolved = await client.resolveChannel(input.projectId, input.bundleId, input.channel);
  if (!resolved.resolution) throw new Error('Channel unavailable.');
  return input;
}
export async function createSetup(
  env: Environment,
  input: {
    projectId: string;
    compatibilityTarget?: CompatibilityTarget;
    name: string;
    channel: string;
    origin: 'created' | 'imported' | 'example';
    payload?: BundlePayload;
    key: string;
  },
  fetcher: typeof fetch = fetch,
) {
  let body: ReturnType<typeof setupRequest>;
  try {
    setupClient(env, fetcher);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.channel))
      throw new Error('Use a channel name with letters, numbers, hyphens or underscores.');
    if (env.CONSOLE_ALLOW_EDITS !== 'true') throw new Error('Editing is disabled.');
    if (
      !input.name.trim() ||
      input.name.length > 200 ||
      /[\x00-\x1f\x7f]/.test(input.name) ||
      !/^[a-f0-9-]{36}$/i.test(input.key)
    )
      throw new Error('Invalid setup request.');
    if (!['created', 'imported', 'example'].includes(input.origin))
      throw new Error('Invalid origin.');
    body = setupRequest(input);
    validatePayload(body.payload);
  } catch (error) {
    throw new SetupValidationError(
      error instanceof Error ? error.message : 'Invalid setup request.',
    );
  }
  return exactOperation<BundleSetup>(
    scopedEnvironment(env, { projectId: input.projectId }),
    {
      projectId: input.projectId,
      key: input.key,
      operationPath: `/v1/projects/${encodeURIComponent(input.projectId)}/bundle-setups`,
      body: JSON.stringify(body),
    },
    fetcher,
  );
}

export class SetupValidationError extends Error {}
export function setupFailure(error: unknown) {
  const definitive =
    error instanceof SetupValidationError ||
    (error instanceof ApiError && [400, 413, 422].includes(error.status));
  return {
    ok: false as const,
    message: error instanceof SetupValidationError ? error.message : setupError(error),
    uncertain: !definitive,
  };
}
