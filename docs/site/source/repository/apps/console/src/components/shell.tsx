import { Link, useRouter, useRouterState } from '@tanstack/react-router';
import {
  BookOpen,
  Building2,
  ChevronRight,
  Files,
  Users,
  Plug,
  Menu,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { usePendingChanges } from './pending-changes';
import { AccountMenu } from './account-menu';
import { WorkspaceCreate } from './workspace-create';
import { ConsoleLink, consoleDestination } from './console-link';
import {
  workspaceHref,
  bundleHref,
  bundleViewLabels,
  bundleDetailLabel,
  type BundleView,
} from '../navigation';
import { useNavigation } from './use-navigation';

function Navigation({ onNavigate }: { onNavigate?: (href: string) => void }) {
  const nav = useNavigation();
  if (!nav?.projectId) return null;
  const links = [
    { view: 'bundles' as const, label: 'Bundles', icon: Files },
    ...(nav.role === 'admin'
      ? [{ view: 'connections' as const, label: 'Connections', icon: Plug }]
      : []),
  ];
  return (
    <nav aria-label="Main navigation" className="space-y-1">
      <p className="sidebar-heading">WORKSPACE</p>
      {links.map(({ view, label, icon: Icon }) => (
        <ConsoleLink
          key={view}
          href={workspaceHref(nav.projectId!, view)}
          onClick={() => onNavigate?.(workspaceHref(nav.projectId!, view))}
          className={`navigation-link ${nav.location?.view === view || (view === 'bundles' && nav.bundleId) ? 'is-current' : ''}`}
          aria-current={
            nav.location?.view === view || (view === 'bundles' && nav.bundleId) ? 'page' : undefined
          }
        >
          <Icon className="size-[18px]" aria-hidden="true" />
          {label}
        </ConsoleLink>
      ))}
      {nav.role === 'admin' && (
        <>
          <p className="sidebar-heading mt-6">SETTINGS</p>
          <ConsoleLink
            href={workspaceHref(nav.projectId, 'members')}
            onClick={() => onNavigate?.(workspaceHref(nav.projectId!, 'members'))}
            className={`navigation-link ${nav.location?.view === 'members' ? 'is-current' : ''}`}
            aria-current={nav.location?.view === 'members' ? 'page' : undefined}
          >
            <Users className="size-[18px]" aria-hidden="true" />
            Members
          </ConsoleLink>
        </>
      )}
    </nav>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const nav = useNavigation();
  const router = useRouter();
  const { confirmDiscard } = usePendingChanges();
  const [open, setOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creationPending, setCreationPending] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const loading = useRouterState({ select: (state) => state.isLoading });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const previousPath = useRef(pathname);
  const focusAfterSheetNavigation = useRef(false);
  const returnTo = useRouterState({ select: (state) => state.location.href });
  const search = useRouterState({
    select: (state) => state.location.search as Record<string, unknown>,
  });
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    if (loading || previousPath.current === pathname) return;
    previousPath.current = pathname;
    if (open) focusAfterSheetNavigation.current = true;
    setOpen(false);
    setCreating(false);
    const focusFrame = requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(focusFrame);
  }, [pathname, loading, open]);
  const view = nav?.location?.view;
  const bundleView = nav?.bundleId ? (view as BundleView) : undefined;
  const detailLabel = bundleView ? bundleDetailLabel(bundleView, search) : undefined;
  const viewLabel = bundleView
    ? bundleViewLabels[bundleView]
    : view === 'connections'
      ? 'Connections'
      : view === 'members'
        ? 'Members'
        : 'Bundles';
  const bundleTabHref =
    nav?.projectId && nav.bundleId && bundleView
      ? bundleHref(
          {
            projectId: nav.projectId,
            bundleId: nav.bundleId,
            channel: nav.location?.channel || String(search.channel || 'stable'),
          },
          bundleView,
        )
      : undefined;
  useEffect(() => {
    document.title = nav?.projectId
      ? [detailLabel, viewLabel, nav.bundleName, nav.projectName, 'Acclimate']
          .filter(Boolean)
          .join(' · ')
      : 'Welcome · Acclimate';
  }, [nav?.projectId, nav?.projectName, nav?.bundleName, detailLabel, viewLabel]);
  const projects = nav?.access.ok ? nav.access.projects : [];
  const canCreate = nav?.access.ok && nav.access.canCreateWorkspace;
  function startCreating() {
    setOpen(false);
    setCreating(true);
  }
  function switcher(id: string) {
    if (!projects.length) return null;
    return (
      <div className="workspace-switcher mb-5 space-y-3 rounded-xl border bg-background/60 p-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Building2 aria-hidden="true" className="size-3.5" />
          {projects.length > 1 ? <label htmlFor={id}>Workspace</label> : <span>Workspace</span>}
        </div>
        {projects.length > 1 ? (
          <NativeSelect
            id={id}
            aria-label="Workspace"
            className="w-full"
            disabled={!hydrated}
            value={nav?.projectId || ''}
            onChange={(event) => {
              if (event.target.value && event.target.value !== nav?.projectId)
                void router.navigate(consoleDestination(workspaceHref(event.target.value)));
            }}
          >
            {!nav?.projectId && <option value="">Choose workspace</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <ConsoleLink
            href={workspaceHref(projects[0].id)}
            className="block truncate text-sm font-semibold hover:text-primary"
            title={projects[0].name}
          >
            {projects[0].name}
          </ConsoleLink>
        )}
        {canCreate && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={startCreating}
          >
            <Plus aria-hidden="true" />
            New workspace
          </Button>
        )}
      </div>
    );
  }
  const separator = (
    <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/60" />
  );
  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="workspace-sidebar" aria-label="Workspace sidebar">
        <Link
          {...(nav?.projectId
            ? consoleDestination(workspaceHref(nav.projectId))
            : { to: '/' as const })}
          className="workspace-brand"
        >
          <span className="brand-symbol">
            <BookOpen className="size-5" aria-hidden="true" />
          </span>
          Acclimate
        </Link>
        {switcher('workspace-switcher')}
        <Navigation />
        <div className="workspace-sidebar-footer mt-auto border-t pt-4">
          {nav && <AccountMenu access={nav.access} returnTo={returnTo} />}
        </div>
      </aside>
      <div className="workspace-column">
        <header className="workspace-topbar">
          <div className="flex min-w-0 items-center gap-3">
            <div className="md:hidden">
              <Sheet open={open} onOpenChange={setOpen}>
                <SheetTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={!hydrated}
                    aria-label="Open navigation"
                  >
                    <Menu aria-hidden="true" />
                  </Button>
                </SheetTrigger>
                <SheetContent
                  side="left"
                  className="flex w-80 max-w-full flex-col overflow-auto p-5"
                  onCloseAutoFocus={(event) => {
                    if (focusAfterSheetNavigation.current) {
                      event.preventDefault();
                      focusAfterSheetNavigation.current = false;
                      mainRef.current?.focus({ preventScroll: true });
                    } else if (creating) event.preventDefault();
                  }}
                >
                  <SheetTitle className="mb-4 flex items-center gap-2 text-lg">
                    <BookOpen className="size-5" aria-hidden="true" /> Acclimate
                  </SheetTitle>
                  <SheetDescription className="sr-only">Workspace navigation</SheetDescription>
                  {switcher('mobile-workspace-switcher')}
                  <Navigation
                    onNavigate={(href) => {
                      if (href === pathname) setOpen(false);
                    }}
                  />
                  <div className="mt-auto border-t pt-4">
                    {nav && <AccountMenu access={nav.access} returnTo={returnTo} />}
                  </div>
                </SheetContent>
              </Sheet>
            </div>
            <nav aria-label="Breadcrumb" className="workspace-breadcrumb flex-wrap">
              {nav?.projectId ? (
                <>
                  <ConsoleLink
                    href={workspaceHref(nav.projectId)}
                    className="hidden max-w-40 truncate sm:block"
                    title={nav.projectName || 'Workspace'}
                  >
                    {nav.projectName || 'Workspace'}
                  </ConsoleLink>
                  <span className="hidden sm:contents">{separator}</span>
                  {nav.bundleId ? (
                    <>
                      <ConsoleLink href={workspaceHref(nav.projectId)} className="hidden sm:block">
                        Bundles
                      </ConsoleLink>
                      <span className="hidden sm:contents">{separator}</span>
                      <ConsoleLink
                        href={bundleTabHref!}
                        className="max-w-48 truncate"
                        title={nav.bundleName || 'Bundle'}
                      >
                        {nav.bundleName || 'Bundle'}
                      </ConsoleLink>
                      {separator}
                      {detailLabel ? (
                        <>
                          <ConsoleLink href={bundleTabHref!}>{viewLabel}</ConsoleLink>
                          {separator}
                          <strong aria-current="page" title={detailLabel}>
                            {detailLabel}
                          </strong>
                        </>
                      ) : (
                        <strong aria-current="page">{viewLabel}</strong>
                      )}
                    </>
                  ) : (
                    <strong aria-current="page">{viewLabel}</strong>
                  )}
                </>
              ) : (
                <strong aria-current="page">Getting started</strong>
              )}
            </nav>
          </div>
          {nav?.access.ok && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              disabled={!hydrated || loading}
              onClick={() =>
                confirmDiscard(() => {
                  void router.invalidate();
                })
              }
            >
              <RefreshCw aria-hidden="true" className={loading ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">{loading ? 'Refreshing…' : 'Refresh'}</span>
              <span className="sr-only sm:hidden">{loading ? 'Refreshing…' : 'Refresh'}</span>
            </Button>
          )}
        </header>
        <main ref={mainRef} id="main" tabIndex={-1} className="workspace-main">
          {children}
        </main>
      </div>
      <Dialog
        open={creating}
        onOpenChange={(next) => {
          if (!creationPending) setCreating(next);
        }}
      >
        <DialogContent className="sm:max-w-lg" showCloseButton={!creationPending}>
          <DialogHeader>
            <DialogTitle>Create a workspace</DialogTitle>
            <DialogDescription>
              A shared home for your bundles and team. You'll be its administrator.
            </DialogDescription>
          </DialogHeader>
          {nav && (
            <WorkspaceCreate
              access={nav.access}
              showHeading={false}
              onPendingChange={setCreationPending}
              onCreated={(id) => {
                setCreating(false);
                void router.navigate(consoleDestination(workspaceHref(id)));
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
