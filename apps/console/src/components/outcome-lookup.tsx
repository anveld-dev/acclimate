import { useId, useState, type FormEvent } from 'react';
import { readLearningOutcome } from '../server/integration-actions';
import type { OutcomeLookupResult } from '../server/integration-core';
import type { LearningOutcomeStatus, LearningReleaseEvidence } from '@acclimate/sdk';
import { bundleHref } from '../navigation';
import type { BundleScope } from '../server/selection';
import { ConsoleLink } from './console-link';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';

export const roundLabels: Record<string, string> = {
  proposing: 'Generating proposal',
  development: 'Comparing versions',
  audit: 'Independent comparison',
  awaiting_review: 'Awaiting decision',
  promoted: 'Released',
  rejected: 'Rejected',
};

const correctionLabels: Record<string, string> = {
  ...roundLabels,
  queued: 'Queued for a proposal',
  awaiting_baseline_recheck: 'Checking the issue on the current version',
  private_evidence_unavailable: 'The app could not check the issue on the current version',
  admission_closed: 'This connection is closed to new proposals',
  admissions_exhausted: 'Proposal limit reached. Update the limit to continue.',
  audits_exhausted: 'No independent comparisons remain. Add more cases to continue.',
  resolved: 'The issue is resolved on the current version',
};

export function OutcomeLookup({
  target,
}: {
  target: { projectId: string; integrationId: string };
}) {
  const field = useId();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OutcomeLookupResult>();
  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const outcomeId = String(new FormData(event.currentTarget).get('outcomeId') ?? '').trim();
    setBusy(true);
    setResult(undefined);
    try {
      setResult(await readLearningOutcome({ data: { ...target, outcomeId } }));
    } catch {
      setResult({ ok: false, message: 'Could not read the outcome. Try again.' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Disclosure>
      <DisclosureTrigger>Find a reported outcome</DisclosureTrigger>
      <DisclosureContent className="space-y-2">
        <form onSubmit={lookup} className="space-y-2">
          <Label htmlFor={field}>Application outcome ID</Label>
          <Input
            id={field}
            name="outcomeId"
            required
            maxLength={36}
            disabled={busy}
            onChange={() => setResult(undefined)}
          />
          <Button size="sm" type="submit" disabled={busy}>
            Look up outcome
          </Button>
        </form>
        <div aria-live="polite">
          {busy && <p>Looking up outcome…</p>}
          {result && !result.ok && <p>{result.message}</p>}
          {result?.ok && <OutcomeDetails outcome={result.outcome} projectId={target.projectId} />}
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}

function ReleaseDetails({ release }: { release: LearningReleaseEvidence }) {
  return (
    <div>
      <div>
        Release <code>{release.promotionId}</code> · revision {release.revision}
        {release.withdrawn && ' · withdrawn'}
      </div>
      {release.rollback && (
        <div>
          Automatic rollback restored <code>{release.rollback.versionId}</code>
          {' · revision '}
          {release.rollback.revision} · release <code>{release.rollback.promotionId}</code>
        </div>
      )}
    </div>
  );
}

function EvidenceLinks({
  scope,
  version,
  development,
  audit,
}: {
  scope: BundleScope;
  version: string;
  development?: string | null;
  audit?: string | null;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {[
        [development, 'Development evidence'],
        [audit, 'Independent comparison'],
      ].map(
        ([request, label]) =>
          request && (
            <ConsoleLink
              key={request}
              className="underline"
              href={bundleHref(scope, 'changes', { history: 1, candidate: version, request })}
            >
              {label}
            </ConsoleLink>
          ),
      )}
    </div>
  );
}

function OutcomeDetails({
  outcome,
  projectId,
}: {
  outcome: LearningOutcomeStatus;
  projectId: string;
}) {
  const scope =
    outcome.bundleId && outcome.channel
      ? { projectId, bundleId: outcome.bundleId, channel: outcome.channel }
      : null;
  return (
    <div className="space-y-2 break-all">
      <p>
        Job {outcome.status} · served version <code>{outcome.versionId}</code>
        {outcome.deliveryRevision && <> · revision {outcome.deliveryRevision}</>}
      </p>
      {outcome.servedRelease && (
        <>
          <ReleaseDetails release={outcome.servedRelease} />
          {scope && (
            <EvidenceLinks
              scope={scope}
              version={outcome.versionId}
              development={outcome.servedRelease.developmentRequestId}
              audit={outcome.servedRelease.auditRequestId}
            />
          )}
        </>
      )}
      {outcome.fieldAudit && (
        <p>
          Outcome comparison · {outcome.fieldAudit.verdict} against control{' '}
          <code>{outcome.fieldAudit.controlVersionId}</code>
          {outcome.fieldAudit.triggeredRollback && ' · this verdict triggered automatic rollback'}
        </p>
      )}
      {outcome.currentDelivery && (
        <p>
          Current version <code>{outcome.currentDelivery.versionId}</code> · revision{' '}
          {outcome.currentDelivery.revision}
        </p>
      )}
      {outcome.corrections.length ? (
        <ul>
          {outcome.corrections.map((c) => (
            <li key={c.correctionId} className="break-all py-1">
              Correction <code>{c.correctionId}</code> ·{' '}
              {c.release?.withdrawn
                ? 'Released, later withdrawn'
                : (correctionLabels[c.state] ?? c.state)}
              {c.roundId && (
                <div>
                  Latest proposal activity <code>{c.roundId}</code>
                </div>
              )}
              {c.reason && <div>{c.reason}</div>}
              {c.incidentReplay && (
                <div>
                  Original issue check ·{' '}
                  {c.state === 'rejected' && c.incidentReplay === 'pending'
                    ? 'No verdict received'
                    : c.incidentReplay}
                </div>
              )}
              {c.candidateVersionId && (
                <div>
                  Candidate <code>{c.candidateVersionId}</code>
                </div>
              )}
              {c.release && <ReleaseDetails release={c.release} />}
              {scope && c.candidateVersionId && (
                <EvidenceLinks
                  scope={scope}
                  version={c.candidateVersionId}
                  development={c.developmentRequestId}
                  audit={c.auditRequestId}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        !outcome.fieldAudit && <p>No reviewed correction has been submitted for this job.</p>
      )}
      {scope && (
        <ConsoleLink className="underline" href={bundleHref(scope, 'changes', { history: 1 })}>
          View evaluation history
        </ConsoleLink>
      )}
    </div>
  );
}
