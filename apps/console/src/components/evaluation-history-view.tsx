import { ReceiptTime } from './receipt-time';
import { Fragment, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Comparison, Evaluation, EvaluationProgressView, Outcome } from '@acclimate/sdk';
import type { EvaluationHistoryViewProps, RequestEvidence } from '../lib/changes-workspace';
import { evaluationEvidenceSummary, notComparableReasons } from '../lib/evaluation-history';
import { evaluationPairs, formatReward, pairCounts, pairLabels } from '../lib/evaluation-pairs';
import { evaluationRunName } from '../lib/evaluation-run-name';
import { Button } from './ui/button';
import { DirectorySearch } from './ui/directory-search';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';
import { CopyButton } from './copy-button';
import { EvaluationActivity } from './evaluation-activity';

const value = (text: string | null | undefined) => text || 'Unavailable';
const reward = (number: number | null | undefined) =>
  number == null || !Number.isFinite(number) ? '—' : formatReward(number);

function RunScores({ parent, candidate }: { parent: number | null; candidate: number | null }) {
  // Scale each experiment separately. Normalize first to avoid an overflow for opposite extremes.
  const scale = Math.max(Math.abs(parent ?? 0), Math.abs(candidate ?? 0)) || 1;
  const low = Math.min(0, (parent ?? 0) / scale, (candidate ?? 0) / scale);
  const high = Math.max(0, (parent ?? 0) / scale, (candidate ?? 0) / scale);
  const position = (number: number) => (100 * (number / scale - low)) / (high - low || 1);
  return (
    <div className="ledger-paired-scores">
      {(
        [
          ['Parent', parent],
          ['Candidate', candidate],
        ] as const
      ).map(([label, number]) => (
        <div className="ledger-score-line" key={label}>
          <span className="ledger-score-value" title={`${label} ${number ?? '—'}`}>
            {label} <b>{reward(number)}</b>
          </span>
          {number !== null && (
            <span className="ledger-score-track" aria-hidden="true">
              <i
                style={{
                  left: `${Math.min(position(0), position(number))}%`,
                  width: `${Math.abs(position(number) - position(0))}%`,
                }}
              />
              <i
                className="ledger-score-origin"
                style={{ left: `clamp(0px, ${position(0)}%, calc(100% - 1px))` }}
              />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function EvidenceState({ evidence }: { evidence: RequestEvidence }) {
  switch (evidence.status) {
    case 'none':
      return <span>{evidence.message || 'No comparison reported'}</span>;
    case 'loading':
      return <span>Loading evidence…</span>;
    case 'unavailable':
      return <span>{evidence.message || 'Evidence unavailable. Retrying automatically.'}</span>;
    case 'mismatch':
      return <span>Evidence binding mismatch: {evidence.message}</span>;
    case 'unbound':
      return <span>{evidence.message}</span>;
    case 'bound':
      return null;
  }
}

function OutcomeView({ label, outcome }: { label: string; outcome: Outcome | undefined }) {
  return (
    <div className="evaluation-ledger-outcome">
      <h5>
        <span>{label}</span>
        <strong>Reward {reward(outcome?.reward)}</strong>
      </h5>
      <p>
        {outcome ? (
          <>
            Execution {outcome.executionStatus} · grading {outcome.gradingStatus}
          </>
        ) : (
          'Missing outcome · execution unavailable · grading unavailable'
        )}
      </p>
      {outcome?.error && <p className="evaluation-ledger-outcome-error">Error: {outcome.error}</p>}
    </div>
  );
}

function Provenance({ request, comparison }: { request: Evaluation; comparison?: Comparison }) {
  const runtime = Object.entries(request.runtime ?? {});
  return (
    <div className="evaluation-ledger-provenance">
      <h4>Run provenance</h4>
      <dl>
        <div>
          <dt>Dataset revision</dt>
          <dd>{value(request.datasetRevision)}</dd>
        </div>
        <div>
          <dt>Grader revision</dt>
          <dd>{value(request.graderRevision)}</dd>
        </div>
        <div>
          <dt>Runtime identities</dt>
          <dd>
            {runtime.length
              ? runtime.map(([key, item]) => (
                  <div key={key}>
                    {key}: {value(item)}
                  </div>
                ))
              : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt>Parent version</dt>
          <dd>{value(request.parentVersionId)}</dd>
        </div>
        <div>
          <dt>Parent digest</dt>
          <dd>{value(request.parentDigest)}</dd>
        </div>
        <div>
          <dt>Candidate version</dt>
          <dd>{value(request.candidateVersionId)}</dd>
        </div>
        <div>
          <dt>Candidate digest</dt>
          <dd>{value(request.candidateDigest)}</dd>
        </div>
        <div>
          <dt>Request</dt>
          <dd>{value(request.id)}</dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd>{value(request.attemptId)}</dd>
        </div>
        <div>
          <dt>Comparison</dt>
          <dd>{value(comparison?.id ?? request.comparisonId)}</dd>
        </div>
        <div>
          <dt>Expected case / repetition inventory</dt>
          <dd>
            {request.expectedCases.length ? (
              <ul>
                {request.expectedCases.map((item, i) => (
                  <li key={i}>
                    {item.caseId} / {item.repetition}
                  </li>
                ))}
              </ul>
            ) : (
              'No expected cases'
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function BoundEvidence({ comparison }: { comparison: Comparison }) {
  const summary = evaluationEvidenceSummary(comparison);
  const rows = evaluationPairs(comparison).filter((row) => row.expected);
  const priority = { lower: 0, unscored: 1, higher: 2, same: 2 } as const;
  const preview = [...rows].sort((a, b) => priority[a.change] - priority[b.change]).slice(0, 6);
  const counts = pairCounts(rows);
  const reasons = Array.from(new Set(rows.flatMap((row) => notComparableReasons(row))));
  return (
    <div className="evaluation-ledger-evidence">
      <p>
        {comparison.complete ? 'Complete inventory' : 'Incomplete inventory'} · {counts.higher}{' '}
        higher reward · {counts.lower} lower reward · {counts.same} same reward ·{' '}
        {summary.notComparable} not comparable
      </p>
      {summary.notComparable > 0 && (
        <p>Not comparable reasons: {reasons.length ? reasons.join('; ') : 'Unavailable'}</p>
      )}
      <dl className="evaluation-ledger-metrics" aria-label="Expected outcome metrics">
        <div>
          <dt>Execution failures · expected outcomes</dt>
          <dd>{summary.expectedExecutionFailures}</dd>
        </div>
        <div>
          <dt>Missing or failed grades · expected outcomes</dt>
          <dd>{summary.expectedMissingGrades}</dd>
        </div>
        <div>
          <dt>Cost · expected outcomes</dt>
          <dd>{summary.expectedCostUsd == null ? 'unknown' : `$${summary.expectedCostUsd}`}</dd>
        </div>
      </dl>
      <p>
        {summary.unexpectedCount} unexpected case / repetition{' '}
        {summary.unexpectedCount === 1 ? 'record' : 'records'}; excluded from expected coverage and
        means.
      </p>
      <Disclosure className="ledger-case-preview">
        <DisclosureTrigger>
          Expected case preview ({preview.length} of {summary.expectedCount})
        </DisclosureTrigger>
        <DisclosureContent>
          <p>
            Showing {preview.length} of {summary.expectedCount} expected case / repetition pairs.
          </p>
          <div className="evaluation-ledger-case-list">
            {preview.map((row) => (
              <div className="evaluation-ledger-case" key={row.id}>
                <div className="evaluation-ledger-case-heading">
                  <strong>
                    {row.key.caseId} / {row.key.repetition}
                  </strong>{' '}
                  · {pairLabels[row.change]}
                  {row.change === 'unscored' && <> · {notComparableReasons(row).join('; ')}</>}
                </div>
                <div className="evaluation-ledger-case-sides">
                  <OutcomeView label="Parent" outcome={row.pair?.parent} />
                  <OutcomeView label="Candidate" outcome={row.pair?.candidate} />
                </div>
              </div>
            ))}
          </div>
        </DisclosureContent>
      </Disclosure>
    </div>
  );
}

function Detail({
  request,
  evidence,
  progress,
  href,
  detailRef,
  onClose,
}: {
  request: Evaluation;
  evidence: RequestEvidence;
  progress?: EvaluationProgressView | null;
  href: string;
  detailRef: (node: HTMLDivElement | null) => void;
  onClose: () => void;
}) {
  const independent = 'comparison' in evidence ? new URL(href, 'https://console.invalid') : null;
  if (independent && 'comparison' in evidence) {
    independent.searchParams.delete('request');
    independent.searchParams.set('comparison', evidence.comparison.id);
  }
  return (
    <div ref={detailRef} className="evaluation-ledger-detail">
      <div className="evaluation-ledger-actions">
        <dl className="ledger-selected-identity">
          <div>
            <dt>Candidate version</dt>
            <dd>
              <code>{request.candidateVersionId}</code>
            </dd>
          </div>
          {request.comparisonId && (
            <div>
              <dt>Reported comparison</dt>
              <dd>
                <code>{request.comparisonId}</code>
              </dd>
            </div>
          )}
        </dl>
        {independent && (evidence.status === 'unbound' || evidence.status === 'mismatch') && (
          <Button asChild variant="outline" size="sm">
            <a href={independent.pathname + independent.search + independent.hash}>
              Inspect comparison independently
            </a>
          </Button>
        )}
        <Button asChild variant="outline" size="sm">
          <a href={href}>{request.comparisonId ? 'Open full review' : 'Open evaluation'}</a>
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close evaluation details
        </Button>
      </div>
      {request.error && (
        <p role="alert" className="ledger-request-error">
          Request error: {request.error}
        </p>
      )}
      <div className="ledger-detail-context">
        <EvaluationActivity request={request} progress={progress} />
        <Disclosure>
          <DisclosureTrigger>Run details</DisclosureTrigger>
          <DisclosureContent className="space-y-3 pt-3">
            <Provenance
              request={request}
              comparison={'comparison' in evidence ? evidence.comparison : undefined}
            />
            <CopyButton
              label="Copy run details"
              value={JSON.stringify(
                { request, comparisonId: 'comparison' in evidence ? evidence.comparison.id : null },
                null,
                2,
              )}
            />
          </DisclosureContent>
        </Disclosure>
      </div>
      <div className="ledger-detail-results">
        {evidence.status === 'bound' ? (
          <BoundEvidence comparison={evidence.comparison} />
        ) : (
          <p>
            <EvidenceState evidence={evidence} />
          </p>
        )}
      </div>
    </div>
  );
}

export type HistoryFilters = { query: string; status: string };

export function EvaluationHistoryView({
  model,
  selectedCandidateId,
  selectedRequestId,
  onSelectRequest,
  reviewHref,
  versionSelector,
  filters: { query, status },
  onFiltersChange,
}: EvaluationHistoryViewProps & {
  versionSelector?: ReactNode;
  filters: HistoryFilters;
  onFiltersChange: (filters: HistoryFilters) => void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const detail = useRef<HTMLDivElement | null>(null);
  const selected = selectedRequestId;
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtering = Boolean(terms.length || status);
  const loaded = model.requests.filter(
    (request) => !selectedCandidateId || request.candidateVersionId === selectedCandidateId,
  );
  const pinned =
    model.selectedRequest &&
    model.selectedRequest.id === selected &&
    !model.requests.some((request) => request.id === selected) &&
    (!selectedCandidateId || model.selectedRequest.candidateVersionId === selectedCandidateId)
      ? model.selectedRequest
      : null;
  const matches = loaded.filter((run) => {
    if (status && run.status !== status) return false;
    if (!terms.length) return true;
    const text = [
      evaluationRunName(run.datasetRevision),
      run.datasetRevision,
      run.graderRevision,
      run.id,
      run.attemptId,
      run.comparisonId,
      run.parentVersionId,
      run.candidateVersionId,
      ...Object.values(run.runtime ?? {}),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const outsideFilter =
    filtering &&
    loaded.find((run) => run.id === selected && !matches.some((match) => match.id === run.id));
  const retained = pinned || outsideFilter;
  const rows = retained ? [retained, ...matches] : matches;
  const statuses: Evaluation['status'][] = [
    'requested',
    'running',
    'completed',
    'failed',
    'interrupted',
    'abandoned',
  ];
  const visibleIds = useRef(new Set<string>());
  visibleIds.current = new Set(rows.map((row) => row.id));

  useLayoutEffect(() => {
    return () => {
      if (detail.current?.contains(document.activeElement)) {
        (
          (selected && visibleIds.current.has(selected) && triggers.current.get(selected)) ||
          heading.current
        )?.focus();
      }
    };
  }, [selected, rows.some((row) => row.id === selected)]);

  return (
    <section
      id="evaluation-history"
      tabIndex={-1}
      className="evaluation-ledger"
      data-version-context={Boolean(selectedCandidateId)}
      aria-labelledby={`${id}-heading`}
    >
      <div className="evaluation-ledger-heading">
        <div className="ledger-heading-title">
          <h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>
            Evaluation history
          </h3>
          <span>
            {!model.requests.length && (model.error || model.loading) ? (
              model.error ? (
                'History list unavailable'
              ) : (
                'Loading bundle history…'
              )
            ) : (
              <>
                {loaded.length} loaded {loaded.length === 1 ? 'request' : 'requests'}
                {selectedCandidateId ? ' for this version' : ' across bundle channels'}
              </>
            )}
          </span>
        </div>
        {versionSelector}
      </div>
      {(loaded.length > 0 || filtering || model.cursor) && (
        <div className="ledger-run-filters" role="group" aria-label="Filter loaded evaluations">
          <DirectorySearch
            id={`${id}-run-search`}
            label="Search loaded evaluations"
            placeholder="Search runs, harnesses or IDs"
            value={query}
            onValueChange={(query) => onFiltersChange({ query, status })}
          />
          <NativeSelect
            aria-label="Evaluation status"
            value={status}
            onChange={(event) => onFiltersChange({ query, status: event.target.value })}
          >
            <NativeSelectOption value="">All statuses</NativeSelectOption>
            {statuses.map((item) => (
              <NativeSelectOption key={item} value={item}>
                {item[0].toUpperCase() + item.slice(1)} (
                {loaded.filter((run) => run.status === item).length})
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {filtering && (
            <span className="ledger-match-count" role="status">
              {matches.length} matching {matches.length === 1 ? 'request' : 'requests'}
            </span>
          )}
        </div>
      )}
      <p className="evaluation-ledger-note">
        Compare parent and candidate within each run. Reward scales, datasets and graders can differ
        between runs.
      </p>
      {model.error && (
        <p role="alert">
          {model.error}
          {model.requests.length > 0 && ' Showing previously loaded requests.'}
        </p>
      )}
      {selected && model.selectedState === 'loading' && (
        <p role="status">Loading selected evaluation…</p>
      )}
      {selected &&
        (model.selectedState === 'unavailable' || model.selectedState === 'mismatch') && (
          <p role="alert">
            {model.selectedState === 'mismatch'
              ? 'Selected evaluation does not match this version. '
              : 'Selected evaluation unavailable. '}
            {model.selectedError}
          </p>
        )}
      {filtering && !matches.length && (
        <div className="ledger-search-empty">
          <p>No loaded requests match these filters.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onFiltersChange({ status: '', query: '' });
              document.getElementById(`${id}-run-search`)?.focus();
            }}
          >
            Clear filters
          </Button>
        </div>
      )}
      {!filtering && !rows.length && !model.error && (
        <p role="status">
          {model.loading && !model.requests.length
            ? 'Loading evaluations…'
            : selectedCandidateId
              ? 'No loaded evaluations for this version.'
              : 'No evaluations yet.'}
        </p>
      )}
      {!!rows.length && (
        <div
          className="evaluation-ledger-scroll"
          role="region"
          aria-label="Evaluation history table"
          tabIndex={0}
        >
          <Table role="table" className="evaluation-ledger-table">
            <TableHeader role="rowgroup">
              <TableRow role="row">
                <TableHead role="columnheader" scope="col">
                  Evaluation
                </TableHead>
                <TableHead role="columnheader" scope="col">
                  Status
                </TableHead>
                <TableHead role="columnheader" scope="col" id={`${id}-coverage`}>
                  Scored pairs
                </TableHead>
                <TableHead role="columnheader" scope="col">
                  Observed equal-case mean
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody role="rowgroup">
              {rows.map((request) => {
                const open = selected === request.id;
                const evidence =
                  model.evidence[request.id] ??
                  ({ status: request.comparisonId ? 'loading' : 'none' } as RequestEvidence);
                const summary =
                  evidence.status === 'bound'
                    ? evaluationEvidenceSummary(evidence.comparison)
                    : null;
                const name = evaluationRunName(request.datasetRevision);
                const observation =
                  open &&
                  request.status === 'running' &&
                  model.selectedProgress?.requestId === request.id &&
                  model.selectedProgress.attemptId === request.attemptId &&
                  model.selectedProgress.observation?.attemptId === request.attemptId
                    ? model.selectedProgress.observation
                    : null;
                const detailId = `${id}-detail-${encodeURIComponent(request.id)}`;
                const coverageId = `${id}-coverage-${encodeURIComponent(request.id)}`;
                return (
                  <Fragment key={request.id}>
                    <TableRow role="row" className={open ? 'evaluation-ledger-selected' : ''}>
                      <TableCell role="cell">
                        <Button
                          ref={(node) => {
                            if (node) triggers.current.set(request.id, node);
                            else triggers.current.delete(request.id);
                          }}
                          variant="ghost"
                          id={`ledger-request-${request.id}`}
                          className="evaluation-ledger-trigger"
                          aria-expanded={open}
                          aria-controls={detailId}
                          onClick={() => onSelectRequest(open ? null : request)}
                        >
                          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                          <span>
                            <strong>{name}</strong>
                            {name !== request.datasetRevision && (
                              <span className="sr-only">Dataset {request.datasetRevision}</span>
                            )}
                            <small>
                              {request.runtime?.harness ? `${request.runtime.harness} · ` : ''}
                              <span className="ledger-request-id">
                                Request {request.id.slice(0, 8)} ·{' '}
                              </span>
                              <ReceiptTime value={request.createdAt} />
                              {pinned?.id === request.id && ' · Selected outside loaded history'}
                              {outsideFilter &&
                                outsideFilter.id === request.id &&
                                ' · Selected outside filters'}
                            </small>
                          </span>
                        </Button>
                      </TableCell>
                      <TableCell role="cell">
                        <span className="ledger-request-status" data-state={request.status}>
                          {request.status}
                        </span>
                        {observation && (
                          <small>
                            {observation.completed} / {observation.total} outcomes reported
                            {model.selectedProgress?.activity === 'stale' && ' · stale'}
                          </small>
                        )}
                      </TableCell>
                      <TableCell role="cell" id={coverageId}>
                        <span className="evaluation-compact-label" aria-hidden="true">
                          Scored pairs
                        </span>
                        {summary ? (
                          <>
                            {summary.pairedCount} / {summary.expectedCount}
                            {summary.partial && ' · partial'}
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell
                        role="cell"
                        aria-describedby={summary ? `${id}-coverage ${coverageId}` : undefined}
                      >
                        <span className="evaluation-compact-label" aria-hidden="true">
                          Observed equal-case mean
                        </span>
                        {summary ? (
                          <RunScores
                            parent={summary.parentMean}
                            candidate={summary.candidateMean}
                          />
                        ) : (
                          <span className="ledger-evidence-state">
                            {evidence.status === 'none' &&
                            !evidence.message &&
                            request.status === 'requested' ? (
                              'Awaiting evaluator'
                            ) : evidence.status === 'none' &&
                              !evidence.message &&
                              request.status === 'running' ? (
                              'Awaiting grades'
                            ) : (
                              <EvidenceState evidence={evidence} />
                            )}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow role="row" className="evaluation-ledger-detail-row">
                        <TableCell role="cell" colSpan={4} id={detailId}>
                          <Detail
                            request={request}
                            evidence={evidence}
                            progress={model.selectedProgress}
                            href={reviewHref(request)}
                            detailRef={(node) => {
                              detail.current = node;
                            }}
                            onClose={() => {
                              triggers.current.get(request.id)?.focus();
                              onSelectRequest(null);
                            }}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {model.cursor && (
        <div className="evaluation-ledger-pagination">
          <Button
            variant="outline"
            size="sm"
            disabled={model.loading}
            onClick={() => void model.loadMore()}
          >
            {model.loading ? 'Loading older evaluations…' : 'Load older evaluations'}
          </Button>
        </div>
      )}
    </section>
  );
}
