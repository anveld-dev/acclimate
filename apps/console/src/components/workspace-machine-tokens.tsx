import { useEffect, useRef, useState } from 'react';
import { KeyRound, RotateCw, ShieldOff } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';
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

  if (hidden) return null;
  const validIssue =
    NAME.test(name) && rights.length > 0 && Number(days) >= 1 && Number(days) <= 365;
  return (
    <section
      aria-labelledby="machine-tokens-heading"
      className="workspace-panel machine-tokens space-y-4 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="machine-tokens-heading" className="flex items-center gap-2 font-medium">
            <KeyRound aria-hidden="true" className="size-4" /> Machine tokens
          </h2>
          <p className="text-sm text-muted-foreground">
            Credentials for applications and automation. Issue, rotate or revoke them here without
            restarting the service. Each secret is shown once.
          </p>
        </div>
        <Button
          disabled={pending}
          onClick={() => {
            setName('delivery-client');
            setRights(['read']);
            setDays('90');
            setReason('');
            setIssuing(true);
          }}
        >
          Issue token
        </Button>
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {issued && <IssuedSecret issued={issued} onDone={() => setIssued(undefined)} />}
      {!tokens ? (
        <p role="status">Loading machine tokens…</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">No machine tokens yet.</p>
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
                <TableCell>{token.rights.join(', ')}</TableCell>
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
                    {token.status}
                  </StatusBadge>
                </TableCell>
                <TableCell>
                  <ReceiptTime value={token.expiresAt} />
                </TableCell>
                <TableCell>
                  {token.lastUsedAt ? <ReceiptTime value={token.lastUsedAt} relative /> : 'Never'}
                </TableCell>
                <TableCell className="text-right">
                  {token.status === 'active' && (
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        aria-label={`Rotate ${token.name}`}
                        onClick={() =>
                          void run({
                            kind: 'rotate',
                            workspaceId,
                            id: token.id,
                            overlapSeconds: 3600,
                          })
                        }
                      >
                        <RotateCw aria-hidden="true" /> Rotate
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        aria-label={`Revoke ${token.name}`}
                        onClick={() => {
                          setRevokeReason('');
                          setRevoking(token);
                        }}
                      >
                        <ShieldOff aria-hidden="true" /> Revoke
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {events.length > 0 && (
        <Disclosure>
          <DisclosureTrigger>Token audit trail</DisclosureTrigger>
          <DisclosureContent>
            <ul className="space-y-1 text-sm">
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
      <Dialog open={issuing} onOpenChange={(open) => !pending && setIssuing(open)}>
        <DialogContent>
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
            <div className="space-y-2">
              <Label htmlFor="token-name">Name</Label>
              <Input
                id="token-name"
                value={name}
                aria-invalid={!NAME.test(name)}
                aria-describedby="token-name-help"
                onChange={(event) => setName(event.target.value)}
              />
              <p id="token-name-help" className="text-xs text-muted-foreground">
                Lowercase letters, digits, dot, dash or underscore.
              </p>
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Rights</legend>
              {MACHINE_TOKEN_RIGHTS.map((right) => (
                <label key={right} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={rights.includes(right)}
                    onChange={(event) =>
                      setRights((current) =>
                        event.target.checked
                          ? [...current, right]
                          : current.filter((value) => value !== right),
                      )
                    }
                  />
                  {RIGHT_LABELS[right]}
                </label>
              ))}
              <p className="text-xs text-muted-foreground">
                Evaluate includes workspace read access.
              </p>
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor="token-expiry">Expires after</Label>
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
            </div>
            <div className="space-y-2">
              <Label htmlFor="token-reason">Reason (optional, recorded in the audit trail)</Label>
              <Input
                id="token-reason"
                value={reason}
                maxLength={1024}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
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
        <DialogContent>
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
            <div className="space-y-2">
              <Label htmlFor="revoke-reason">Reason</Label>
              <Input
                id="revoke-reason"
                value={revokeReason}
                maxLength={1024}
                required
                onChange={(event) => setRevokeReason(event.target.value)}
              />
            </div>
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
    </section>
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
