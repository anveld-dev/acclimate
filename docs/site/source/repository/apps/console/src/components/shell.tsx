import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Label } from './ui/label';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { BookOpen, Building2, Files, Users, Plug, Plus, Radio } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { usePendingChanges } from './pending-changes';
import { AccountMenu } from './account-menu';
import { WorkspaceCreate } from './workspace-create';
import { ConsoleLink, consoleDestination } from './console-link';
import { workspaceHref, bundleViewLabels, bundleDetailLabel, type BundleView } from '../navigation';
import { useNavigation } from './use-navigation';
import { useBackgroundRefresh } from './use-background-refresh';
import { WorkspaceChromeProvider, WorkspaceChromeTools } from './workspace-chrome';

function Navigation({
  onNavigate,
  layout = 'sidebar',
}: {
  onNavigate?: (href: string) => void;
  layout?: 'sidebar' | 'rail';
}) {
  const nav = useNavigation();
  if (!nav?.projectId) return null;
  const links = [
    { view: 'bundles' as const, label: 'Bundles', icon: Files },
    { view: 'delivery' as const, label: 'Delivery', icon: Radio },
    ...(nav.role === 'admin'
      ? [
          { view: 'connections' as const, label: 'Connections', icon: Plug },
          { view: 'members' as const, label: 'Members', icon: Users },
        ]
      : []),
  ];
  return (
    <nav
      aria-label="Main navigation"
      className={layout === 'rail' ? 'workspace-rail-navigation' : 'space-y-1'}
    >
      {layout === 'sidebar' && <p className="sidebar-heading">WORKSPACE</p>}
      {links.map(({ view, label, icon: Icon }) => {
        const current =
          nav.location?.view === view || (view === 'bundles' && Boolean(nav.bundleId));
        const link = (
          <ConsoleLink
            href={workspaceHref(nav.projectId!, view)}
            onClick={() => onNavigate?.(workspaceHref(nav.projectId!, view))}
            className={`navigation-link${layout === 'rail' ? ' workspace-rail-control' : ''}${current ? ' is-current' : ''}`}
            aria-label={label}
            aria-current={current ? 'page' : undefined}
          >
            <Icon className="size-[18px]" aria-hidden="true" />
            <span className={layout === 'rail' ? 'sr-only' : undefined}>{label}</span>
          </ConsoleLink>
        );
        return layout === 'rail' ? (
          <Tooltip key={view}>
            <TooltipTrigger asChild data-slot="button">
              <Button asChild variant="ghost" size="icon">
                {link}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={10}>
              {label}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span key={view} className="block">
            {link}
          </span>
        );
      })}
    </nav>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const nav = useNavigation();
  const router = useRouter();
  const { hasPendingChanges } = usePendingChanges();
  const [open, setOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creationPending, setCreationPending] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const desktopHeaderRef = useRef<HTMLElement>(null);
  const navigationFocus = useRef<'desktop' | 'menu' | null>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const creationReturnRef = useRef<HTMLElement | null>(null);
  const workspaceMenuRef = useRef<HTMLButtonElement>(null);
  const openingWorkspaceDialog = useRef(false);
  const loading = useRouterState({ select: (state) => state.isLoading });
  const routeFailed = useRouterState({
    select: (state) =>
      state.matches.some((match) => match.status === 'error' || match.status === 'notFound'),
  });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const previousPath = useRef(pathname);
  const focusAfterSheetNavigation = useRef(false);
  const returnTo = useRouterState({ select: (state) => state.location.href });
  const search = useRouterState({
    select: (state) => state.location.search as Record<string, unknown>,
  });
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    // A browser can blur a display:none control before dispatching resize.
    // Remember its region while visible, clearing it on intentional focus moves.
    const rememberNavigationFocus = (event: FocusEvent) => {
      const target = event.target as Node | null;
      navigationFocus.current = desktopHeaderRef.current?.contains(target)
        ? 'desktop'
        : target === menuRef.current
          ? 'menu'
          : null;
    };
    const forgetVisibleNavigationFocus = (event: FocusEvent) => {
      const header = desktopHeaderRef.current;
      const menu = menuRef.current;
      if (
        navigationFocus.current === 'desktop' &&
        header?.getClientRects().length &&
        !header.contains(event.relatedTarget as Node | null)
      )
        navigationFocus.current = null;
      else if (
        navigationFocus.current === 'menu' &&
        menu?.getClientRects().length &&
        event.relatedTarget !== menu
      )
        navigationFocus.current = null;
    };
    const keepNavigationFocusVisible = () => {
      const header = desktopHeaderRef.current;
      const menu = menuRef.current;
      const active = document.activeElement;
      if (
        header &&
        !header.getClientRects().length &&
        (header.contains(active) || navigationFocus.current === 'desktop')
      ) {
        navigationFocus.current = null;
        if (menu?.getClientRects().length) menu.focus({ preventScroll: true });
        else mainRef.current?.focus({ preventScroll: true });
      } else if (
        !open &&
        !menu?.getClientRects().length &&
        (active === menu || navigationFocus.current === 'menu')
      ) {
        navigationFocus.current = null;
        mainRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('focusin', rememberNavigationFocus);
    document.addEventListener('focusout', forgetVisibleNavigationFocus);
    window.addEventListener('resize', keepNavigationFocusVisible);
    return () => {
      document.removeEventListener('focusin', rememberNavigationFocus);
      document.removeEventListener('focusout', forgetVisibleNavigationFocus);
      window.removeEventListener('resize', keepNavigationFocusVisible);
    };
  }, [open]);
  useEffect(() => {
    if (loading || previousPath.current === pathname) return;
    previousPath.current = pathname;
    if (open) focusAfterSheetNavigation.current = true;
    setOpen(false);
    setCreating(false);
    const focusFrame = requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(focusFrame);
  }, [pathname, loading, open]);
  useEffect(() => {
    if (!open) return;
    const closeHiddenNavigation = () => {
      if (!menuRef.current?.getClientRects().length) {
        focusAfterSheetNavigation.current = true;
        setOpen(false);
      }
    };
    window.addEventListener('resize', closeHiddenNavigation);
    return () => window.removeEventListener('resize', closeHiddenNavigation);
  }, [open]);
  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const closeHiddenWorkspaceMenu = () => {
      if (!desktopHeaderRef.current?.getClientRects().length) setWorkspaceMenuOpen(false);
    };
    window.addEventListener('resize', closeHiddenWorkspaceMenu);
    return () => window.removeEventListener('resize', closeHiddenWorkspaceMenu);
  }, [workspaceMenuOpen]);
  const view = nav?.location?.view;
  useBackgroundRefresh(() => router.invalidate(), {
    enabled:
      Boolean(nav?.projectId) &&
      view !== 'changes' &&
      view !== 'members' &&
      !loading &&
      !hasPendingChanges,
  });
  const bundleView = nav?.bundleId ? (view as BundleView) : undefined;
  const detailLabel = bundleView ? bundleDetailLabel(bundleView, search) : undefined;
  const viewLabel = bundleView
    ? bundleViewLabels[bundleView]
    : view === 'delivery'
      ? 'Delivery'
      : view === 'connections'
        ? 'Connections'
        : view === 'members'
          ? 'Members'
          : 'Bundles';
  useEffect(() => {
    document.title = nav?.projectId
      ? [detailLabel, viewLabel, nav.bundleName, nav.projectName, 'Acclimate']
          .filter(Boolean)
          .join(' · ')
      : 'Welcome · Acclimate';
  }, [nav?.projectId, nav?.projectName, nav?.bundleName, detailLabel, viewLabel]);
  const projects = nav?.access.ok ? nav.access.projects : [];
  const canCreate = nav?.access.ok && nav.access.canCreateWorkspace;
  function workspaceRole(role: string) {
    if (role === 'admin') return 'Administrator';
    if (role === 'editor') return 'Editor';
    if (role === 'viewer') return 'Viewer';
    return role || 'Unknown role';
  }
  function hasDuplicateName(project: (typeof projects)[number]) {
    return projects.some((other) => other.id !== project.id && other.name === project.name);
  }
  function startCreating(returnToElement?: HTMLElement | null) {
    creationReturnRef.current =
      returnToElement ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setOpen(false);
    setCreating(true);
  }
  function switcher(id: string) {
    if (!projects.length) return null;
    return (
      <div className="workspace-switcher">
        <div className="workspace-switcher-label">
          <Building2 aria-hidden="true" className="size-3.5" />
          {projects.length > 1 ? <Label htmlFor={id}>Workspace</Label> : <span>Workspace</span>}
        </div>
        {projects.length > 1 ? (
          <NativeSelect
            id={id}
            aria-label="Workspace"
            className="w-full"
            disabled={!hydrated}
            value={nav?.projectId || ''}
            onChange={(event) => {
              const id = event.currentTarget.value;
              event.currentTarget.value = nav?.projectId ?? '';
              if (id && id !== nav?.projectId)
                void router.navigate(consoleDestination(workspaceHref(id)));
            }}
          >
            {!nav?.projectId && <option value="">Choose workspace</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} · {workspaceRole(project.role)}
                {hasDuplicateName(project) ? ` · ${project.id}` : ''}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <ConsoleLink
                href={workspaceHref(projects[0].id)}
                className="workspace-switcher-name block text-sm font-semibold whitespace-normal break-words hover:text-primary"
              >
                {projects[0].name}
              </ConsoleLink>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              className="max-w-[min(20rem,calc(100vw-2rem))] break-words text-sm"
            >
              {projects[0].name}
            </TooltipContent>
          </Tooltip>
        )}
        {canCreate && (
          <Button
            variant="ghost"
            size="sm"
            className="workspace-create-button w-full justify-start"
            onClick={() => startCreating()}
          >
            <Plus aria-hidden="true" />
            New workspace
          </Button>
        )}
      </div>
    );
  }
  return (
    <WorkspaceChromeProvider
      value={{
        hydrated,
        menuRef,
      }}
    >
      <Sheet open={open} onOpenChange={setOpen}>
        <div className="workspace-shell workspace-shell-rail">
          <a className="skip-link" href="#main">
            Skip to content
          </a>
          <header
            ref={desktopHeaderRef}
            className="workspace-desktop-header workspace-desktop-rail"
            aria-label="Application"
          >
            <div className="workspace-brand workspace-rail-brand" role="img" aria-label="Acclimate">
              <BookOpen className="size-5" aria-hidden="true" />
            </div>
            <Navigation layout="rail" />
            <div className="workspace-rail-bottom">
              {(projects.length > 0 || canCreate) && (
                <DropdownMenu open={workspaceMenuOpen} onOpenChange={setWorkspaceMenuOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild data-slot="button">
                      <DropdownMenuTrigger asChild data-slot="button">
                        <Button
                          ref={workspaceMenuRef}
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="workspace-rail-control workspace-rail-workspaces"
                          disabled={!hydrated}
                          aria-label="Workspaces"
                        >
                          <Building2 aria-hidden="true" className="size-[18px]" />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      sideOffset={10}
                      hidden={workspaceMenuOpen}
                      className="workspace-rail-tooltip"
                    >
                      <span className="font-medium">Workspaces</span>
                      <span className="opacity-75">{nav?.projectName ?? 'Choose a workspace'}</span>
                    </TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent
                    side="right"
                    align="end"
                    sideOffset={12}
                    className="workspace-rail-workspace-menu"
                    onCloseAutoFocus={(event) => {
                      if (openingWorkspaceDialog.current) {
                        event.preventDefault();
                        openingWorkspaceDialog.current = false;
                      } else if (!workspaceMenuRef.current?.getClientRects().length) {
                        event.preventDefault();
                        const menu = menuRef.current;
                        if (menu?.getClientRects().length) menu.focus({ preventScroll: true });
                        else mainRef.current?.focus({ preventScroll: true });
                      }
                    }}
                  >
                    <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={nav?.projectId ?? ''}
                      aria-label="Workspaces"
                      className="workspace-rail-workspace-list"
                      onValueChange={(id) => {
                        if (id && id !== nav?.projectId)
                          void router.navigate(consoleDestination(workspaceHref(id)));
                      }}
                    >
                      {projects.map((project) => (
                        <DropdownMenuRadioItem
                          key={project.id}
                          value={project.id}
                          data-workspace-id={project.id}
                          className="workspace-rail-workspace-option"
                        >
                          <span>
                            <span>{project.name}</span>
                            <span className="workspace-rail-workspace-role">
                              {workspaceRole(project.role)}
                            </span>
                            {hasDuplicateName(project) && (
                              <span className="workspace-rail-workspace-id">{project.id}</span>
                            )}
                          </span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    {canCreate && (
                      <>
                        {projects.length > 0 && <DropdownMenuSeparator />}
                        <DropdownMenuItem
                          onSelect={() => {
                            openingWorkspaceDialog.current = true;
                            startCreating(workspaceMenuRef.current);
                          }}
                        >
                          <Plus aria-hidden="true" />
                          New workspace
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {nav && (
                <AccountMenu
                  access={nav.access}
                  returnTo={returnTo}
                  compact
                  iconOnly
                  suppressTooltip={workspaceMenuOpen}
                />
              )}
            </div>
          </header>
          <div className="workspace-column">
            {(!nav?.location || routeFailed) && (
              <header className="workspace-topbar workspace-fallback-header">
                <WorkspaceChromeTools />
              </header>
            )}
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
            <DialogContent
              className="sm:max-w-lg"
              showCloseButton={!creationPending}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const previous = creationReturnRef.current;
                creationReturnRef.current = null;
                const menu = menuRef.current;
                if (previous?.isConnected && previous.getClientRects().length) previous.focus();
                else if (menu?.getClientRects().length) menu.focus();
                else mainRef.current?.focus({ preventScroll: true });
              }}
            >
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
          <Navigation
            onNavigate={(href) => {
              if (href === pathname) setOpen(false);
            }}
          />
          <div className="mt-auto border-t pt-4">
            {switcher('mobile-workspace-switcher')}
            {nav && <AccountMenu access={nav.access} returnTo={returnTo} />}
          </div>
        </SheetContent>
      </Sheet>
    </WorkspaceChromeProvider>
  );
}
