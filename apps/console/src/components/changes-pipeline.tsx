import type { ReactNode } from 'react';
import type { Draft, Evaluation, Proposal } from '@acclimate/sdk';
import type { ConsoleState } from '../server/channel';
import type { EvaluationHistoryModel } from '../lib/changes-workspace';
import { bundleHref } from '../navigation';
import { evaluationScoreSummary } from '../lib/evaluation-score-summary';
import { evaluationPairs, formatReward, pairCounts } from '../lib/evaluation-pairs';
import { ConsoleLink } from './console-link';
import { ChangeRecordDetails } from './change-record-details';
import { ReceiptTime } from './receipt-time';
import { StatusBadge } from './status-badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { ArrowRight, ListFilter } from 'lucide-react';

type Ready = Extract<ConsoleState, { status: 'ready' }>;

type Candidate = {
  id: string;
  kind: 'draft' | 'suggestion' | 'candidate';
  title: string;
  candidate?: string | null;
  stale?: boolean;
  generation?: number;
  status?: string;
  href: string;
  details?: ReactNode;
  request?: Evaluation;
};

export function ChangesPipeline({
  state,
  model,
  drafts,
  proposals,
  includeClosed,
  onIncludeClosed,
  loading,
  errors,
  moreDrafts,
  moreSuggestions,
}: {
  state: Ready;
  model: EvaluationHistoryModel;
  drafts: Draft[];
  proposals: Proposal[];
  includeClosed: boolean;
  onIncludeClosed: () => void;
  loading: boolean;
  errors: (string | null)[];
  moreDrafts: ReactNode;
  moreSuggestions: ReactNode;
}) {
  const { resolution } = state;
  const released = state.history.items.slice(0, 3);
  const releasedVersions = new Set(state.history.items.map((release) => release.version.id));
  const scope = { projectId: state.projectId, bundleId: state.bundleId, channel: state.channel };
  const historyHref = bundleHref(scope, 'changes', { history: 1 });
  const releasesHref = bundleHref(scope, 'releases');
  const drafting: Candidate[] = [];
  const evaluating: Candidate[] = [];
  const ready: Candidate[] = [];
  const knownVersions = new Set(drafts.map((draft) => draft.snapshotVersion.id));
  const candidateRequests = new Map<string, { active?: Evaluation; compared?: Evaluation }>();
  for (const request of model.requests) {
    const row = candidateRequests.get(request.candidateVersionId) ?? {};
    if (!row.active && (request.status === 'requested' || request.status === 'running'))
      row.active = request;
    if (!row.compared && request.status === 'completed' && request.comparisonId)
      row.compared = request;
    candidateRequests.set(request.candidateVersionId, row);
  }
  function place(item: Candidate, closed = false) {
    if (item.candidate) knownVersions.add(item.candidate);
    const runs =
      item.candidate && !releasedVersions.has(item.candidate)
        ? candidateRequests.get(item.candidate)
        : undefined;
    if (closed || !runs) drafting.push(item);
    else if (runs.compared) ready.push({ ...item, request: runs.compared });
    else if (runs.active) evaluating.push({ ...item, request: runs.active });
    else drafting.push(item);
  }
  for (const draft of drafts) {
    if (!includeClosed && draft.status !== 'open') continue;
    place(
      {
        id: draft.id,
        kind: 'draft',
        candidate: draft.snapshotVersion.id,
        title: 'Draft ' + draft.id.slice(0, 8),
        generation: draft.generation,
        status: draft.status,
        stale: draft.status === 'open' && draft.baseRevision !== resolution.revision,
        href: bundleHref(scope, 'changes', { draft: draft.id }),
        details: (
          <ChangeRecordDetails
            title="Draft details"
            identity={draft.id}
            triggerLabel={`Draft details for ${draft.id}`}
            description="The saved snapshot and the release it started from."
            copyLabel="Copy draft details"
            value={JSON.stringify(draft, null, 2)}
            fields={[
              ['Status', draft.status],
              ['Generation', draft.generation],
              ['Updated', <ReceiptTime value={draft.updatedAt} />],
              ['Base revision', draft.baseRevision],
              ['Draft ID', draft.id],
              ['Base version', draft.baseVersionId],
              ['Snapshot version', draft.snapshotVersion.id],
            ]}
          />
        ),
      },
      draft.status !== 'open',
    );
  }
  for (const proposal of proposals) {
    place({
      id: proposal.id,
      kind: 'suggestion',
      candidate: proposal.candidate?.id,
      title: proposal.rationale?.trim().split('\n')[0] || 'Suggestion ' + proposal.id.slice(0, 8),
      stale: proposal.parentVersionId !== resolution.version.id,
      status:
        proposal.status === 'succeeded'
          ? proposal.candidate
            ? 'Suggested'
            : 'No candidate'
          : proposal.status,
      href: bundleHref(scope, 'changes', { proposal: proposal.id }),
      details: (
        <ChangeRecordDetails
          title="Suggestion details"
          identity={proposal.id}
          triggerLabel={`Suggestion details for ${proposal.id}`}
          description="The provider’s explanation and the version it started from."
          copyLabel="Copy suggestion details"
          value={JSON.stringify(proposal, null, 2)}
          fields={[
            ['Status', proposal.status],
            ['Created', <ReceiptTime value={proposal.createdAt} />],
            ['Rationale', proposal.rationale || 'No rationale reported.'],
            ['Attempts', proposal.attempts],
            ['Suggestion ID', proposal.id],
            ['Parent version', proposal.parentVersionId],
            ...(proposal.candidate ? [['Candidate version', proposal.candidate.id] as const] : []),
            ...(proposal.error ? [['Error', proposal.error] as const] : []),
          ].map(([label, value]): [string, ReactNode] => [String(label), value])}
        />
      ),
    });
  }
  for (const [candidate, runs] of candidateRequests) {
    const request = runs.compared ?? runs.active;
    if (!request || knownVersions.has(candidate) || releasedVersions.has(candidate)) continue;
    place({
      id: candidate,
      kind: 'candidate',
      candidate,
      title: 'Candidate ' + candidate.slice(0, 8),
      stale: request.parentVersionId !== resolution.version.id,
      href: bundleHref(scope, 'changes', { candidate }),
    });
  }

  function card(item: Candidate) {
    const request = item.request;
    const compared = request?.status === 'completed';
    const evidence = request && model.evidence[request.id];
    const comparison = evidence?.status === 'bound' ? evidence.comparison : null;
    const score = comparison && evaluationScoreSummary(comparison);
    const delta =
      score && score.parentMean !== null && score.candidateMean !== null
        ? score.candidateMean - score.parentMean
        : null;
    const href = request
      ? bundleHref(scope, 'changes', {
          ...Object.fromEntries(new URL(item.href, 'https://console.invalid').searchParams),
          candidate: request.candidateVersionId,
          generation: item.generation,
          request: request.id,
          comparison: request.comparisonId ?? undefined,
        })
      : item.href;
    return (
      <li key={item.id} data-change-kind={item.kind}>
        <Card size="sm" className="pipeline-card text-sm ring-0">
          <h4 className="pipeline-card-title" title={item.title}>
            {item.title}
          </h4>
          <div className="flex flex-wrap items-center gap-1.5">
            {item.generation !== undefined && (
              <span className="text-muted-foreground">Generation {item.generation}</span>
            )}
            {item.stale && <StatusBadge tone="warning">Stale base</StatusBadge>}
            {delta !== null && Number.isFinite(delta) && (
              <StatusBadge
                tone={delta < 0 ? 'warning' : delta > 0 ? 'success' : 'neutral'}
                aria-label="Mean reward change"
              >
                {delta > 0 ? '+' : ''}
                {formatReward(delta)} reward
              </StatusBadge>
            )}
            {comparison && (
              <StatusBadge>{pairCounts(evaluationPairs(comparison)).lower} worse</StatusBadge>
            )}
            {compared && !comparison && <StatusBadge>Comparison reported</StatusBadge>}
            {/* An open draft's status repeats its Open action; show only other states. */}
            {!compared &&
              (request?.status ?? item.status) &&
              (request?.status ?? item.status) !== 'open' && (
                <StatusBadge className="capitalize">{request?.status ?? item.status}</StatusBadge>
              )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-1">
            <Button asChild variant="outline" size="sm" className="min-h-9">
              <ConsoleLink href={href} aria-label={`${compared ? 'Review' : 'Open'} ${item.title}`}>
                {compared ? 'Review' : 'Open'} <ArrowRight aria-hidden="true" />
              </ConsoleLink>
            </Button>
            {item.details}
          </div>
        </Card>
      </li>
    );
  }

  return (
    <section aria-label="Change pipeline" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {loading && (
          <p role="status" className="text-muted-foreground">
            Loading changes…
          </p>
        )}
        <Button
          size="sm"
          variant={includeClosed ? 'secondary' : 'outline'}
          className="ml-auto min-h-9"
          aria-pressed={includeClosed}
          aria-label="Include closed drafts"
          onClick={onIncludeClosed}
        >
          <ListFilter aria-hidden="true" /> Include closed
        </Button>
      </div>
      {errors.filter(Boolean).map((error, index) => (
        <p key={index} role="alert" className="text-destructive">
          {error}
        </p>
      ))}
      <div className="changes-pipeline">
        {(
          [
            ['Drafting', drafting, 'No open drafts or suggestions.'],
            ['Evaluating', evaluating, 'No evaluations in progress.'],
            ['Ready to review', ready, 'No completed comparisons to review.'],
          ] as const
        ).map(([label, items, empty]) => (
          <section key={label} aria-label={label} className="pipeline-column">
            <h3>
              {label} <StatusBadge>{items.length}</StatusBadge>
            </h3>
            {items.length ? (
              <ul>{items.map(card)}</ul>
            ) : (
              !loading && <p className="text-muted-foreground">{empty}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {label === 'Drafting' && (
                <>
                  {moreDrafts}
                  {moreSuggestions}
                </>
              )}
              {label === 'Evaluating' && (
                <Button asChild variant="link" className="min-h-9 px-0">
                  <ConsoleLink href={historyHref}>View evaluation history</ConsoleLink>
                </Button>
              )}
            </div>
          </section>
        ))}
        <section aria-label="Released" className="pipeline-column">
          <h3>
            Released <StatusBadge>{released.length}</StatusBadge>
          </h3>
          {released.length ? (
            <ul>
              {released.map((release) => (
                <li key={release.id}>
                  <Card size="sm" className="pipeline-card text-sm ring-0">
                    <h4>Revision {release.revision}</h4>
                    <ReceiptTime value={release.createdAt} />
                    <p>
                      {release.policyOverride?.reason ||
                        release.unevaluatedReason ||
                        (release.comparisonId
                          ? 'Recorded evaluation evidence.'
                          : 'No release reason recorded.')}
                    </p>
                    <Button asChild variant="outline" size="sm" className="min-h-9">
                      <ConsoleLink
                        href={releasesHref + '#revision-' + release.revision}
                        aria-label={`Open revision ${release.revision}`}
                      >
                        Open <ArrowRight aria-hidden="true" />
                      </ConsoleLink>
                    </Button>
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">No channel releases.</p>
          )}
          <Button asChild variant="link" className="min-h-9 px-0">
            <ConsoleLink href={releasesHref}>View releases</ConsoleLink>
          </Button>
        </section>
      </div>
    </section>
  );
}
