import type { ReactNode } from 'react';
import type { Draft, Evaluation, Proposal } from '@acclimate/sdk';
import type { ConsoleState } from '../server/channel';
import type { EvaluationHistoryModel } from '../lib/changes-workspace';
import { bundleHref } from '../navigation';
import { evaluationScoreSummary } from '../lib/evaluation-score-summary';
import { evaluationPairs, formatReward, pairCounts } from '../lib/evaluation-pairs';
import { groupAttempts, runLabel } from '../lib/run-attempts';
import { ConsoleLink } from './console-link';
import { ChangeRecordDetails } from './change-record-details';
import { ReceiptTime } from './receipt-time';
import { StatusBadge } from './status-badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { ArrowRight } from 'lucide-react';

type Ready = Extract<ConsoleState, { status: 'ready' }>;

const kindLabels = { draft: 'Draft', suggestion: 'Suggestion', candidate: 'Candidate' } as const;

/** Paths the provider edited, or why it stopped, from the latest screening pass. */
function suggestionMeta(proposal: Proposal) {
  if (proposal.status === 'failed') return proposal.error || 'No candidate produced.';
  const changes = proposal.screening?.at(-1)?.changes ?? [];
  const paths = [...new Set(changes.map((change) => change.path))];
  if (!paths.length) return undefined;
  return (
    'Edits ' + paths.slice(0, 2).join(', ') + (paths.length > 2 ? ` +${paths.length - 2}` : '')
  );
}

type Candidate = {
  id: string;
  kind: 'draft' | 'suggestion' | 'candidate';
  /** Accessible identity used in the card's link name. */
  title: string;
  /** What a reader scans for: when it changed or what it proposes. */
  heading: ReactNode;
  meta?: ReactNode;
  candidate?: string | null;
  stale?: boolean;
  generation?: number;
  status?: string;
  href: string;
  details?: ReactNode;
  request?: Evaluation;
  /** Older attempts at the same parent and candidate content, newest first. */
  earlier?: Candidate[];
};

