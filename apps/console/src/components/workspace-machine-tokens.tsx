import { useEffect, useRef, useState, type ReactNode } from 'react';
import { History, KeyRound, MoreHorizontal, RotateCw, ShieldOff } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Field } from './ui/field';
import { NativeSelect } from './ui/native-select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Panel } from './panel';
import { PageTitle } from './shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { shortId } from '../lib/format';
import { CopyButton } from './copy-button';
import { ReceiptTime } from './receipt-time';
import { StatusBadge } from './status-badge';
import { runMachineTokenCommand } from '../server/machine-token-actions';
import type {
  MachineToken,
  MachineTokenCommand,
  MachineTokenEvent,
} from '../server/machine-token-core';
import { MACHINE_TOKEN_RIGHTS, type MachineTokenRight } from '../lib/machine-token-rights';

const RIGHT_LABELS: Record<MachineTokenRight, string> = {
  read: 'Read content',
  write: 'Write content',
  promote: 'Promote releases',
};
const RIGHT_SHORT_LABELS: Record<MachineTokenRight, string> = {
  read: 'Read',
  write: 'Write',
  promote: 'Promote',
};
/** What each right allows, as in the Rights table of the credentials reference. */
const RIGHT_HINTS: Record<MachineTokenRight, string> = {
  read: 'Resolve a channel and read the released content.',
  write: 'Add versions, import or edit tasks and report outcomes.',
  promote: 'Release versions to channels and change learning settings.',
};
const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  revoked: 'Revoked',
  expired: 'Expired',
};
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
type Issued = { secret: string; token: MachineToken };

