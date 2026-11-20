import { ArrowLeft, GitBranch } from 'lucide-react';
import { PageHeader } from '../components/page-header';
import { Button } from '@/components/ui/button';
import { WorkspaceMenuButton } from '../components/workspace-chrome';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
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
import { SdkSetup, UseInAnApp } from '../components/sdk-setup';
import { BundleReleases } from '../components/bundle-releases';
import { WorkspaceConnections } from '../components/workspace-connections';
import { WorkspaceDelivery } from '../components/workspace-delivery';
import { readDeliveryObservations } from '../server/delivery-observations-actions';
import { WorkspaceMembers } from '../components/workspace-members';
import { WorkspaceMachineTokens } from '../components/workspace-machine-tokens';
import { ConsoleLink, consoleDestination } from '../components/console-link';
import { ConnectionNotice, PageTitle } from '../components/shared';
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
            'connectionTab',
            'connection',
            'access',
            'bundleId',
          ].includes(key) &&
          (typeof value === 'string' || typeof value === 'number'),
      ),
    ) as Record<string, string | number>,
  loaderDeps: ({ search }) => ({
    search: Object.fromEntries(Object.entries(search).filter(([key]) => key !== 'connectionTab')),
  }),
  loader: async ({ params, deps }) => {
    const location = parseConsoleLocation('/w/' + params._splat);
    if (!location) return { kind: 'missing' as const };
    if (location.view === 'bundles')
      return {
        kind: 'library' as const,
        location,
        result: await readWorkspaceBundles({ data: { workspaceId: location.workspaceId } }),
      };
    if (location.view === 'connections')
      return {
        kind: 'connections' as const,
        location,
        result: await readConnections({
          data: {
            workspaceId: location.workspaceId,
            connectionId:
              typeof deps.search.connection === 'string' ? deps.search.connection : undefined,
          },
        }),
      };
    if (location.view === 'delivery')
      return {
        kind: 'delivery' as const,
        location,
        result: await readDeliveryObservations({
          data: {
            workspaceId: location.workspaceId,
            connectionId:
              typeof deps.search.connection === 'string' ? deps.search.connection : undefined,
          },
        }),
      };
    if (location.view === 'members')
      return {
        kind: 'members' as const,
        location,
        result: await readWorkspaceAccess({ data: { workspaceId: location.workspaceId } }),
      };
    const scope = {
      workspaceId: location.workspaceId,
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
  const workspaceKey = `${navigation?.actorScope}:${navigation?.role}:${data.kind === 'missing' ? '' : data.location.workspaceId}`;
  if (data.kind === 'missing')
    return (
      <section className="missing-page space-y-4">
        <PageTitle
          title="Page not found"
          description="This workspace link is no longer available."
        />
        <Button asChild variant="outline">
          <Link to="/">Back to bundles</Link>
        </Button>
      </section>
    );
  if (
    (data.kind === 'members' || data.kind === 'connections') &&
    navigation?.workspaceId === data.location.workspaceId &&
    (navigation.role === 'viewer' || navigation.role === 'editor')
  ) {
    const members = data.kind === 'members';
    return (
      <section className="space-y-4">
        <PageTitle
          title={members ? 'Members' : 'Connections'}
          description={
            members
              ? 'A workspace administrator manages member access.'
              : 'A workspace administrator manages app connections. You can view app delivery reports.'
          }
        />
        <Button asChild variant="outline">
          <ConsoleLink
            href={workspaceHref(data.location.workspaceId, members ? 'bundles' : 'delivery')}
          >
            {members ? 'Browse bundles' : 'View delivery'}
          </ConsoleLink>
        </Button>
      </section>
    );
  }
  if (data.kind === 'library')
    return (
      <BundleLibrary
        key={workspaceKey}
        workspaceId={data.location.workspaceId}
        state={data.result}
      />
    );
  if (data.kind === 'connections')
    return (
      <WorkspaceConnections
        key={workspaceKey}
        workspaceId={data.location.workspaceId}
        search={search}
        initial={data.result}
      />
    );
  if (data.kind === 'delivery')
    return (
      <WorkspaceDelivery
        key={workspaceKey}
        initialAppId={typeof search.connection === 'string' ? search.connection : undefined}
        canManage={navigation?.role === 'admin'}
        workspaceId={data.location.workspaceId}
        initial={data.result}
      />
    );
  if (data.kind === 'members')
    return (
      <div className="space-y-6">
        <WorkspaceMembers
          key={workspaceKey}
          workspaceId={data.location.workspaceId}
          initial={data.result}
        />
        <WorkspaceMachineTokens
          key={`tokens-${workspaceKey}`}
          workspaceId={data.location.workspaceId}
        />
      </div>
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
          unavailableChannel={
            navigation?.bundleId === scope.bundleId &&
            !navigation.channels.some((channel) => channel.name === scope.channel)
          }
        />
        <ConnectionNotice state={state} />
        {navigation?.workspaceId === scope.workspaceId &&
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
    releases: 'See what shipped or restore an earlier release.',
    connect: 'Use this bundle in your agent app.',
  }[view];
  const identity = `${state.actorScope}:${scope.workspaceId}:${scope.bundleId}:${scope.channel}`;
  return (
    <div className="bundle-page bundle-workspace">
      <BundleScopeHeader
        name={state.bundleName || scope.bundleId}
        scope={scope}
        view={view}
        search={search}
        description={description}
        apiUrl={state.publicApiUrl}
      />
      {view === 'content' ? (
        <BundleContent key={identity} state={state} search={search} />
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
  unavailableChannel = false,
  apiUrl,
}: {
  name: string;
  scope: { workspaceId: string; bundleId: string; channel: string };
  view: BundleView;
  search: Record<string, unknown>;
  description: string;
  unavailableChannel?: boolean;
  apiUrl?: string;
}) {
  const parentLabel = view === 'connect' ? 'Back to content' : 'Back to bundles';
  const parentHref =
    view === 'connect' ? bundleHref(scope, 'content') : workspaceHref(scope.workspaceId);
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
            <ConsoleLink aria-label={parentLabel} href={parentHref}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              <span className="bundle-scope-return-label">{parentLabel}</span>
              <span className="bundle-scope-return-short" aria-hidden="true">
                {view === 'connect' ? 'Content' : 'Bundles'}
              </span>
            </ConsoleLink>
          </Button>
        </>
      }
      titleAccessory={<ChannelPicker scope={scope} view={view} search={search} />}
      actions={
        apiUrl && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <UseInAnApp state={{ ...scope, bundleName: name, publicApiUrl: apiUrl }} />
          </div>
        )
      }
      footer={
        !unavailableChannel && (
          <nav aria-label="Bundle navigation" className="bundle-tabs bundle-scope-navigation">
            {(Object.keys(bundleViewLabels) as (keyof typeof bundleViewLabels)[]).map((tab) => (
              <ConsoleLink
                key={tab}
                href={bundleHref(scope, tab)}
                exactActive
                aria-current={view === tab ? 'page' : undefined}
              >
                {bundleViewLabels[tab]}
              </ConsoleLink>
            ))}
          </nav>
        )
      }
    />
  );
}
function ChannelPicker({
  scope,
  view,
  search,
}: {
  scope: { workspaceId: string; bundleId: string; channel: string };
  view: BundleView;
  search: Record<string, unknown>;
}) {
  const nav = useNavigation();
  const navigate = useNavigate();
  const channels = nav?.channels ?? [];
  const published = channels.some((channel) => channel.name === scope.channel);
  return (
    <div className="bundle-channel-picker">
      <Select
        value={published ? scope.channel : ''}
        disabled={!channels.length}
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
          <SelectValue placeholder="Choose channel" />
        </SelectTrigger>
        <SelectContent position="popper" align="end" className="bundle-channel-options">
          {channels.map((channel) => (
            <SelectItem key={channel.name} value={channel.name} className="bundle-channel-option">
              {channel.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
