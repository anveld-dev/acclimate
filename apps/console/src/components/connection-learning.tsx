import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { LearningRound } from '@acclimate/sdk';
import { readConnectionLearning, runConnectionLearning } from '../server/integration-actions';
import type { LearningRequest, LearningResult } from '../server/integration-core';
import type { LearningSetup } from '../server/connection-learning-policy';
import { bundleHref } from '../navigation';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { ConsoleLink } from './console-link';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

type Target = Pick<LearningRequest, 'projectId' | 'integrationId'>;
type Mutation = Exclude<LearningRequest, { action: 'read' }>;
const roundLabels: Record<string, string> = {
  proposing: 'Generating proposal',
  development: 'Development evaluation',
  audit: 'Independent audit',
  awaiting_review: 'Awaiting decision',
  promoted: 'Rolled out',
  rejected: 'Rejected',
};

export function ConnectionLearning({
  target,
  bundleId,
  channel,
  currentVersionId,
  currentRevision,
  canManage,
  enabled,
}: {
  target: Target;
  bundleId: string;
  channel: string;
  currentVersionId: string;
  currentRevision: string;
  canManage: boolean;
  enabled: boolean;
}) {
  const { projectId, integrationId } = target;
  const [result, setResult] = useState<LearningResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);
  const [decision, setDecision] = useState<{ roundId: string; approve: boolean }>();
  const decisionTrigger = useRef<HTMLElement | null>(null);
  const stopTrigger = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const status = result?.ok ? result.status : null;
  const editable = canManage && enabled;
  const active = status?.enabled && !status.stoppedAt;
  const proposalLimitReached = status && status.proposalAdmissions >= status.maxProposalAdmissions;

  useEffect(() => {
    let current = true;
    void readConnectionLearning({ data: { projectId, integrationId } })
      .then((next) => {
        if (current) setResult(next);
      })
      .catch(() => {
        if (current) setResult({ ok: false, message: 'Could not read learning status.' });
      });
    return () => {
      current = false;
    };
  }, [projectId, integrationId]);

  async function request(action: () => Promise<LearningResult>) {
    setBusy(true);
    setError('');
    try {
      const next = await action();
      if (next.ok) {
        setResult(next);
        return true;
      }
      setError(next.message);
    } catch {
      setError('The operation could not be confirmed. Refresh learning status.');
    } finally {
      setBusy(false);
    }
    return false;
  }

  function mutate(input: Mutation) {
    return request(() => runConnectionLearning({ data: input }));
  }

  return (
    <section aria-labelledby={titleId} className="workspace-panel space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={titleId} className="font-semibold">
            Continuous learning
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Use reported task outcomes to propose and evaluate changes for this connection.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!result || busy}
          onClick={() => void request(() => readConnectionLearning({ data: target }))}
        >
          Refresh learning status
        </Button>
      </div>
      {!result && (
        <p role="status" className="text-sm">
          Loading learning status…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {result && !result.ok && !error && (
        <p role="alert" className="text-sm">
          {result.message}
        </p>
      )}
      {result?.ok && !status && (
        <>
          <p className="text-sm">Learning is off for this connection.</p>
          {editable && (
            <Disclosure>
              <DisclosureTrigger>Set up continuous learning</DisclosureTrigger>
              <DisclosureContent>
                <EnrollmentForm
                  busy={busy}
                  onSubmit={(setup) => void mutate({ ...target, action: 'enroll', setup })}
                />
              </DisclosureContent>
            </Disclosure>
          )}
        </>
      )}
      {result?.ok && (
        <p className="break-all text-sm">
          <strong>{enabled ? 'Delivery target' : 'Last delivery target'}</strong>{' '}
          <code>{status?.deliveredVersionId ?? currentVersionId}</code>
          {' · revision '}
          {status?.deliveredRevision ?? currentRevision}
        </p>
      )}
      {status && (
        <>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">
              {!status.enabled ? 'Connection revoked' : status.stoppedAt ? 'Stopped' : 'Enrolled'}
            </Badge>
            <Badge variant="outline">
              {status.automaticRollout ? 'Automatic rollout' : 'Manual review'}
            </Badge>
            <Badge variant="outline">
              {status.automaticRollback ? 'Automatic rollback on' : 'Automatic rollback off'}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Post-rollout audits track independently graded jobs served by the current rollout.
            Automatic rollback restores the previous version after three regressions in the latest
            ten eligible verdicts.
          </p>
          <p className="text-sm">
            {status.proposalAdmissions} of {status.maxProposalAdmissions} proposal admissions used ·{' '}
            {status.remainingAudits} of {status.auditCount} audit cohorts available
          </p>
          {active && proposalLimitReached && (
            <p className="text-sm">Proposal admission limit reached.</p>
          )}
          {active && status.remainingAudits === 0 && (
            <p className="text-sm">Independent audit cohorts exhausted.</p>
          )}
          {editable && active && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void mutate({
                    ...target,
                    action: 'rollout',
                    automaticRollout: !status.automaticRollout,
                  })
                }
              >
                {status.automaticRollout ? 'Disable automatic rollout' : 'Enable automatic rollout'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void mutate({
                    ...target,
                    action: 'rollback',
                    automaticRollback: !status.automaticRollback,
                  })
                }
              >
                {status.automaticRollback
                  ? 'Disable automatic rollback'
                  : 'Enable automatic rollback'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={(event) => {
                  stopTrigger.current = event.currentTarget;
                  setConfirmStop(true);
                }}
              >
                Stop learning
              </Button>
            </div>
          )}
          {editable && active && (
            <Disclosure>
              <DisclosureTrigger>Add proposal admissions or audit cohorts</DisclosureTrigger>
              <DisclosureContent>
                <RenewalForm
                  key={status.renewalRevision}
                  busy={busy}
                  revision={status.renewalRevision}
                  onSubmit={(settings) => mutate({ ...target, action: 'renew', ...settings })}
                />
              </DisclosureContent>
            </Disclosure>
          )}
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Learning rounds</h4>
            {status.rounds.length ? (
              <ul className="divide-y divide-border">
                {status.rounds.map((round) => (
                  <li key={round.id} className="py-2">
                    <LearningRound
                      round={round}
                      scope={{ projectId, bundleId, channel }}
                      busy={busy}
                      onDecision={
                        editable && active && round.state === 'awaiting_review'
                          ? (approve, trigger) => {
                              decisionTrigger.current = trigger;
                              setDecision({ roundId: round.id, approve });
                            }
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No rounds recorded.</p>
            )}
          </div>
        </>
      )}
      <Dialog
        open={confirmStop}
        onOpenChange={(open) => {
          if (!busy) setConfirmStop(open);
        }}
      >
        <DialogContent size="decision" returnFocusRef={stopTrigger}>
          <DialogHeader>
            <DialogTitle>Stop continuous learning?</DialogTitle>
            <DialogDescription>
              Stop admitting new learning work and rolling out candidates. The current delivery
              target stays in place.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmStop(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                // Close the dialog so the current result or a refresh error is visible.
                setConfirmStop(false);
                await mutate({ ...target, action: 'stop' });
              }}
            >
              Stop learning
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(decision)}
        onOpenChange={(open) => {
          if (!busy && !open) setDecision(undefined);
        }}
      >
        <DialogContent size="decision" returnFocusRef={decisionTrigger}>
          <DialogHeader>
            <DialogTitle>
              {decision?.approve ? 'Roll out this candidate?' : 'Decline this candidate?'}
            </DialogTitle>
            <DialogDescription>
              {decision?.approve
                ? 'This changes the delivery target for future jobs using this connection.'
                : 'Keep the current delivery target and record this decision for the learning round.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDecision(undefined)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !decision}
              onClick={() => {
                if (!decision) return;
                setDecision(undefined);
                void mutate({ ...target, action: 'review', ...decision });
              }}
            >
              {decision?.approve ? 'Roll out candidate' : 'Decline candidate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function EnrollmentForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit(setup: LearningSetup): void;
}) {
  const prefix = useId();
  const [automaticRollout, setAutomaticRollout] = useState(false);
  const [automaticRollback, setAutomaticRollback] = useState(true);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSubmit({
      installationId: String(form.get('installationId') ?? ''),
      outcomePrincipal: String(form.get('outcomePrincipal') ?? ''),
      evaluatorPrincipal: String(form.get('evaluatorPrincipal') ?? ''),
      permittedPaths: String(form.get('permittedPaths') ?? ''),
      maxProposalAdmissions: String(form.get('maxProposalAdmissions') ?? ''),
      descriptors: String(form.get('descriptors') ?? ''),
      automaticRollout,
      automaticRollback,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3 pt-2">
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          ['installationId', 'Evaluator installation ID', 128],
          ['outcomePrincipal', 'Outcome machine principal ID', 1024],
          ['evaluatorPrincipal', 'Evaluator machine principal ID', 1024],
        ].map(([name, label, max]) => (
          <div key={name} className="space-y-1.5">
            <Label htmlFor={`${prefix}-${name}`}>{label}</Label>
            <Input
              id={`${prefix}-${name}`}
              name={String(name)}
              maxLength={Number(max)}
              required
              disabled={busy}
            />
          </div>
        ))}
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-limit`}>Proposal admission limit</Label>
          <Input
            id={`${prefix}-limit`}
            name="maxProposalAdmissions"
            type="number"
            min={1}
            max={100}
            step={1}
            required
            disabled={busy}
          />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Use distinct machine principal IDs with workspace grants. The outcome principal needs write
        access and the evaluator needs read and write access. Keep their credentials in your app.
      </p>
      <p className="text-sm text-muted-foreground">
        Your app submits terminal task outcomes using this connection ID. Its installed evaluator
        runs the cohorts declared below.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-paths`}>Permitted bundle paths</Label>
        <Textarea
          id={`${prefix}-paths`}
          name="permittedPaths"
          rows={3}
          maxLength={8192}
          required
          disabled={busy}
          aria-describedby={`${prefix}-path-help`}
        />
        <p id={`${prefix}-path-help`} className="text-sm text-muted-foreground">
          Enter one existing bundle path per line.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-descriptors`}>Installed evaluation descriptors</Label>
        <Textarea
          id={`${prefix}-descriptors`}
          name="descriptors"
          rows={6}
          maxLength={1_000_000}
          required
          disabled={busy}
          spellCheck={false}
          aria-describedby={`${prefix}-descriptor-help`}
          className="font-mono text-sm"
        />
        <p id={`${prefix}-descriptor-help`} className="text-sm text-muted-foreground">
          Paste evaluator JSON with a <code>development</code> descriptor and an <code>audits</code>{' '}
          array. Each descriptor declares <code>datasetRevision</code>, <code>graderRevision</code>,{' '}
          <code>runtime</code> and <code>expectedCases</code>.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${prefix}-rollout`}
          checked={automaticRollout}
          onCheckedChange={(checked) => setAutomaticRollout(checked === true)}
          disabled={busy}
        />
        <Label htmlFor={`${prefix}-rollout`}>
          Automatically roll out candidates that pass the independent audit
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${prefix}-rollback`}
          checked={automaticRollback}
          onCheckedChange={(checked) => setAutomaticRollback(checked === true)}
          disabled={busy}
        />
        <Label htmlFor={`${prefix}-rollback`}>
          Automatically restore the previous version after three regressions in the latest ten
          eligible post-rollout verdicts
        </Label>
      </div>
      <Button type="submit" disabled={busy}>
        Enroll connection
      </Button>
    </form>
  );
}

type RenewalSubmission = Pick<
  Extract<Mutation, { action: 'renew' }>,
  'renewalId' | 'expectedRevision' | 'proposalAdmissions' | 'descriptors'
>;

function RenewalForm({
  busy,
  revision,
  onSubmit,
}: {
  busy: boolean;
  revision: number;
  onSubmit(settings: RenewalSubmission): Promise<boolean>;
}) {
  const prefix = useId();
  const pending = useRef<RenewalSubmission | undefined>(undefined);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const proposalAdmissions = String(fields.get('proposalAdmissions') ?? '');
    const descriptors = String(fields.get('descriptors') ?? '');
    if (
      pending.current?.proposalAdmissions !== proposalAdmissions ||
      pending.current.descriptors !== descriptors
    ) {
      pending.current = {
        renewalId: crypto.randomUUID(),
        expectedRevision: revision,
        proposalAdmissions,
        descriptors,
      };
    }
    if (await onSubmit(pending.current)) {
      pending.current = undefined;
      form.reset();
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 pt-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-limit`}>Additional proposal admissions</Label>
        <Input
          id={`${prefix}-limit`}
          name="proposalAdmissions"
          type="number"
          min={0}
          max={100}
          step={1}
          disabled={busy}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-audits`}>Additional independent audit descriptors</Label>
        <Textarea
          id={`${prefix}-audits`}
          name="descriptors"
          rows={4}
          maxLength={1_000_000}
          disabled={busy}
          spellCheck={false}
          aria-describedby={`${prefix}-audits-help`}
          className="font-mono text-sm"
        />
        <p id={`${prefix}-audits-help`} className="text-sm text-muted-foreground">
          Paste a JSON array of fresh audit descriptors from your evaluator. Add new audit cohorts,
          proposal admissions, or both.
        </p>
      </div>
      <Button type="submit" disabled={busy}>
        Save additions
      </Button>
    </form>
  );
}

function LearningRound({
  round,
  scope,
  busy,
  onDecision,
}: {
  round: LearningRound;
  scope: { projectId: string; bundleId: string; channel: string };
  busy: boolean;
  onDecision?(approve: boolean, trigger: HTMLButtonElement): void;
}) {
  const fieldAudits = round.promotionId ? round.fieldAudits : undefined;
  return (
    <Disclosure>
      <DisclosureTrigger className="text-sm">
        {fieldAudits?.rollbackPromotionId
          ? 'Rolled back'
          : (roundLabels[round.state] ?? round.state)}
        {' · outcome '}
        {round.outcomeId.slice(0, 8)}
      </DisclosureTrigger>
      <DisclosureContent className="space-y-2 pt-1 text-sm">
        {round.reason && <p>{round.reason}</p>}
        <dl className="space-y-1 break-all">
          <div>
            <dt className="inline font-medium">Outcome </dt>
            <dd className="inline font-mono">{round.outcomeId}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Baseline version </dt>
            <dd className="inline font-mono">{round.parentVersionId}</dd>
          </div>
          {round.candidateVersionId && (
            <div>
              <dt className="inline font-medium">Candidate version </dt>
              <dd className="inline font-mono">{round.candidateVersionId}</dd>
            </div>
          )}
        </dl>
        {fieldAudits && (
          <div className="space-y-1">
            <p>
              Post-rollout audit window · {fieldAudits.regressions} regressions in{' '}
              {fieldAudits.windowSize} graded jobs
            </p>
            {fieldAudits.rollbackPromotionId && (
              <>
                <p className="break-all">
                  Rollback restored version <code>{round.parentVersionId}</code>.
                </p>
                <p className="break-all">
                  Rollback promotion <code>{fieldAudits.rollbackPromotionId}</code>
                </p>
              </>
            )}
          </div>
        )}
        {round.developmentComparisonId && (
          <ConsoleLink
            className="block underline"
            href={bundleHref(scope, 'changes', {
              candidate: round.candidateVersionId ?? undefined,
              request: round.developmentRequestId ?? undefined,
              comparison: round.developmentComparisonId,
            })}
          >
            View development evidence
          </ConsoleLink>
        )}
        {round.auditComparisonId && (
          <ConsoleLink
            className="block underline"
            href={bundleHref(scope, 'changes', {
              candidate: round.candidateVersionId ?? undefined,
              request: round.auditRequestId ?? undefined,
              comparison: round.auditComparisonId,
            })}
          >
            View audit evidence
          </ConsoleLink>
        )}
        {onDecision && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={(event) => onDecision(true, event.currentTarget)}
            >
              Review rollout
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={(event) => onDecision(false, event.currentTarget)}
            >
              Decline candidate
            </Button>
          </div>
        )}
      </DisclosureContent>
    </Disclosure>
  );
}
