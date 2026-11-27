import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Label } from './ui/label';
import { useRouter, useRouterState } from '@tanstack/react-router';
import {
  Building2,
  ChevronsUpDown,
  Cpu,
  Files,
  KeyRound,
  Users,
  Plug,
  Plus,
  Radio,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { AcclimateMark } from './acclimate-mark';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
import { WorkspaceChromeProvider, WorkspaceMenuButton } from './workspace-chrome';

function Navigation({
  onNavigate,
  layout = 'sidebar',
  expanded = false,
}: {
  onNavigate?: (href: string) => void;
  layout?: 'sidebar' | 'rail';
  expanded?: boolean;
}) {
  const nav = useNavigation();
  const settingsHeading = useId();
  if (!nav?.workspaceId) return null;
  const admin = nav.role === 'admin';
  const groups = [
    {
      key: 'work',
      heading: undefined,
      links: [
        { view: 'bundles' as const, label: 'Bundles', icon: Files },
        { view: 'delivery' as const, label: 'Delivery', icon: Radio },
        ...(admin ? [{ view: 'connections' as const, label: 'Connections', icon: Plug }] : []),
      ],
    },
    ...(admin
      ? [
          {
            key: 'settings',
            heading: 'Settings',
            links: [
              { view: 'members' as const, label: 'Members', icon: Users },
              { view: 'model-provider' as const, label: 'Model provider', icon: Cpu },
              { view: 'tokens' as const, label: 'Machine tokens', icon: KeyRound },
            ],
          },
        ]
      : []),
  ];
  return (
    <nav
      aria-label="Main navigation"
      className={layout === 'rail' ? 'workspace-rail-navigation' : 'space-y-1'}
    >
      {groups.map((group) => (
        <div
          key={group.key}
          className={layout === 'rail' ? 'workspace-nav-group' : 'workspace-nav-group space-y-1'}
          role={group.heading ? 'group' : undefined}
          aria-labelledby={group.heading ? settingsHeading : undefined}
        >
          {group.heading && (
            <>
              <span className="workspace-nav-divider" aria-hidden="true" />
              <p id={settingsHeading} className="workspace-nav-heading">
                {group.heading}
              </p>
            </>
          )}
          {group.links.map(({ view, label, icon: Icon }) => {
            const current =
              nav.location?.view === view || (view === 'bundles' && Boolean(nav.bundleId));
            const link = (
              <ConsoleLink
                href={workspaceHref(nav.workspaceId!, view)}
                onClick={() => onNavigate?.(workspaceHref(nav.workspaceId!, view))}
                className={`navigation-link${layout === 'rail' ? ' workspace-rail-control' : ''}${current ? ' is-current' : ''}`}
                aria-label={label}
                aria-current={current ? 'page' : undefined}
              >
                <Icon className="size-[18px]" aria-hidden="true" />
                <span className={layout === 'rail' ? 'sr-only workspace-rail-label' : undefined}>
                  {label}
                </span>
              </ConsoleLink>
            );
            return layout === 'rail' ? (
              <Tooltip key={view}>
                <TooltipTrigger asChild data-slot="button">
                  <Button asChild variant="ghost" size="icon">
                    {link}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={10} hidden={expanded}>
                  {label}
                </TooltipContent>
              </Tooltip>
            ) : (
              <span key={view} className="block">
                {link}
              </span>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const nav = useNavigation();
  const router = useRouter();
  const { hasPendingChanges } = usePendingChanges();
  const [open, setOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [railPreference, setRailPreference] = useState<boolean>();
  const [wideViewport, setWideViewport] = useState(false);
  const railExpanded = railPreference ?? wideViewport;
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
  const menuInShell = !nav?.location || routeFailed;
  const previousPath = useRef(pathname);
  const focusAfterSheetNavigation = useRef(false);
  const returnTo = useRouterState({ select: (state) => state.location.href });
  const search = useRouterState({
    select: (state) => state.location.search as Record<string, unknown>,
  });
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 1280px)');
    const syncWidth = () => setWideViewport(wide.matches);
    syncWidth();
    wide.addEventListener('change', syncWidth);
    try {
      const saved = localStorage.getItem('acclimate.navigation.expanded');
      if (saved === 'true' || saved === 'false') setRailPreference(saved === 'true');
    } catch {
      // The current session can still expand and collapse navigation.
    }
    setHydrated(true);
    return () => wide.removeEventListener('change', syncWidth);
  }, []);
  function toggleRail() {
    const next = !railExpanded;
    setRailPreference(next);
    try {
      localStorage.setItem('acclimate.navigation.expanded', String(next));
    } catch {
      // Keep the chosen width for this session when storage is unavailable.
    }
  }
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
    const focusFrame = requestAnimationFrame(() => {
      const fragment = document.getElementById(window.location.hash.slice(1));
      if (fragment && mainRef.current?.contains(fragment)) {
        if (fragment.tabIndex < 0) fragment.tabIndex = -1;
        fragment.focus({ preventScroll: true });
      } else {
        mainRef.current?.focus({ preventScroll: true });
      }
    });
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
      Boolean(nav?.workspaceId) &&
      view !== 'members' &&
      view !== 'learning' &&
      !loading &&
      !hasPendingChanges,
  });
  const bundleView = nav?.bundleId ? (view as BundleView) : undefined;
  const detailLabel = bundleView ? bundleDetailLabel(bundleView, search) : undefined;
  const viewLabel = bundleView
    ? bundleView === 'connect' ? 'App setup' : bundleViewLabels[bundleView]
    : view === 'delivery'
      ? 'Delivery'
      : view === 'connections'
        ? 'Connections'
        : view === 'members'
          ? 'Members'
          : view === 'model-provider'
            ? 'Model provider'
            : view === 'tokens'
              ? 'Machine tokens'
              : 'Bundles';
  useEffect(() => {
    const page = nav?.workspaceId
      ? [detailLabel, viewLabel, nav.bundleName].filter(Boolean).join(' · ')
      : mainRef.current?.querySelector('h1')?.textContent || 'Welcome';
    let title = page;
    for (const label of [nav?.workspaceName, 'Acclimate']) {
      if (!label) continue;
      const suffix = title.toLowerCase();
      const identity = label.toLowerCase();
      if (suffix !== identity && !suffix.endsWith(' · ' + identity)) title += ' · ' + label;
    }
    document.title = title;
  }, [nav?.workspaceId, nav?.workspaceName, nav?.bundleName, detailLabel, viewLabel, pathname]);
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
            value={nav?.workspaceId || ''}
            onChange={(event) => {
              const id = event.currentTarget.value;
              event.currentTarget.value = nav?.workspaceId ?? '';
              if (id && id !== nav?.workspaceId)
                void router.navigate(consoleDestination(workspaceHref(id)));
            }}
          >
            {!nav?.workspaceId && <option value="">Choose workspace</option>}
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
                title={projects[0].name}
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
        menuInShell,
      }}
    >
      <Sheet open={open} onOpenChange={setOpen}>
        <div className="workspace-shell workspace-shell-rail">
          <a className="skip-link" href="#main">
            Skip to content
          </a>
          <header
            id="desktop-workspace-rail"
            data-rail-expanded={hydrated ? railExpanded : undefined}
            ref={desktopHeaderRef}
            className="workspace-desktop-header workspace-desktop-rail"
            aria-label="Application"
          >
            <div className="workspace-brand workspace-rail-brand" role="img" aria-label="Acclimate">
              <AcclimateMark className="size-5 shrink-0" />
              <span className="sr-only workspace-rail-label">Acclimate</span>
            </div>
            {(projects.length > 0 || canCreate) && (
              <DropdownMenu modal={false} open={workspaceMenuOpen} onOpenChange={setWorkspaceMenuOpen}>
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
                        title={nav?.workspaceName}
                        aria-label={nav?.workspaceName ? `Workspaces ${nav.workspaceName}` : 'Workspaces'}
                      >
                        <Building2 aria-hidden="true" className="size-[18px]" />
                        <span className="sr-only workspace-rail-label">
                          <small>Workspaces</small>{' '}
                          <strong>{nav?.workspaceName ?? 'Choose workspace'}</strong>
                        </span>
                        <ChevronsUpDown className="workspace-scope-indicator" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  {!railExpanded && (
                    <TooltipContent
                      side="right"
                      sideOffset={10}
                      hidden={workspaceMenuOpen}
                      className="workspace-rail-tooltip"
                    >
                      <span className="font-medium">Workspaces</span>
                      <span className="opacity-75">{nav?.workspaceName ?? 'Choose a workspace'}</span>
                    </TooltipContent>
                  )}
                </Tooltip>
                <DropdownMenuContent
                  side="right"
                  align="start"
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
                    value={nav?.workspaceId ?? ''}
                    aria-label="Workspaces"
                    className="workspace-rail-workspace-list"
                    onValueChange={(id) => {
                      if (id && id !== nav?.workspaceId)
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
            <Navigation layout="rail" expanded={railExpanded} />
            <div className="workspace-rail-bottom">
              <Tooltip>
                <TooltipTrigger asChild data-slot="button">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="workspace-rail-control"
                    aria-label={railExpanded ? 'Collapse navigation' : 'Expand navigation'}
                    aria-controls="desktop-workspace-rail"
                    aria-expanded={railExpanded}
                    disabled={!hydrated}
                    onClick={toggleRail}
                  >
                    {railExpanded ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
                    <span className="sr-only workspace-rail-label">{railExpanded ? 'Collapse' : 'Expand'}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" hidden={railExpanded}>
                  Expand navigation
                </TooltipContent>
              </Tooltip>
              {nav && (
                <AccountMenu
                  access={nav.access}
                  returnTo={returnTo}
                  compact
                  iconOnly
                  suppressTooltip={railExpanded || workspaceMenuOpen}
                />
              )}
            </div>
          </header>
          <div className="workspace-column">
            {menuInShell && (
              <header className="workspace-topbar workspace-fallback-header">
                <div className="workspace-chrome-tools">
                  <WorkspaceMenuButton inShell />
                </div>
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
            <AcclimateMark className="size-5 shrink-0" /> Acclimate
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
    </WorkspaceChromeProvider>
  );
}
