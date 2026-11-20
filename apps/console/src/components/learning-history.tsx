import { ReceiptTime } from './receipt-time';
import { StatusBadge } from './status-badge';
import { useEffect, useRef, useState } from 'react';
import type { Comparison, Evaluation } from '@acclimate/sdk';
import type { ConsoleState } from '../server/channel';
import { runImprovement } from '../server/improvement-actions';
import { bundleHref } from '../navigation';
import { mergeHistory, refreshKnownActive } from '../lib/improvement-history';
import { evaluationPairs, formatReward, pairCounts, pairLabels } from '../lib/evaluation-pairs';
import { evaluationScoreSummary } from '../lib/evaluation-score-summary';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';
import { ConsoleLink } from './console-link';
import { ArrowRight } from 'lucide-react';

type Ready = Extract<ConsoleState, { status: 'ready' }>;

export function RewardBreakdown({ comparison }: { comparison: Comparison }) {
  const counts = pairCounts(evaluationPairs(comparison));
  const total = comparison.expectedCases.length;
  const label = (['lower', 'higher', 'same', 'unscored'] as const)
    .map((key) => `${counts[key]} ${pairLabels[key].toLowerCase()}`)
    .join(', ');
  return (
    <div className="learning-reward-breakdown" role="img" aria-label={label} title={label}>
      {!total && <span className="text-muted-foreground text-sm">No expected pairs</span>}
      {(['lower', 'higher', 'same', 'unscored'] as const).map(
        (key) =>
          counts[key] > 0 && (
            <span
              key={key}
              className={`is-${key}`}
              style={{ flex: counts[key] }}
              aria-hidden="true"
            >
              {counts[key]}
            </span>
          ),
      )}
    </div>
  );
}

