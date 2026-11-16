import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import type { ConsoleState } from '../server/channel';
import { useEffect, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { ConsoleLink } from './console-link';
import { CopyButton } from './copy-button';
import { SyntaxCode } from './syntax-code';
import { connectionHref } from '../lib/connection-navigation';
import { basicDeliveryRecipes, deliveryRecipes } from './sdk-setup-recipes';

type Ready = Extract<ConsoleState, { status: 'ready' }>;
export function SdkSetup({ state, role }: { state: Ready; role?: string }) {
  const [language, setLanguage] = useState<'typescript' | 'python'>('typescript');
  const [reportingOpen, setReportingOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  useEffect(() => {
    const openLinkedSection = () => {
      if (window.location.hash === '#reporting') setReportingOpen(true);
      if (window.location.hash === '#sdk-local-install') setInstallOpen(true);
    };
    openLinkedSection();
    window.addEventListener('hashchange', openLinkedSection);
    return () => window.removeEventListener('hashchange', openLinkedSection);
  }, []);
  const selection = {
    projectId: state.projectId,
    bundleId: state.bundleId,
    channel: state.channel,
  };
  const recipe = basicDeliveryRecipes(selection)[language];
  const reportingRecipe = deliveryRecipes(selection)[language];
  const isTypeScript = language === 'typescript';
  const languageLabel = isTypeScript ? 'TypeScript' : 'Python';
  const filename = isTypeScript ? 'delivery-check.mts' : 'delivery_check.py';
  const runCommand = isTypeScript ? 'npx tsx delivery-check.mts' : 'python3 delivery_check.py';
  const installCommand = isTypeScript
    ? 'npm install /absolute/path/to/acclimate-sdk.tgz'
    : 'python3 -m pip install /absolute/path/to/acclimate-sdk.whl';
  const buildCommands = isTypeScript
    ? 'npm run build:packages\nnpm pack --workspace @acclimate/sdk'
    : 'python3 -m pip wheel --no-deps --wheel-dir artifacts ./python';
  const canManage = role === 'admin';
  const credentialsHref = connectionHref(state.projectId, {
    bundleId: state.bundleId,
    channel: state.channel,
  });
  return (
    <section className="sdk-setup sdk-setup-workspace min-w-0 text-sm">
      <header className="sdk-setup-header">
        <div className="min-w-0">
          <h2>App setup</h2>
          <p>Fetch a pinned bundle, prepare its files, then start your agent.</p>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          value={language}
          aria-label="Recipe language"
          onValueChange={(value) => {
            if (value) setLanguage(value as typeof language);
          }}
        >
          <ToggleGroupItem value="typescript">TypeScript</ToggleGroupItem>
          <ToggleGroupItem value="python">Python</ToggleGroupItem>
        </ToggleGroup>
      </header>
      <div className="sdk-setup-layout">
        <div className="sdk-setup-checklist">
          <section className="sdk-step sdk-install-step" aria-labelledby="sdk-install-heading">
            <h3 id="sdk-install-heading">1. Install the SDK</h3>
            <p>
              {isTypeScript ? (
                <>
                  Node.js 22.22+ on POSIX and an <code>@acclimate/sdk</code> tarball.
                </>
              ) : (
                <>
                  Python 3.11+ on POSIX and an <code>acclimate-sdk</code> wheel.
                </>
              )}{' '}
              Get the package from your admin or build it from this checkout.
            </p>
            <div className="sdk-install-command">
              <SyntaxCode
                code={installCommand}
                language="bash"
                aria-label="SDK package install command"
                className="sdk-command-code select-text"
              />
              <CopyButton value={installCommand} label="Copy install command" iconOnly />
            </div>
            <p className="sdk-install-help">
              Run in your app’s directory; replace the absolute path with your actual package file.
            </p>
            <Disclosure
              id="sdk-local-install"
              className="sdk-disclosure scroll-mt-4"
              open={installOpen}
              onOpenChange={setInstallOpen}
            >
              <DisclosureTrigger>Install from this checkout</DisclosureTrigger>
              <DisclosureContent className="sdk-detail-content">
                <p>
                  Run from the Acclimate repository root.
                  {isTypeScript
                    ? ' Install its dependencies with npm ci first if needed.'
                    : ' Use a Python environment with pip installed.'}
                </p>
                <SyntaxCode
                  code={buildCommands}
                  language="bash"
                  aria-label="SDK build commands"
                  className="sdk-command-code select-text"
                />
                <CopyButton value={buildCommands} label="Copy build commands" iconOnly />
                <p>
                  {isTypeScript
                    ? 'npm prints the generated .tgz filename in the repository root.'
                    : 'The generated .whl file is in the artifacts directory.'}{' '}
                  Use its absolute path above.
                </p>
              </DisclosureContent>
            </Disclosure>
          </section>
          <section className="sdk-step sdk-access-step" aria-labelledby="sdk-access-heading">
            <h3 id="sdk-access-heading">2. Configure access</h3>
            {canManage ? (
              <p>
                <ConsoleLink href={credentialsHref} className="underline underline-offset-4">
                  Manage app credentials
                </ConsoleLink>{' '}
                in Connections: create a content-read credential for this bundle and channel.
              </p>
            ) : (
              <p>
                Ask a workspace admin for a content-read credential for this bundle and channel.
              </p>
            )}
            <p>
              Set these five required variables in your app’s private environment. Keep credentials
              out of browser code and source control.
            </p>
            <dl aria-label="Required environment variables" className="sdk-required-environment">
              <div>
                <dt>ACCLIMATE_URL</dt>
                <dd>API base URL.</dd>
              </div>
              <div>
                <dt>ACCLIMATE_TOKEN</dt>
                <dd>Private content-read credential.</dd>
              </div>
              <div>
                <dt>ACCLIMATE_SCOPE</dt>
                <dd>Stable app identity for the cache; never a token.</dd>
              </div>
              <div>
                <dt>ACCLIMATE_CACHE</dt>
                <dd>Absolute private cache directory.</dd>
              </div>
              <div>
                <dt>ACCLIMATE_JOB_DIR</dt>
                <dd>Absolute, separate empty private job directory.</dd>
              </div>
            </dl>
            <Disclosure className="sdk-disclosure">
              <DisclosureTrigger>Environment variables and private directories</DisclosureTrigger>
              <DisclosureContent className="sdk-detail-content">
                <div className="sdk-api-url">
                  <span>API base URL</span>
                  <code>{state.publicApiUrl}</code>
                  <CopyButton value={state.publicApiUrl} label="Copy API URL" iconOnly />
                </div>
                <p>Give each identity its own scope; never use a token.</p>
                <p>
                  Use absolute paths for both directories. Keep each job directory separate from the
                  cache and empty before preparation.
                </p>
                <p>
                  Existing directories must be owned by the current user and private (mode 0700),
                  with no symlink ancestors. The SDK rejects unsafe directories.
                </p>
              </DisclosureContent>
            </Disclosure>
          </section>
        </div>
        <section className="sdk-step sdk-check-step" aria-label="SDK delivery recipe">
          <div className="sdk-recipe-heading">
            <div>
              <h3 id="sdk-check-heading">3. Run the delivery check</h3>
              <p>
                This check makes no model calls. Your app owns its agent, tools and model
                credentials.
              </p>
            </div>
          </div>
          <div className="sdk-recipe-file">
            <div className="sdk-recipe-toolbar">
              <code>{filename}</code>
              <CopyButton value={recipe} label="Copy recipe" size="default" />
            </div>
            <SyntaxCode
              code={recipe}
              language={language}
              path={filename}
              wrap={false}
              aria-label={`${languageLabel} delivery recipe`}
              className="sdk-recipe-code select-text"
            />
          </div>
          <div className="sdk-run-command">
            <span>
              Save as <code>{filename}</code>, then run:
            </span>
            <div className="sdk-run-command-line">
              <SyntaxCode
                code={runCommand}
                language="bash"
                aria-label="Run delivery check command"
                className="sdk-command-code select-text"
              />
              <CopyButton value={runCommand} label="Copy run command" iconOnly />
            </div>
          </div>
          <p className="sdk-expected-output">
            Expected: the resolved version stays pinned for this job. The check reads every prepared
            file, prints the version, digest and checked file count, then cleans up its prepared
            files.
          </p>
        </section>
      </div>
      <footer className="sdk-setup-support">
        <Disclosure
          id="reporting"
          className="sdk-disclosure"
          open={reportingOpen}
          onOpenChange={setReportingOpen}
        >
          <DisclosureTrigger>Optional delivery reports</DisclosureTrigger>
          <DisclosureContent className="sdk-detail-content">
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
            </p>
            <p>
              Replace the model-free child process with your app and observe its actual start before
              reporting started. Report only what the application observed. Missing reports mean
              unknown delivery; a report does not prove model consumption.
            </p>
            <div className="sdk-reporting-recipe-heading">
              <h4>Delivery check with optional reports</h4>
              <CopyButton value={reportingRecipe} label="Copy reporting recipe" />
            </div>
            <p>
              This longer example observes a model-free child process starting. Reporting still
              needs both optional variables above.
            </p>
            <SyntaxCode
              code={reportingRecipe}
              language={language}
              wrap={false}
              aria-label={`${languageLabel} reporting recipe`}
              className="sdk-reporting-code select-text"
            />
          </DisclosureContent>
        </Disclosure>
        <Disclosure className="sdk-disclosure">
          <DisclosureTrigger>Cache and offline delivery</DisclosureTrigger>
          <DisclosureContent className="sdk-detail-content">
            <p>
              New jobs resolve online by default. Offline delivery requires explicit bounded
              permission or an explicitly pinned cached version. The cache is verified before use;
              denied access and integrity failures do not become offline success.
            </p>
            <p>
              Use <code>{isTypeScript ? 'prepareFiles' : 'prepare_files'}</code> or your app&apos;s
              native preparation plugin to stage a separate job-local copy. Approve reusable memory
              paths explicitly where the plugin requires it, and keep the resolved version pinned
              throughout that job.
            </p>
          </DisclosureContent>
        </Disclosure>
        <Disclosure className="sdk-disclosure">
          <DisclosureTrigger>Workspace and bundle IDs</DisclosureTrigger>
          <DisclosureContent className="sdk-detail-content">
            <dl className="sdk-selection-details">
              <div>
                <dt>Workspace</dt>
                <dd>
                  <code>{state.projectId}</code>
                  <CopyButton value={state.projectId} label="Copy workspace ID" iconOnly />
                </dd>
              </div>
              <div>
                <dt>Bundle</dt>
                <dd>
                  <code>{state.bundleId}</code>
                  <CopyButton value={state.bundleId} label="Copy bundle ID" iconOnly />
                </dd>
              </div>
              <div>
                <dt>Channel</dt>
                <dd>
                  <code>{state.channel}</code>
                </dd>
              </div>
            </dl>
          </DisclosureContent>
        </Disclosure>
      </footer>
    </section>
  );
}
