import { scopedEnvironment, actorScope, type Environment } from './selection';
import { readAccessState } from './access-core';
import { allPages } from './listing';
import { setupClient } from './setup';
import { parseConsoleLocation } from '../navigation';
export async function navigationState(
  env: Environment,
  path: string,
  fetcher: typeof fetch = fetch,
) {
  const access = await readAccessState(env, fetcher);
  const location = parseConsoleLocation(path);
  const workspaceId = location?.workspaceId ?? env.CONSOLE_WORKSPACE;
  const project = access.ok ? access.projects.find((p) => p.id === workspaceId) : undefined;
  const base = {
    access,
    actorScope: actorScope(env),
    location,
    workspaceId: project?.id,
    workspaceName: project?.name,
    role: project?.role,
    bundleId: location?.bundleId,
    bundleName: undefined as string | undefined,
    channels: [] as { name: string; revision: string }[],
  };
  if (!project || !location?.bundleId) return base;
  try {
    const client = setupClient(scopedEnvironment(env, { workspaceId: project.id }), fetcher);
    const bundles = await allPages((cursor) =>
      client.listBundles(project.id, { limit: 100, cursor }),
    );
    const bundle = bundles.find((b) => b.id === location.bundleId);
    if (!bundle) return base;
    return {
      ...base,
      bundleName: bundle.name,
      channels: await allPages((cursor) =>
        client.listChannels(project.id, bundle.id, { limit: 100, cursor }),
      ),
    };
  } catch {
    return base;
  }
}
export type NavigationState = Awaited<ReturnType<typeof navigationState>>;
