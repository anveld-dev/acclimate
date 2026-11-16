import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { useId, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { AccessState, AccessResult } from '../server/access-core';
import { runAccessCommand } from '../server/access-actions';
import {
  adoptionIdentityMatches,
  adoptionOutcome,
  reviewWorkspaceAdoption,
  type AdoptionReview,
} from '../lib/workspace-adoption';
import { workspaceHref } from '../navigation';
import { ConsoleLink } from './console-link';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

type Adoption = NonNullable<Extract<AccessResult, { ok: true }>['adoption']>;
export function WorkspaceAdopt({
  access,
  onPendingChange,
}: {
  access: AccessState;
  onPendingChange?: (pending: boolean) => void;
}) {
  const titleId = useId();
  const [projectId, setProjectId] = useState('');
  const [reason, setReason] = useState('');
  const [review, setReview] = useState<AdoptionReview>();
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [adoption, setAdoption] = useState<Adoption>();
  if (!access.ok || !access.canCreateWorkspace) return null;
  const identity = access.identity;
  const currentReview = review && adoptionIdentityMatches(review, identity) ? review : undefined;
  function edit() {
    setReview(undefined);
    setConfirmed(false);
    setAdoption(undefined);
    setMessage('');
  }
  async function adopt() {
    if (!currentReview || !confirmed || pending || adoption) return;
    setPending(true);
    onPendingChange?.(true);
    setMessage('');
    try {
      const result = await runAccessCommand({
        data: {
          kind: 'adoptWorkspace',
          projectId: currentReview.projectId,
          reason: currentReview.reason,
          confirmedIdentity: currentReview.identity,
        },
      });
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      if (result.adoption) {
        setAdoption(result.adoption);
      }
    } catch {
      setMessage(
        'Could not confirm adoption. Retry this exact workspace to inspect its original adoption record; retrying never restores removed access.',
      );
    } finally {
      setPending(false);
      onPendingChange?.(false);
    }
  }
  return (
    <Disclosure className="workspace-adoption group rounded-lg border">
      <DisclosureTrigger className="w-full rounded-lg p-4 text-sm [&>span]:flex [&>span]:items-center [&>span]:gap-3">
        <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">Adopt an existing workspace</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Operator tools · for workspaces without members
          </span>
        </span>
      </DisclosureTrigger>
      <DisclosureContent>
        <section className="space-y-5 border-t p-4" aria-labelledby={titleId}>
          <div className="space-y-2">
            <h3 id={titleId} className="font-semibold">
              Claim a workspace without members
            </h3>
            <p className="text-sm text-muted-foreground">
              Operators may claim a workspace with no members. This gives your verified identity its
              initial administrator membership and permanently records the reason. It does not grant
              access to other workspaces.
            </p>
          </div>
          <div className="grid max-w-lg gap-3">
            <Label htmlFor="adoption-workspace-id">Workspace ID to adopt</Label>
            <Input
              id="adoption-workspace-id"
              value={projectId}
              disabled={pending}
              onChange={(event) => {
                edit();
                setProjectId(event.target.value);
              }}
            />
            <Label htmlFor="adoption-reason">Reason for adoption</Label>
            <Textarea
              id="adoption-reason"
              value={reason}
              maxLength={2000}
              disabled={pending}
              onChange={(event) => {
                edit();
                setReason(event.target.value);
              }}
            />
            <Button
              variant="outline"
              disabled={pending || !reviewWorkspaceAdoption(projectId, reason, identity)}
              onClick={() => {
                setReview(reviewWorkspaceAdoption(projectId, reason, identity) ?? undefined);
                setConfirmed(false);
                setAdoption(undefined);
                setMessage('');
              }}
            >
              Review adoption
            </Button>
          </div>
          {currentReview && (
            <div className="space-y-4 rounded-lg border p-4">
              <h3 className="font-semibold">Review workspace adoption</h3>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Workspace ID</dt>
                  <dd className="break-all font-mono">{currentReview.projectId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Reason</dt>
                  <dd className="whitespace-pre-wrap break-words">{currentReview.reason}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Your user ID</dt>
                  <dd className="break-all font-mono">{currentReview.identity.userId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Issuer</dt>
                  <dd className="break-all">{currentReview.identity.issuer}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Subject</dt>
                  <dd className="break-all">{currentReview.identity.subject}</dd>
                </div>
              </dl>
              <p className="text-sm text-muted-foreground">
                Only a workspace without members can be adopted. Repeating an earlier adoption
                returns its immutable history and never restores removed membership or a former
                role.
              </p>
              <Label className="flex items-center gap-2">
                <Checkbox
                  checked={confirmed}
                  disabled={pending || Boolean(adoption)}
                  onCheckedChange={(value) => setConfirmed(value === true)}
                />
                I confirm this workspace and my verified identity.
              </Label>
              <Button
                disabled={pending || !confirmed || Boolean(adoption)}
                onClick={() => void adopt()}
              >
                {pending ? 'Adopting…' : 'Adopt workspace'}
              </Button>
            </div>
          )}
          {adoption && (
            <div className="space-y-3" role="status">
              <p>{adoptionOutcome(adoption)}</p>
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">Recorded reason</dt>
                  <dd className="whitespace-pre-wrap break-words">{adoption.reason}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Recorded at</dt>
                  <dd>{adoption.createdAt}</dd>
                </div>
              </dl>
              {adoption.currentRole && (
                <Button asChild variant="outline">
                  <ConsoleLink href={workspaceHref(adoption.projectId)}>Open workspace</ConsoleLink>
                </Button>
              )}
            </div>
          )}
          {message && <p role="alert">{message}</p>}
        </section>
      </DisclosureContent>
    </Disclosure>
  );
}
