import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { DeliveryReceipt, IntegrationCredential, Page } from '@acclimate/sdk';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { DirectorySearch } from './ui/directory-search';
import { ArrowUpRight, ChevronRight, Radio } from 'lucide-react';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import { ConnectionReports } from './connection-reports';
import { ConnectionLearning } from './connection-learning';
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
  projectId: string;
  search: Record<string, unknown>;
  initial?: ConnectionsResult;
}) {
  return <ConnectionPage key={props.projectId} {...props} />;
}

function ConnectionPage({
  projectId,
  search,
  initial,
}: {
  projectId: string;
  search: Record<string, unknown>;
  initial?: ConnectionsResult;
}) {
  const selectedId = typeof search.integration === 'string' ? search.integration : undefined;
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
    void readConnections({ data: { projectId, integrationId: selectedId } })
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
  }, [projectId, selectedId, initial]);
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
      setResult(await readConnections({ data: { projectId, integrationId: selectedId } }));
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
          key={`${result.state.actorScope}:${projectId}:${selectedId ?? 'index'}:${String(search.bundleId ?? '')}:${String(search.channel ?? '')}`}
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
              <ConsoleLink href={scopedConnectionHref(projectId, search)}>
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
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [bundleId, setBundle] = useState(
    typeof search.bundleId === 'string' ? search.bundleId : (state.bundles[0]?.id ?? ''),
  );
  const bundle = state.bundles.find((item) => item.id === bundleId);
  const [channel, setChannel] = useState(
    typeof search.channel === 'string' ? search.channel : (bundle?.channels[0]?.name ?? ''),
  );
  const [credential, setCredential] = useState<IntegrationCredential | null>(null);
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
    state.projectId,
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
  const directorySearch = { ...search, q: query, access };
  const connectionHref = (id: string) => scopedConnectionHref(state.projectId, directorySearch, id);
  const setupHref = selected
    ? bundleHref(
        { projectId: state.projectId, bundleId: selected.bundleId, channel: selected.channel },
        'connect',
      )
    : undefined;
  const binding = selected
    ? { projectId: state.projectId, bundleId: selected.bundleId, channel: selected.channel }
    : undefined;
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
          await navigate(consoleDestination(connectionHref(result.integration.id)));
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
          <p className="text-sm text-muted-foreground">
            No {kind === 'content-read' ? 'read' : 'reporting'} credentials created.
          </p>
        )}
        {items.map((item) => (
          <div key={item.id} className="connection-credential-row">
            <div className="min-w-0 space-y-1">
              <p className="font-medium">
                {item.kind === 'content-read' ? 'Read credential' : 'Reporting credential'} ·{' '}
                {item.revokedAt ? 'Revoked' : 'Active'}
              </p>
              <code className="block break-all text-sm">{item.id}</code>
            </div>
            <Button
              variant="outline"
              aria-label={`Revoke ${item.kind === 'content-read' ? 'read' : 'reporting'} credential ${item.id}`}
              disabled={!state.canManage || busy || Boolean(item.revokedAt)}
              onClick={(event) => {
                revokeTriggerRef.current = event.currentTarget;
                setCredentialId(item.id);
                setConfirm('credential');
              }}
            >
              Revoke {item.kind === 'content-read' ? 'read' : 'reporting'} credential
            </Button>
          </div>
        ))}
      </div>
    );
  }
  const directoryAbout = (
    <Disclosure className="text-sm">
      <DisclosureTrigger className="cursor-pointer text-muted-foreground">
        Workspace details
      </DisclosureTrigger>
      <DisclosureContent className="space-y-2 pt-2">
        <p className="text-muted-foreground">
          A connection groups an app’s credentials for one bundle and channel. Creating one does not
          connect a running app. SDK clients can fetch content without a connection.
        </p>
        <p className="break-words">Workspace: {state.projectName}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span>Workspace ID:</span>
          <code className="break-all">{state.projectId}</code>
          <CopyButton value={state.projectId} label="Copy workspace ID" />
        </div>
      </DisclosureContent>
    </Disclosure>
  );
  return (
    <>
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
            New connection
          </Button>
        }
      />
      <div className="connection-workspace" data-selected={Boolean(state.selected)}>
        <section
          className={
            selected ? 'connection-selected-navigation space-y-3' : 'connection-directory space-y-3'
          }
          aria-label="Workspace connections"
        >
          {selected && (
            <div className="connection-directory-header">
              <ConsoleLink
                href={scopedConnectionHref(state.projectId, directorySearch)}
                className="underline"
                onClick={(e) => {
                  if (e.detail === 0) focusAfterNavigation('connection-entry-' + selected.id);
                }}
              >
                Back to connections
              </ConsoleLink>
            </div>
          )}
          {selected && directoryAbout}
          {selected && (
            <div className="space-y-2">
              <Label htmlFor="selected-app-connection">App connection</Label>
              <Select
                value={selected.id}
                onValueChange={(id) => {
                  if (id !== selected.id)
                    void navigate(consoleDestination(connectionHref(id))).then(() => {
                      document.getElementById('selected-app-connection')?.focus();
                    });
                }}
              >
                <SelectTrigger id="selected-app-connection" className="connection-switcher-trigger">
                  <SelectValue>{selected.displayName}</SelectValue>
                </SelectTrigger>
                <SelectContent position="popper" className="connection-switcher-options">
                  {(!rows.some((item) => item.id === selected.id) ? [selected, ...rows] : rows).map(
                    (item) => (
                      <SelectItem
                        key={item.id}
                        value={item.id}
                        textValue={item.displayName}
                        className="connection-switcher-option"
                      >
                        <span className="connection-switcher-choice">
                          <span className="block font-medium">{item.displayName}</span>
                          <span className="block text-muted-foreground">
                            {bundleName(item.bundleId)} / {item.channel} ·{' '}
                            {item.enabled ? 'Access enabled' : 'Access revoked'}
                            {!rows.some((row) => row.id === item.id) ? ' · Outside filters' : ''}
                          </span>
                          <code className="block text-xs">{item.id}</code>
                        </span>
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
              {!rows.some((item) => item.id === selected.id) && (
                <p className="text-sm">
                  The selected connection is outside the current directory filters.
                </p>
              )}
            </div>
          )}
          {(filterBundle || filterChannel || (selected && (query || access !== 'all'))) && (
            <div className="text-sm">
              Filtered to {filterBundle ? bundleName(filterBundle) : 'all bundles'}
              {filterChannel ? ` / ${filterChannel}` : ''}
              {query ? ' · ' + query : ''}
              {access !== 'all' ? ' · ' + access : ''}.{' '}
              <ConsoleLink
                href={scopedConnectionHref(state.projectId, {}, selected?.id)}
                className="underline"
              >
                Clear filters
              </ConsoleLink>
            </div>
          )}
          {!selected && (
            <div className="connection-index-tools">
              {scopedRows.length > 0 && (
                <>
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
                  <span role="status">
                    {rows.length} of {scopedRows.length} connections
                  </span>
                </>
              )}
              {directoryAbout}
            </div>
          )}
          {!selected &&
            (!rows.length ? (
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
                    href={workspaceHref(state.projectId, 'bundles')}
                    className="underline"
                  >
                    Go to bundles
                  </ConsoleLink>
                )}
              </div>
            ) : (
              <div className="connection-list connection-ledger divide-y rounded-md border bg-card">
                <div className="connection-index-head" aria-hidden="true">
                  <span>App connection</span>
                  <span>Bundle / channel</span>
                  <span>Credentials</span>
                  <span>Last report · UTC</span>
                  <span>Access</span>
                  <span />
                </div>
                {rows.map((item) => {
                  const report = state.reports?.[item.id];
                  const unrevoked = item.credentials?.filter((c) => !c.revokedAt);
                  return (
                    <ConsoleLink
                      key={item.id}
                      href={connectionHref(item.id)}
                      id={'connection-entry-' + item.id}
                      onClick={(e) => {
                        if (e.detail === 0) focusAfterNavigation('connection-selected-title');
                      }}
                      className="connection-row"
                    >
                      <span className="connection-cell connection-ledger-app">
                        <Radio aria-hidden="true" size={15} />
                        <span>
                          <strong>{item.displayName}</strong>
                          <code title={item.id}>{item.id.slice(0, 8)}</code>
                        </span>
                      </span>
                      <span className="connection-cell">
                        <small>Bundle / channel</small>
                        <strong>{bundleName(item.bundleId)}</strong>
                        <code>{item.channel}</code>
                      </span>
                      <span className="connection-cell">
                        <small>Credentials</small>
                        {unrevoked ? (
                          <>
                            <span>
                              {unrevoked.filter((c) => c.kind === 'content-read').length} read
                            </span>
                            <span>
                              {unrevoked.filter((c) => c.kind === 'receipt-write').length} reporting
                            </span>
                          </>
                        ) : (
                          <span>Unavailable</span>
                        )}
                      </span>
                      <span className="connection-cell">
                        <small>Last report · UTC</small>
                        {report ? (
                          <>
                            <strong className="capitalize">{report.stage}</strong>
                            <time dateTime={report.receivedAt} title={report.receivedAt}>
                              {new Date(report.receivedAt).toLocaleString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                                hourCycle: 'h23',
                                timeZone: 'UTC',
                              })}
                            </time>
                          </>
                        ) : (
                          <span>{report === null ? 'No retained report' : 'Unavailable'}</span>
                        )}
                      </span>
                      <Badge variant={item.enabled ? 'secondary' : 'outline'}>
                        {item.enabled ? 'Enabled' : 'Revoked'}
                      </Badge>
                      <ChevronRight size={15} className="connection-row-arrow" aria-hidden="true" />
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
            <header className="connection-selected-header space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2
                    id="connection-selected-title"
                    tabIndex={-1}
                    className="break-words text-lg font-semibold"
                  >
                    {selected.displayName}
                  </h2>
                  <p className="mt-1 break-words text-sm">
                    {bundleName(selected.bundleId)} / {selected.channel}
                  </p>
                  <Badge variant="outline" className="mt-2">
                    {selected.enabled ? 'Access enabled' : 'Access revoked'}
                  </Badge>
                </div>
                <div className="connection-detail-actions">
                  <ConsoleLink
                    href={
                      workspaceHref(state.projectId, 'delivery') +
                      '?integration=' +
                      encodeURIComponent(selected.id)
                    }
                    className="inline-flex min-h-9 items-center gap-1 rounded-md border px-3 text-sm font-medium hover:bg-muted"
                  >
                    View delivery <ArrowUpRight size={14} />
                  </ConsoleLink>
                  <ConsoleLink
                    href={setupHref!}
                    className="inline-flex min-h-9 items-center rounded-md border px-3 font-medium hover:bg-muted"
                  >
                    Open app setup
                  </ConsoleLink>
                </div>
              </div>
              <nav aria-label="Connection sections" className="connection-sections">
                <a href="#continuous-learning">Continuous learning</a>
                <a href="#delivery-reports">Delivery reports</a>
                <a href="#app-credentials">App credentials</a>
              </nav>
              <Disclosure className="connection-identity text-sm">
                <DisclosureTrigger className="cursor-pointer font-medium">
                  Connection identity details
                </DisclosureTrigger>
                <DisclosureContent>
                  <dl className="connection-identities">
                    <div>
                      <dt>Workspace ID</dt>
                      <dd>
                        <code className="break-all">{state.projectId}</code>
                        <CopyButton value={state.projectId} label="Copy workspace ID" />
                      </dd>
                    </div>
                    <div>
                      <dt>Bundle ID</dt>
                      <dd>
                        <code className="break-all">{selected.bundleId}</code>
                        <CopyButton value={selected.bundleId} label="Copy bundle ID" />
                      </dd>
                    </div>
                    <div>
                      <dt>Connection ID</dt>
                      <dd>
                        <code className="min-w-0 break-all text-xs">{selected.id}</code>
                        <CopyButton value={selected.id} label="Copy connection ID" />
                      </dd>
                    </div>
                  </dl>
                </DisclosureContent>
              </Disclosure>
            </header>
            <div className="connection-detail-panels">
              <section
                id="app-credentials"
                className="workspace-panel connection-credentials-panel space-y-4 p-4"
              >
                {(busy || !selected.enabled || recovery) && (
                  <p className="text-sm text-muted-foreground">
                    {busy
                      ? 'An operation is in progress.'
                      : !selected.enabled
                        ? 'This connection is revoked; new credentials cannot be issued.'
                        : 'Resolve the pending credential creation before issuing another credential.'}
                  </p>
                )}
                <div>
                  <h3 className="font-semibold">App credentials</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    These work only for {bundleName(selected.bundleId)} / {selected.channel}.
                    Secrets appear once; save them in your app’s secret manager.
                  </p>
                </div>
                <div className="connection-credential-groups">
                  <section className="connection-read-credentials space-y-3">
                    <div>
                      <h4 className="text-sm font-medium">Read published content</h4>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Use this credential in your app’s SDK setup.
                      </p>
                    </div>
                    <Button
                      disabled={!state.canManage || busy || !selected.enabled || Boolean(recovery)}
                      onClick={(event) => {
                        credentialTriggerRef.current = event.currentTarget;
                        void command({
                          action: 'issue',
                          id: selected.id,
                          kind: 'content-read',
                          key: crypto.randomUUID(),
                        });
                      }}
                    >
                      Create read credential
                    </Button>
                    {issuedCredentials('content-read')}
                  </section>
                  <Disclosure className="connection-reporting-credentials">
                    <DisclosureTrigger className="cursor-pointer text-sm font-medium">
                      Optional delivery reports &amp; credentials
                    </DisclosureTrigger>
                    <DisclosureContent className="space-y-3">
                      <p className="mt-3 text-sm text-muted-foreground">
                        A separate credential lets your app report what it observed.
                      </p>
                      <Button
                        variant="outline"
                        disabled={
                          !state.canManage || busy || !selected.enabled || Boolean(recovery)
                        }
                        onClick={(event) => {
                          credentialTriggerRef.current = event.currentTarget;
                          void command({
                            action: 'issue',
                            id: selected.id,
                            kind: 'receipt-write',
                            key: crypto.randomUUID(),
                          });
                        }}
                      >
                        Create reporting credential
                      </Button>
                      {issuedCredentials('receipt-write')}
                    </DisclosureContent>
                  </Disclosure>
                </div>
                {recovery && (
                  <div className="space-y-3 rounded border border-amber-500/50 p-3" role="status">
                    <p>
                      We couldn’t confirm this{' '}
                      {recovery.kind === 'content-read' ? 'read' : 'reporting'} credential creation.
                      Check its result before creating another credential. Previously issued secrets
                      cannot be retrieved.
                    </p>
                    {recovery.credentialId ? (
                      <>
                        <p className="break-all">
                          Original credential: {recovery.credentialId} ·{' '}
                          {recoveredOriginal?.revokedAt
                            ? 'Revocation confirmed'
                            : 'Revocation not confirmed'}
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
                )}
                <Disclosure className="max-w-lg space-y-2">
                  <DisclosureTrigger className="cursor-pointer text-sm font-medium">
                    Advanced credential actions
                  </DisclosureTrigger>
                  <DisclosureContent className="space-y-2">
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
                <Disclosure className="border-t pt-4">
                  <DisclosureTrigger className="cursor-pointer text-sm font-medium">
                    Revoke this connection
                  </DisclosureTrigger>
                  <DisclosureContent>
                    <div className="space-y-3 pt-3">
                      <p className="text-sm text-muted-foreground">
                        Block all credentials for this app. This cannot recall cached files or stop
                        prepared sessions.
                      </p>
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
                    </div>
                  </DisclosureContent>
                </Disclosure>
              </section>
              <ConnectionReports
                key={selected.id}
                receipts={receiptPage}
                channel={selected.channel}
                currentRevision={state.selected!.currentRevision}
                currentVersionId={state.selected!.currentVersionId}
                setupHref={setupHref!}
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
            </div>
            <ConnectionLearning
              key={`${selected.id}:${selected.enabled}`}
              target={{ projectId: state.projectId, integrationId: selected.id }}
              bundleId={selected.bundleId}
              channel={selected.channel}
              connectionName={selected.displayName}
              currentVersionId={state.selected!.currentVersionId}
              currentRevision={state.selected!.currentRevision}
              canManage={state.canManage}
              enabled={selected.enabled}
            />
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
                  { projectId: state.projectId, bundleId, channel },
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
                <dd className="break-all">{state.projectId}</dd>
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
