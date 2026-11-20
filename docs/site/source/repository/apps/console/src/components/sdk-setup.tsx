import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import type { ConsoleState } from '../server/channel';
import { useEffect, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { ConsoleLink } from './console-link';
import { CopyButton } from './copy-button';
import { Button } from './ui/button';
import { Code, Download, FileCode2, GitBranch } from 'lucide-react';
import { SetupReceipt } from './setup-receipt';
import { SyntaxCode } from './syntax-code';
import { connectionHref } from '../lib/connection-navigation';
import { bundleHref, workspaceHref } from '../navigation';
import {
  basicDeliveryRecipes,
  deliveryRecipes,
  nativeDeliveryRecipe,
  agentConnectionRecipes,
  applicationModuleRecipes,
} from './sdk-setup-recipes';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { NativeSelect } from './ui/native-select';
import releaseMetadata from '../../../../scripts/packaging/release-metadata.json';

type Ready = Extract<ConsoleState, { status: 'ready' }>;
type SetupScope = Pick<Ready, 'workspaceId' | 'bundleId' | 'bundleName' | 'channel' | 'publicApiUrl'>;
type Language = 'typescript' | 'python';

/** A visible step marker; the accessible heading still reads "1. Install the SDK". */
function StepNumber({ value }: { value: number }) {
  return (
    <>
      <span className="sdk-step-number" aria-hidden="true">
        {value}
      </span>
      <span className="sr-only">{value}. </span>
    </>
  );
}

function SdkLanguage({
  language,
  onChange,
}: {
  language: Language;
  onChange: (language: Language) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={language}
      aria-label="Recipe language"
      onValueChange={(value) => {
        if (value === 'typescript' || value === 'python') onChange(value);
      }}
    >
      <ToggleGroupItem className="min-h-9" value="typescript">
        TypeScript
      </ToggleGroupItem>
      <ToggleGroupItem className="min-h-9" value="python">
        Python
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

function sdkArtifact(language: Language) {
  return releaseMetadata.artifacts.find(
    (item) => item.package === (language === 'typescript' ? '@acclimate/sdk' : 'acclimate-sdk'),
  )!;
}

function sdkInstallCommand(language: Language, pluginFile?: string) {
  const path = '/absolute/path/to/release/';
  const artifact = path + sdkArtifact(language).file;
  return language === 'typescript'
    ? `npm install ${artifact}${pluginFile ? ' ' + path + pluginFile : ''}`
    : `python3 -m pip install ${artifact}`;
}

function InstallSnippet({ command }: { command: string }) {
  return (
    <div className="sdk-install-command">
      <SyntaxCode
        code={command}
        language="bash"
        aria-label="SDK package install command"
        className="sdk-command-code select-text"
      />
      <CopyButton value={command} label="Copy install command" iconOnly />
    </div>
  );
}

function EnvironmentSnippet({ apiUrl }: { apiUrl: string }) {
  return (
    <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3">
      {`ACCLIMATE_URL=${apiUrl}\nACCLIMATE_TOKEN=<content-read credential>\nACCLIMATE_SCOPE=<stable app identity>`}
    </pre>
  );
}

export function UseInAnApp({ state }: { state: SetupScope }) {
  const [language, setLanguage] = useState<Language>('typescript');
  const [open, setOpen] = useState(false);
  const install = sdkInstallCommand(language);
  const ids = `Workspace: ${state.workspaceId}\nBundle: ${state.bundleId}\nChannel: ${state.channel}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="use-in-app-trigger min-h-9">
          <Code aria-hidden="true" /> <span className="use-in-app-label">Use in an app</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] p-4" aria-label="Use this bundle in an app">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-sm">Use this bundle in an app</h2>
          <SdkLanguage language={language} onChange={setLanguage} />
        </div>
        <InstallSnippet command={install} />
        <EnvironmentSnippet apiUrl={state.publicApiUrl} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <pre className="min-w-0 whitespace-pre-wrap break-all">{ids}</pre>
          <CopyButton value={ids} label="Copy IDs" />
        </div>
        <div className="flex flex-wrap gap-2 border-t pt-3">
          <Button asChild>
            <ConsoleLink
              href={connectionHref(state.workspaceId, state)}
              onClick={() => setOpen(false)}
            >
              Connect an app
            </ConsoleLink>
          </Button>
          <Button asChild variant="outline">
            <ConsoleLink href={bundleHref(state, 'connect')} onClick={() => setOpen(false)}>
              Full setup guide
            </ConsoleLink>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function SdkSetup({
  state,
  role,
  step,
}: {
  state: SetupScope;
  role?: string;
  step?: 'delivery' | 'agent';
}) {
  const [language, setLanguage] = useState<Language>('typescript');
  const [runtime, setRuntime] = useState<'custom' | 'codex' | 'claude' | 'pi' | 'cursor'>('custom');
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
    workspaceId: state.workspaceId,
    bundleId: state.bundleId,
    channel: state.channel,
  };
  const runtimeLabel = {
    custom: 'Custom application',
    codex: 'Codex',
    claude: 'Claude',
    pi: 'Pi',
    cursor: 'Cursor',
  }[runtime];
  const recipe =
    runtime === 'custom'
      ? basicDeliveryRecipes(selection)[language]
      : nativeDeliveryRecipe(selection, runtime);
  const reportingRecipe = deliveryRecipes(selection)[language];
  const agentRecipe = agentConnectionRecipes(selection)[language];
  const moduleRecipe = applicationModuleRecipes()[language];
  const isTypeScript = language === 'typescript';
  const languageLabel = isTypeScript ? 'TypeScript' : 'Python';
  const filename =
    runtime !== 'custom'
      ? `${runtime}-delivery-check.mjs`
      : isTypeScript
        ? 'delivery-check.mjs'
        : 'delivery_check.py';
  const runCommand = `${isTypeScript ? 'node' : 'python3'} ${filename}`;
  const plugin =
    runtime === 'custom'
      ? undefined
      : releaseMetadata.artifacts.find((item) => item.package === `@acclimate/${runtime}-plugin`);
  const nativePeer = {
    codex: '@openai/codex-sdk',
    claude: '@anthropic-ai/claude-agent-sdk',
    pi: '@earendil-works/pi-coding-agent',
    cursor: '@cursor/sdk',
  } as const;
  const installCommand = sdkInstallCommand(language, plugin?.file);
  const buildCommands = isTypeScript
    ? `npm run build:packages\nnpm pack --workspace @acclimate/sdk${plugin ? ' --workspace ' + plugin.package : ''}`
    : 'python3 -m pip wheel --no-deps --wheel-dir artifacts ./python';
  const canManage = role === 'admin';
  const credentialsHref = connectionHref(state.workspaceId, {
    bundleId: state.bundleId,
    channel: state.channel,
  });
  const agentInstructions = (
    <div className="sdk-agent-instructions">
      <p>
        Connect your existing agent loop in{' '}
        <code>{isTypeScript ? 'application.mjs' : 'application.py'}</code>, the one module both
        delivery and evaluation load. Export{' '}
        <code>{isTypeScript ? 'runAgent' : 'run_agent'}</code> with the arguments below, plus the{' '}
        <code>cases</code>, <code>execute</code> and <code>grade</code> the evaluator needs; the
        application module recipe shows <code>execute</code> calling the same function.
      </p>
      <ol>
        <li>
          Set <code>ACCLIMATE_JOB_DIR</code> to an empty, private, persistent directory for this
          run.
        </li>
        <li>
          Supply the real task in <code>AGENT_TASK</code>, expose the supplied skill files through
          your tools, and return the result after the agent stops.
        </li>
        <li>
          Save the recipe beside the module as{' '}
          <code>{isTypeScript ? 'agent-connection.mjs' : 'agent_connection.py'}</code>. Run it with
          your private delivery settings.
        </li>
      </ol>
      <p className="sdk-agent-note">
        It retains the result in <code>ACCLIMATE_JOB_DIR/acclimate-agent-result.json</code> with its
        version and digest; use a new empty job directory for another run. Return stopped only
        after actual termination; a rejected call retains the private job directory for inspection
        instead of cleaning possibly active inputs.
      </p>
    </div>
  );
  return (
    <section className="sdk-setup sdk-setup-workspace sdk-recipe-lab min-w-0 text-sm">
      {!step && (
        <header className="sdk-setup-header">
          <div className="min-w-0">
            <h2>App setup</h2>
            <p>Prepare a delivery check for {state.bundleName ?? state.bundleId}.</p>
          </div>
          <a className="sdk-source-jump" href="#sdk-generated-file">
            View recipe ↓
          </a>
        </header>
      )}
      <section className="sdk-recipe-options" aria-label="Recipe configuration">
        <div className="sdk-control-group">
          <span>SDK language</span>
          <SdkLanguage
            language={language}
            onChange={(value) => {
              setLanguage(value);
              if (value === 'python') setRuntime('custom');
            }}
          />
        </div>
        <label className="block space-y-1">
          Application runtime
          <NativeSelect
            value={runtime}
            onChange={(event) => setRuntime(event.target.value as typeof runtime)}
            aria-label="Application runtime"
          >
            <option value="custom">Custom application</option>
            {isTypeScript && (
              <>
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
                <option value="pi">Pi</option>
                <option value="cursor">Cursor</option>
              </>
            )}
          </NativeSelect>
        </label>
        {!step && (
          <div className="sdk-scope">
            <span>SDK version</span>
            <strong>{releaseMetadata.version}</strong>
          </div>
        )}
        {!step && (
          <div className="sdk-scope">
            <span>Selected channel</span>
            <strong>
              <GitBranch aria-hidden="true" />
              {state.channel}
            </strong>
          </div>
        )}
      </section>
      <div className={step ? 'sdk-setup-layout sdk-connection-recipe' : 'sdk-setup-layout'}>
        {step !== 'agent' && (
          <>
            <section className="sdk-step sdk-install-step" aria-labelledby="sdk-install-heading">
              <h3 id="sdk-install-heading">
                <StepNumber value={1} />
                Install the SDK
              </h3>
              {!step && (
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
                  Use your admin’s release package.
                </p>
              )}
              <InstallSnippet command={installCommand} />
              <p className="sdk-install-help">
                {step
                  ? 'Use the absolute path to your release package.'
                  : 'In your app’s directory, replace the absolute path with your actual package file.'}
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
                    Verify release {releaseMetadata.version} against SHA256SUMS and the release
                    manifest.
                  </p>
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
                      ? 'npm writes the generated .tgz packages to the repository root.'
                      : 'The generated .whl file is in the artifacts directory.'}{' '}
                    Use its absolute path above.
                  </p>
                </DisclosureContent>
              </Disclosure>
            </section>
            <section className="sdk-step sdk-access-step" aria-labelledby="sdk-access-heading">
              <h3 id="sdk-access-heading">
                <StepNumber value={2} />
                Configure access
              </h3>
              {!step &&
                (canManage ? (
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
                ))}
              {step ? (
                <>
                  <EnvironmentSnippet apiUrl={state.publicApiUrl} />
                  {runtime !== 'custom' && (
                    <p>
                      Optional <code>ACCLIMATE_CACHE</code> selects the private cache directory. It
                      defaults to <code>~/.cache/acclimate/typescript</code>.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p>
                    Set these required delivery variables in your app’s private environment. Keep
                    credentials out of browser code and source control.
                  </p>
                  <dl
                    aria-label="Required environment variables"
                    className="sdk-required-environment"
                  >
                    <div>
                      <dt>ACCLIMATE_URL</dt>
                      <dd className="sdk-api-url">
                        <code>{state.publicApiUrl}</code>
                        <CopyButton value={state.publicApiUrl} label="Copy API URL" iconOnly />
                      </dd>
                    </div>
                    <div>
                      <dt>ACCLIMATE_TOKEN</dt>
                      <dd>Private content-read credential.</dd>
                    </div>
                    <div>
                      <dt>ACCLIMATE_SCOPE</dt>
                      <dd>Stable app identity for the cache; never a token.</dd>
                    </div>
                    {runtime !== 'custom' && (
                      <div>
                        <dt>ACCLIMATE_CACHE</dt>
                        <dd>
                          Optional private cache directory. Defaults to{' '}
                          <code>~/.cache/acclimate/typescript</code>.
                        </dd>
                      </div>
                    )}
                  </dl>
                </>
              )}
              <Disclosure className="sdk-disclosure">
                <DisclosureTrigger>Environment variables and private directories</DisclosureTrigger>
                <DisclosureContent className="sdk-detail-content">
                  <p>Give each identity its own scope; never use a token.</p>
                  <p>
                    The delivery check uses a private cache and a new job directory by default. To
                    choose their locations, set <code>ACCLIMATE_CACHE</code> and{' '}
                    <code>ACCLIMATE_JOB_DIR</code> to absolute paths. Keep each job directory
                    separate from the cache and empty before preparation.
                  </p>
                  <p>
                    Existing directories must be owned by the current user and private (mode 0700),
                    with no symlink ancestors. The SDK rejects unsafe directories.
                  </p>

                  <p>
                    <strong>Delivery:</strong> a workspace admin issues content-read access in
                    Connections; optional observations use a separate reporting credential.
                  </p>
                  <p>
                    <strong>Evaluation:</strong> ask the service operator for a dedicated workspace
                    read/write principal. Delivery credentials cannot read unpublished candidates or
                    execute evaluation requests. The operator currently validates static grants and
                    restarts the service.
                  </p>
                  <p>
                    <strong>Release:</strong> requires separate release authority and a deliberate
                    decision. Evaluation completion or a policy pass does not release a version.
                  </p>
                  <p>
                    Evaluator execution needs a private configuration file, a stable principal, and
                    durable owner-only local journals. TypeScript durable execution also needs
                    python3 with fcntl; Python needs 3.11+. Run the installed starter’s doctor
                    command before a first comparison.
                  </p>
                  <h4>Public evaluator access request for your operator</h4>
                  <SyntaxCode
                    language="json"
                    code={JSON.stringify(
                      {
                        serviceUrl: state.publicApiUrl,
                        workspaceId: state.workspaceId,
                        bundleId: state.bundleId,
                        rights: ['read', 'write'],
                        purpose:
                          'Evaluate unpublished candidates; proposal and release permissions are separate',
                      },
                      null,
                      2,
                    )}
                  />
                  <p>
                    This is a public request template, not a credential. Receive the private
                    evaluator configuration through your team’s secret channel; never paste it into
                    the console.
                  </p>
                  <ConsoleLink
                    href={workspaceHref(state.workspaceId, 'delivery')}
                    className="underline"
                  >
                    View reported delivery observations
                  </ConsoleLink>
                </DisclosureContent>
              </Disclosure>
            </section>
            <section className="sdk-step sdk-run-step">
              <div className="sdk-recipe-heading">
                <div>
                  <h3 id="sdk-check-heading">
                    <StepNumber value={3} />
                    Run the delivery check
                  </h3>
                  <p>
                    This check makes no model calls. Run it from the folder containing the
                    downloaded file.
                  </p>
                </div>
              </div>
              <div className="sdk-run-command-line">
                <SyntaxCode
                  code={runCommand}
                  language="bash"
                  aria-label="Run delivery check command"
                  className="sdk-command-code select-text"
                />
                <CopyButton value={runCommand} label="Copy run command" iconOnly />
              </div>
              <section
                id="sdk-generated-file"
                tabIndex={-1}
                className="sdk-step sdk-check-step"
                aria-label="SDK delivery recipe"
              >
                <div className="sdk-recipe-file">
                  <div className="sdk-recipe-toolbar">
                    <div className="sdk-file-name">
                      <FileCode2 aria-hidden="true" />
                      <h3>{filename}</h3>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <CopyButton value={recipe} label="Copy recipe" iconOnly />
                      <Button asChild variant="outline" size="sm">
                        <a
                          href={`data:text/plain;charset=utf-8,${encodeURIComponent(recipe)}`}
                          download={filename}
                          aria-label={`Download ${filename}`}
                        >
                          <Download aria-hidden="true" /> Download
                        </a>
                      </Button>
                    </div>
                  </div>
                  <SyntaxCode
                    code={recipe}
                    language={language}
                    path={filename}
                    wrap={false}
                    aria-label={`${languageLabel} delivery recipe`}
                    className="sdk-recipe-code select-text"
                    lineNumbers
                  />
                </div>
                {runtime === 'custom' ? (
                  <p className="sdk-expected-output">
                    On success, the resolved version stays pinned for this job. The check reads
                    every prepared file, prints the version, digest and checked file count, then
                    cleans up its prepared files.
                  </p>
                ) : (
                  <p className="sdk-expected-output">
                    The {runtimeLabel} plugin prepares the pinned bundle, prints its version, digest
                    and staged resource counts, then cleans up its private workspace.
                  </p>
                )}
              </section>
              {!step && (
                <aside className="sdk-receipt-panel">
                  <SetupReceipt {...selection} />
                </aside>
              )}
            </section>
          </>
        )}
        {step !== 'delivery' && (
          <section
            className="sdk-step sdk-agent-step space-y-3"
            aria-labelledby="sdk-agent-heading"
          >
            <h3 id="sdk-agent-heading">
              <StepNumber value={4} />
              Connect your agent, then compare a change
            </h3>
            {runtime === 'custom' ? (
              <>
                {step ? (
                  <Disclosure className="sdk-disclosure">
                    <DisclosureTrigger>Agent integration instructions</DisclosureTrigger>
                    <DisclosureContent className="sdk-detail-content">
                      {agentInstructions}
                    </DisclosureContent>
                  </Disclosure>
                ) : (
                  agentInstructions
                )}
                <div className="sdk-recipe-file">
                  <div className="sdk-recipe-toolbar">
                    <code>{isTypeScript ? 'agent-connection.mjs' : 'agent_connection.py'}</code>
                    <div className="flex flex-wrap gap-2">
                      <CopyButton value={agentRecipe} label="Copy agent connection recipe" />
                      <Button asChild size="sm" variant="outline" className="min-h-9">
                        <a
                          href={`data:text/plain;charset=utf-8,${encodeURIComponent(agentRecipe)}`}
                          download={isTypeScript ? 'agent-connection.mjs' : 'agent_connection.py'}
                          aria-label="Download agent connection recipe"
                        >
                          <Download aria-hidden="true" /> Download
                        </a>
                      </Button>
                    </div>
                  </div>
                  <SyntaxCode
                    code={agentRecipe}
                    language={isTypeScript ? 'javascript' : 'python'}
                    wrap={false}
                    aria-label={`${languageLabel} agent connection recipe`}
                    className="sdk-recipe-code select-text"
                  />
                </div>
                <div className="sdk-recipe-file">
                  <div className="sdk-recipe-toolbar">
                    <code>{isTypeScript ? 'application.mjs' : 'application.py'}</code>
                    <div className="flex flex-wrap gap-2">
                      <CopyButton value={moduleRecipe} label="Copy application module recipe" />
                    </div>
                  </div>
                  <SyntaxCode
                    code={moduleRecipe}
                    language={isTypeScript ? 'javascript' : 'python'}
                    wrap={false}
                    aria-label={`${languageLabel} application module recipe`}
                    className="sdk-recipe-code select-text"
                  />
                </div>
              </>
            ) : (
              <>
                <p>
                  Install the matching <code>@acclimate/{runtime}-plugin</code> package shown in
                  step 1. Extract{' '}
                  <code>
                    {
                      releaseMetadata.starters.find((item) => item.name === 'native-repository')!
                        .file
                    }
                  </code>{' '}
                  from your release. Its <code>application.mjs</code> already runs {runtimeLabel}{' '}
                  through a built-in adapter with explicit sandbox defaults: set{' '}
                  <code>&quot;harness&quot;: &quot;{runtime}&quot;</code> and your model in{' '}
                  <code>native.json</code>, then install the tested peer{' '}
                  <code>
                    {nativePeer[runtime]}@{releaseMetadata.nativePeers[nativePeer[runtime]]}
                  </code>
                  . You do not write an adapter. Run <code>node smoke.mjs</code> first for an
                  offline check with the replay harness.
                </p>
              </>
            )}
            <p>
              In your agent’s application directory, export your cases, agent callback and
              independent grader from{' '}
              <code>{isTypeScript ? 'application.mjs or application.mts' : 'application.py'}</code>.
              For a separate private case file, set <code>ACCLIMATE_EVALUATOR_CASES</code>. Run the
              command below. Use the resulting public configuration to request a comparison of the
              saved versions.
            </p>
            <SyntaxCode
              code={
                isTypeScript
                  ? 'npx --no-install acclimate-eval describe'
                  : 'python -m acclimate describe'
              }
              language="bash"
              aria-label="Describe evaluation configuration command"
            />
            <ConsoleLink
              href={bundleHref(selection, 'changes')}
              className="underline underline-offset-4"
            >
              Compare a change using this app
            </ConsoleLink>
          </section>
        )}
      </div>
      {!step && (
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
                Set <code>ACCLIMATE_CONNECTION</code> to your connection ID to scope the client’s
                delivery to that connection. To report observations, set{' '}
                <code>ACCLIMATE_RECEIPT_TOKEN</code> to a separate reporting credential.
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
                    Ask a workspace admin for a connection ID and a separate reporting credential.
                  </>
                )}
              </p>
              <p>
                The reporting client uses a separate identity, a short deadline and no automatic
                retries. Optional reporting failures do not block delivery or application start.
              </p>
              <p>
                Connect reporting to your application’s actual start event. Call{' '}
                <code>
                  {isTypeScript ? 'prepared.reportStarted()' : 'prepared.report_started()'}
                </code>{' '}
                after you observe the job start. Keep missing observations as unknown.
              </p>
              <CopyButton value={reportingRecipe} label="Copy reporting recipe" />
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
            <DisclosureTrigger>Preparing job-local files</DisclosureTrigger>
            <DisclosureContent className="sdk-detail-content">
              <p>
                Use <code>client.prepare</code> or your app&apos;s native preparation plugin to
                stage a separate job-local copy. Approve reusable memory paths explicitly where the
                plugin requires it, and keep the resolved version pinned throughout that job.
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
                    <code>{state.workspaceId}</code>
                    <CopyButton value={state.workspaceId} label="Copy workspace ID" iconOnly />
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
      )}
    </section>
  );
}
