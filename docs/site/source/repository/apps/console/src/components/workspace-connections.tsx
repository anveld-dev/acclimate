import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { DeliveryReceipt, IntegrationCredential, Page } from '@acclimate/sdk';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';
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
  const [result, setResult] = useState<ConnectionsResult>(
    initial ?? { ok: false, message: 'Loading connections…' },
  );
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let active = true;
    if (
      initial &&
      (!selectedId || !initial.ok || initial.state.selected?.integration.id === selectedId)
    ) {
      setResult(initial);
      return;
    }
    setRefreshing(true);
    void readConnections({ data: { projectId, integrationId: selectedId } })
      .then((value) => {
        if (active) setResult(value);
      })
      .catch(() => {
        if (active)
          setResult({ ok: false, message: 'Could not read connections. Refresh to try again.' });
      })
      .finally(() => {
        if (active) setRefreshing(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, selectedId, initial]);
  async function refresh() {
    setRefreshing(true);
    try {
      setResult(await readConnections({ data: { projectId, integrationId: selectedId } }));
    } catch {
      setResult({ ok: false, message: 'Could not read connections. Current state is unknown.' });
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Connections</h1>
          <p className="mt-1 text-muted-foreground">
            Give apps access to your bundles and see the delivery reports they send.
          </p>
        </div>
        <Button variant="outline" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? 'Refreshing…' : 'Refresh connections'}
        </Button>
      </div>
      {result.ok ? (
        <ConnectionWorkspace
          key={`${result.state.actorScope}:${projectId}:${selectedId ?? 'index'}:${String(search.bundleId ?? '')}:${String(search.channel ?? '')}`}
          state={result.state}
          search={search}
          refresh={refresh}
        />
      ) : (
        <p role="alert" className="workspace-panel p-4">
          {result.message}
        </p>
      )}
    </div>
  );
}

