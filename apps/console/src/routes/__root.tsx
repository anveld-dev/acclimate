import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  redirect,
} from '@tanstack/react-router';
import { signInHref } from '../lib/return-destination';
import { PendingChangesProvider } from '../components/pending-changes';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Shell } from '../components/shell';
import { readNavigation } from '../server/navigation-state';
import { Button } from '@/components/ui/button';
import styles from '../styles.css?url';
import railStyles from '../components/shell-rail.css?url';
import bundleHeaderStyles from '../components/bundle-header.css?url';
import syntaxStyles from '../components/syntax.css?url';
import fileWorkspaceStyles from '../components/file-workspace.css?url';
import sourceEditorStyles from '../components/source-editor.css?url';
import sdkSetupStyles from '../components/sdk-setup.css?url';
import pageHeaderStyles from '../components/page-header.css?url';
import workspacePageStyles from '../components/workspace-pages.css?url';
import workspaceMemberStyles from '../components/workspace-members.css?url';
import bundleLibraryStyles from '../components/bundle-library.css?url';
import settingsPageStyles from '../components/settings-pages.css?url';
import changesReleasesStyles from '../components/changes-releases.css?url';
import versionInspectorStyles from '../components/version-inspector.css?url';

export const Route = createRootRoute({
  loader: async ({ location, cause }) => {
    const nav = await readNavigation({ data: { path: location.pathname } });
    // Background revalidation must not navigate away from browser edits.
    if (
      !nav.access.ok &&
      nav.access.requiresSignIn &&
      cause !== 'stay' &&
      !location.pathname.startsWith('/auth/')
    ) {
      throw redirect({ href: signInHref(location.href), reloadDocument: true });
    }
    return nav;
  },
  staleTime: 0,
  shouldReload: true,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Acclimate · Agent context' },
      { name: 'description', content: 'Manage instructions, skills and memory for your agents.' },
    ],
    links: [
      { rel: 'stylesheet', href: styles },
      { rel: 'stylesheet', href: railStyles },
      { rel: 'stylesheet', href: bundleHeaderStyles },
      { rel: 'stylesheet', href: syntaxStyles },
      { rel: 'stylesheet', href: fileWorkspaceStyles },
      { rel: 'stylesheet', href: sourceEditorStyles },
      { rel: 'stylesheet', href: sdkSetupStyles },
      { rel: 'stylesheet', href: changesReleasesStyles },
      { rel: 'stylesheet', href: versionInspectorStyles },
      { rel: 'stylesheet', href: pageHeaderStyles },
      { rel: 'stylesheet', href: workspacePageStyles },
      { rel: 'stylesheet', href: workspaceMemberStyles },
      { rel: 'stylesheet', href: bundleLibraryStyles },
      { rel: 'stylesheet', href: settingsPageStyles },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
    ],
  }),
  headers: () => ({ 'Cache-Control': 'private, no-store' }),
  component: Root,
  notFoundComponent: () => (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p>This page is not part of the console.</p>
      <Button asChild variant="outline">
        <Link to="/">Back to bundles</Link>
      </Button>
    </div>
  ),
  errorComponent: () => (
    <div className="space-y-4" role="alert">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p>Refresh the page to try again. Check Releases before repeating a publish.</p>
      <Button asChild variant="outline">
        <a href="/">Back to bundles</a>
      </Button>
    </div>
  ),
});

function Root() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <TooltipProvider>
          <PendingChangesProvider>
            <Shell>
              <Outlet />
            </Shell>
          </PendingChangesProvider>
        </TooltipProvider>
        <Toaster theme="system" position="bottom-right" richColors />
        <Scripts />
      </body>
    </html>
  );
}
