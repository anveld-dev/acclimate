import { ArrowLeft, GitBranch, History } from 'lucide-react';
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
  releaseRevision,
  type BundleView,
} from '../navigation';
import { readWorkspaceBundles } from '../server/setup-actions';
import { readConsole } from '../server/read-console';
import { readConnections } from '../server/integration-actions';
import { readWorkspaceAccess } from '../server/access-actions';
import { BundleLibrary } from '../components/bundle-library';
import { BundleContent } from '../components/bundle-content';
import { BundleChanges } from '../components/bundle-changes';
import { SdkSetup, UseInAnApp } from '../components/sdk-setup';
import { BundleReleases } from '../components/bundle-releases';
import { WorkspaceConnections } from '../components/workspace-connections';
import { WorkspaceDelivery } from '../components/workspace-delivery';
import { readDeliveryObservations } from '../server/delivery-observations-actions';
import { WorkspaceMembers } from '../components/workspace-members';
import { WorkspaceEvaluatorTokens } from '../components/workspace-evaluator-tokens';
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
            'draft',
            'proposal',
            'candidate',
            'generation',
            'comparison',
            'pair',
            'fromRevision',
            'request',
            'history',
            'tab',
            'reviewTab',
            'connectionTab',
            'integration',
            'access',
            'bundleId',
          ].includes(key) &&
          (typeof value === 'string' || typeof value === 'number'),
      ),
    ) as Record<string, string | number>,
  loaderDeps: ({ search }) => ({
    search: Object.fromEntries(
      Object.entries(search).filter(([key]) => key !== 'reviewTab' && key !== 'connectionTab'),
    ),
  }),
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
    if (location.view === 'delivery')
      return {
        kind: 'delivery' as const,
        location,
        result: await readDeliveryObservations({
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
    navigation?.projectId === data.location.projectId &&
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
            href={workspaceHref(data.location.projectId, members ? 'bundles' : 'delivery')}
          >
            {members ? 'Browse bundles' : 'View delivery'}
          </ConsoleLink>
        </Button>
      </section>
    );
  }
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
  if (data.kind === 'delivery')
    return (
      <WorkspaceDelivery
        key={workspaceKey}
        initialAppId={typeof search.integration === 'string' ? search.integration : undefined}
        canManage={navigation?.role === 'admin'}
        projectId={data.location.projectId}
        initial={data.result}
      />
    );
  if (data.kind === 'members')
    return (
      <div className="space-y-6">
        <WorkspaceMembers
          key={workspaceKey}
          projectId={data.location.projectId}
          initial={data.result}
        />
        <WorkspaceEvaluatorTokens
          key={`tokens-${workspaceKey}`}
          projectId={data.location.projectId}
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
        currentRevision={state.resolution.revision}
        apiUrl={state.publicApiUrl}
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
  unavailableChannel = false,
  currentRevision,
  apiUrl,
}: {
  name: string;
  scope: { projectId: string; bundleId: string; channel: string };
  view: BundleView;
  search: Record<string, unknown>;
  description: string;
  unavailableChannel?: boolean;
  currentRevision?: string;
  apiUrl?: string;
}) {
  const navigate = useNavigate();
  const historyHref = bundleHref(scope, 'changes', { history: 1 }) + '#evaluation-history';
  const isChangeDetail =
    !unavailableChannel &&
    view === 'changes' &&
    Boolean(
      search.draft || search.proposal || search.candidate || search.comparison || search.request,
    );
  const fromRevision =
    isChangeDetail && search.candidate && currentRevision
      ? releaseRevision(search.fromRevision)
      : undefined;
  const returnRevision =
    fromRevision && currentRevision && BigInt(fromRevision) <= BigInt(currentRevision)
      ? fromRevision
      : undefined;
  const parentLabel = returnRevision
    ? `Back to revision ${returnRevision}`
    : isChangeDetail
      ? 'Back to changes'
      : view === 'connect'
        ? 'Back to content'
        : 'Back to bundles';
  const parentHref = returnRevision
    ? `${bundleHref(scope, 'releases')}#revision-${returnRevision}`
    : isChangeDetail
      ? bundleHref(scope, 'changes')
      : view === 'connect'
        ? bundleHref(scope, 'content')
        : workspaceHref(scope.projectId);
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
                {returnRevision
                  ? `Revision ${returnRevision}`
                  : isChangeDetail
                    ? 'Changes'
                    : view === 'connect'
                      ? 'Content'
                      : 'Bundles'}
              </span>
            </ConsoleLink>
          </Button>
          {!unavailableChannel && !(view === 'changes' && String(search.history) === '1') && (
            <Button asChild variant="ghost" size="sm" className="ml-auto">
              <ConsoleLink
                aria-label="Evaluation history"
                className="bundle-evaluation-history"
                href={historyHref}
                onClick={async (event) => {
                  const link = event.currentTarget;
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey ||
                    link.pathname !== window.location.pathname
                  )
                    return;
                  event.preventDefault();
                  const destination = link.href;
                  await navigate(consoleDestination(historyHref));
                  requestAnimationFrame(() => {
                    if (window.location.href === destination)
                      document.getElementById('evaluation-history')?.focus({ preventScroll: true });
                  });
                }}
              >
                <History aria-hidden="true" className="size-4" />
                <span className="hidden sm:inline">Evaluation history</span>
                <span className="sm:hidden">History</span>
              </ConsoleLink>
            </Button>
          )}
        </>
      }
      actions={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {apiUrl && <UseInAnApp state={{ ...scope, bundleName: name, publicApiUrl: apiUrl }} />}
          <ChannelPicker scope={scope} view={view} search={search} />
        </div>
      }
      footer={
        !unavailableChannel && (
          <nav aria-label="Bundle navigation" className="bundle-tabs bundle-scope-navigation">
            {(Object.keys(bundleViewLabels) as (keyof typeof bundleViewLabels)[]).map((tab) => (
              <ConsoleLink
                key={tab}
                href={bundleHref(scope, tab)}
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
  scope: { projectId: string; bundleId: string; channel: string };
  view: 'content' | 'changes' | 'releases' | 'connect';
  search: Record<string, unknown>;
}) {
  const nav = useNavigation();
  const navigate = useNavigate();
  const channels = nav?.channels ?? [];
  const published = channels.some((channel) => channel.name === scope.channel);
  return (
    <div className="bundle-channel-picker">
      <span className="bundle-channel-label">Channel</span>
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
