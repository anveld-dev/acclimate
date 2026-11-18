import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { LearningRound } from '@acclimate/sdk';
import { readConnectionLearning, runConnectionLearning } from '../server/integration-actions';
import type {
  BlockingLearningPolicy,
  LearningRequest,
  LearningResult,
} from '../server/integration-core';
import type { LearningSetup } from '../server/connection-learning-policy';
import { bundleHref } from '../navigation';
import { OutcomeLookup, roundLabels } from './outcome-lookup';
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
import {
  RestoreDelivery,
  SelectionPoliciesField,
  SkillPermissionFields,
} from './connection-learning-controls';

type Target = Pick<LearningRequest, 'projectId' | 'integrationId'>;
type Mutation = Exclude<LearningRequest, { action: 'read' }>;
export function ConnectionLearning({
  target,
  bundleId,
  channel,
  connectionName,
  currentVersionId,
  currentRevision,
  canManage,
  enabled,
}: {
  target: Target;
  bundleId: string;
  channel: string;
  connectionName: string;
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
  const [decision, setDecision] = useState<{
    parentVersionId: string;
    roundId: string;
    candidateVersionId: string | null;
    approve: boolean;
    policies?: BlockingLearningPolicy[] | null;
  }>();
  const [overrideReason, setOverrideReason] = useState('');
  const decisionTrigger = useRef<HTMLElement | null>(null);
  const stopTrigger = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const refreshEpoch = useRef(0);
  const sectionRef = useRef<HTMLElement>(null);
  const alignOnLoad = useRef(false);
  const [refreshError, setRefreshError] = useState('');
  const status = result?.ok ? result.status : null;
  const editable = canManage && enabled;
  const active = status?.enabled && !status.stoppedAt;
  const proposalLimitReached = status && status.proposalAdmissions >= status.maxProposalAdmissions;

  useEffect(() => {
    if (window.location.hash !== '#continuous-learning') return;
    alignOnLoad.current = true;
    const cancel = () => {
      alignOnLoad.current = false;
    };
    const listeners = new AbortController();
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'hashchange']) {
      window.addEventListener(event, cancel, { passive: true, signal: listeners.signal });
    }
    return () => listeners.abort();
  }, []);

  const settled = Boolean(result || refreshError);
  useEffect(() => {
    if (!settled || !alignOnLoad.current) return;
    const frame = requestAnimationFrame(() => {
      if (alignOnLoad.current && window.location.hash === '#continuous-learning') {
        sectionRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
        alignOnLoad.current = false;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [settled]);

  useEffect(() => {
    if (busy) return;
    const epoch = ++refreshEpoch.current;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await readConnectionLearning({ data: { projectId, integrationId } });
        if (epoch !== refreshEpoch.current) return;
        setResult(next);
        setRefreshError('');
      } catch {
        if (epoch !== refreshEpoch.current) return;
        setRefreshError('Learning status could not be refreshed. Retrying automatically.');
      }
      timer = setTimeout(refresh, 15000);
    }
    void refresh();
    return () => {
      refreshEpoch.current++;
      clearTimeout(timer);
    };
  }, [projectId, integrationId, busy]);

  async function request(action: () => Promise<LearningResult>) {
    refreshEpoch.current++;
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
    <section
      ref={sectionRef}
      id="continuous-learning"
      aria-labelledby={titleId}
      className="workspace-panel space-y-4 p-4"
    >
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
          disabled={busy}
          onClick={() => void request(() => readConnectionLearning({ data: target }))}
        >
          Refresh learning status
        </Button>
      </div>
      {refreshError && (
        <p role="status" className="text-sm text-destructive">
          {refreshError}
        </p>
      )}
      {!result && !refreshError && (
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
        <Disclosure>
          <DisclosureTrigger>
            {enabled ? 'Delivery target' : 'Last delivery target'} · revision{' '}
            {status?.deliveredRevision ?? currentRevision} ·{' '}
            <code>{(status?.deliveredVersionId ?? currentVersionId).slice(0, 8)}</code>
          </DisclosureTrigger>
          <DisclosureContent className="break-all text-sm">
            Full version ID <code>{status?.deliveredVersionId ?? currentVersionId}</code>
          </DisclosureContent>
        </Disclosure>
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
            Comparisons after release can confirm the improvement or restore an earlier version.
          </p>
          <dl className="learning-capacity">
            <div>
              <dt>Proposal history</dt>
              <dd>{status.rounds.length}</dd>
            </div>
            <div>
              <dt>Proposals used</dt>
              <dd>
                {status.proposalAdmissions} <small>of {status.maxProposalAdmissions}</small>
              </dd>
            </div>
            <div>
              <dt>Independent comparisons available</dt>
              <dd>
                {status.remainingAudits} <small>of {status.auditCount}</small>
              </dd>
            </div>
          </dl>
          {status.noiseCalibration && (
            <p className="text-sm">
              Baseline noise calibration · {status.noiseCalibration.status}
              {status.noiseCalibration.minimumDetectableEffect !== undefined && (
                <>
                  <br />
                  Estimated detectable improvement ·{' '}
                  {status.noiseCalibration.minimumDetectableEffect.toPrecision(3)} metric units at
                  80% power
                </>
              )}
              {status.noiseCalibration.warning && (
                <>
                  <br />
                  {status.noiseCalibration.warning}
                </>
              )}
            </p>
          )}
          {!status.developmentCommitted && (
            <p className="text-sm">
              Automatic release requires saved settings for both comparisons and unused independent
              cases. Update the connection settings.
            </p>
          )}
          {status.policySummary && (
            <p className="text-sm">
              Development policy · {status.policySummary.development}
              <br />
              Independent comparison rules · {status.policySummary.audit}
            </p>
          )}
          {active && proposalLimitReached && <p className="text-sm">Proposal limit reached.</p>}
          {active && status.remainingAudits === 0 && (
            <p className="text-sm">No independent comparisons remain.</p>
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
              <DisclosureTrigger>
                Update limits, comparison cases or release rules
              </DisclosureTrigger>
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
          {editable && active && (
            <Disclosure>
              <DisclosureTrigger>Manage skill package permissions</DisclosureTrigger>
              <DisclosureContent>
                <form
                  className="space-y-3 pt-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void mutate({
                      ...target,
                      action: 'skills',
                      permittedPaths: String(data.get('permittedPaths') ?? ''),
                      createSkillNames: String(data.get('createSkillNames') ?? ''),
                      retireSkillNames: String(data.get('retireSkillNames') ?? ''),
                    });
                  }}
                >
                  <Label htmlFor={`${titleId}-skill-paths`}>Permitted bundle paths</Label>
                  <Textarea
                    key={status.permittedPaths.join('\n')}
                    id={`${titleId}-skill-paths`}
                    name="permittedPaths"
                    required
                    rows={3}
                    maxLength={8192}
                    disabled={busy}
                    defaultValue={status.permittedPaths.join('\n')}
                    aria-describedby={`${titleId}-skill-path-help`}
                  />
                  <p id={`${titleId}-skill-path-help`} className="text-sm text-muted-foreground">
                    Add or remove paths within authorized skill packages, one path per line. Keep
                    the existing paths outside those packages.
                  </p>
                  <SkillPermissionFields
                    key={JSON.stringify(status.skillPackages)}
                    busy={busy}
                    current={status.skillPackages}
                  />
                  <Button type="submit" disabled={busy}>
                    Save skill permissions
                  </Button>
                </form>
              </DisclosureContent>
            </Disclosure>
          )}
          {editable && status.enabled && (
            <RestoreDelivery
              key={status.deliveredRevision}
              busy={busy}
              revision={status.deliveredRevision}
              targets={status.restoreTargets}
              onSubmit={(settings) => mutate({ ...target, action: 'restore', ...settings })}
            />
          )}
          <OutcomeLookup key={integrationId} target={target} />
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Proposal history</h4>
            {status.rounds.length ? (
              <ul className="divide-y divide-border">
                {status.rounds.map((round, index) => (
                  <li key={round.id} className="py-2">
                    <LearningRound
                      latest={index === 0}
                      round={round}
                      scope={{ projectId, bundleId, channel }}
                      busy={busy}
                      onDecision={
                        editable && active && round.state === 'awaiting_review'
                          ? (approve, trigger) => {
                              decisionTrigger.current = trigger;
                              setOverrideReason('');
                              setDecision({
                                parentVersionId: round.parentVersionId,
                                roundId: round.id,
                                candidateVersionId: round.candidateVersionId,
                                approve,
                                policies: round.blockingPolicies,
                              });
                            }
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No proposals started.</p>
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
                : 'Keep the current delivery target and record this decision for the proposal.'}
            </DialogDescription>
          </DialogHeader>
          {decision && (
            <dl className="grid gap-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Connection</dt>
                <dd className="break-words">
                  {connectionName} / {channel}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Baseline version</dt>
                <dd className="break-all font-mono">{decision.parentVersionId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Candidate version</dt>
                <dd className="break-all font-mono">{decision.candidateVersionId}</dd>
              </div>
            </dl>
          )}
          {decision?.approve && decision.policies === null && (
            <p role="status">
              Policy checks could not be loaded. Refresh learning status to review a blocking
              policy.
            </p>
          )}
          {decision?.approve && !!decision.policies?.length && (
            <div className="space-y-2">
              <p>Review the policies blocking rollout of this candidate.</p>
              <ul className="list-disc pl-5">
                {decision.policies.map((policy) => (
                  <li key={policy.comparisonId + policy.policyDigest}>
                    <ConsoleLink
                      className="underline"
                      href={bundleHref({ projectId, bundleId, channel }, 'changes', {
                        history: 1,
                        candidate: decision.candidateVersionId ?? undefined,
                        request: policy.requestId,
                        comparison: policy.comparisonId,
                      })}
                    >
                      {policy.policyId} · {policy.revision} · {policy.verdict}
                    </ConsoleLink>
                  </li>
                ))}
              </ul>
              <Label htmlFor={titleId + '-override'}>Reason for overriding these policies</Label>
              <Input
                id={titleId + '-override'}
                value={overrideReason}
                maxLength={1024}
                onChange={(e) => setOverrideReason(e.target.value)}
              />
              <p>The release records your reason and the policy checks you reviewed.</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDecision(undefined)}>
              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                !decision ||
                (decision.approve && !!decision.policies?.length && !overrideReason.trim())
              }
              onClick={() => {
                if (!decision) return;
                setDecision(undefined);
                void mutate({
                  ...target,
                  action: 'review',
                  roundId: decision.roundId,
                  approve: decision.approve,
                  ...(decision.approve && decision.policies?.length
                    ? {
                        policyOverride: {
                          reason: overrideReason.trim(),
                          receipts: decision.policies.map(({ comparisonId, policyDigest }) => ({
                            comparisonId,
                            policyDigest,
                          })),
                        },
                      }
                    : {}),
                });
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
      selectionPolicies: String(form.get('selectionPolicies') ?? ''),
      createSkillNames: String(form.get('createSkillNames') ?? ''),
      retireSkillNames: String(form.get('retireSkillNames') ?? ''),
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
          <Label htmlFor={`${prefix}-limit`}>Proposal limit</Label>
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
        uses the comparison cases you configure below.
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
          Enter one bundle path per line. A future path may belong to a skill package this learner
          can create.
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
          array. Generate descriptors with <code>connectedEvaluationDescriptor(app)</code> to bind
          the installed inputs, expected answers and repetitions.
        </p>
      </div>
      <Disclosure>
        <DisclosureTrigger>Configure selection policies and skill packages</DisclosureTrigger>
        <DisclosureContent className="space-y-3 pt-2">
          <SelectionPoliciesField busy={busy} />
          <SkillPermissionFields busy={busy} />
        </DisclosureContent>
      </Disclosure>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${prefix}-rollout`}
          checked={automaticRollout}
          onCheckedChange={(checked) => setAutomaticRollout(checked === true)}
          disabled={busy}
        />
        <Label htmlFor={`${prefix}-rollout`}>
          Automatically release versions that pass the independent comparison
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
          Automatically restore the comparison version after three regressions in the latest ten
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
  | 'renewalId'
  | 'expectedRevision'
  | 'proposalAdmissions'
  | 'descriptors'
  | 'development'
  | 'selectionPolicies'
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
    const development = String(fields.get('development') ?? '');
    const selectionPolicies = String(fields.get('selectionPolicies') ?? '');
    if (
      pending.current?.proposalAdmissions !== proposalAdmissions ||
      pending.current.descriptors !== descriptors ||
      pending.current.development !== development ||
      pending.current.selectionPolicies !== selectionPolicies
    ) {
      pending.current = {
        renewalId: crypto.randomUUID(),
        expectedRevision: revision,
        proposalAdmissions,
        descriptors,
        development,
        selectionPolicies,
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
        <Label htmlFor={`${prefix}-limit`}>Additional proposals</Label>
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
        <Label htmlFor={`${prefix}-audits`}>Additional settings for independent comparisons</Label>
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
          Paste a JSON array of fresh descriptors generated by{' '}
          <code>connectedEvaluationDescriptor(app)</code>.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-development`}>
          Replacement development descriptor (optional)
        </Label>
        <Textarea
          id={`${prefix}-development`}
          name="development"
          rows={3}
          maxLength={1_000_000}
          disabled={busy}
          spellCheck={false}
          className="font-mono text-sm"
        />
      </div>
      <SelectionPoliciesField busy={busy} />
      <p className="text-sm text-muted-foreground">
        Install replacement evaluators before saving. Development and policy changes take effect
        between proposals.
      </p>
      <Button type="submit" disabled={busy}>
        Save connection settings
      </Button>
    </form>
  );
}

function LearningRound({
  round,
  latest,
  scope,
  busy,
  onDecision,
}: {
  round: LearningRound;
  latest: boolean;
  scope: { projectId: string; bundleId: string; channel: string };
  busy: boolean;
  onDecision?(approve: boolean, trigger: HTMLButtonElement): void;
}) {
  const fieldAudits = round.promotionId ? round.fieldAudits : undefined;
  return (
    <Disclosure defaultOpen={latest} className="learning-round">
      <DisclosureTrigger className="text-sm">
        {latest && <span className="learning-round-latest">Latest proposal · </span>}
        {fieldAudits?.rollbackPromotionId
          ? 'Rolled back'
          : (roundLabels[round.state] ?? round.state)}
        {' · outcome '}
        {round.outcomeId.slice(0, 8)}
      </DisclosureTrigger>
      <DisclosureContent className="space-y-2 pt-1 text-sm">
        {round.reason && <p>{round.reason}</p>}
        {round.incidentReplay && (
          <p>
            Original issue check ·{' '}
            {round.state === 'rejected' && round.incidentReplay === 'pending'
              ? 'No verdict received'
              : round.incidentReplay}
          </p>
        )}
        {round.correctionId && (
          <p className="break-all">
            Correction <code>{round.correctionId}</code>
            {round.attempt !== undefined && <> · attempt {round.attempt}</>}
          </p>
        )}
        {round.policyEpoch !== undefined && <p>Policy revision {round.policyEpoch}</p>}
        <div className="learning-round-links">
          {(
            [
              ['development', round.developmentRequestId, round.developmentComparisonId],
              ['independent', round.auditRequestId, round.auditComparisonId],
            ] as const
          ).map(
            ([phase, request, comparison]) =>
              (request || comparison) && (
                <ConsoleLink
                  key={phase}
                  href={bundleHref(scope, 'changes', {
                    candidate: round.candidateVersionId ?? undefined,
                    request: request ?? undefined,
                    comparison: comparison ?? undefined,
                  })}
                >
                  {comparison ? `View ${phase} comparison` : `Watch ${phase} comparison`}
                </ConsoleLink>
              ),
          )}
        </div>
        {fieldAudits && (
          <div className="space-y-1">
            <p>
              Comparison after release · {fieldAudits.regressions}{' '}
              {fieldAudits.regressions === 1 ? 'regression' : 'regressions'} in{' '}
              {fieldAudits.windowSize} graded {fieldAudits.windowSize === 1 ? 'job' : 'jobs'}
            </p>
            {fieldAudits.rollbackPromotionId && (
              <>
                <p className="break-all">
                  Rollback release <code>{fieldAudits.rollbackPromotionId}</code>
                </p>
              </>
            )}
          </div>
        )}
        <Disclosure>
          <DisclosureTrigger>Version and outcome IDs</DisclosureTrigger>
          <DisclosureContent>
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
          </DisclosureContent>
        </Disclosure>
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