/** Workspace admins issue, rotate and revoke machine tokens without a service restart. */
export function WorkspaceMachineTokens({ workspaceId }: { workspaceId: string }) {
  const [tokens, setTokens] = useState<MachineToken[]>();
  const [events, setEvents] = useState<MachineTokenEvent[]>([]);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [name, setName] = useState('delivery-client');
  const [rights, setRights] = useState<MachineTokenRight[]>(['read']);
  const [days, setDays] = useState('90');
  const [reason, setReason] = useState('');
  const [issued, setIssued] = useState<Issued>();
  const [revoking, setRevoking] = useState<MachineToken>();
  const [revokeReason, setRevokeReason] = useState('');
  const issueTrigger = useRef<HTMLButtonElement>(null);
  const revokeTrigger = useRef<HTMLButtonElement | null>(null);
  const actionTriggers = useRef(new Map<string, HTMLButtonElement>());
  const scope = useRef(workspaceId);
  scope.current = workspaceId;

  async function refresh(target = workspaceId) {
    const value = await runMachineTokenCommand({ data: { kind: 'list', workspaceId: target } });
    if (target !== scope.current) return;
    if (!value.ok) {
      if (value.denied) setHidden(true);
      else setMessage(value.message);
      return;
    }
    setTokens(value.items ?? []);
    setEvents(value.events ?? []);
  }

  useEffect(() => {
    setTokens(undefined);
    setHidden(false);
    setIssued(undefined);
    setMessage('');
    void refresh(workspaceId).catch(() => {
      if (scope.current === workspaceId) setMessage('Could not load machine tokens.');
    });
    // refresh reads the current project from its argument.
  }, [workspaceId]);

  async function run(command: MachineTokenCommand) {
    if (pending) return;
    setPending(true);
    setMessage('');
    try {
      const result = await runMachineTokenCommand({ data: command });
      if (command.workspaceId !== scope.current) return;
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      if (result.secret && result.token) setIssued({ secret: result.secret, token: result.token });
      if (command.kind === 'issue') setIssuing(false);
      if (command.kind === 'revoke') {
        setRevoking(undefined);
        setMessage(
          `Revoked ${result.token?.name ?? 'token'}. It stops working on its next request.`,
        );
      }
      await refresh(command.workspaceId);
    } catch {
      setMessage('Could not confirm the token change. Refresh the token list before trying again.');
    } finally {
      setPending(false);
    }
  }

  const title = (actions?: ReactNode) => (
    <PageTitle
      title="Machine tokens"
      description="Credentials for applications and automation that call the API for this workspace."
      actions={actions}
    />
  );
  if (hidden)
    return (
      <div className="settings-page">
        {title()}
        <p role="alert" className="rounded-lg border p-4">
          Machine token management requires a workspace administrator.
        </p>
      </div>
    );
  const validIssue =
    NAME.test(name) && rights.length > 0 && Number(days) >= 1 && Number(days) <= 365;
  return (
    <div className="machine-tokens settings-page">
      {title(
        <Button
          ref={issueTrigger}
          disabled={pending}
          onClick={() => {
            setName('delivery-client');
            setRights(['read']);
            setDays('90');
            setReason('');
            setIssuing(true);
          }}
        >
          <KeyRound aria-hidden="true" /> Issue token
        </Button>,
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {issued && <IssuedSecret issued={issued} onDone={() => setIssued(undefined)} />}
      <Panel
        title={
          <>
            Issued tokens
            {tokens && <span className="settings-count">{tokens.length}</span>}
          </>
        }
        description="Rotate or revoke a token without restarting the service. Each secret is shown once."
        flush
      >
        {!tokens ? (
          <p role="status" className="settings-empty">
            Loading machine tokens…
          </p>
        ) : tokens.length === 0 ? (
          <div className="settings-empty">
            <KeyRound aria-hidden="true" />
            <p>No machine tokens yet.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Token</TableHead>
                <TableHead>Rights</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => (
                <TableRow key={token.id}>
                  <TableCell>
                    <div className="token-identity">
                      <span className="font-medium break-all">{token.name}</span>
                      <code title={`Principal ${token.principalId}`}>{token.secretPrefix}…</code>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {token.rights.map((right) => (
                        <StatusBadge
                          key={right}
                          title={RIGHT_LABELS[right as MachineTokenRight] ?? right}
                        >
                          {RIGHT_SHORT_LABELS[right as MachineTokenRight] ?? right}
                        </StatusBadge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      tone={
                        token.status === 'active'
                          ? 'success'
                          : token.status === 'revoked'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {STATUS_LABELS[token.status] ?? token.status}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <ReceiptTime value={token.expiresAt} relative />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {token.lastUsedAt ? <ReceiptTime value={token.lastUsedAt} relative /> : 'Never'}
                  </TableCell>
                  <TableCell className="text-right">
                    {token.status === 'active' && (
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={pending}
                            aria-label={`Actions for ${token.name}`}
                            ref={(node) => {
                              if (node) actionTriggers.current.set(token.id, node);
                              else actionTriggers.current.delete(token.id);
                            }}
                          >
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel className="break-words">
                            {token.name}
                          </DropdownMenuLabel>
                          <DropdownMenuItem
                            aria-label={`Rotate ${token.name}`}
                            onSelect={() =>
                              void run({
                                kind: 'rotate',
                                workspaceId,
                                id: token.id,
                                overlapSeconds: 3600,
                              })
                            }
                          >
                            <RotateCw aria-hidden="true" /> Rotate
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            aria-label={`Revoke ${token.name}`}
                            onSelect={() => {
                              revokeTrigger.current = actionTriggers.current.get(token.id) ?? null;
                              setRevokeReason('');
                              setRevoking(token);
                            }}
                          >
                            <ShieldOff aria-hidden="true" /> Revoke…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
      {events.length > 0 && (
        <Panel
          title="Token activity"
          description="Who issued, rotated or revoked each token, newest first."
          flush
        >
          <ul className="settings-list">
            {events.slice(0, showAllEvents ? 50 : 5).map((event, index) => (
              <li key={`${event.tokenId}-${event.createdAt}-${index}`}>
                <div className="settings-list-main">
                  <History aria-hidden="true" className="text-muted-foreground" />
                  <p className="min-w-0">
                    <strong className="font-medium">{event.tokenName}</strong>{' '}
                    {event.action} by{' '}
                    <code className="text-xs" title={event.actorPrincipal}>
                      {actorLabel(event.actorPrincipal)}
                    </code>
                    {event.reason && (
                      <span className="block text-muted-foreground">{event.reason}</span>
                    )}
                  </p>
                </div>
                <span className="settings-list-meta">
                  <ReceiptTime value={event.createdAt} relative />
                </span>
              </li>
            ))}
          </ul>
          {events.length > 5 && (
            <div className="settings-list-more">
              <Button variant="ghost" size="sm" onClick={() => setShowAllEvents((all) => !all)}>
                {showAllEvents ? 'Show recent only' : `Show all ${Math.min(events.length, 50)} events`}
              </Button>
            </div>
          )}
        </Panel>
      )}
      <Dialog open={issuing} onOpenChange={(open) => !pending && setIssuing(open)}>
        <DialogContent returnFocusRef={issueTrigger}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!validIssue) return;
              void run({
                kind: 'issue',
                workspaceId,
                name,
                rights,
                expiresInDays: Number(days),
                reason: reason || undefined,
              });
            }}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>Issue machine token</DialogTitle>
              <DialogDescription>
                The token acts as <code>machine:{NAME.test(name) ? name : '…'}</code>. Rotating it
                later keeps that principal.
              </DialogDescription>
            </DialogHeader>
            <Field
              label="Name"
              htmlFor="token-name"
              hint="Lowercase letters, digits, dot, dash or underscore."
            >
              <Input
                id="token-name"
                value={name}
                aria-invalid={!NAME.test(name)}
                aria-describedby="token-name-hint"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <fieldset className="grid gap-2">
              <legend className="form-field-label mb-1.5">Rights</legend>
              {MACHINE_TOKEN_RIGHTS.map((right) => (
                <div key={right} className="flex items-start gap-2">
                  <input
                    id={`token-right-${right}`}
                    type="checkbox"
                    className="mt-0.5"
                    aria-describedby={`token-right-${right}-hint`}
                    checked={rights.includes(right)}
                    onChange={(event) =>
                      setRights((current) =>
                        event.target.checked
                          ? [...current, right]
                          : current.filter((value) => value !== right),
                      )
                    }
                  />
                  <div className="grid gap-0.5">
                    <label htmlFor={`token-right-${right}`} className="text-sm font-medium">
                      {RIGHT_LABELS[right]}
                    </label>
                    <p id={`token-right-${right}-hint`} className="text-xs text-muted-foreground">
                      {RIGHT_HINTS[right]}
                    </p>
                  </div>
                </div>
              ))}
            </fieldset>
            <Field label="Expires after" htmlFor="token-expiry">
              <NativeSelect
                id="token-expiry"
                value={days}
                onChange={(event) => setDays(event.target.value)}
              >
                {['7', '30', '90', '180', '365'].map((value) => (
                  <option key={value} value={value}>
                    {value} days
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field
              label="Reason (optional)"
              htmlFor="token-reason"
              hint="Recorded in the audit trail."
            >
              <Input
                id="token-reason"
                value={reason}
                maxLength={1024}
                aria-describedby="token-reason-hint"
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIssuing(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !validIssue}>
                Issue token
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !pending && !open && setRevoking(undefined)}
      >
        <DialogContent returnFocusRef={revokeTrigger}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (revoking && revokeReason.trim())
                void run({ kind: 'revoke', workspaceId, id: revoking.id, reason: revokeReason });
            }}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>Revoke {revoking?.name}</DialogTitle>
              <DialogDescription>
                This token will no longer authenticate requests.
              </DialogDescription>
            </DialogHeader>
            <Field label="Reason" htmlFor="revoke-reason">
              <Input
                id="revoke-reason"
                value={revokeReason}
                maxLength={1024}
                required
                onChange={(event) => setRevokeReason(event.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRevoking(undefined)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={pending || !revokeReason.trim()}
              >
                Revoke token
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A principal such as user:<uuid> with the ID shortened; the full value is in its title. */
function actorLabel(principal: string) {
  const split = principal.indexOf(':');
  return split < 0 ? principal : `${principal.slice(0, split)}:${shortId(principal.slice(split + 1))}`;
}

/** Shown once after issue or rotation. The secret never reaches a URL or local storage. */
function IssuedSecret({ issued, onDone }: { issued: Issued; onDone: () => void }) {
  return (
    <div
      role="region"
      aria-label="New token secret"
      className="grid gap-3 rounded-[10px] border bg-card p-5 shadow-xs"
    >
      <p className="text-sm font-medium">
        Copy the secret for <code>{issued.token.name}</code> now. It is not shown again.
      </p>
      <div className="secret-field">
        <KeyRound aria-hidden="true" />
        <code className="mr-auto min-w-0 break-all text-xs">{issued.secret}</code>
        <CopyButton value={issued.secret} label="Copy secret" />
      </div>
      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
