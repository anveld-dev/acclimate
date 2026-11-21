import { ListToolbar } from './list-toolbar';
import { ReceiptTime } from './receipt-time';
import { DirectorySearch } from './ui/directory-search';
import { CopyButton } from './copy-button';
import { SyntaxCode } from './syntax-code';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { ArrowRight, BookOpen, Files, FileText, Layers3, MoreHorizontal, Plus, Upload } from 'lucide-react';
import { NativeSelect } from './ui/native-select';
import {
  compatibilityIssues,
  validatePayload,
  type CompatibilityTarget,
  type CompatibilityIssue,
} from '@acclimate/sdk/validation';
import {
  freezePending,
  loadPending,
  resolvePending,
  forgetPending,
  type PendingScope,
} from '../lib/pending-operation';
import { setupRequest } from '../lib/content-operation';
import { Checkbox } from '@/components/ui/checkbox';
import { useRouter } from '@tanstack/react-router';
import { ConsoleLink, consoleDestination } from './console-link';
import { bundleHref, workspaceHref } from '../navigation';
import { signInHref } from '../lib/return-destination';
import { useEffect, useRef, useState } from 'react';
import { usePendingChanges } from './pending-changes';
import type { BundleScope } from '../server/selection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { PageTitle } from './shared';
import { ImportContent } from './import-content';
import type { BundlePayload } from '@acclimate/sdk';
const targetLabels: Record<CompatibilityTarget, string> = {
  generic: 'Generic',
  codex: 'Codex',
  claude: 'Claude',
  pi: 'Pi',
  cursor: 'Cursor',
};
const sourceLabels = {
  created: 'Created',
  imported: 'Imported',
  example: 'Example',
  unknown: 'Stored content',
};
const EMPTY_IMPORT: BundlePayload = { schemaVersion: 1, files: [] };
import {
  createWorkspaceContent,
  readWorkspaceBundles,
  reconcileSetup,
  closeSetup,
} from '../server/setup-actions';
type LibraryState = Awaited<ReturnType<typeof readWorkspaceBundles>>;
export function BundleLibrary({ state, workspaceId }: { state: LibraryState; workspaceId: string }) {
  const router = useRouter();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { setPendingChanges, confirmDiscard, discardVersion } = usePendingChanges();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [name, setName] = useState('');
  const [bundleQuery, setBundleQuery] = useState('');
  const entries = state.ok ? state.entries.filter((entry) => entry.workspaceId === workspaceId) : [];
  const [targetFilter, setTargetFilter] = useState('');
  const targets = Array.from(
    new Set(entries.map(({ bundle }) => bundle.compatibilityTarget)),
  ).sort();
  const query = bundleQuery.trim().toLowerCase();
  const visibleEntries = entries.filter(
    ({ bundle, channels }) =>
      (!targetFilter || bundle.compatibilityTarget === targetFilter) &&
      [
        bundle.name,
        bundle.id,
        ...channels.flatMap((channel) => [channel.name, channel.versionId]),
      ].some((value) => value.toLowerCase().includes(query)),
  );
  const [channel, setChannel] = useState('stable');
  const [compatibilityTarget, setCompatibilityTarget] = useState<CompatibilityTarget>('generic');
  const [source, setSource] = useState<'created' | 'imported' | 'files'>('created');
  const [json, setJson] = useState('');
  const [importedFiles, setImportedFiles] = useState<BundlePayload>(EMPTY_IMPORT);
  const [readingFiles, setReadingFiles] = useState(false);
  const [initialText, setInitialText] = useState('');
  const dirty = Boolean(
    name ||
      json ||
      initialText ||
      importedFiles.files.length ||
      readingFiles ||
      channel !== 'stable' ||
      compatibilityTarget !== 'generic',
  );
  const lastDiscardVersion = useRef(discardVersion);
  function clearBrowserText() {
    setName('');
    setJson('');
    setImportedFiles(EMPTY_IMPORT);
    setReadingFiles(false);
    setInitialText('');
    setChannel('stable');
    setConfirmed(false);
    setCompatibilityTarget('generic');
    setSource('created');
  }
  function openCreated(selection: BundleScope) {
    if (!mounted.current) return;
    clearBrowserText();
    setPendingChanges(false);
    void router.navigate({
      ...consoleDestination(bundleHref(selection, 'content')),
      ignoreBlocker: true,
    });
  }
  useEffect(() => {
    setPendingChanges(dirty);
    return () => setPendingChanges(false);
  }, [dirty, setPendingChanges]);
  useEffect(() => {
    if (lastDiscardVersion.current === discardVersion) return;
    lastDiscardVersion.current = discardVersion;
    clearBrowserText();
    setShowCreate(false);
  }, [discardVersion]);
  type Pending = { key: string; workspaceId: string; body?: string };
  const recoveryScope: PendingScope = {
    owner: 'library',
    actorScope: state.ok ? state.actorScope : 'unauthenticated',
    serviceIdentity: state.ok ? state.serviceIdentity : '',
    workspaceId,
  };
  const [operation, setOperation] = useState<Pending>();
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    setStorageReady(false);
    try {
      const frozen = loadPending(sessionStorage, recoveryScope);
      setOperation(frozen ? { key: frozen.key, workspaceId, body: frozen.body } : undefined);
      setStorageReady(true);
    } catch {
      setMessage(
        'Creation recovery data could not be read. Enable browser storage before creating content.',
      );
    }
  }, [recoveryScope.actorScope, recoveryScope.serviceIdentity, workspaceId]);
  let preview: { path: string; kind: string; text: string }[] | undefined;
  let validationError = '';
  let importIssues: CompatibilityIssue[] = [];
  function creationPayload(): unknown {
    if (source === 'imported') return JSON.parse(json);
    if (source === 'files') return importedFiles;
    return {
      schemaVersion: 1,
      files: [{ path: 'AGENTS.md', kind: 'instruction', text: initialText }],
    };
  }
  try {
    const candidate = creationPayload();
    validatePayload(candidate);
    preview = candidate.files;
    importIssues = compatibilityIssues(candidate, compatibilityTarget);
  } catch (error) {
    if (source === 'imported' && json.trim())
      validationError =
        error instanceof SyntaxError
          ? 'Enter valid bundle JSON.'
          : error instanceof Error
            ? error.message
            : 'Invalid bundle JSON.';
  }
  let submittedSummary: string | undefined;
  if (operation?.body) {
    try {
      const submitted = JSON.parse(operation.body);
      if (
        typeof submitted.name === 'string' &&
        typeof submitted.channel === 'string' &&
        Array.isArray(submitted.payload?.files)
      )
        submittedSummary = `${submitted.name} · Publishes ${submitted.payload.files.length} ${submitted.payload.files.length === 1 ? 'entry' : 'entries'} to ${submitted.channel}. Target: ${submitted.compatibilityTarget || 'generic'}, fixed for this bundle. No evaluation.`;
    } catch {}
  }
  async function reconcile() {
    if (!operation) return;
    setPending(true);
    try {
      const result = await reconcileSetup({ data: operation });
      if (!result.ok) setMessage(result.message);
      else if (result.committed || result.closed) {
        resolvePending(sessionStorage, recoveryScope);
        setOperation(undefined);
        setMessage(
          result.closed
            ? 'Creation operation closed. Review a new request.'
            : 'Creation confirmed. No model evaluation was run.',
        );
        if (result.selection) openCreated(result.selection);
        await router.invalidate();
      } else
        setMessage(
          'No committed result observed yet. You can retry the identical content with the same operation key; do not create a new operation.',
        );
    } catch {
      setMessage('Result unavailable. Keep this creation pending and check again.');
    } finally {
      setPending(false);
    }
  }
  async function create() {
    const origin = source === 'files' ? 'imported' : source;
    if (!storageReady) return;
    setPending(true);
    setMessage('');
    try {
      const payload = operation ? undefined : creationPayload();
      const reviewed = { workspaceId, name, channel, origin, payload, compatibilityTarget };
      if (operation) {
        const stored = loadPending(sessionStorage, recoveryScope);
        if (!stored?.body) {
          setOperation({ ...operation, body: undefined });
          setMessage('Submitted text was forgotten or expired. Reconcile or close this operation.');
          return;
        }
      }
      if (operation && !operation.body) {
        setMessage(
          'Only the operation identity remains. Reconcile or close it before creating a new bundle.',
        );
        return;
      }
      const current =
        operation ??
        (() => {
          const frozen = freezePending(
            sessionStorage,
            recoveryScope,
            `/v1/workspaces/${encodeURIComponent(workspaceId)}/bundle-setups`,
            setupRequest(reviewed),
          );
          return { key: frozen.key, workspaceId, body: frozen.body };
        })();
      setOperation(current);
      const request = { ...JSON.parse(current.body!), workspaceId } as Parameters<
        typeof createWorkspaceContent
      >[0]['data'];
      if (operation) {
        const prior = await reconcileSetup({ data: current });
        if (!prior.ok) {
          setMessage(prior.message);
          return;
        }
        if (prior.committed || prior.closed) {
          resolvePending(sessionStorage, recoveryScope);
          setOperation(undefined);
          await router.invalidate();
          setMessage(
            prior.closed
              ? 'Earlier operation closed. Review a new creation.'
              : 'Earlier creation confirmed.',
          );
          if (prior.selection) openCreated(prior.selection);
          return;
        }
      }
      const result = await createWorkspaceContent({ data: { ...request, key: current.key } });
      if (!result.ok) {
        setMessage(result.message);
        if (!result.uncertain) {
          resolvePending(sessionStorage, recoveryScope);
          setOperation(undefined);
        }
      } else {
        resolvePending(sessionStorage, recoveryScope);
        setOperation(undefined);
        setMessage('Content created. No model evaluation was run.');
        openCreated(result.selection);
        await router.invalidate();
      }
    } catch {
      setMessage(
        'Check the bundle JSON. If creation was submitted, check its result before trying again.',
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="bundle-library mx-auto w-full max-w-5xl space-y-4">
      <PageTitle
        title={showCreate ? 'Create a bundle' : 'Bundles'}
        description={
          showCreate
            ? 'Write instructions or import the files your agents use.'
            : 'The instructions, skills and memory your agents work with.'
        }
        actions={
          state.ok &&
          state.canEdit &&
          (operation || (entries.length > 0 && !showCreate)) && (
            <Button
              disabled={Boolean(operation)}
              onClick={() => setShowCreate(true)}
            >
              {!operation && <Plus aria-hidden="true" />}
              {operation ? 'Pending creation' : 'New bundle'}
            </Button>
          )
        }
      />
      {operation && (
        <section
          role="status"
          className="space-y-3 rounded-md border border-amber-500/50 bg-amber-500/5 p-4"
        >
          <h2 className="font-semibold">Creation result unresolved</h2>
          <p>We couldn't confirm this submission. Check its result before submitting again.</p>
          {submittedSummary && (
            <p className="break-words text-sm" aria-label="Submitted publication summary">
              {submittedSummary}
            </p>
          )}
          <Button disabled={pending} onClick={() => void reconcile()}>
            Check result
          </Button>
          <Disclosure className="space-y-3">
            <DisclosureTrigger>Creation recovery details</DisclosureTrigger>
            <DisclosureContent className="space-y-3">
              <p className="break-all text-sm">
                Operation: {operation.key}. New creation stays blocked until this operation is
                resolved or closed.
              </p>
              {operation.body ? (
                <>
                  <SyntaxCode
                    className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-sm"
                    aria-label="Exact submitted creation"
                    code={operation.body}
                    language="json"
                  />
                  <Button variant="outline" disabled={pending} onClick={() => void create()}>
                    Retry exact submitted creation
                  </Button>
                  <p className="text-sm text-muted-foreground">
                    Retry sends this frozen request with the same operation key.
                  </p>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      forgetPending(sessionStorage, recoveryScope);
                      setOperation({ ...operation, body: undefined });
                      setMessage(
                        'Submitted text forgotten; reconciliation or close is still required.',
                      );
                    }}
                  >
                    Forget submitted text
                  </Button>
                </>
              ) : (
                <p>
                  Submitted text is unavailable. Exact retry is unavailable; check the result or
                  close this operation.
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                Forgetting text does not cancel submission. Closing preserves any committed result.
              </p>
              <Button
                variant="outline"
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  try {
                    const result = await closeSetup({ data: { workspaceId, key: operation.key } });
                    if (result.ok && result.operation.status === 'closed') {
                      resolvePending(sessionStorage, recoveryScope);
                      setOperation(undefined);
                      setMessage('Creation operation closed.');
                    } else if (result.ok) await reconcile();
                    else setMessage(result.message);
                  } catch {
                    setMessage('Close outcome unknown. Check the result before another creation.');
                  } finally {
                    setPending(false);
                  }
                }}
              >
                Close unresolved creation
              </Button>
            </DisclosureContent>
          </Disclosure>
        </section>
      )}
      {!state.ok ? (
        state.requiresSignIn ? (
          <section className="workspace-panel space-y-4 p-6" aria-label="Sign in required">
            <h2 className="text-lg font-semibold">Sign in to open this workspace</h2>
            <p className="text-muted-foreground">Sign in to view your bundles and saved changes.</p>
            <Button asChild>
              <a href={signInHref(workspaceHref(workspaceId, 'bundles'))}>Sign in</a>
            </Button>
          </section>
        ) : (
          <p role="alert">{state.message}</p>
        )
      ) : (
        <>
          <section hidden={showCreate} aria-labelledby="bundle-list-heading">
            <h2 id="bundle-list-heading" className="sr-only">
              Your bundles
            </h2>
            {!entries.length ? (
              !showCreate &&
              !operation && (
                <div className="bundle-library-empty mx-auto flex max-w-2xl flex-col items-center rounded-xl border border-dashed bg-card px-6 py-14 text-center sm:py-20">
                  <span className="mb-5 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Layers3 className="size-6" aria-hidden="true" />
                  </span>
                  <h2 className="text-2xl font-semibold tracking-tight">
                    Give your agents a place to start
                  </h2>
                  <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
                    A bundle keeps your agent’s instructions, reusable skills and approved memory
                    together. Start with a few instructions. You can add more files as you go.
                  </p>
                  {state.canEdit ? (
                    <Button
                      className="mt-6"
                      disabled={!storageReady}
                      onClick={() => setShowCreate(true)}
                    >
                      <Plus aria-hidden="true" /> Create your first bundle
                    </Button>
                  ) : (
                    <p className="mt-6 text-sm text-muted-foreground">
                      Ask a workspace editor to create your first bundle.
                    </p>
                  )}
                </div>
              )
            ) : (
              <div className="bundle-directory overflow-hidden rounded-lg border bg-card">
                <ListToolbar count={query || targetFilter
                  ? `${visibleEntries.length} of ${entries.length} bundles`
                  : `${entries.length} ${entries.length === 1 ? 'bundle' : 'bundles'}`}>
                  <DirectorySearch
                    id="bundle-search"
                    label="Find a bundle"
                    placeholder="Search by name, ID, or channel"
                    value={bundleQuery}
                    onValueChange={setBundleQuery}
                  />
                  {targets.length > 1 && (
                    <div className="bundle-target-filter">
                      <Label htmlFor="bundle-target-filter">Target</Label>
                      <NativeSelect
                        id="bundle-target-filter"
                        value={targetFilter}
                        onChange={(event) => setTargetFilter(event.target.value)}
                      >
                        <option value="">All targets</option>
                        {targets.map((target) => (
                          <option key={target} value={target}>
                            {targetLabels[target]}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                  )}
                </ListToolbar>
                <div className="bundle-directory-heading directory-heading" aria-hidden="true">
                  <span>Bundle</span>
                  <span>Published channels</span>
                  <span>Created</span>
                  <span />
                </div>
                <ul className="divide-y">
                  {visibleEntries.map(({ bundle, channels }) => {
                    const primary =
                      channels.find((channel) => channel.name === 'stable') ?? channels[0];
                    const matchingChannels = channels.filter(
                      (channel) =>
                        channel !== primary &&
                        query &&
                        [channel.name, channel.versionId].some((value) =>
                          value.toLowerCase().includes(query),
                        ),
                    );
                    const otherChannels = channels.filter(
                      (channel) => channel !== primary && !matchingChannels.includes(channel),
                    );
                    const channelLink = ({ name, revision }: (typeof channels)[number]) => {
                      const scope = { workspaceId, bundleId: bundle.id, channel: name };
                      return (
                        <span key={name} className="bundle-published-channel">
                          <ConsoleLink
                            aria-description={`Open content on ${name}`}
                            href={bundleHref(scope, 'content')}
                          >
                            {name}
                          </ConsoleLink>
                          <ConsoleLink
                            aria-label={`Revision ${revision} on ${name} for ${bundle.name}`}
                            href={bundleHref(scope, 'releases') + '#revision-' + revision}
                          >
                            Revision {revision}
                          </ConsoleLink>
                        </span>
                      );
                    };
                    return (
                      <Disclosure key={bundle.id} asChild>
                        <li className="bundle-library-row directory-row">
                          <div className="bundle-directory-name flex min-w-0 flex-1 items-center gap-3">
                            <BookOpen
                              className="size-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                            <div className="min-w-0">
                              <h3 className="break-words font-medium">
                                {primary ? (
                                  <ConsoleLink
                                    className="bundle-directory-link"
                                    aria-description={`Opens the ${primary.name} channel`}
                                    href={bundleHref(
                                      { workspaceId, bundleId: bundle.id, channel: primary.name },
                                      'content',
                                    )}
                                  >
                                    {bundle.name}
                                  </ConsoleLink>
                                ) : (
                                  bundle.name
                                )}
                              </h3>
                              {(bundle.origin !== 'created' || bundle.compatibilityTarget !== 'generic') && (
                                <span className="bundle-directory-meta">
                                  {[bundle.origin !== 'created' && sourceLabels[bundle.origin],
                                    bundle.compatibilityTarget !== 'generic' && targetLabels[bundle.compatibilityTarget]]
                                    .filter(Boolean).join(' · ')}
                                </span>
                              )}
                            </div>
                          </div>
                          <div
                            className="bundle-directory-channels"
                            aria-label={`Published channels for ${bundle.name}`}
                          >
                            <span className="bundle-directory-channel-label">
                              Published channels
                            </span>
                            {primary && channelLink(primary)}
                            {matchingChannels.map(channelLink)}
                            {otherChannels.length > 0 && (
                              <Disclosure className="bundle-channel-disclosure">
                                <DisclosureTrigger>
                                  Other channels ({otherChannels.length})
                                </DisclosureTrigger>
                                <DisclosureContent>
                                  {otherChannels.map(channelLink)}
                                </DisclosureContent>
                              </Disclosure>
                            )}
                            {!channels.length && (
                              <span className="text-sm text-muted-foreground">
                                No published channels
                              </span>
                            )}
                          </div>
                          <span className="bundle-directory-created">
                            <ReceiptTime value={bundle.createdAt} relative />
                          </span>
                          <DisclosureTrigger
                            className="bundle-reference-trigger"
                            title="SDK reference"
                            aria-label={`SDK reference for ${bundle.name}`}
                          >
                            <MoreHorizontal aria-hidden="true" className="size-4" />
                          </DisclosureTrigger>
                          <DisclosureContent className="bundle-reference-details">
                            <dl className="grid gap-4 sm:grid-cols-2">
                              {[
                                ['Workspace ID', workspaceId, 'Copy workspace ID'],
                                ['Bundle ID', bundle.id, 'Copy bundle ID'],
                              ].map(([label, value, copyLabel]) => (
                                <div key={label} className="min-w-0">
                                  <dt className="text-sm text-muted-foreground">{label}</dt>
                                  <dd className="flex items-center gap-2">
                                    <code className="min-w-0 break-all text-sm select-all">
                                      {value}
                                    </code>
                                    <CopyButton value={value} label={copyLabel} iconOnly />
                                  </dd>
                                </div>
                              ))}
                            </dl>
                            {channels.length > 0 && (
                              <div className="bundle-version-references">
                                {channels.map((channel) => (
                                  <div className="bundle-version-reference" key={channel.name}>
                                    <div>
                                      <span className="font-medium">{channel.name}</span>
                                      <span className="text-muted-foreground">
                                        {' '}
                                        · Revision {channel.revision}
                                      </span>
                                    </div>
                                    <div className="bundle-version-id">
                                      <span className="text-muted-foreground">Version ID</span>
                                      <code className="break-all select-all">
                                        {channel.versionId}
                                      </code>
                                      <CopyButton
                                        iconOnly
                                        value={channel.versionId}
                                        label={`Copy version ID for ${channel.name}`}
                                      />
                                    </div>
                                    <Button size="sm" variant="outline" asChild>
                                      <ConsoleLink
                                        aria-label={`App setup for ${channel.name}`}
                                        href={bundleHref(
                                          { workspaceId, bundleId: bundle.id, channel: channel.name },
                                          'connect',
                                        )}
                                      >
                                        App setup <ArrowRight aria-hidden="true" />
                                      </ConsoleLink>
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </DisclosureContent>
                        </li>
                      </Disclosure>
                    );
                  })}
                </ul>
                {!visibleEntries.length && (
                  <div className="grid justify-items-start gap-3 p-5">
                    <p className="break-all text-sm text-muted-foreground">
                      {query
                        ? `No bundles match “${bundleQuery}”.`
                        : 'No bundles match this target.'}
                    </p>
                    {targetFilter && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setTargetFilter('');
                          setBundleQuery('');
                          document.getElementById('bundle-search')?.focus();
                        }}
                      >
                        Reset filters
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
          {state.canEdit && storageReady && showCreate && !operation && (
            <section
              className="bundle-create-form mx-auto max-w-3xl space-y-5 rounded-xl border bg-card p-5 sm:p-6"
              aria-label="Create a bundle"
            >
              <fieldset className="space-y-2" disabled={pending}>
                <legend className="sr-only">Source</legend>
                <RadioGroup
                  name="bundle-source"
                  aria-label="Bundle source"
                  className="grid gap-2 sm:grid-cols-3"
                  value={source}
                  disabled={pending}
                  onValueChange={(value) => {
                    setSource(value as typeof source);
                    setConfirmed(false);
                  }}
                >
                  {(
                    [
                      ['created', 'Write instructions', FileText],
                      ['files', 'Import files', Files],
                      ['imported', 'Import JSON', Upload],
                    ] as const
                  ).map(([value, label, Icon]) => (
                    <Label
                      key={value}
                      htmlFor={`bundle-source-${value}`}
                      className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-2 py-2.5 text-sm sm:px-3 ${source === value ? 'border-primary bg-primary/5 font-medium' : 'text-muted-foreground hover:bg-muted/50'}`}
                    >
                      <RadioGroupItem id={`bundle-source-${value}`} value={value} />
                      <Icon className="hidden size-4 shrink-0 sm:block" aria-hidden="true" />
                      {label}
                    </Label>
                  ))}
                </RadioGroup>
              </fieldset>
              <div className="space-y-2">
                <Label htmlFor="new-bundle-name">Bundle name</Label>
                <Input
                  disabled={pending}
                  id="new-bundle-name"
                  autoFocus
                  placeholder="e.g. Engineering guidelines"
                  value={name}
                  maxLength={200}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              {source === 'created' && (
                <div className="space-y-2">
                  <Label htmlFor="new-bundle-instructions">Instructions</Label>
                  <Textarea
                    disabled={pending}
                    id="new-bundle-instructions"
                    value={initialText}
                    onChange={(e) => setInitialText(e.target.value)}
                    className="min-h-32 text-sm leading-relaxed"
                    placeholder="How should your agent work? Describe your team’s conventions, review standards or preferred approach."
                  />
                </div>
              )}
              {source === 'files' && (
                <div className="space-y-3">
                  <ImportContent
                    payload={importedFiles}
                    disabled={pending}
                    onReadingChange={setReadingFiles}
                    onApply={(payload) => {
                      setImportedFiles(payload);
                      setConfirmed(false);
                    }}
                  />
                  {importedFiles.files.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending || readingFiles}
                      onClick={() => {
                        setImportedFiles(EMPTY_IMPORT);
                        setConfirmed(false);
                      }}
                    >
                      Clear imported files
                    </Button>
                  )}
                </div>
              )}
              {source === 'imported' && (
                <div className="space-y-2">
                  <Label htmlFor="new-bundle-json">Bundle JSON</Label>
                  <Textarea
                    disabled={pending}
                    id="new-bundle-json"
                    className="min-h-48 font-mono text-sm"
                    placeholder={
                      '{"schemaVersion": 1, "files": [{"path": "AGENTS.md", "kind": "instruction", "text": "Your instructions"}]}'
                    }
                    value={json}
                    onChange={(e) => {
                      setJson(e.target.value);
                      setConfirmed(false);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Paste a bundle export with schemaVersion and files. Review its entries below
                    before publishing.
                  </p>
                  {validationError && (
                    <p role="alert" className="text-sm text-destructive">
                      {validationError}
                    </p>
                  )}
                </div>
              )}
              <Disclosure className="rounded-lg border px-4 py-3">
                <DisclosureTrigger className="cursor-pointer text-sm font-medium">
                  Publishing settings{' '}
                  <span className="font-normal text-muted-foreground">
                    · {channel || 'Choose a channel'}
                    {` · ${compatibilityTarget}`}
                  </span>
                </DisclosureTrigger>
                <DisclosureContent>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="new-bundle-channel">Initial channel</Label>
                      <Input
                        disabled={pending}
                        id="new-bundle-channel"
                        value={channel}
                        onChange={(e) => setChannel(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        A named release your agents can follow. Stable works for most teams.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="new-bundle-target">Compatibility target</Label>
                      <NativeSelect
                        disabled={pending}
                        id="new-bundle-target"
                        value={compatibilityTarget}
                        onChange={(e) =>
                          setCompatibilityTarget(e.target.value as CompatibilityTarget)
                        }
                      >
                        {['generic', 'codex', 'claude', 'pi', 'cursor'].map((target) => (
                          <option key={target} value={target}>
                            {target === 'generic' ? 'Generic · no native checks' : target}
                          </option>
                        ))}
                      </NativeSelect>
                      <p className="text-xs text-muted-foreground">
                        Fixed after creation. Choose your agent for native compatibility checks.
                      </p>
                    </div>
                  </div>
                </DisclosureContent>
              </Disclosure>
              {preview && preview.length > 0 && source !== 'created' && (
                <div className="space-y-3 rounded-lg border p-4">
                  <h3 className="font-medium">Import preview · {compatibilityTarget}</h3>
                  {preview.map((file) => (
                    <Disclosure key={`${source}-${file.path}`}>
                      <DisclosureTrigger className="break-all text-sm">
                        {file.path} · {file.kind}
                      </DisclosureTrigger>
                      <DisclosureContent>
                        <SyntaxCode
                          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm"
                          code={file.text}
                          path={file.path}
                        />
                      </DisclosureContent>
                    </Disclosure>
                  ))}
                  <Label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      aria-label="Confirm these entries for import"
                      disabled={pending || readingFiles}
                      checked={confirmed}
                      onCheckedChange={(checked) => setConfirmed(checked === true)}
                    />
                    Confirm these entries for import
                  </Label>
                </div>
              )}
              {importIssues.length > 0 && (
                <div role="status" className="space-y-2 rounded-md border p-3">
                  <p>
                    Repair native compatibility issues before publishing. Incomplete content can be
                    found in an existing version.
                  </p>
                  <ul className="list-inside list-disc">
                    {importIssues.map((issue, index) => (
                      <li key={index}>
                        {issue.path || issue.package || issue.code}: {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="border-t pt-5" aria-label="Initial publication summary">
                <p className="text-sm">
                  Publishes{' '}
                  {preview
                    ? `${preview.length} ${preview.length === 1 ? 'entry' : 'entries'}`
                    : 'the validated entries'}{' '}
                  to <strong>{channel || '(choose a channel)'}</strong>.
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Available immediately after creation. Existing bundles are not overwritten. No
                  evaluation is run.
                  {compatibilityTarget === 'generic'
                    ? ' Native compatibility is unchecked.'
                    : ` Target: ${compatibilityTarget}, fixed for this bundle.`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={
                    pending ||
                    readingFiles ||
                    !workspaceId ||
                    !name.trim() ||
                    !channel.trim() ||
                    !preview ||
                    !preview.length ||
                    importIssues.length > 0 ||
                    (source === 'created' && !initialText.trim()) ||
                    ((source === 'imported' || source === 'files') && !confirmed)
                  }
                  onClick={() => void create()}
                >
                  {pending
                    ? 'Publishing…'
                    : source === 'imported' || source === 'files'
                      ? 'Import and publish'
                      : 'Create and publish'}
                  {!pending && <ArrowRight aria-hidden="true" />}
                </Button>
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => confirmDiscard(() => setShowCreate(false))}
                >
                  Cancel
                </Button>
              </div>
            </section>
          )}
        </>
      )}
      {pending && <p role="status">Waiting for the service…</p>}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