export function ChangesPipeline({
  state,
  model,
  drafts,
  proposals,
  includeClosed,
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
  const candidateRequests = new Map<
    string,
    { active?: Evaluation; compared?: Evaluation; latest?: Evaluation }
  >();
  for (const request of model.requests) {
    const row = candidateRequests.get(request.candidateVersionId) ?? {};
    if (!row.latest || Date.parse(request.createdAt) > Date.parse(row.latest.createdAt))
      row.latest = request;
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
        heading: (
          <>
            Edited <ReceiptTime value={draft.updatedAt} relative />
          </>
        ),
        meta: `${draft.generation} ${draft.generation === 1 ? 'save' : 'saves'}`,
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
      heading:
        proposal.rationale?.trim().split('\n')[0] ||
        (proposal.status === 'failed'
          ? 'Suggestion failed'
          : proposal.status === 'succeeded'
            ? 'Suggestion'
            : 'Preparing suggestion'),
      meta: suggestionMeta(proposal),
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
      heading: 'Saved version',
      stale: request.parentVersionId !== resolution.version.id,
      href: bundleHref(scope, 'changes', { candidate }),
    });
  }

  // A retry saves the same content as a new version. Show it once, with its earlier attempts,
  // including a failed attempt that would otherwise wait in Drafting.
  const settled = (item: Candidate) =>
    item.candidate && !releasedVersions.has(item.candidate)
      ? candidateRequests.get(item.candidate)?.latest
      : undefined;
  const pool = [
    ...evaluating.map((item) => ({ item, column: evaluating, request: item.request })),
    ...ready.map((item) => ({ item, column: ready, request: item.request })),
    ...drafting.map((item) => ({ item, column: drafting, request: settled(item) })),
  ];
  const attempts = groupAttempts(pool, (entry) => entry.request);
  evaluating.length = 0;
  ready.length = 0;
  drafting.length = 0;
  for (const { item: entry, earlier } of attempts)
    entry.column.push({
      ...entry.item,
      earlier: earlier.map((attempt) => ({ ...attempt.item, request: attempt.request })),
    });

  function requestHref(item: Candidate, request: Evaluation) {
    return bundleHref(scope, 'changes', {
      ...Object.fromEntries(new URL(item.href, 'https://console.invalid').searchParams),
      candidate: request.candidateVersionId,
      generation: item.generation,
      request: request.id,
      comparison: request.comparisonId ?? undefined,
    });
  }

  function card(item: Candidate) {
    const request = item.request;
    const name = runLabel(request);
    const title = name ? `run ${name}` : item.title;
    const compared = request?.status === 'completed';
    const evidence = request && model.evidence[request.id];
    const comparison = evidence?.status === 'bound' ? evidence.comparison : null;
    const score = comparison && evaluationScoreSummary(comparison);
    const delta =
      score && score.parentMean !== null && score.candidateMean !== null
        ? score.candidateMean - score.parentMean
        : null;
    const href = request ? requestHref(item, request) : item.href;
    const counts = comparison && pairCounts(evaluationPairs(comparison));
    const verb = compared ? 'Review' : 'Open';
    const rawStatus = !compared && (request?.status ?? item.status);
    // A failed suggestion already says so in its heading; tint its reason instead.
    const failed = rawStatus === 'failed';
    const status = failed && item.kind === 'suggestion' ? undefined : rawStatus;
    return (
      <li key={item.id} data-change-kind={item.kind}>
        <Card size="sm" className="pipeline-card text-sm ring-0">
          <div className="pipeline-card-eyebrow">
            <span>{kindLabels[item.kind]}</span>
            <code>{item.id.slice(0, 8)}</code>
          </div>
          <h4 className="pipeline-card-title" title={title}>
            <ConsoleLink className="pipeline-card-link" href={href} aria-label={`${verb} ${title}`}>
              {name ?? item.heading}
            </ConsoleLink>
          </h4>
          {name && <p className="pipeline-card-meta">{item.heading}</p>}
          {item.meta && (
            <p className="pipeline-card-meta" data-failed={failed || undefined}>
              {item.meta}
            </p>
          )}
          {(delta !== null && Number.isFinite(delta)) || counts ? (
            <div className="pipeline-card-result">
              {delta !== null && Number.isFinite(delta) && (
                <StatusBadge
                  tone={delta < 0 ? 'danger' : delta > 0 ? 'success' : 'neutral'}
                  aria-label="Mean reward change"
                >
                  {delta > 0 ? '▲ +' : delta < 0 ? '▼ ' : ''}
                  {formatReward(delta)}
                </StatusBadge>
              )}
              {counts && (
                <span className="pipeline-card-pairs">
                  {counts.higher} higher · {counts.lower} lower
                  {counts.unscored ? ` · ${counts.unscored} unscored` : ''}
                </span>
              )}
            </div>
          ) : null}
          {(item.stale || (compared && !comparison) || (status && status !== 'open')) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {item.stale && <StatusBadge tone="warning">Stale base</StatusBadge>}
              {compared && !comparison && <StatusBadge>Comparison reported</StatusBadge>}
              {/* An open draft's status repeats its Open action; show only other states. */}
              {status && status !== 'open' && (
                <StatusBadge
                  tone={status === 'failed' ? 'danger' : 'neutral'}
                  className="capitalize"
                >
                  {status}
                </StatusBadge>
              )}
            </div>
          )}
          {item.earlier?.length ? (
            <div className="pipeline-card-meta" data-earlier-attempts>
              <span>
                Supersedes {item.earlier.length} earlier{' '}
                {item.earlier.length === 1 ? 'attempt' : 'attempts'}:
              </span>{' '}
              {item.earlier.map((attempt, index) => {
                const label = runLabel(attempt.request) ?? attempt.id.slice(0, 8);
                return (
                  <span key={attempt.id}>
                    {index > 0 && ', '}
                    <ConsoleLink
                      href={attempt.request ? requestHref(attempt, attempt.request) : attempt.href}
                      aria-label={`Open earlier attempt ${label}`}
                    >
                      {label}
                    </ConsoleLink>
                  </span>
                );
              })}
            </div>
          ) : null}
          <div className="pipeline-card-foot">
            <span className="pipeline-card-cta" aria-hidden="true">
              {verb} <ArrowRight />
            </span>
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
          <section
            key={label}
            aria-label={label}
            className="pipeline-column"
            data-stage={label === 'Ready to review' ? 'ready' : undefined}
            data-empty={items.length ? undefined : true}
          >
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
                    <div className="pipeline-card-eyebrow">
                      <span>Revision {release.revision}</span>
                    </div>
                    <h4 className="pipeline-card-title">
                      <ConsoleLink
                        className="pipeline-card-link"
                        href={releasesHref + '#revision-' + release.revision}
                        aria-label={`Open revision ${release.revision}`}
                      >
                        {release.policyOverride?.reason ||
                          release.unevaluatedReason ||
                          (release.comparisonId
                            ? 'Released with evaluation evidence'
                            : 'No release reason recorded')}
                      </ConsoleLink>
                    </h4>
                    <p className="pipeline-card-meta">
                      <ReceiptTime value={release.createdAt} relative />
                    </p>
                    <div className="pipeline-card-foot">
                      <span className="pipeline-card-cta" aria-hidden="true">
                        Open <ArrowRight />
                      </span>
                    </div>
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
