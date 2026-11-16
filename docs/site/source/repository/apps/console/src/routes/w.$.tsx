import { ArrowLeft, GitBranch } from 'lucide-react';
import { PageHeader } from '../components/page-header';
import { Button } from '@/components/ui/button';
import { WorkspaceMenuButton } from '../components/workspace-chrome';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  parseConsoleLocation,
  bundleHref,
  bundleViewLabels,
  channelSwitchSearch,
  workspaceHref,
  type BundleView,
} from '../navigation';
import { readWorkspaceBundles } from '../server/setup-actions';
import { readConsole } from '../server/read-console';
import { readConnections } from '../server/integration-actions';
import { readWorkspaceAccess } from '../server/access-actions';
import { BundleLibrary } from '../components/bundle-library';
import { BundleContent } from '../components/bundle-content';
import { BundleChanges } from '../components/bundle-changes';
import { SdkSetup } from '../components/sdk-setup';
import { BundleReleases } from '../components/bundle-releases';
import { WorkspaceConnections } from '../components/workspace-connections';
import { WorkspaceMembers } from '../components/workspace-members';
import { ConsoleLink, consoleDestination } from '../components/console-link';
import { ConnectionNotice } from '../components/shared';
import { useNavigation } from '../components/use-navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';

export const Route = createFileRoute('/w/$')({
  validateSearch: (search: Record<string, unknown>): Record<string, string | number> =>
    Object.fromEntries(
      Object.entries(search).filter(
        ([key, value]) =>
          [
            'channel',
            'path',
            'kind',
            'query',
            'q',
            'draft',
            'proposal',
            'candidate',
            'generation',
            'comparison',
            'request',
            'history',
            'tab',
            'integration',
            'bundleId',
          ].includes(key) &&
          (typeof value === 'string' || typeof value === 'number'),
      ),
    ) as Record<string, string | number>,
  loaderDeps: ({ search }) => ({ search }),
  loader: async ({ params, deps }) => {
    const location = parseConsoleLocation('/w/' + params._splat);
    if (!location) return { kind: 'missing' as const };
    if (location.view === 'bundles')
      return {
        kind: 'library' as const,
        location,
        result: await readWorkspaceBundles({ data: { projectId: location.projectId } }),
      };
    if (location.view === 'connections')
      return {
        kind: 'connections' as const,
        location,
        result: await readConnections({
          data: {
            projectId: location.projectId,
            integrationId:
              typeof deps.search.integration === 'string' ? deps.search.integration : undefined,
          },
        }),
      };
    if (location.view === 'members')
      return {
        kind: 'members' as const,
        location,
        result: await readWorkspaceAccess({ data: { projectId: location.projectId } }),
      };
    const scope = {
      projectId: location.projectId,
      bundleId: location.bundleId!,
      channel: location.channel || String(deps.search.channel || 'stable'),
    };
    return {
      kind: 'bundle' as const,
      location,
      scope,
      state: await readConsole({ data: { scope } }),
    };
  },
  component: ScopedPage,
});
function ScopedPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigation = useNavigation();
  const workspaceKey = `${navigation?.actorScope}:${navigation?.role}:${data.kind === 'missing' ? '' : data.location.projectId}`;
  if (data.kind === 'missing')
    return (
      <div role="alert">
        <h1>Page not found</h1>
        <p>Choose a workspace from the sidebar.</p>
      </div>
    );
  if (data.kind === 'library')
    return (
      <BundleLibrary key={workspaceKey} projectId={data.location.projectId} state={data.result} />
    );
  if (data.kind === 'connections')
    return (
      <WorkspaceConnections
        key={workspaceKey}
        projectId={data.location.projectId}
        search={search}
        initial={data.result}
      />
    );
  if (data.kind === 'members')
    return (
      <WorkspaceMembers
        key={workspaceKey}
        projectId={data.location.projectId}
        initial={data.result}
      />
    );
  const { state, scope, location } = data;
  const view = location.view as BundleView;
  if (state.status !== 'ready')
    return (
      <div className="space-y-5">
        <BundleScopeHeader
          name={navigation?.bundleName || scope.bundleId}
          scope={scope}
          view={view}
          search={search}
          description="This bundle is currently unavailable."
        />
        <ConnectionNotice state={state} />
        {navigation?.projectId === scope.projectId &&
          navigation.bundleId === scope.bundleId &&
          navigation.channels.length > 0 && (
            <section className="workspace-panel space-y-3 p-5">
              <h2 className="font-semibold">Open a published channel</h2>
              <p className="text-sm text-muted-foreground">
                This link may point to a channel that no longer exists. Choose one below.
              </p>
              <nav aria-label="Available channels" className="flex flex-wrap gap-3">
                {navigation.channels.map((channel) => (
                  <ConsoleLink
                    key={channel.name}
                    href={bundleHref({ ...scope, channel: channel.name }, 'content')}
                    className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
                  >
                    {channel.name}
                  </ConsoleLink>
                ))}
              </nav>
            </section>
          )}
      </div>
    );
  const description = {
    content: 'The instructions, skills and memory your app receives.',
    changes: 'Edit, evaluate and review updates before publishing.',
    releases: 'See what shipped or restore an earlier release.',
    connect: 'Use this bundle in your agent app.',
  }[view];
  const identity = `${state.actorScope}:${scope.projectId}:${scope.bundleId}:${scope.channel}`;
  return (
    <div className="bundle-page bundle-workspace">
      <BundleScopeHeader
        name={state.bundleName || scope.bundleId}
        scope={scope}
        view={view}
        search={search}
        description={description}
      />
      {view === 'content' ? (
        <BundleContent key={identity} state={state} search={search} />
      ) : view === 'changes' ? (
        <BundleChanges key={identity} state={state} search={search} />
      ) : view === 'releases' ? (
        <BundleReleases key={identity + ':' + state.resolution.revision} state={state} />
      ) : (
        <SdkSetup key={identity} state={state} role={navigation?.role} />
      )}
    </div>
  );
}
function BundleScopeHeader({
  name,
  scope,
  view,
  search,
  description,
}: {
  name: string;
  scope: { projectId: string; bundleId: string; channel: string };
  view: BundleView;
  search: Record<string, unknown>;
  description: string;
}) {
  const isChangeDetail =
    view === 'changes' &&
    Boolean(search.draft || search.proposal || search.candidate || search.comparison);
  const parentLabel = isChangeDetail ? 'Back to changes' : 'Back to bundles';
  return (
    <PageHeader
      title={name}
      description={description}
      variant="bundle"
      label="Bundle"
      utility={
        <>
          <WorkspaceMenuButton />
          <Button asChild variant="ghost" size="sm" className="bundle-scope-return">
            <ConsoleLink
              aria-label={parentLabel}
              href={isChangeDetail ? bundleHref(scope, 'changes') : workspaceHref(scope.projectId)}
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              <span className="bundle-scope-return-label">{parentLabel}</span>
              <span className="bundle-scope-return-short" aria-hidden="true">
                {isChangeDetail ? 'Changes' : 'Bundles'}
              </span>
            </ConsoleLink>
          </Button>
        </>
      }
      actions={<ChannelPicker scope={scope} view={view} search={search} />}
      footer={
        <nav aria-label="Bundle navigation" className="bundle-tabs bundle-scope-navigation">
          {(['content', 'changes', 'releases', 'connect'] as const).map((tab) => (
            <ConsoleLink
              key={tab}
              href={bundleHref(scope, tab)}
              aria-current={view === tab ? 'page' : undefined}
            >
              {bundleViewLabels[tab]}
            </ConsoleLink>
          ))}
        </nav>
      }
    />
  );
}
function ChannelPicker({
  scope,
  view,
  search,
}: {
  scope: { projectId: string; bundleId: string; channel: string };
  view: 'content' | 'changes' | 'releases' | 'connect';
  search: Record<string, unknown>;
}) {
  const nav = useNavigation();
  const navigate = useNavigate();
  const channels = nav?.channels ?? [];
  const options = channels.some((channel) => channel.name === scope.channel)
    ? channels
    : [{ name: scope.channel, revision: '' }, ...channels];
  return (
    <div className="bundle-channel-picker">
      <span className="bundle-channel-label">Channel</span>
      <Select
        value={scope.channel}
        onValueChange={(channel) => {
          void navigate(
            consoleDestination(
              bundleHref({ ...scope, channel }, view, channelSwitchSearch(view, search)),
            ),
          );
        }}
      >
        <SelectTrigger aria-label="Channel" className="bundle-channel-trigger">
          <GitBranch aria-hidden="true" className="size-4" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="end" className="bundle-channel-options">
          {options.map((channel) => (
            <SelectItem key={channel.name} value={channel.name} className="bundle-channel-option">
              {channel.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
