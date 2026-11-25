import { useEffect, useRef, useState } from 'react';
import { KeyRound, MoreHorizontal, RotateCw, ShieldOff } from 'lucide-react';
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
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';
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

  const title = (
    <PageTitle
      title="Machine tokens"
      description="Credentials for applications and automation that call the API for this workspace."
    />
  );
  if (hidden)
    return (
      <div className="space-y-4">
        {title}
        <p role="alert" className="rounded-lg border p-4">
          Machine token management requires a workspace administrator.
        </p>
      </div>
    );
  const validIssue =
    NAME.test(name) && rights.length > 0 && Number(days) >= 1 && Number(days) <= 365;
  return (
    <div className="machine-tokens space-y-4">
      {title}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {issued && <IssuedSecret issued={issued} onDone={() => setIssued(undefined)} />}
      <Panel
        title="Issued tokens"
        description="Rotate or revoke a token without restarting the service. Each secret is shown once."
        actions={
          <Button
            ref={issueTrigger}
            size="sm"
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
          </Button>
        }
        flush
      >
        {!tokens ? (
          <p role="status" className="p-4 text-sm">
            Loading machine tokens…
          </p>
        ) : tokens.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No machine tokens yet.</p>
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
                    <div className="font-medium">{token.name}</div>
                    <div className="text-xs text-muted-foreground">
                      <code>{token.principalId}</code> · <code>{token.secretPrefix}…</code>
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
        {events.length > 0 && (
          <Disclosure className="border-t px-4 py-3">
            <DisclosureTrigger>Token audit trail</DisclosureTrigger>
            <DisclosureContent>
              <ul className="space-y-1 pt-2 text-sm">
                {events.slice(0, 50).map((event, index) => (
                  <li key={`${event.tokenId}-${event.createdAt}-${index}`}>
                    <ReceiptTime value={event.createdAt} /> · {event.action}{' '}
                    <strong>{event.tokenName}</strong> by <code>{event.actorPrincipal}</code>
                    {event.reason ? ` — ${event.reason}` : ''}
                  </li>
                ))}
              </ul>
            </DisclosureContent>
          </Disclosure>
        )}
      </Panel>
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

/** Shown once after issue or rotation. The secret never reaches a URL or local storage. */
function IssuedSecret({ issued, onDone }: { issued: Issued; onDone: () => void }) {
  return (
    <div role="region" aria-label="New token secret" className="space-y-3 rounded-lg border p-4">
      <p className="text-sm font-medium">
        Copy the secret for <code>{issued.token.name}</code> now. It is not shown again.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="break-all rounded bg-muted px-2 py-1 text-xs">{issued.secret}</code>
        <CopyButton value={issued.secret} label="Copy secret" />
      </div>
      <Button type="button" variant="outline" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