function ConnectionWorkspace({
  state,
  search,
  refresh,
}: {
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
  const rows = state.integrations.filter(
    (item) =>
      (!filterBundle || item.bundleId === filterBundle) &&
      (!filterChannel || item.channel === filterChannel),
  );
  const connectionHref = (id: string) => scopedConnectionHref(state.projectId, search, id);
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
        request.action === 'issue' && !issuanceRecorded
          ? 'Browser storage is unavailable. No credential issuance request was sent.'
          : 'Outcome unknown. Refresh and inspect the connection before repeating this action. The same operation ID will be reused.',
      );
    } finally {
      setBusy(false);
    }
  }
  const bundleName = (id: string) => state.bundles.find((item) => item.id === id)?.name ?? id;
  return (
    <>
      <details key={selected?.id ?? 'index'} open={!selected} className="workspace-panel p-4">
        <summary className="cursor-pointer font-semibold">
          {selected ? 'Switch connection or create another' : 'Workspace connections'}
        </summary>
        <div className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">{state.projectName}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Each connection groups an app’s access to one bundle and channel.
              </p>
            </div>
            <Button
              disabled={!state.canManage || busy || !state.bundles.length}
              onClick={() => setCreating(true)}
            >
              New connection
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            A connection groups an app’s credentials and optional delivery reports. Creating one
            does not connect a running app. SDK clients can also fetch content without a connection.
          </p>
          {(filterBundle || filterChannel) && (
            <div className="text-sm">
              Filtered to {filterBundle ? bundleName(filterBundle) : 'all bundles'}
              {filterChannel ? ` / ${filterChannel}` : ''}.{' '}
              <ConsoleLink
                href={workspaceHref(state.projectId, 'connections')}
                className="underline"
              >
                Clear filters
              </ConsoleLink>
            </div>
          )}
          {!rows.length ? (
            <div className="space-y-2 rounded border border-dashed p-4">
              <p>
                {filterBundle || filterChannel
                  ? 'No connections match these filters.'
                  : !state.bundles.length
                    ? 'Add a bundle before setting up app access.'
                    : state.canManage
                      ? 'Create a connection for app credentials and optional reporting.'
                      : 'No connections yet. Ask a workspace administrator to configure app access.'}
              </p>
              {!state.bundles.length && (
                <ConsoleLink href={workspaceHref(state.projectId, 'bundles')} className="underline">
                  Go to bundles
                </ConsoleLink>
              )}
            </div>
          ) : (
            <div className="divide-y rounded border">
              {rows.map((item) => (
                <ConsoleLink
                  key={item.id}
                  href={connectionHref(item.id)}
                  aria-current={selected?.id === item.id ? 'page' : undefined}
                  className="flex flex-wrap items-center justify-between gap-3 p-4 hover:bg-muted/40 aria-[current=page]:bg-muted/60"
                >
                  <div className="min-w-0 flex-1 basis-48">
                    <strong className="break-words">{item.displayName}</strong>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {bundleName(item.bundleId)} / {item.channel}
                    </p>
                  </div>
                  <Badge variant="outline">{item.enabled ? 'Enabled' : 'Revoked'}</Badge>
                </ConsoleLink>
              ))}
            </div>
          )}
          {!state.canManage && (
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
        </div>
      </details>
      {error && (
        <p role="alert" className="rounded border border-destructive/30 p-4">
          {error}
        </p>
      )}
      {selected && (
        <>
          <section className="workspace-panel space-y-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="break-words text-lg font-semibold">{selected.displayName}</h2>
                <p className="mt-1 break-words text-sm">
                  {bundleName(selected.bundleId)} / {selected.channel}
                </p>
                <Badge variant="outline" className="mt-2">
                  {selected.enabled ? 'Active connection' : 'Revoked connection'}
                </Badge>
              </div>
              <p className="text-sm">
                <ConsoleLink
                  href={setupHref!}
                  className="inline-flex min-h-9 items-center rounded-md border px-3 font-medium hover:bg-muted"
                >
                  Open app setup
                </ConsoleLink>
              </p>
            </div>
            <details className="rounded-md border p-3 text-sm">
              <summary className="cursor-pointer font-medium">Connection ID</summary>
              <div className="flex min-w-0 flex-wrap items-center gap-2 pt-3">
                <code className="min-w-0 break-all text-xs">{selected.id}</code>
                <CopyButton value={selected.id} label="Copy connection ID" />
              </div>
            </details>
            <div>
              <h3 className="font-semibold">App credentials</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                These work only for {bundleName(selected.bundleId)} / {selected.channel}. Secrets
                appear once; save them in your app’s secret manager.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-3 rounded-md border p-4">
                <div>
                  <h4 className="text-sm font-medium">Read published content</h4>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Use this credential in your app’s SDK setup.
                  </p>
                </div>
                <Button
                  disabled={!state.canManage || busy || !selected.enabled || Boolean(recovery)}
                  onClick={() =>
                    void command({
                      action: 'issue',
                      id: selected.id,
                      kind: 'content-read',
                      key: crypto.randomUUID(),
                    })
                  }
                >
                  Create read credential
                </Button>
              </div>
              <div className="space-y-3 rounded-md border p-4">
                <div>
                  <h4 className="text-sm font-medium">
                    Send delivery reports{' '}
                    <span className="font-normal text-muted-foreground">· optional</span>
                  </h4>
                  <p className="mt-1 text-sm text-muted-foreground">
                    A separate credential lets your app report what it observed.
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={!state.canManage || busy || !selected.enabled || Boolean(recovery)}
                  onClick={() =>
                    void command({
                      action: 'issue',
                      id: selected.id,
                      kind: 'receipt-write',
                      key: crypto.randomUUID(),
                    })
                  }
                >
                  Create reporting credential
                </Button>
              </div>
            </div>
            {recovery && (
              <div className="space-y-3 rounded border border-amber-500/50 p-3" role="status">
                <p>
                  We couldn’t confirm this {recovery.kind === 'content-read' ? 'read' : 'reporting'}{' '}
                  credential creation. Check its result before creating another credential.
                  Previously issued secrets cannot be retrieved.
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
                        onClick={() => {
                          setCredentialId(recovery.credentialId!);
                          setConfirm('credential');
                        }}
                      >
                        Confirm revoke original credential
                      </Button>
                    ) : (
                      <Button
                        disabled={busy || !state.canManage || !selected.enabled}
                        onClick={() =>
                          void command({
                            action: 'issue',
                            id: selected.id,
                            kind: recovery.kind,
                            replacementOf: recovery.credentialId,
                            key: crypto.randomUUID(),
                          })
                        }
                      >
                        Create replacement credential
                      </Button>
                    )}
                  </>
                ) : (
                  <Button
                    disabled={busy || !state.canManage}
                    onClick={() =>
                      void command({
                        action: 'issue',
                        id: selected.id,
                        kind: recovery.kind,
                        key: recovery.key,
                      })
                    }
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
            <div className="space-y-2">
              <h3 className="font-medium">Issued credentials</h3>
              {!(selected.credentials ?? []).length && (
                <p className="text-sm text-muted-foreground">
                  No credentials created for this connection.
                </p>
              )}
              {(selected.credentials ?? []).map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b py-3 text-sm last:border-b-0"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">
                      {item.kind === 'content-read' ? 'Read credential' : 'Reporting credential'} ·{' '}
                      {item.revokedAt ? 'Revoked' : 'Active'}
                    </p>
                    <code className="block break-all text-xs">{item.id}</code>
                  </div>
                  <Button
                    variant="outline"
                    disabled={!state.canManage || busy || Boolean(item.revokedAt)}
                    onClick={() => {
                      setCredentialId(item.id);
                      setConfirm('credential');
                    }}
                  >
                    Revoke this credential
                  </Button>
                </div>
              ))}
            </div>
            <details className="max-w-lg space-y-2">
              <summary className="cursor-pointer text-sm font-medium">
                Advanced credential actions
              </summary>
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
                  disabled={!state.canManage || busy || !credentialId.trim()}
                  onClick={() => setConfirm('credential')}
                >
                  Revoke credential
                </Button>
              </div>
            </details>
            <details className="border-t pt-4">
              <summary className="cursor-pointer text-sm font-medium">
                Revoke this connection
              </summary>
              <div className="space-y-3 pt-3">
                <p className="text-sm text-muted-foreground">
                  Block all credentials for this app. This cannot recall cached files or stop
                  prepared sessions.
                </p>
                <Button
                  variant="destructive"
                  disabled={!state.canManage || busy || !selected.enabled}
                  onClick={() => setConfirm('integration')}
                >
                  Revoke connection
                </Button>
              </div>
            </details>
          </section>
          <section className="workspace-panel space-y-4 p-4">
            <div>
              <h2 className="font-semibold">App-reported delivery</h2>
              <p className="mt-1 break-all text-sm text-muted-foreground">
                Current {selected.channel}: revision {state.selected?.currentRevision} · version{' '}
                {state.selected?.currentVersionId}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              Each row is an independent observation, ordered by service receipt time. History lasts
              30 days. It does not establish a completed delivery chain or model consumption.
            </p>
            {!receiptPage.items.length ? (
              <p className="rounded bg-muted/50 p-4">
                No delivery report received; status unknown.{' '}
                <ConsoleLink href={`${setupHref}#reporting`} className="underline">
                  Set up reporting
                </ConsoleLink>
              </p>
            ) : (
              receiptPage.items.map((receipt) => (
                <ReceiptFact key={receipt.eventId} receipt={receipt} />
              ))
            )}
            {receiptPage.nextCursor && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void command({
                    action: 'receipts',
                    id: selected.id,
                    cursor: receiptPage.nextCursor!,
                  })
                }
              >
                Load older reports
              </Button>
            )}
          </section>
        </>
      )}
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!busy) setCreating(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New connection</DialogTitle>
            <DialogDescription>
              Name the app and choose the bundle and channel it can use. Next, create its
              credentials and add them to your app.
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="connection-name">Display name</Label>
          <Input
            id="connection-name"
            placeholder="e.g. Support assistant"
            disabled={busy}
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
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
        <DialogContent>
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Revoke {confirm === 'integration' ? 'connection' : 'credential'}?
            </DialogTitle>
            <DialogDescription>
              This blocks future service access. It cannot remove application caches or stop an
              existing prepared session.
            </DialogDescription>
          </DialogHeader>
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
              disabled={busy || !selected || !state.canManage}
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

function ReceiptFact({ receipt: r }: { receipt: DeliveryReceipt }) {
  return (
    <article className="space-y-2 rounded border p-4">
      <div className="flex flex-wrap gap-2">
        <h3 className="text-sm font-medium">
          {r.stage === 'started'
            ? 'App reported a session or turn started'
            : `App reported ${r.stage}`}
        </h3>
        <Badge variant="outline">{r.source}</Badge>
        {r.stale && <Badge variant="secondary">Stale mapping</Badge>}
        {r.delayed && <Badge variant="secondary">Delayed report</Badge>}
      </div>
      <p className="text-xs font-mono break-all">
        Version {r.versionId}
        <br />
        {r.digest}
      </p>
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">App-reported occurrence</dt>
          <dd>{r.occurredAt}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Service received</dt>
          <dd>{r.receivedAt}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Mapping</dt>
          <dd>
            {r.channel
              ? `${r.channel} · revision ${r.revision} · ${r.stale ? 'stale' : 'fresh'}`
              : 'Explicit pinned version'}
          </dd>
        </div>
        {r.resolvedAt && (
          <div>
            <dt className="text-muted-foreground">App-reported resolution</dt>
            <dd>{r.resolvedAt}</dd>
          </div>
        )}
      </dl>
    </article>
  );
}
