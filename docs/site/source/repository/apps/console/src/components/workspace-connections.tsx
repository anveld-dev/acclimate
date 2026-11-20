import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { SdkSetup } from './sdk-setup';
import { isCurrentDelivery } from '../lib/delivery-release';
import { WorkspaceEmptyState } from './workspace-empty-state';
import { PageHeader } from './page-header';
import { WorkspaceMenuButton } from './workspace-chrome';
import { ListToolbar } from './list-toolbar';
import { StatusBadge } from './status-badge';
import { ReceiptTime } from './receipt-time';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import type { DeliveryReceipt, ConnectionCredential, Page } from '@acclimate/sdk';
import { Button } from './ui/button';
import { DirectorySearch } from './ui/directory-search';
import { ArrowUpRight, Check, ChevronRight, Plug, Plus } from 'lucide-react';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';
import { ConnectionReports } from './connection-reports';
import { ConnectionLearning, useConnectionLearning } from './connection-learning';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { ConsoleLink, consoleDestination } from './console-link';
import { bundleHref, workspaceHref } from '../navigation';
import { connectionHref as scopedConnectionHref } from '../lib/connection-navigation';
import { CopyButton } from './copy-button';
import { PageTitle } from './shared';
import { Textarea } from './ui/textarea';
import {
  credentialRecoveryKey,
  readCredentialRecovery,
  saveCredentialRecovery,
  type CredentialRecovery,
} from '../server/credential-recovery';
import { readConnections, runConnectionCommand } from '../server/integration-actions';
import type {
  ConnectionCommand,
  ConnectionsResult,
  ConnectionsState,
  IntegrationCommand,
} from '../server/integration-core';

export function WorkspaceConnections(props: {
  workspaceId: string;
  search: Record<string, unknown>;
  initial?: ConnectionsResult;
}) {
  return <ConnectionPage key={props.workspaceId} {...props} />;
}

