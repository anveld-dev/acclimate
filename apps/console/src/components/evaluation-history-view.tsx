import { Fragment, useId, useLayoutEffect, useRef } from 'react';
import type { Comparison, Evaluation, Outcome } from '@acclimate/sdk';
import type { EvaluationHistoryViewProps, RequestEvidence } from '../lib/changes-workspace';
import { evaluationEvidenceSummary, notComparableReasons } from '../lib/evaluation-history';
import { evaluationPairs, formatReward, pairCounts, pairLabels } from '../lib/evaluation-pairs';
import { Button } from './ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';
import { CopyButton } from './copy-button';

const value = (text: string | null | undefined) => text || 'Unavailable';
const reward = (number: number | null | undefined) =>
  number == null || !Number.isFinite(number) ? '—' : formatReward(number);

function EvidenceState({ evidence }: { evidence: RequestEvidence }) {
  switch (evidence.status) {
    case 'none':
      return <span>{evidence.message || 'No comparison reported'}</span>;
    case 'loading':
      return <span>Loading evidence…</span>;
    case 'unavailable':
      return (
        <span>
          Evidence unavailable · retrying automatically
          {evidence.message ? `: ${evidence.message}` : ''}
        </span>
      );
    case 'mismatch':
      return <span>Evidence binding mismatch: {evidence.message}</span>;
    case 'unbound':
      return <span>Legacy unbound evidence: {evidence.message}</span>;
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
      <h4>Expected case preview</h4>
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
    </div>
  );
}

function Detail({
  request,
  evidence,
  href,
  detailRef,
  onClose,
}: {
  request: Evaluation;
  evidence: RequestEvidence;
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
      {request.error && <p>Request error: {request.error}</p>}
      {evidence.status === 'bound' ? (
        <BoundEvidence comparison={evidence.comparison} />
      ) : (
        <p>
          <EvidenceState evidence={evidence} />
        </p>
      )}
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
      <div className="evaluation-ledger-actions">
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
    </div>
  );
}

export function EvaluationHistoryView({
  model,
  selectedCandidateId,
  selectedRequestId,
  onSelectRequest,
  reviewHref,
}: EvaluationHistoryViewProps) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const detail = useRef<HTMLDivElement | null>(null);
  const selected = selectedRequestId;
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
  const rows = pinned ? [pinned, ...loaded] : loaded;
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
      className="evaluation-ledger"
      data-version-context={Boolean(selectedCandidateId)}
      aria-labelledby={`${id}-heading`}
    >
      <div className="evaluation-ledger-heading">
        <h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>
          Evaluation history
        </h3>
        <span>
          {loaded.length} loaded {loaded.length === 1 ? 'request' : 'requests'}
          {selectedCandidateId ? ' for this version' : ' across bundle channels'}
        </span>
      </div>
      <p className="evaluation-ledger-note">
        Each request is a separate experiment; datasets, graders and runtimes may differ.
      </p>
      {model.error && (
        <p role="alert">{model.error} Displayed history may be stale. Retrying automatically.</p>
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
      {!rows.length && (
        <p role="status">
          {model.loading && !model.requests.length
            ? 'Loading evaluations…'
            : model.error && !model.requests.length
              ? 'Evaluation history is unavailable.'
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
          <Table className="evaluation-ledger-table">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Evaluation</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col" id={`${id}-coverage`}>
                  Gradeable paired / expected
                </TableHead>
                <TableHead scope="col">Observed paired mean</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((request) => {
                const open = selected === request.id;
                const evidence =
                  model.evidence[request.id] ??
                  ({ status: request.comparisonId ? 'loading' : 'none' } as RequestEvidence);
                const summary =
                  evidence.status === 'bound'
                    ? evaluationEvidenceSummary(evidence.comparison)
                    : null;
                const detailId = `${id}-detail-${encodeURIComponent(request.id)}`;
                const coverageId = `${id}-coverage-${encodeURIComponent(request.id)}`;
                return (
                  <Fragment key={request.id}>
                    <TableRow className={open ? 'evaluation-ledger-selected' : ''}>
                      <TableCell>
                        <Button
                          ref={(node) => {
                            if (node) triggers.current.set(request.id, node);
                            else triggers.current.delete(request.id);
                          }}
                          variant="ghost"
                          className="evaluation-ledger-trigger"
                          aria-expanded={open}
                          aria-controls={detailId}
                          onClick={() => onSelectRequest(open ? null : request)}
                        >
                          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                          <span>
                            <strong>{value(request.datasetRevision)}</strong>
                            <small>
                              Request {request.id.slice(0, 8)} ·{' '}
                              <time dateTime={request.createdAt} title={request.createdAt}>
                                {Number.isNaN(Date.parse(request.createdAt))
                                  ? 'Date unavailable'
                                  : new Date(request.createdAt).toLocaleString(undefined, {
                                      dateStyle: 'short',
                                      timeStyle: 'short',
                                    })}
                              </time>
                              {pinned?.id === request.id && ' · Selected outside loaded history'}
                            </small>
                          </span>
                        </Button>
                      </TableCell>
                      <TableCell>{request.status}</TableCell>
                      <TableCell id={coverageId}>
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
                        aria-describedby={summary ? `${id}-coverage ${coverageId}` : undefined}
                      >
                        {summary ? (
                          <>
                            <span>
                              Parent {reward(summary.parentMean)} · Candidate{' '}
                              {reward(summary.candidateMean)}
                            </span>
                          </>
                        ) : (
                          <EvidenceState evidence={evidence} />
                        )}
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow className="evaluation-ledger-detail-row">
                        <TableCell colSpan={4} id={detailId}>
                          <Detail
                            request={request}
                            evidence={evidence}
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
