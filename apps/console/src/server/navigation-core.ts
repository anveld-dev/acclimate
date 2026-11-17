import { scopedEnvironment, actorScope, type Environment } from './selection';
import { readAccessState } from './access-core';
import { allPages } from './listing';
import { setupClient } from './setup';
import { parseConsoleLocation, workspaceHref, bundleHref } from '../navigation';
export async function navigationState(
  env: Environment,
  path: string,
  fetcher: typeof fetch = fetch,
) {
  const access = await readAccessState(env, fetcher);
  const location = parseConsoleLocation(path);
  const projectId = location?.projectId ?? env.CONSOLE_PROJECT;
  const project = access.ok ? access.projects.find((p) => p.id === projectId) : undefined;
  const base = {
    access,
    actorScope: actorScope(env),
    location,
    projectId: project?.id,
    projectName: project?.name,
    role: project?.role,
    bundleId: location?.bundleId,
    bundleName: undefined as string | undefined,
    channels: [] as { name: string; revision: string }[],
  };
  if (!project || !location?.bundleId) return base;
  try {
    const client = setupClient(scopedEnvironment(env, { projectId: project.id }), fetcher);
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

export async function landingState(
  env: Environment,
  data: { legacy?: string; search?: Record<string, unknown> },
  fetcher: typeof fetch = fetch,
) {
  const access = await readAccessState(env, fetcher);
  if (!access.ok || !access.projects.length) return { href: '/' };
  const project = access.projects.find((p) => p.id === env.CONSOLE_PROJECT) ?? access.projects[0];
  const legacy = data.legacy;
  if (legacy === 'access')
    return {
      href: workspaceHref(project.id, project.role === 'admin' ? 'members' : 'bundles'),
    };
  if (legacy === 'integrations')
    return {
      href: workspaceHref(project.id, project.role === 'admin' ? 'connections' : 'delivery'),
    };
  if (['content', 'releases', 'improvement'].includes(legacy || '') && env.CONSOLE_BUNDLE) {
    const scope = {
      projectId: project.id,
      bundleId: env.CONSOLE_BUNDLE,
      channel: env.CONSOLE_CHANNEL || 'stable',
    };
    const values = Object.fromEntries(
      Object.entries(data.search || {}).filter(
        ([, v]) => typeof v === 'string' || typeof v === 'number',
      ),
    ) as Record<string, string | number>;
    return {
      href: bundleHref(
        scope,
        legacy === 'improvement' ? 'changes' : (legacy as 'content' | 'releases'),
        values,
      ),
    };
  }
  return { href: workspaceHref(project.id, 'bundles') };
}
