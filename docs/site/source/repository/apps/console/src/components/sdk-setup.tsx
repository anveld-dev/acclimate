import type { ConsoleState } from '../server/channel';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { ConsoleLink } from './console-link';
import { CopyButton } from './copy-button';
import { connectionHref } from '../lib/connection-navigation';
import { deliveryRecipes } from './sdk-setup-recipes';

type Ready = Extract<ConsoleState, { status: 'ready' }>;
export function SdkSetup({ state, role }: { state: Ready; role?: string }) {
  const [language, setLanguage] = useState<'typescript' | 'python'>('typescript');
  const [reportingOpen, setReportingOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  useEffect(() => {
    const openReporting = () => {
      if (window.location.hash === '#reporting') setReportingOpen(true);
      if (window.location.hash === '#sdk-local-install') setInstallOpen(true);
    };
    openReporting();
    window.addEventListener('hashchange', openReporting);
    return () => window.removeEventListener('hashchange', openReporting);
  }, []);
  const { typescript, python } = deliveryRecipes({
    projectId: state.projectId,
    bundleId: state.bundleId,
    channel: state.channel,
  });
  const recipe = language === 'typescript' ? typescript : python;
  const buildCommands =
    language === 'typescript'
      ? 'npm run build:packages\nnpm pack --workspace @acclimate/sdk'
      : 'python3 -m pip wheel --no-deps --wheel-dir artifacts ./python';
  const canManage = role === 'admin';
  const credentialsHref = connectionHref(state.projectId, {
    bundleId: state.bundleId,
    channel: state.channel,
  });
  return (
    <section className="workspace-panel min-w-0 space-y-6 p-4 text-sm sm:p-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">App setup</h2>
        <p>
          Get this bundle into your app in three steps. Your app runs the agent and owns its tools
          and model credentials.
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-md bg-muted/40 px-3 py-2">
        <span className="min-w-0 break-all">
          <span className="text-muted-foreground">Bundle </span>
          <code>{state.bundleId}</code>
        </span>
        <span>
          <span className="text-muted-foreground">Channel </span>
          <code>{state.channel}</code>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Recipe language">
        <span className="mr-1 font-medium">Choose your language</span>
        {(['typescript', 'python'] as const).map((value) => (
          <Button
            key={value}
            variant={language === value ? 'default' : 'outline'}
            aria-pressed={language === value}
            onClick={() => setLanguage(value)}
          >
            {value === 'typescript' ? 'TypeScript' : 'Python'}
          </Button>
        ))}
      </div>
      <section className="space-y-2 border-t pt-4" aria-labelledby="sdk-install-heading">
        <h3 id="sdk-install-heading" className="font-semibold">
          1. Install the SDK
        </h3>
        <p>
          {language === 'typescript' ? (
            <>
              Ask your workspace admin for the <code>@acclimate/sdk</code> tarball, or build it from
              an Acclimate source checkout. Use Node.js 22.22+.
            </>
          ) : (
            <>
              Ask your workspace admin for the <code>acclimate-sdk</code> wheel, or build it from an
              Acclimate source checkout. Use Python 3.11+ on POSIX.
            </>
          )}{' '}
          <a
            href="#sdk-local-install"
            className="underline underline-offset-4"
            onClick={() => setInstallOpen(true)}
          >
            Install from this checkout
          </a>{' '}
          has the build commands and package installation steps.
        </p>
      </section>
      <section className="space-y-2 border-t pt-4" aria-labelledby="sdk-access-heading">
        <h3 id="sdk-access-heading" className="font-semibold">
          2. Configure access
        </h3>
        {canManage ? (
          <p>
            <ConsoleLink href={credentialsHref} className="underline underline-offset-4">
              Manage app credentials
            </ConsoleLink>{' '}
            in Connections for this bundle and channel. Create a content-read credential for your
            app.
          </p>
        ) : (
          <p>Ask a workspace admin for a content-read credential for this bundle and channel.</p>
        )}
        <p>
          Add the environment variables below to your app’s private environment. Keep credentials
          out of browser code and source control. The recipe already includes this bundle and
          channel.
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3">
          <span className="text-muted-foreground">API URL</span>
          <code className="min-w-0 select-text break-all">{state.publicApiUrl}</code>
          <CopyButton value={state.publicApiUrl} label="Copy API URL" />
        </div>
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-medium">
            Environment variables and private directories
          </summary>
          <div className="space-y-3 pt-3">
            <dl className="grid min-w-0 gap-x-3 gap-y-2 sm:grid-cols-[180px_minmax(0,1fr)]">
              <dt className="break-all font-mono">ACCLIMATE_URL</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-2">
                <code className="select-text break-all">{state.publicApiUrl}</code>
                <CopyButton value={state.publicApiUrl} label="Copy API URL" />
              </dd>
              <dt className="break-all font-mono">ACCLIMATE_TOKEN</dt>
              <dd>The private content-read credential for this bundle and channel.</dd>
              <dt className="break-all font-mono">ACCLIMATE_SCOPE</dt>
              <dd>
                A stable app identity for its cache scope. Give each identity its own scope; never
                use a token.
              </dd>
              <dt className="break-all font-mono">ACCLIMATE_CACHE</dt>
              <dd>An absolute path to your app&apos;s private cache directory.</dd>
              <dt className="break-all font-mono">ACCLIMATE_JOB_DIR</dt>
              <dd>An absolute path to a separate, empty private directory for this job.</dd>
            </dl>
            <p className="text-muted-foreground">
              Existing directories must be owned by the current user and private (mode 0700), with
              no symlink ancestors. The SDK rejects unsafe directories.
            </p>
          </div>
        </details>
      </section>
      <section className="min-w-0 space-y-3 border-t pt-4" aria-label="SDK delivery recipe">
        <div className="space-y-2">
          <h3 className="font-semibold">3. Run the delivery check</h3>
          <p>
            Fetch and verify the published bytes, prepare job-local files, then start a small child
            process that reads them. This check makes no model calls.
          </p>
          <p>
            {language === 'typescript' ? (
              <>
                Save the recipe as <code>delivery-check.mts</code> and run{' '}
                <code>npx tsx delivery-check.mts</code>.
              </>
            ) : (
              <>
                Save the recipe as <code>delivery_check.py</code> and run{' '}
                <code>python3 delivery_check.py</code>.
              </>
            )}
          </p>
          <p className="text-muted-foreground">
            The resolved version stays pinned for this job. Publishing a newer release does not
            change its prepared files. The check prints the version, digest and observed start, then
            cleans up its prepared files.
          </p>
        </div>
        <details className="min-w-0 rounded-md border p-3">
          <summary className="cursor-pointer font-medium">
            View the {language === 'typescript' ? 'TypeScript' : 'Python'} recipe
          </summary>
          <div className="min-w-0 space-y-3 pt-3">
            <pre
              tabIndex={0}
              aria-label={`${language === 'typescript' ? 'TypeScript' : 'Python'} delivery recipe`}
              className="max-w-full select-text overflow-auto rounded-md border bg-muted/40 p-3 text-sm"
            >
              <code>{recipe}</code>
            </pre>
          </div>
        </details>
        <CopyButton value={recipe} label="Copy recipe" size="default" />
      </section>
      <div className="divide-y border-t">
        <details className="py-3">
          <summary className="cursor-pointer font-medium">Workspace and bundle IDs</summary>
          <div className="pt-3">
            <dl className="grid min-w-0 gap-x-3 gap-y-1 sm:grid-cols-[100px_minmax(0,1fr)]">
              <dt className="text-muted-foreground">Workspace</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-2">
                <code className="select-text break-all">{state.projectId}</code>
                <CopyButton value={state.projectId} label="Copy workspace ID" />
              </dd>
              <dt className="text-muted-foreground">Bundle</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-2">
                <code className="select-text break-all">{state.bundleId}</code>
                <CopyButton value={state.bundleId} label="Copy bundle ID" />
              </dd>
              <dt className="text-muted-foreground">Channel</dt>
              <dd className="select-text break-all font-mono">{state.channel}</dd>
            </dl>
          </div>
        </details>
        <details
          id="sdk-local-install"
          className="scroll-mt-4 py-3"
          open={installOpen}
          onToggle={(event) => setInstallOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer font-medium">Install from this checkout</summary>
          <div className="min-w-0 space-y-2 pt-3">
            <p>
              In an Acclimate source checkout, run these commands from the repository root.
              {language === 'typescript'
                ? ' Install the repository dependencies with npm ci first if needed.'
                : ' Use a Python environment with pip installed.'}
            </p>
            <pre
              tabIndex={0}
              aria-label="SDK build commands"
              className="max-w-full select-text overflow-auto rounded-md bg-muted/40 p-3"
            >
              <code>{buildCommands}</code>
            </pre>
            <CopyButton value={buildCommands} label="Copy build commands" />
            <p>
              {language === 'typescript'
                ? 'npm prints the generated .tgz filename in the repository root.'
                : 'The generated .whl file is in the artifacts directory.'}{' '}
              In your app’s directory, install that file using its absolute path:
            </p>
            <pre
              tabIndex={0}
              aria-label="Install the generated SDK package"
              className="max-w-full select-text overflow-auto rounded-md bg-muted/40 p-3"
            >
              <code>
                {language === 'typescript'
                  ? 'npm install /absolute/path/to/the-generated-sdk.tgz'
                  : 'python3 -m pip install /absolute/path/to/the-generated-sdk.whl'}
              </code>
            </pre>
            <p className="text-muted-foreground">
              Replace the example path with the actual package file. Use the same installation
              command for a package supplied by your admin.
            </p>
          </div>
        </details>
        <details
          id="reporting"
          className="py-3"
          open={reportingOpen}
          onToggle={(event) => setReportingOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer font-medium">Optional delivery reports</summary>
          <div className="space-y-2 pt-3">
            <p>
              Reporting is off by default. Set both <code>ACCLIMATE_INTEGRATION</code> (the
              connection ID) and <code>ACCLIMATE_RECEIPT_TOKEN</code> (a separate private
              receipt-write credential) to enable the recipe&apos;s reports.
            </p>
            <p>
              {canManage ? (
                <>
                  <ConsoleLink href={credentialsHref} className="underline underline-offset-4">
                    Manage reporting credentials
                  </ConsoleLink>{' '}
                  in Connections to create the reporting credential.
                </>
              ) : (
                <>
                  Ask a workspace admin for a connection ID and a separate receipt-write credential.
                </>
              )}
            </p>
            <p>
              The reporting client uses a separate identity, a short deadline and no automatic
              retries. Optional reporting failures do not block delivery or application start.
              Replace the model-free child process with your app and observe its actual start before
              reporting started.
            </p>
            <p className="text-muted-foreground">
              Report only what the application observed. Missing reports mean unknown delivery; a
              report does not prove model consumption.
            </p>
          </div>
        </details>
        <details className="py-3">
          <summary className="cursor-pointer font-medium">Cache and offline delivery</summary>
          <div className="space-y-2 pt-3">
            <p>
              New jobs resolve online by default. Offline delivery requires explicit bounded
              permission or an explicitly pinned cached version. The cache is verified before use;
              denied access and integrity failures do not become offline success.
            </p>
            <p>
              Use{' '}
              {language === 'typescript' ? <code>prepareFiles</code> : <code>prepare_files</code>}{' '}
              or your app&apos;s native preparation plugin to stage a separate job-local copy.
              Approve reusable memory paths explicitly where the plugin requires it, and keep the
              resolved version pinned throughout that job.
            </p>
          </div>
        </details>
      </div>
    </section>
  );
}