function ConnectionPage({
  workspaceId,
  search,
  initial,
}: {
  workspaceId: string;
  search: Record<string, unknown>;
  initial?: ConnectionsResult;
}) {
  const selectedId = typeof search.connection === 'string' ? search.connection : undefined;
  const pendingFocus = useRef('');
  const [result, setResult] = useState<ConnectionsResult>(
    initial ?? { ok: false, message: 'Loading connections…' },
  );
  useEffect(() => {
    let active = true;
    if (
      initial &&
      (!selectedId || !initial.ok || initial.state.selected?.integration.id === selectedId)
    ) {
      setResult(initial);
      return;
    }
    void readConnections({ data: { workspaceId, connectionId: selectedId } })
      .then((value) => {
        if (active) setResult(value);
      })
      .catch(() => {
        if (active)
          setResult({ ok: false, message: 'Could not read connections. Retrying automatically.' });
      });
    return () => {
      active = false;
    };
  }, [workspaceId, selectedId, initial]);
  useEffect(() => {
    if (
      !result.ok ||
      (result.state.selected?.integration.id ?? undefined) !== selectedId ||
      !pendingFocus.current
    )
      return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(pendingFocus.current);
      if (target) {
        target.focus();
        pendingFocus.current = '';
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [result, selectedId]);
  async function refresh() {
    try {
      setResult(await readConnections({ data: { workspaceId, connectionId: selectedId } }));
    } catch {
      setResult({ ok: false, message: 'Could not read connections. Current state is unknown.' });
    }
  }
  return (
    <div
      className="workspace-connections space-y-4"
      data-selected={result.ok && Boolean(result.state.selected)}
    >
      {!result.ok && (
        <PageTitle
          title="Connections"
          description="App credentials and reported delivery for your bundles."
        />
      )}
      {result.ok ? (
        <ConnectionWorkspace
          key={`${result.state.actorScope}:${workspaceId}:${result.state.selected?.integration.id ?? 'index'}:${String(search.bundleId ?? '')}:${String(search.channel ?? '')}`}
          state={result.state}
          search={search}
          refresh={refresh}
          focusAfterNavigation={(id) => {
            pendingFocus.current = id;
          }}
        />
      ) : (
        <div className="workspace-panel space-y-3 p-4">
          <p role="alert">{result.message}</p>
          {result.connectionMissing && (
            <Button asChild variant="outline" size="sm">
              <ConsoleLink href={scopedConnectionHref(workspaceId, search)}>
                Back to connections
              </ConsoleLink>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ConnectionWorkspace({
  state,
  search,
  refresh,
  focusAfterNavigation,
}: {
  focusAfterNavigation: (id: string) => void;
  state: ConnectionsState;
  search: Record<string, unknown>;
  refresh: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const selected = state.selected?.integration;
  const [receiptPage, setReceiptPage] = useState<Page<DeliveryReceipt>>(
    state.selected?.receipts ?? { items: [], nextCursor: null },
  );
  const latestReport = receiptPage.items[0];
  const [defaultTab] = useState(() =>
    state.selected?.receipts.items.length ? 'delivery' : 'setup',
  );
  const learning = useConnectionLearning(state.workspaceId, selected?.id);
  const learningStatus = learning.result?.ok ? learning.result.status : null;
  const learningActive = learningStatus?.enabled && !learningStatus.stoppedAt;
  const compared = Boolean(
    learningStatus?.rounds.some(
      (round) => round.developmentComparisonId || round.auditComparisonId,
    ),
  );
  const readCredential = selected?.credentials?.find(
    (item) => item.kind === 'content-read' && !item.revokedAt,
  );
  const [setupStep, setSetupStep] = useState<string>();
  const [checkingDelivery, setCheckingDelivery] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [bundleId, setBundle] = useState(
    typeof search.bundleId === 'string' ? search.bundleId : (state.bundles[0]?.id ?? ''),
  );
  const bundle = state.bundles.find((item) => item.id === bundleId);
  const [channel, setChannel] = useState(
    typeof search.channel === 'string' ? search.channel : (bundle?.channels[0]?.name ?? ''),
  );
  const [credential, setCredential] = useState<ConnectionCredential | null>(null);
  const [credentialId, setCredentialId] = useState('');
  const [confirm, setConfirm] = useState<'integration' | 'credential' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<string>();
  const createTriggerRef = useRef<HTMLElement | null>(null);
  const revokeTriggerRef = useRef<HTMLElement | null>(null);
  const credentialTriggerRef = useRef<HTMLElement | null>(null);
  const keys = useRef(new Map<string, string>());
  const recoveryStorageKey = credentialRecoveryKey(
    state.actorScope,
    state.workspaceId,
    selected?.id ?? '',
  );
  const [recovery, setRecovery] = useState<CredentialRecovery>();
  useEffect(() => {
    try {
      setRecovery(readCredentialRecovery(sessionStorage, recoveryStorageKey));
    } catch {
      setError('Browser storage is unavailable. Credential issuance cannot start.');
    }
  }, [recoveryStorageKey]);
  const recoveredOriginal = selected?.credentials?.find(
    (item) => item.id === recovery?.credentialId,
  );
  const revokeCredentialId = credentialId.trim();
  const knownRevokedCredential = selected?.credentials?.some(
    (item) => item.id === revokeCredentialId && Boolean(item.revokedAt),
  );
  const revokeCredentialKind =
    selected?.credentials?.find((item) => item.id === revokeCredentialId)?.kind ??
    (recovery?.credentialId === revokeCredentialId ? recovery.kind : undefined);
  function persistRecovery(value: CredentialRecovery) {
    saveCredentialRecovery(sessionStorage, recoveryStorageKey, value);
    setRecovery(value);
  }
  function forgetRecovery() {
    sessionStorage.removeItem(recoveryStorageKey);
    setRecovery(undefined);
  }
  useEffect(
    () => setReceiptPage(state.selected?.receipts ?? { items: [], nextCursor: null }),
    [state.selected],
  );
  const filterBundle = typeof search.bundleId === 'string' ? search.bundleId : undefined;
  const filterChannel = typeof search.channel === 'string' ? search.channel : undefined;
  const initialQuery = typeof search.q === 'string' ? search.q : '';
  const initialAccess =
    search.access === 'enabled' || search.access === 'revoked' ? search.access : 'all';
  const [query, setQuery] = useState(initialQuery);
  const [access, setAccess] = useState<string>(initialAccess);
  useEffect(() => {
    setQuery(initialQuery);
    setAccess(initialAccess);
  }, [initialQuery, initialAccess]);
  const bundleName = (id: string) => state.bundles.find((item) => item.id === id)?.name ?? id;
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scopedRows = state.integrations.filter(
    (item) =>
      (!filterBundle || item.bundleId === filterBundle) &&
      (!filterChannel || item.channel === filterChannel),
  );
  const rows = scopedRows.filter((item) => {
    const fields = [
      item.displayName,
      item.id,
      bundleName(item.bundleId),
      item.bundleId,
      item.channel,
    ]
      .join(' ')
      .toLowerCase();
    return (
      terms.every((term) => fields.includes(term)) &&
      (access === 'all' || item.enabled === (access === 'enabled'))
    );
  });
  // A handful of connections reads at a glance; search appears once it helps.
  const searchable = scopedRows.length > 5 || Boolean(query.trim()) || access !== 'all';
  const directorySearch = { ...search, q: query, access };
  const connectionHref = (id: string) =>
    scopedConnectionHref(state.workspaceId, directorySearch, id);
  const guideHref = selected
    ? bundleHref(
        { workspaceId: state.workspaceId, bundleId: selected.bundleId, channel: selected.channel },
        'connect',
      )
    : undefined;
  const binding = selected
    ? { workspaceId: state.workspaceId, bundleId: selected.bundleId, channel: selected.channel }
    : undefined;
  const connectionTabs = [
    ['setup', 'Setup'],
    ['delivery', 'Delivery reports'],
    ['credentials', 'Credentials'],
    ['learning', 'Learning'],
    ['settings', 'Settings'],
  ];
  const hash = useRouterState({ select: (router) => router.location.hash });
  const legacyTab = {
    'continuous-learning': 'learning',
    'delivery-reports': 'delivery',
    'app-credentials': 'credentials',
  }[hash];
  const tab = connectionTabs.some(([value]) => value === search.connectionTab)
    ? String(search.connectionTab)
    : (legacyTab ?? defaultTab);
  const tabHref = (value: string) => {
    const url = new URL(connectionHref(selected!.id), 'https://console.invalid');
    url.searchParams.set('connectionTab', value);
    return url.pathname + url.search;
  };
  const currentDelivery =
    latestReport &&
    state.selected &&
    isCurrentDelivery(latestReport, {
      versionId: state.selected.currentVersionId,
      digest: state.selected.currentDigest,
    });
  const setupSteps = [
    { id: 'binding', title: 'Bundle & channel', done: true },
    { id: 'credential', title: 'Read credential', done: Boolean(readCredential) },
    { id: 'delivery', title: 'First delivery', done: Boolean(latestReport) },
    { id: 'agent', title: 'Compare a change', done: compared, optional: true },
  ];
  const currentStep = setupSteps.find((step) => !step.done)?.id ?? 'agent';
  const shownStep = setupStep ?? currentStep;

  async function command(input: IntegrationCommand, target = binding) {
    if (busy || !target) return;
    setBusy(true);
    setError('');
    if (
      input.action === 'issue' &&
      recovery &&
      !input.replacementOf &&
      input.kind !== recovery.kind
    ) {
      setError('Resolve the pending credential issuance before issuing another credential.');
      setBusy(false);
      return;
    }
    const signature = JSON.stringify({ ...target, ...input, key: undefined });
    if (!keys.current.has(signature)) keys.current.set(signature, crypto.randomUUID());
    const request = {
      ...input,
      ...target,
      ...('key' in input ? { key: keys.current.get(signature)! } : {}),
    } as ConnectionCommand;
    let issuanceRecorded = false;
    try {
      if (request.action === 'issue') {
        // Store only scope, kind and operation key before sending. Storage failure sends nothing.
        if (recovery && !request.replacementOf) request.key = recovery.key;
        persistRecovery({ key: request.key, kind: request.kind });
        issuanceRecorded = true;
      }
      const result = await runConnectionCommand({ data: request });
      if (!result.ok) {
        if (request.action === 'issue' && result.issuedCredential) {
          persistRecovery({
            key: request.key,
            kind: result.issuedCredential.kind,
            credentialId: result.issuedCredential.credentialId,
          });
          setCredentialId(result.issuedCredential.credentialId);
          await refresh();
        }
        setError(result.message);
        return;
      }
      keys.current.delete(signature);
      if (result.credential) {
        // Keep the one-time secret visible even if the next list read fails.
        if (tab === 'setup') setSetupStep('credential');
        setCredential(result.credential);
        try {
          forgetRecovery();
        } catch {
          setError(
            'Credential created. Browser recovery data could not be cleared. Save this secret before closing.',
          );
        }
        return;
      }
      if (result.receipts) {
        const page = result.receipts;
        setReceiptPage((previous) => ({
          items: [
            ...previous.items,
            ...page.items.filter(
              (row) => !previous.items.some((old) => old.eventId === row.eventId),
            ),
          ],
          nextCursor: page.nextCursor,
        }));
      }
      if (result.integration) {
        setCreated(result.integration.id);
        setCreating(false);
        setName('');
        try {
          focusAfterNavigation('connection-selected-title');
          await navigate(
            consoleDestination(connectionHref(result.integration.id) + '&connectionTab=setup'),
          );
        } catch {
          setError(
            'Connection created, but its page could not open. Use Open connection or refresh.',
          );
        }
        return;
      }
      setConfirm(null);
      if (input.action !== 'receipts') await refresh();
    } catch {
      setError(
        request.action === 'receipts'
          ? 'Could not load older reports. Loaded reports are unchanged; try again.'
          : request.action === 'issue' && !issuanceRecorded
            ? 'Browser storage is unavailable. No credential issuance request was sent.'
            : 'Outcome unknown. Inspect the connection before repeating this action. Its status updates automatically; the same operation ID will be reused.',
      );
    } finally {
      setBusy(false);
    }
  }
  function issuedCredentials(kind: 'content-read' | 'receipt-write') {
    const items = (selected?.credentials ?? []).filter((item) => item.kind === kind);
    return (
      <div
        className="connection-issued-credentials"
        aria-label={
          kind === 'content-read' ? 'Issued read credentials' : 'Issued reporting credentials'
        }
      >
        {!items.length && (
          <p className="connection-credential-empty">
            No {kind === 'content-read' ? 'read' : 'reporting'} credentials yet.
          </p>
        )}
        {items.map((item) => (
          <div
            key={item.id}
            className="connection-credential-row"
            data-revoked={Boolean(item.revokedAt)}
          >
            <div className="min-w-0">
              <p className="connection-credential-title">
                {item.kind === 'content-read' ? 'Read credential' : 'Reporting credential'} ·{' '}
                {item.revokedAt ? 'Revoked' : 'Active'}
              </p>
              <code>{item.id}</code>
              <span className="connection-credential-time">
                {item.revokedAt ? 'Revoked ' : 'Created '}
                <ReceiptTime value={item.revokedAt ?? item.createdAt} relative />
              </span>
            </div>
            {!item.revokedAt && (
              <Button
                variant="ghost"
                size="sm"
                className="connection-credential-revoke"
                aria-label={`Revoke ${item.kind === 'content-read' ? 'read' : 'reporting'} credential ${item.id}`}
                disabled={!state.canManage || busy}
                onClick={(event) => {
                  revokeTriggerRef.current = event.currentTarget;
                  setCredentialId(item.id);
                  setConfirm('credential');
                }}
              >
                Revoke
              </Button>
            )}
          </div>
        ))}
      </div>
    );
  }
  function credentialSection(kind: 'content-read' | 'receipt-write', className = '') {
    if (!selected) return null;
    const read = kind === 'content-read';
    return (
      <section className={`connection-credential-section ${className}`}>
        <div className="connection-credential-heading">
          <div className="min-w-0">
            <h3>
              {read ? 'Read credentials' : 'Reporting credentials'}
              {!read && <span className="connection-optional">Optional</span>}
            </h3>
            <p>
              {read
                ? 'Your app’s SDK uses this to fetch published content.'
                : 'Lets your app report what it delivered. Keep it separate from read access.'}
            </p>
          </div>
          <Button
            variant={read ? 'default' : 'outline'}
            disabled={!state.canManage || busy || !selected.enabled || Boolean(recovery)}
            onClick={(event) => {
              credentialTriggerRef.current = event.currentTarget;
              void command({ action: 'issue', id: selected.id, kind, key: crypto.randomUUID() });
            }}
          >
            <Plus aria-hidden="true" />{' '}
            {read ? 'Create read credential' : 'Create reporting credential'}
          </Button>
        </div>
        {issuedCredentials(kind)}
      </section>
    );
  }
  const credentialRecovery = selected && recovery && (
    <div className="space-y-3 rounded border border-amber-500/50 p-3" role="status">
      <p>
        We couldn’t confirm this {recovery.kind === 'content-read' ? 'read' : 'reporting'}{' '}
        credential creation. Check its result before creating another credential. Previously issued
        secrets cannot be retrieved.
      </p>
      {recovery.credentialId ? (
        <>
          <p className="break-all">
            Original credential: {recovery.credentialId} ·{' '}
            {recoveredOriginal?.revokedAt ? 'Revocation confirmed' : 'Revocation not confirmed'}
          </p>
          {!recoveredOriginal?.revokedAt ? (
            <Button
              variant="destructive"
              disabled={busy || !state.canManage}
              onClick={(event) => {
                revokeTriggerRef.current = event.currentTarget;
                setCredentialId(recovery.credentialId!);
                setConfirm('credential');
              }}
            >
              Confirm revoke original credential
            </Button>
          ) : (
            <Button
              disabled={busy || !state.canManage || !selected.enabled}
              onClick={(event) => {
                credentialTriggerRef.current = event.currentTarget;
                void command({
                  action: 'issue',
                  id: selected.id,
                  kind: recovery.kind,
                  replacementOf: recovery.credentialId,
                  key: crypto.randomUUID(),
                });
              }}
            >
              Create replacement credential
            </Button>
          )}
        </>
      ) : (
        <Button
          disabled={busy || !state.canManage}
          onClick={(event) => {
            credentialTriggerRef.current = event.currentTarget;
            void command({
              action: 'issue',
              id: selected.id,
              kind: recovery.kind,
              key: recovery.key,
            });
          }}
        >
          Check creation result
        </Button>
      )}
      <p className="text-sm text-muted-foreground">
        {recovery.credentialId
          ? 'A replacement uses a new operation ID and is available only after the original revocation is confirmed.'
          : 'Checking reuses the original operation ID. It may confirm a credential whose secret is no longer available.'}
      </p>
    </div>
  );
  const directoryAbout = (
    <div className="connection-directory-footnote">
      <span>Workspace ID</span>
      <code>{state.workspaceId}</code>
      <CopyButton value={state.workspaceId} label="Copy workspace ID" iconOnly />
      <span className="connection-directory-footnote-note">
        Creating a connection does not connect a running app. SDK clients can fetch content without
        one.
      </span>
    </div>
  );
  return (
    <>
      {selected ? (
        <div className="connection-page-heading">
          <PageHeader
            title={selected.displayName}
            titleId="connection-selected-title"
            titleAccessory={
              <StatusBadge tone={selected.enabled ? 'success' : 'neutral'}>
                {selected.enabled ? 'Access enabled' : 'Access revoked'}
              </StatusBadge>
            }
            utility={
              <>
                <WorkspaceMenuButton />
                <ConsoleLink
                  href={scopedConnectionHref(state.workspaceId, directorySearch)}
                  className="workspace-back-link text-muted-foreground hover:text-foreground"
                  onClick={(event) => {
                    if (event.detail === 0) focusAfterNavigation('connection-entry-' + selected.id);
                  }}
                >
                  Back to connections
                </ConsoleLink>
              </>
            }
          />
        </div>
      ) : (
        <PageTitle
          title="Connections"
          description="App credentials and reported delivery for your bundles."
          actions={
            <Button
              disabled={!state.canManage || busy || !state.bundles.length}
              onClick={(event) => {
                createTriggerRef.current = event.currentTarget;
                setCreating(true);
              }}
            >
              <Plus aria-hidden="true" /> New connection
            </Button>
          }
        />
      )}
      <div className="connection-workspace" data-selected={Boolean(state.selected)}>
        <section
          className={
            selected
              ? 'connection-selected-navigation space-y-3'
              : 'connection-directory overflow-hidden rounded-md border bg-card'
          }
          aria-label="Workspace connections"
        >
          {selected && !rows.some((item) => item.id === selected.id) && (
            <p className="text-sm">
              The selected connection is outside the current directory filters.
            </p>
          )}
          {(filterBundle || filterChannel || (selected && (query || access !== 'all'))) && (
            <div className="text-sm">
              Filtered to {filterBundle ? bundleName(filterBundle) : 'all bundles'}
              {filterChannel ? ` / ${filterChannel}` : ''}
              {query ? ' · ' + query : ''}
              {access !== 'all' ? ' · ' + access : ''}.{' '}
              <ConsoleLink
                href={scopedConnectionHref(state.workspaceId, {}, selected?.id)}
                className="underline"
              >
                Clear filters
              </ConsoleLink>
            </div>
          )}
          {!selected && (
            <div className="connection-index-tools bg-card">
              {searchable && (
                <ListToolbar count={`${rows.length} of ${scopedRows.length} connections`}>
                  <DirectorySearch
                    id="connection-directory-search"
                    label="Search connections"
                    placeholder="Search app, bundle, channel or ID"
                    value={query}
                    onValueChange={setQuery}
                  />
                  <div className="connection-access-filter">
                    <Label htmlFor="connection-directory-access">Access</Label>
                    <NativeSelect
                      id="connection-directory-access"
                      value={access}
                      onChange={(e) => setAccess(e.target.value)}
                    >
                      <option value="all">All access</option>
                      <option value="enabled">Enabled</option>
                      <option value="revoked">Revoked</option>
                    </NativeSelect>
                  </div>
                </ListToolbar>
              )}
            </div>
          )}
          {!selected &&
            (!rows.length &&
            !query.trim() &&
            access === 'all' &&
            !filterBundle &&
            !filterChannel &&
            state.bundles.length > 0 &&
            state.canManage ? (
              <WorkspaceEmptyState
                icon={Plug}
                title="No connections yet"
                description="A connection gives one app its own credentials for a bundle and channel, and can collect that app’s delivery reports. SDK clients can fetch content without one."
                actions={
                  <Button
                    disabled={busy}
                    onClick={(event) => {
                      createTriggerRef.current = event.currentTarget;
                      setCreating(true);
                    }}
                  >
                    <Plus aria-hidden="true" /> Create your first connection
                  </Button>
                }
              />
            ) : !rows.length ? (
              <div className="space-y-2 rounded border border-dashed p-4">
                <p>
                  {query.trim() || access !== 'all'
                    ? 'No connections match your search and access filters.'
                    : filterBundle || filterChannel
                      ? 'No connections match these filters.'
                      : !state.bundles.length
                        ? 'Add a bundle before setting up app access.'
                        : state.canManage
                          ? 'Create a connection for app credentials and optional reporting.'
                          : 'No connections yet. Ask a workspace administrator to configure app access.'}
                </p>
                {scopedRows.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQuery('');
                      setAccess('all');
                      document.getElementById('connection-directory-search')?.focus();
                    }}
                  >
                    Reset search and access
                  </Button>
                )}
                {!state.bundles.length && (
                  <ConsoleLink
                    href={workspaceHref(state.workspaceId, 'bundles')}
                    className="underline"
                  >
                    Go to bundles
                  </ConsoleLink>
                )}
              </div>
            ) : (
              <div className="connection-list connection-ledger divide-y">
                <div className="connection-index-head directory-heading" aria-hidden="true">
                  <span>App</span>
                  <span>Bundle</span>
                  <span>Credentials</span>
                  <span>Last report</span>
                  <span>Access</span>
                  <span />
                </div>
                {rows.map((item) => {
                  const report = state.reports?.[item.id];
                  const unrevoked = item.credentials?.filter((c) => !c.revokedAt);
                  const reads = unrevoked?.filter((c) => c.kind === 'content-read').length ?? 0;
                  const reporting =
                    unrevoked?.filter((c) => c.kind === 'receipt-write').length ?? 0;
                  return (
                    <ConsoleLink
                      key={item.id}
                      href={connectionHref(item.id)}
                      id={'connection-entry-' + item.id}
                      onClick={(e) => {
                        if (e.detail === 0) focusAfterNavigation('connection-selected-title');
                      }}
                      className="connection-row directory-row"
                    >
                      <span className="connection-cell connection-ledger-app">
                        <strong>{item.displayName}</strong>
                      </span>
                      <span className="connection-cell connection-ledger-binding">
                        <span className="sr-only">Bundle: </span>
                        <span>{bundleName(item.bundleId)}</span>
                        <code className="connection-channel">{item.channel}</code>
                      </span>
                      <span
                        className="connection-cell"
                        data-muted={!unrevoked || !(reads + reporting)}
                      >
                        <span className="sr-only">Credentials: </span>
                        {!unrevoked
                          ? 'Unavailable'
                          : reads + reporting
                            ? [reads && `${reads} read`, reporting && `${reporting} reporting`]
                                .filter(Boolean)
                                .join(' · ')
                            : 'No credentials'}
                      </span>
                      <span className="connection-cell" data-muted={!report}>
                        <span className="sr-only">Last report: </span>
                        {report ? (
                          <span>
                            <span className="capitalize">{report.stage}</span> ·{' '}
                            <ReceiptTime value={report.receivedAt} relative />
                          </span>
                        ) : (
                          <span>{report === null ? 'No recent reports' : 'Unavailable'}</span>
                        )}
                      </span>
                      <span className="connection-access" data-enabled={item.enabled}>
                        {item.enabled ? 'Enabled' : 'Revoked'}
                      </span>
                      <ChevronRight size={16} className="connection-row-arrow" aria-hidden="true" />
                    </ConsoleLink>
                  );
                })}
              </div>
            ))}
          {!selected && !state.canManage && (
            <p className="text-sm text-muted-foreground">
              Credential changes are disabled for this console.
            </p>
          )}
          {created && (
            <p role="status">
              Connection created.{' '}
              <ConsoleLink href={connectionHref(created)} className="underline">
                Open connection
              </ConsoleLink>
            </p>
          )}
        </section>
        {!selected && directoryAbout}
        {!selected && error && (
          <p role="alert" className="rounded border border-destructive/30 p-4">
            {error}
          </p>
        )}
        {selected && (
          <div
            className="connection-detail space-y-4"
            id="selected-connection-detail"
            tabIndex={-1}
          >
            {error && (
              <p role="alert" className="rounded border border-destructive/30 p-4">
                {error}
              </p>
            )}
            {!state.canManage && (
              <p className="text-sm text-muted-foreground">
                Credential changes are disabled for this console.
              </p>
            )}
            <dl className="connection-status-strip">
              <div>
                <dt>Bundle</dt>
                <dd>
                  <ConsoleLink
                    href={bundleHref(binding!, 'content')}
                    className="connection-strip-link"
                  >
                    {bundleName(selected.bundleId)}
                  </ConsoleLink>
                  <code className="connection-channel">{selected.channel}</code>
                </dd>
              </div>
              <div>
                <dt>Last report</dt>
                {latestReport ? (
                  <dd>
                    <span className="capitalize">{latestReport.stage}</span>{' '}
                    <span className="connection-strip-muted">
                      · <ReceiptTime value={latestReport.receivedAt} relative />
                    </span>
                  </dd>
                ) : (
                  <dd className="connection-strip-muted">No delivery report</dd>
                )}
              </div>
              <div>
                <dt>Release</dt>
                <dd>
                  {latestReport && (
                    <StatusBadge tone={currentDelivery ? 'success' : 'warning'}>
                      {currentDelivery ? 'Current' : 'Behind'}
                    </StatusBadge>
                  )}
                  <span className={latestReport ? 'connection-strip-muted' : undefined}>
                    Revision {state.selected!.currentRevision}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Learning</dt>
                <dd>
                  <ConsoleLink href={tabHref('learning')} className="connection-strip-link">
                    {learning.result?.ok ? (learningActive ? 'On' : 'Off') : 'Status unavailable'}
                    <ArrowUpRight className="size-3" aria-hidden="true" />
                  </ConsoleLink>
                </dd>
              </div>
            </dl>
            <Tabs
              value={tab}
              onValueChange={async (value) => {
                await navigate({ ...consoleDestination(tabHref(value)), resetScroll: false });
              }}
            >
              <TabsList
                variant="line"
                aria-label="Connection sections"
                className="console-page-tabs"
              >
                {connectionTabs.map(([value, label]) => (
                  <TabsTrigger key={value} value={value}>
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="setup" className="min-w-0">
                <h2 className="sr-only">Connection setup</h2>
                <div className="connection-setup-grid">
                  <div className="connection-setup-checklist workspace-panel">
                    <div className="connection-setup-progress">
                      <span>Setup</span>
                      <span>{setupSteps.filter((step) => step.done).length} of 4 done</span>
                      <span className="connection-setup-meter" aria-hidden="true">
                        <span
                          style={{
                            width: `${(setupSteps.filter((step) => step.done).length / 4) * 100}%`,
                          }}
                        />
                      </span>
                    </div>
                    <ol aria-label="Setup checklist">
                      {setupSteps.map((step, index) => (
                        <li key={step.id}>
                          <button
                            type="button"
                            className="connection-setup-step"
                            aria-current={shownStep === step.id ? 'step' : undefined}
                            onClick={() => setSetupStep(step.id)}
                          >
                            <span
                              className="connection-setup-mark"
                              data-state={
                                step.done ? 'done' : step.id === currentStep ? 'current' : 'todo'
                              }
                              aria-hidden="true"
                            >
                              {step.done ? <Check /> : index + 1}
                            </span>
                            <span className="min-w-0">
                              <span className="sr-only">{index + 1}. </span>
                              {step.title}
                              <small>
                                {step.done ? 'Done' : step.id === currentStep ? 'Current' : 'To do'}
                                {step.optional ? ' · Optional' : ''}
                              </small>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div className="min-w-0 space-y-3">
                    {shownStep === 'binding' && (
                      <section className="workspace-panel connection-step-panel">
                        <h3>Bundle &amp; channel</h3>
                        <p>
                          This connection’s credentials read{' '}
                          <ConsoleLink href={bundleHref(binding!, 'content')} className="underline">
                            {bundleName(selected.bundleId)}
                          </ConsoleLink>{' '}
                          on the <code className="connection-channel">{selected.channel}</code>{' '}
                          channel.
                        </p>
                        <div className="connection-step-actions">
                          <Button asChild variant="outline">
                            <ConsoleLink href={guideHref!}>Full setup guide</ConsoleLink>
                          </Button>
                        </div>
                      </section>
                    )}
                    {shownStep === 'credential' && (
                      <div className="workspace-panel connection-step-panel">
                        {!selected.enabled && (
                          <p>This connection is revoked; new credentials cannot be issued.</p>
                        )}
                        {credentialSection('content-read')}
                        {credentialRecovery}
                      </div>
                    )}
                    {(shownStep === 'delivery' || shownStep === 'agent') && (
                      <section className="workspace-panel connection-step-panel connection-recipe-panel">
                        <div className="connection-step-header">
                          <div className="min-w-0">
                            <h3>
                              {shownStep === 'agent'
                                ? 'Connect your agent, then compare a change'
                                : latestReport
                                  ? 'Delivery reported'
                                  : 'Waiting for the first delivery'}
                            </h3>
                            <p>
                              {shownStep === 'agent' ? (
                                'Optional. Run your existing agent loop against saved versions of this bundle to compare a change before release.'
                              ) : latestReport ? (
                                <>
                                  Latest report received{' '}
                                  <ReceiptTime value={latestReport.receivedAt} />
                                </>
                              ) : (
                                'Install the SDK, configure access, then run the delivery check from your app. With optional reporting enabled, your app’s report appears here.'
                              )}
                            </p>
                          </div>
                          {shownStep === 'delivery' && (
                            <Button
                              variant="outline"
                              disabled={checkingDelivery}
                              onClick={async () => {
                                setCheckingDelivery(true);
                                try {
                                  await refresh();
                                } finally {
                                  setCheckingDelivery(false);
                                }
                              }}
                            >
                              Refresh delivery reports
                            </Button>
                          )}
                        </div>
                        <SdkSetup
                          state={{
                            ...binding!,
                            publicApiUrl: state.publicApiUrl,
                            bundleName: bundleName(selected.bundleId),
                          }}
                          role={state.canManage ? 'admin' : undefined}
                          step={shownStep}
                        />
                        {shownStep === 'delivery' && (
                          <div className="connection-step-actions connection-recipe-footer">
                            <span>Optional delivery reports:</span>
                            <ConsoleLink href={tabHref('credentials')}>
                              Reporting credentials
                            </ConsoleLink>
                            <ConsoleLink href={guideHref! + '#reporting'}>
                              Reporting recipe
                            </ConsoleLink>
                          </div>
                        )}
                      </section>
                    )}
                  </div>
                </div>
              </TabsContent>
              <TabsContent value="credentials" className="connection-credentials">
                <h2 className="sr-only">App credentials</h2>
                <p className="connection-tab-intro" id="app-credentials">
                  Credentials work only for {bundleName(selected.bundleId)} on the{' '}
                  <code className="connection-channel">{selected.channel}</code> channel. Each
                  secret appears once; save it in your app’s secret manager.
                </p>
                {(busy || !selected.enabled || recovery) && (
                  <p className="connection-tab-notice">
                    {busy
                      ? 'An operation is in progress.'
                      : !selected.enabled
                        ? 'This connection is revoked; new credentials cannot be issued.'
                        : 'Resolve the pending credential creation before issuing another credential.'}
                  </p>
                )}
                {credentialRecovery}
                {credentialSection('content-read', 'workspace-panel')}
                {credentialSection('receipt-write', 'workspace-panel')}
                <Disclosure className="connection-advanced">
                  <DisclosureTrigger>Advanced credential actions</DisclosureTrigger>
                  <DisclosureContent className="connection-advanced-content">
                    <Label htmlFor="connection-credential-id">Revoke by credential ID</Label>
                    <div className="flex flex-wrap gap-2">
                      <Input
                        id="connection-credential-id"
                        className="min-w-0 flex-1 basis-52"
                        value={credentialId}
                        onChange={(event) => setCredentialId(event.target.value)}
                        placeholder="Credential ID, not its secret"
                      />
                      <Button
                        variant="outline"
                        disabled={
                          !state.canManage || busy || !credentialId.trim() || knownRevokedCredential
                        }
                        onClick={(event) => {
                          revokeTriggerRef.current = event.currentTarget;
                          setConfirm('credential');
                        }}
                      >
                        Revoke credential
                      </Button>
                    </div>
                    {knownRevokedCredential && (
                      <p className="text-sm text-muted-foreground">
                        This credential is already revoked.
                      </p>
                    )}
                  </DisclosureContent>
                </Disclosure>
              </TabsContent>
              <TabsContent value="delivery" className="min-w-0 space-y-3">
                <ConnectionReports
                  key={selected.id}
                  action={
                    <Button asChild variant="outline" size="sm">
                      <ConsoleLink
                        href={
                          workspaceHref(state.workspaceId, 'delivery') +
                          '?connection=' +
                          encodeURIComponent(selected.id)
                        }
                      >
                        View delivery <ArrowUpRight size={14} />
                      </ConsoleLink>
                    </Button>
                  }
                  receipts={receiptPage}
                  channel={selected.channel}
                  currentRevision={state.selected!.currentRevision}
                  currentVersionId={state.selected!.currentVersionId}
                  setupHref={guideHref!}
                  busy={busy}
                  onLoadOlder={() => {
                    if (receiptPage.nextCursor)
                      void command({
                        action: 'receipts',
                        id: selected.id,
                        cursor: receiptPage.nextCursor,
                      });
                  }}
                />
              </TabsContent>
              <TabsContent value="learning" className="min-w-0">
                <ConnectionLearning
                  key={`${selected.id}:${selected.enabled}`}
                  learning={learning}
                  target={{ workspaceId: state.workspaceId, connectionId: selected.id }}
                  bundleId={selected.bundleId}
                  channel={selected.channel}
                  connectionName={selected.displayName}
                  currentVersionId={state.selected!.currentVersionId}
                  currentRevision={state.selected!.currentRevision}
                  canManage={state.canManage}
                  enabled={selected.enabled}
                />
              </TabsContent>
              <TabsContent value="settings" className="connection-settings">
                <section className="workspace-panel connection-settings-section">
                  <h3>Identifiers</h3>
                  <p>Use these IDs in SDK configuration and support requests.</p>
                  <dl className="connection-identities">
                    <div>
                      <dt>Workspace</dt>
                      <dd>{state.workspaceName}</dd>
                    </div>
                    <div>
                      <dt>Workspace ID</dt>
                      <dd>
                        <code>{state.workspaceId}</code>
                        <CopyButton value={state.workspaceId} label="Copy workspace ID" iconOnly />
                      </dd>
                    </div>
                    <div>
                      <dt>Bundle ID</dt>
                      <dd>
                        <code>{selected.bundleId}</code>
                        <CopyButton value={selected.bundleId} label="Copy bundle ID" iconOnly />
                      </dd>
                    </div>
                    <div>
                      <dt>Connection ID</dt>
                      <dd>
                        <code>{selected.id}</code>
                        <CopyButton value={selected.id} label="Copy connection ID" iconOnly />
                      </dd>
                    </div>
                  </dl>
                </section>
                <section className="workspace-panel connection-settings-section connection-danger-zone">
                  <div>
                    <h3>Revoke this connection</h3>
                    <p>
                      {selected.enabled
                        ? 'Block all credentials for this app. This cannot recall cached files or stop prepared sessions.'
                        : 'This connection is revoked. Its credentials no longer have access.'}
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    disabled={!state.canManage || busy || !selected.enabled}
                    onClick={(event) => {
                      revokeTriggerRef.current = event.currentTarget;
                      setConfirm('integration');
                    }}
                  >
                    Revoke connection
                  </Button>
                </section>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!busy) setCreating(open);
        }}
      >
        <DialogContent size="decision" returnFocusRef={createTriggerRef}>
          <DialogHeader>
            <DialogTitle>New connection</DialogTitle>
            <DialogDescription>
              Name the app and choose the bundle and channel it can use. Next, create its
              credentials and add them to your app.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="connection-name">Display name</Label>
            <Input
              id="connection-name"
              placeholder="e.g. Support assistant"
              disabled={busy}
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="connection-bundle">Bundle</Label>
            <NativeSelect
              id="connection-bundle"
              disabled={busy}
              value={bundleId}
              onChange={(event) => {
                const id = event.target.value;
                setBundle(id);
                setChannel(state.bundles.find((item) => item.id === id)?.channels[0]?.name ?? '');
              }}
            >
              {state.bundles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.id}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-2">
            <Label htmlFor="connection-channel">Channel</Label>
            <NativeSelect
              id="connection-channel"
              disabled={busy}
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
            >
              {bundle?.channels.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                !state.canManage ||
                busy ||
                !name.trim() ||
                !bundle?.channels.some((item) => item.name === channel)
              }
              onClick={() =>
                void command(
                  { action: 'create', displayName: name, key: crypto.randomUUID() },
                  { workspaceId: state.workspaceId, bundleId, channel },
                )
              }
            >
              {busy ? 'Creating…' : 'Create connection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={credential !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCredential(null);
            void refresh();
          }
        }}
      >
        <DialogContent size="decision" returnFocusRef={credentialTriggerRef}>
          <DialogHeader>
            <DialogTitle>Save this credential now</DialogTitle>
            <DialogDescription>
              This {credential?.kind === 'content-read' ? 'read' : 'reporting'} secret appears only
              once. Save it in your application's secret manager.
            </DialogDescription>
          </DialogHeader>
          <Label>Credential ID</Label>
          <code className="text-xs break-all">{credential?.id}</code>
          <Label>Secret</Label>
          <Textarea
            aria-label="One-time credential secret"
            className="max-h-40 w-full resize-y rounded border bg-muted p-3 font-mono text-sm break-all"
            data-sensitive="true"
            readOnly
            value={credential?.secret ?? ''}
            onFocus={(event) => event.currentTarget.select()}
          />
          {credential && <CopyButton value={credential.secret} label="Copy secret" />}
          {error && (
            <p role="status" className="text-sm">
              {error}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            The secret stays visible until you close this dialog. You can also select and copy it
            above.
          </p>
          <DialogFooter>
            <Button
              onClick={() => {
                setCredential(null);
                void refresh();
              }}
            >
              I saved it · close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <DialogContent size="decision" returnFocusRef={revokeTriggerRef}>
          <DialogHeader>
            <DialogTitle>
              Revoke {confirm === 'integration' ? 'connection' : 'credential'}?
            </DialogTitle>
            <DialogDescription>
              This blocks future service access. It cannot remove application caches or stop an
              existing prepared session.
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <dl className="space-y-2 rounded-md border p-3 text-sm">
              <div>
                <dt className="text-muted-foreground">App connection</dt>
                <dd className="break-words font-medium">{selected.displayName}</dd>
                <dd className="break-all font-mono text-xs">{selected.id}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Workspace</dt>
                <dd className="break-all">{state.workspaceId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Bundle / channel</dt>
                <dd className="break-words">
                  {bundleName(selected.bundleId)} / {selected.channel}
                </dd>
                <dd className="break-all font-mono text-xs">{selected.bundleId}</dd>
              </div>
              {confirm === 'credential' && (
                <div>
                  <dt className="text-muted-foreground">Credential to revoke</dt>
                  <dd className="break-all font-mono text-xs">{revokeCredentialId}</dd>
                  <dd>
                    {revokeCredentialKind === 'content-read'
                      ? 'Read credential (content-read)'
                      : revokeCredentialKind === 'receipt-write'
                        ? 'Reporting credential (receipt-write)'
                        : 'Credential kind is unavailable for this ID.'}
                  </dd>
                </div>
              )}
            </dl>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                busy ||
                !selected ||
                !state.canManage ||
                (confirm === 'credential' && knownRevokedCredential)
              }
              onClick={() => {
                if (selected)
                  void command(
                    confirm === 'integration'
                      ? { action: 'revoke', id: selected.id, key: crypto.randomUUID() }
                      : {
                          action: 'revokeCredential',
                          id: selected.id,
                          credentialId: credentialId.trim(),
                          key: crypto.randomUUID(),
                        },
                  );
              }}
            >
              {busy ? 'Revoking…' : 'Revoke'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