/** Bundle-wide evidence history. Deliberately no line joining different experiments. */
export function LearningHistory({ state }: { state: Ready }) {
  const scope = {
    workspaceId: state.workspaceId,
    bundleId: state.bundleId,
    channel: state.channel,
  };
  const [requests, setRequests] = useState<Evaluation[]>([]);
  const [reports, setReports] = useState<Record<string, Comparison>>({});
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const active = useRef(false);
  const cache = useRef(new Map<string, Comparison>());
  const known = useRef<Evaluation[]>([]);
  const olderLoaded = useRef(false);
  const epoch = useRef(0);
  async function load(next?: string) {
    if (active.current) return;
    active.current = true;
    const started = epoch.current;
    setLoading(true);
    try {
      const result = await runImprovement({
        data: { action: 'requests', requestCursor: next, scope },
      });
      if (started !== epoch.current) return;
      if (!result.ok) throw Error(result.message);
      if (!result.requests) throw Error('Evaluation history could not be read.');
      let merged = mergeHistory(known.current, result.requests.items, !!next);
      const activeUpdates = await refreshKnownActive(
        merged.filter((row) => !result.requests!.items.some((head) => head.id === row.id)),
        async (id) => {
          const read = await runImprovement({ data: { action: 'request', id, scope } });
          if (!read.ok) throw Error(read.message);
          return read.request;
        },
        () => started === epoch.current,
      );
      if (started !== epoch.current) return;
      merged = merged.map((row) => activeUpdates.find((update) => update.id === row.id) || row);
      known.current = merged;
      setRequests(merged);
      if (next || !olderLoaded.current) setCursor(result.requests.nextCursor);
      if (next) olderLoaded.current = true;
      setError('');
      const ids = [
        ...new Set(
          merged.flatMap((request) => (request.comparisonId ? [request.comparisonId] : [])),
        ),
      ].filter((id) => !cache.current.has(id));
      const failed: string[] = [];
      // Bound reads; completed comparisons are immutable and stay cached for this mounted scope.
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (index < ids.length && started === epoch.current) {
            const id = ids[index++];
            try {
              const report = await runImprovement({ data: { action: 'comparison', id, scope } });
              if (started !== epoch.current) return;
              if (!report.ok || !report.comparison) throw Error('Evidence unavailable');
              cache.current.set(id, report.comparison);
            } catch {
              if (started === epoch.current) failed.push(id);
            }
          }
        }),
      );
      if (started === epoch.current) {
        setReports(Object.fromEntries(cache.current));
        setUnavailable(failed);
      }
    } catch (failure) {
      if (started === epoch.current)
        setError(failure instanceof Error ? failure.message : 'History could not be read.');
    } finally {
      if (started === epoch.current) {
        active.current = false;
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    epoch.current++;
    const started = epoch.current;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await load();
      if (started === epoch.current) timer = setTimeout(poll, 15000);
    }
    void poll();
    return () => {
      epoch.current++;
      active.current = false;
      clearTimeout(timer);
    };
  }, []); // Parent keys this component by actor, service, workspace, bundle and channel.

  return (
    <Disclosure defaultOpen className="learning-history" aria-label="Learning history">
      <div className="learning-history-heading">
        <DisclosureTrigger className="font-semibold">Learning history</DisclosureTrigger>
        <span className="text-muted-foreground text-sm">
          Evaluations across this bundle’s channels
        </span>
      </div>
      <DisclosureContent className="space-y-3 pt-3">
        <p className="text-sm text-muted-foreground">
          Follow each tested candidate into its evidence. Rows are separate experiments; datasets
          and graders can differ.
        </p>
        <div className="learning-history-legend text-sm" aria-label="Reward change legend">
          {(['lower', 'higher', 'same', 'unscored'] as const).map((key) => (
            <span key={key}>
              <i className={`is-${key}`} aria-hidden="true" />
              {pairLabels[key]}
            </span>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error} Displayed history may be stale. Retrying automatically.
          </p>
        )}
        {!requests.length && (
          <p role="status" className="text-sm text-muted-foreground">
            {loading
              ? 'Loading evaluations…'
              : error
                ? 'Evaluation history is unavailable.'
                : 'No evaluations yet. Save a change, then request an evaluation to start a history.'}
          </p>
        )}
        <ol className="learning-history-rows" aria-label="Evaluated candidates">
          {(expanded ? requests : requests.slice(0, 5)).map((request) => {
            const report = request.comparisonId ? reports[request.comparisonId] : undefined;
            const bound =
              report &&
              report.parentVersionId === request.parentVersionId &&
              report.candidateVersionId === request.candidateVersionId &&
              report.parentDigest === request.parentDigest &&
              report.candidateDigest === request.candidateDigest &&
              report.evaluation?.requestId === request.id &&
              report.evaluation?.attemptId === request.attemptId;
            const summary = bound ? evaluationScoreSummary(report) : null;
            return (
              <li key={request.id} className="learning-history-row">
                <div className="learning-history-identity">
                  <ConsoleLink
                    href={bundleHref(scope, 'changes', {
                      candidate: request.candidateVersionId,
                      comparison: request.comparisonId || undefined,
                    })}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    <span className="learning-history-name">{request.datasetRevision}</span>
                    <ArrowRight aria-hidden="true" className="size-3.5 shrink-0" />
                  </ConsoleLink>
                  <p className="text-muted-foreground text-sm">
                    <ReceiptTime value={request.createdAt} />
                    {' · '}
                    {request.expectedCases.length} pairs · {request.graderRevision}
                  </p>
                  <p
                    className="text-sm text-muted-foreground"
                    title={`${request.parentVersionId} → ${request.candidateVersionId}`}
                  >
                    <code>
                      {request.parentVersionId.slice(0, 8)} →{' '}
                      {request.candidateVersionId.slice(0, 8)}
                    </code>
                  </p>
                  {request.runtime.source === 'simulated-example' && (
                    <span className="text-muted-foreground text-sm">
                      Simulated example · no model run
                    </span>
                  )}
                </div>
                <div className="learning-history-result">
                  {bound ? (
                    <>
                      <RewardBreakdown comparison={report} />
                      <p className="text-sm text-muted-foreground">
                        Mean reward{' '}
                        {summary!.parentMean === null ? '—' : formatReward(summary!.parentMean)}
                        {' → '}
                        {summary!.candidateMean === null
                          ? '—'
                          : formatReward(summary!.candidateMean)}
                        {' · '}
                        {summary!.pairedCount}/{summary!.expectedCount} scored pairs
                        {!report.complete && ' · incomplete evidence'}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {report
                        ? 'Evidence binding does not match this request'
                        : request.comparisonId
                          ? unavailable.includes(request.comparisonId)
                            ? 'Evidence unavailable · retrying automatically'
                            : 'Loading evidence…'
                          : request.error || 'No comparison reported'}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  <Badge variant="outline">{request.status}</Badge>
                  {request.candidateVersionId === state.resolution.version.id && (
                    <StatusBadge tone="success">Current release</StatusBadge>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>
            {expanded ? requests.length : Math.min(requests.length, 5)} of {requests.length} loaded
            evaluations · newest first
          </span>
          <div className="flex flex-wrap gap-2">
            {requests.length > 5 && (
              <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
                {expanded ? 'Show latest five' : `Show all ${requests.length} loaded evaluations`}
              </Button>
            )}
            {cursor && (
              <Button
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={() => {
                  setExpanded(true);
                  void load(cursor);
                }}
              >
                Load older evaluations
              </Button>
            )}
          </div>
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}
