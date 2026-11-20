import { useEffect, useState } from 'react';
import type { BundlePayload, Comparison } from '@acclimate/sdk';
import { bundleHref } from '../navigation';
import type { ConsoleState } from '../server/channel';
import { runDraftCommand } from '../server/content-actions';
import { runImprovement } from '../server/improvement-actions';
import { ChangesOverview } from './changes-overview';
import { ConsoleLink } from './console-link';
import { ContentDiff } from './diff-content';
import { EvaluationCaseWorkbench } from './evaluation-case-workbench';
import { EvaluationOutcomeStrip, EvaluationScorecard } from './evaluation-scorecard';
import { PolicyReceiptList, usePolicyReceipts } from './evaluation-policy-receipts';
import { RunProvenance } from './evaluation-history-view';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';

type Details = {
  candidate?: string;
  comparison?: Comparison;
  files?: { base: BundlePayload; current: BundlePayload };
  description?: string;
};

export function ImprovementWorkspace({
  state,
  search,
}: {
  state: Extract<ConsoleState, { status: 'ready' }>;
  search: Record<string, unknown>;
}) {
  const [details, setDetails] = useState<Details>();
  const [error, setError] = useState('');
  const { workspaceId, bundleId, channel } = state;
  const { comparison, draft, proposal, candidate, request } = search;
  useEffect(() => {
    const scope = { workspaceId, bundleId, channel };
    let active = true;
    async function read(): Promise<Details> {
      if (typeof comparison === 'string') {
        const result = await runImprovement({
          data: { scope, action: 'comparison', id: comparison },
        });
        if (!result.ok || result.comparison?.id !== comparison)
          throw Error('Comparison unavailable.');
        const report = result.comparison;
        if (
          (candidate && candidate !== report.candidateVersionId) ||
          (request && request !== report.evaluation?.requestId)
        )
          throw Error('The comparison does not match the selected version or evaluation.');
        return { comparison: report, candidate: report.candidateVersionId };
      }
      if (typeof draft === 'string') {
        const result = await runDraftCommand({ data: { scope, action: 'open', id: draft } });
        if (!result.ok || !result.base || !result.payload) throw Error('Saved draft unavailable.');
        return {
          files: { base: result.base, current: result.payload },
          description: 'Saved draft',
        };
      }
      const result = await runImprovement({ data: { scope, action: 'proposal', id: proposal } });
      if (!result.ok || !result.proposal) throw Error('Proposal unavailable.');
      return {
        description: result.proposal.error || result.proposal.rationale || result.proposal.status,
        candidate: result.proposal.candidate?.id,
      };
    }
    void read()
      .then((value) => {
        if (active) setDetails(value);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : 'Could not read this change.');
      });
    return () => {
      active = false;
    };
  }, [workspaceId, bundleId, channel, comparison, draft, proposal, candidate, request]);
  const scope = { workspaceId, bundleId, channel };
  const policy = usePolicyReceipts(
    scope,
    state.actorScope,
    state.serviceIdentity,
    details?.comparison?.candidateVersionId ?? '',
    details?.comparison?.id,
  );
  if (error) return <p role="alert">{error}</p>;
  if (!details) return <p role="status">Loading change…</p>;
  return (
    <div className="min-h-0 min-w-0 space-y-4 overflow-auto">
      {details.description && <p>{details.description}</p>}
      {details.comparison && (
        <>
          <EvaluationOutcomeStrip comparison={details.comparison} />
          <Disclosure>
            <DisclosureTrigger>Run details</DisclosureTrigger>
            <DisclosureContent>
              <RunProvenance
                request={{
                  ...details.comparison,
                  id: details.comparison.evaluation?.requestId,
                  attemptId: details.comparison.evaluation?.attemptId,
                }}
                comparison={details.comparison}
              />
              <EvaluationScorecard comparison={details.comparison} />
              {policy.failed && <p role="status">Could not load the policy checks.</p>}
              {!!policy.receipts?.comparison.length && (
                <section aria-label="Application policy checks">
                  <h3>Application policy checks</h3>
                  <PolicyReceiptList receipts={policy.receipts.comparison} />
                </section>
              )}
            </DisclosureContent>
          </Disclosure>
          <EvaluationCaseWorkbench
            comparison={details.comparison}
            linkedPair={typeof search.pair === 'string' ? search.pair : undefined}
            reviewHref={bundleHref(scope, 'changes', {
              comparison: details.comparison.id,
              candidate: details.candidate,
            })}
          />
        </>
      )}
      {details.files && <ContentDiff {...details.files} />}
      {details.candidate && !details.comparison && (
        <ChangesOverview
          state={state}
          search={{ ...search, candidate: details.candidate, comparison: undefined }}
        />
      )}
      <ConsoleLink href={bundleHref(scope, 'changes')}>All evaluations</ConsoleLink>
    </div>
  );
}
