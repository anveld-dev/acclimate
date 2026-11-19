import { useEffect, useRef, useState } from 'react';
import { Download, KeyRound, RotateCw, ShieldOff } from 'lucide-react';
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
import {
  MACHINE_TOKEN_RIGHTS,
  evaluatorConfig,
  validJournalRoot,
  type MachineTokenRight,
} from '../lib/evaluator-config';

const RIGHT_LABELS: Record<MachineTokenRight, string> = {
  evaluate: 'Evaluate (recommended for CI)',
  read: 'Read content',
  write: 'Write content',
  propose: 'Request service proposals',
  promote: 'Promote releases',
};
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
type Issued = { secret: string; token: MachineToken };

/** Workspace admins issue, rotate and revoke evaluator tokens without a service restart. */
export function WorkspaceEvaluatorTokens({ projectId }: { projectId: string }) {
  const [tokens, setTokens] = useState<MachineToken[]>();
  const [events, setEvents] = useState<MachineTokenEvent[]>([]);
  const [publicApiUrl, setPublicApiUrl] = useState('');
  const [hidden, setHidden] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [name, setName] = useState('ci-evaluator');
  const [rights, setRights] = useState<MachineTokenRight[]>(['evaluate']);
  const [days, setDays] = useState('90');
  const [reason, setReason] = useState('');
  const [issued, setIssued] = useState<Issued>();
  const [revoking, setRevoking] = useState<MachineToken>();
  const [revokeReason, setRevokeReason] = useState('');
  const scope = useRef(projectId);
  scope.current = projectId;

  async function refresh(target = projectId) {
    const value = await runMachineTokenCommand({ data: { kind: 'list', projectId: target } });
    if (target !== scope.current) return;
    if (!value.ok) {
      if (value.denied) setHidden(true);
      else setMessage(value.message);
      return;
    }
    setTokens(value.items ?? []);
    setEvents(value.events ?? []);
    setPublicApiUrl(value.publicApiUrl ?? '');
  }

  useEffect(() => {
    setTokens(undefined);
    setHidden(false);
    setIssued(undefined);
    setMessage('');
    void refresh(projectId).catch(() => {
      if (scope.current === projectId) setMessage('Could not load evaluator tokens.');
    });
    // refresh reads the current project from its argument.
  }, [projectId]);

  async function run(command: MachineTokenCommand) {
    if (pending) return;
    setPending(true);
    setMessage('');
    try {
      const result = await runMachineTokenCommand({ data: command });
      if (command.projectId !== scope.current) return;
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
      await refresh(command.projectId);
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
      aria-labelledby="evaluator-tokens-heading"
      className="workspace-panel evaluator-tokens space-y-4 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="evaluator-tokens-heading" className="flex items-center gap-2 font-medium">
            <KeyRound aria-hidden="true" className="size-4" /> Evaluator tokens
          </h2>
          <p className="text-sm text-muted-foreground">
            Machine credentials for evaluators and CI. Issue, rotate or revoke them here without
            restarting the service. Each secret is shown once.
          </p>
        </div>
        <Button
          disabled={pending}
          onClick={() => {
            setName('ci-evaluator');
            setRights(['evaluate']);
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
      {issued && (
        <IssuedSecret
          issued={issued}
          projectId={projectId}
          publicApiUrl={publicApiUrl}
          onDone={() => setIssued(undefined)}
        />
      )}
      {!tokens ? (
        <p role="status">Loading evaluator tokens…</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No evaluator tokens yet. Issue one with the Evaluate right to run comparisons from CI.
        </p>
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
                            projectId,
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
                projectId,
                name,
                rights,
                expiresInDays: Number(days),
                reason: reason || undefined,
              });
            }}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>Issue evaluator token</DialogTitle>
              <DialogDescription>
                The token acts as <code>machine:{NAME.test(name) ? name : '…'}</code>. Rotating it
                later keeps that principal, so running evaluations continue.
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
                Evaluate reads the workspace and runs evaluations. It never publishes, promotes or
                changes channels.
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
                void run({ kind: 'revoke', projectId, id: revoking.id, reason: revokeReason });
            }}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>Revoke {revoking?.name}</DialogTitle>
              <DialogDescription>
                Its next request is refused. Evaluations it started stay owned by{' '}
                <code>{revoking?.principalId}</code>; finish them with a rotated token or abandon
                them.
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
function IssuedSecret({
  issued,
  projectId,
  publicApiUrl,
  onDone,
}: {
  issued: Issued;
  projectId: string;
  publicApiUrl: string;
  onDone: () => void;
}) {
  const [journalRoot, setJournalRoot] = useState('');
  const [embed, setEmbed] = useState(true);
  const ready = Boolean(publicApiUrl) && validJournalRoot(journalRoot);
  function download() {
    const content = evaluatorConfig({
      publicApiUrl,
      projectId,
      principalId: issued.token.principalId,
      journalRoot,
      token: embed ? issued.secret : undefined,
    });
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'evaluator.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return (
    <div role="region" aria-label="New token secret" className="space-y-3 rounded-lg border p-4">
      <p className="text-sm font-medium">
        Copy the secret for <code>{issued.token.name}</code> now. It is not shown again.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="break-all rounded bg-muted px-2 py-1 text-xs">{issued.secret}</code>
        <CopyButton value={issued.secret} label="Copy secret" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="journal-root">Journal directory on the evaluator machine</Label>
        <Input
          id="journal-root"
          placeholder="/home/you/.acclimate/journal"
          value={journalRoot}
          aria-invalid={Boolean(journalRoot) && !validJournalRoot(journalRoot)}
          onChange={(event) => setJournalRoot(event.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={embed}
            onChange={(event) => setEmbed(event.target.checked)}
          />
          Include the token in the file (otherwise set <code>ACCLIMATE_EVALUATOR_TOKEN</code> or{' '}
          <code>evaluatorTokenFile</code>)
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Save evaluator.json with mode 0600 in a directory only you can read (0700), for example{' '}
        <code>chmod 700 ~/.acclimate &amp;&amp; chmod 600 ~/.acclimate/evaluator.json</code>.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!ready} onClick={download}>
          <Download aria-hidden="true" /> Download evaluator.json
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
