import type { Comparison } from '@acclimate/sdk';
import { evaluationEvidenceSummary } from '../lib/evaluation-history';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { Table, TableHeader, TableRow, TableHead } from './ui/table';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import {
  evaluationCaseHref,
  evaluationPairs,
  selectPairs,
  type PairFilter,
} from '../lib/evaluation-pairs';
import { EvaluationCaseMap } from './evaluation-case-map';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { ConsoleLink } from './console-link';
import { EvaluationPairRow } from './evaluation-pair-row';

export function comparisonIncompleteReason(comparison: Comparison): string | null {
  return comparison.complete
    ? null
    : 'Complete evidence is required before this release can be reviewed.';
}

export function ComparisonEvidence({
  comparison,
  compact = false,
  comparisonUrl,
  linkedPair,
}: {
  comparison: Comparison;
  compact?: boolean;
  comparisonUrl?: string;
  linkedPair?: string;
}) {
  const boundaryRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusedRef = useRef<HTMLElement | null>(null);
  const keyboardHandoff = useRef(false);
  useLayoutEffect(() => {
    if (!keyboardHandoff.current) return;
    keyboardHandoff.current = false;
    const target = linkedPair
      ? boundaryRef.current?.querySelector<HTMLElement>('#linked-case')
      : boundaryRef.current?.querySelector<HTMLElement>('[aria-label="Case results"]');
    target?.focus({ preventScroll: true });
  }, [linkedPair]);
  useLayoutEffect(() => {
    // Preserve outside focus; recover only a control removed by this replacement.
    if (
      focusedRef.current &&
      !focusedRef.current.isConnected &&
      document.activeElement === document.body
    ) {
      headingRef.current?.focus();
    }
  }, [comparison.id]);
  return (
    <div
      ref={boundaryRef}
      onClickCapture={(event) => {
        if ((event.target as HTMLElement).closest('a[data-case-handoff]')) {
          keyboardHandoff.current =
            event.detail === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey;
        }
      }}
      onFocusCapture={(event) => {
        focusedRef.current = event.target as HTMLElement;
      }}
      onBlurCapture={(event) => {
        if (!boundaryRef.current?.contains(event.relatedTarget as Node | null))
          focusedRef.current = null;
      }}
    >
      <h3
        ref={headingRef}
        tabIndex={-1}
        className="sr-only focus:not-sr-only focus:mb-3 focus:outline-none"
      >
        Evaluation case results
      </h3>
      <ComparisonEvidenceInner
        key={JSON.stringify([comparison.id, linkedPair])}
        comparison={comparison}
        compact={compact}
        comparisonUrl={comparisonUrl}
        linkedPair={linkedPair}
      />
    </div>
  );
}

function ComparisonEvidenceInner({
  comparison,
  compact,
  comparisonUrl,
  linkedPair,
}: {
  comparison: Comparison;
  compact: boolean;
  comparisonUrl?: string;
  linkedPair?: string;
}) {
  const summary = evaluationEvidenceSummary(comparison);
  const baseId = useId();
  const headers: [string, string, string] = [
    `${baseId}-case`,
    `${baseId}-parent`,
    `${baseId}-candidate`,
  ];
  const searchRef = useRef<HTMLInputElement>(null);
  const mapHeadingRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<PairFilter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const rows = evaluationPairs(comparison);
  const effectiveSelected = selected && rows.some((row) => row.id === selected) ? selected : null;
  const linkedRow = linkedPair ? rows.find((row) => 'case:' + row.id === linkedPair) : undefined;
  const linkedRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (linkedPair) linkedRef.current?.scrollIntoView({ block: 'start' });
  }, [linkedPair]);
  const matches = linkedPair
    ? linkedRow
      ? [linkedRow]
      : []
    : selectPairs(rows, filter, query).filter(
        (row) => !effectiveSelected || row.id === effectiveSelected,
      );
  const lastPage = Math.max(0, Math.ceil(matches.length / 25) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = matches.slice(currentPage * 25, (currentPage + 1) * 25);
  const binding = (
    <>
      <dl className="comparison-evidence-binding text-muted-foreground">
        <div>
          <dt>Candidate</dt>
          <dd>{comparison.candidateVersionId}</dd>
        </div>
        <div>
          <dt>Parent</dt>
          <dd>{comparison.parentVersionId}</dd>
        </div>
        <div>
          <dt>Request</dt>
          <dd>{comparison.evaluation?.requestId ?? 'Standalone comparison'}</dd>
        </div>
      </dl>
      <p className="comparison-evidence-provenance text-muted-foreground">
        {comparison.evaluation && <span>Attempt {comparison.evaluation.attemptId} · </span>}
        <span>Dataset {comparison.datasetRevision} · </span>
        <span>grader {comparison.graderRevision}</span>
      </p>
    </>
  );
  return (
    <div className="comparison-evidence space-y-3">
      {!compact && (
        <dl className="comparison-evidence-summary">
          <div>
            <dt className="sr-only">Inventory</dt>
            <dd className="font-semibold">
              {!summary.partial ? 'Complete inventory' : 'Incomplete evidence; not a win'}
            </dd>
          </div>
          <div>
            <dt className="sr-only">Pair coverage</dt>
            <dd>
              {summary.pairedCount} scored pairs / {summary.expectedCount} expected pairs
            </dd>
          </div>
          <div>
            <dt>Missing grades</dt>
            <dd>{summary.expectedMissingGrades}</dd>
          </div>
          <div>
            <dt>Execution failures</dt>
            <dd>{summary.expectedExecutionFailures}</dd>
          </div>
          <div>
            <dt>Total cost</dt>
            <dd>{summary.expectedCostUsd === null ? 'unknown' : `$${summary.expectedCostUsd}`}</dd>
          </div>
        </dl>
      )}
      {compact ? (
        <Disclosure>
          <DisclosureTrigger>Evidence details</DisclosureTrigger>
          <DisclosureContent className="space-y-3 pt-3">{binding}</DisclosureContent>
        </Disclosure>
      ) : (
        binding
      )}
      {linkedPair && comparisonUrl && (
        <div
          ref={linkedRef}
          id="linked-case"
          className="case-handoff"
          role="group"
          aria-labelledby={baseId + '-linked-heading'}
          tabIndex={-1}
        >
          <div>
            <h4 id={baseId + '-linked-heading'}>
              {linkedRow ? 'Linked case' : 'Case unavailable'}
            </h4>
            {!linkedRow && (
              <p>This comparison contains no case with the linked identifier and repetition.</p>
            )}
          </div>
          <ConsoleLink
            data-case-handoff
            className="underline"
            href={comparisonUrl + '#case-evidence'}
          >
            View all pairs
          </ConsoleLink>
        </div>
      )}
      {!linkedPair && (
        <>
          <div ref={mapHeadingRef} tabIndex={-1} role="group" aria-label="Case results">
            <EvaluationCaseMap
              rows={rows}
              filter={filter}
              selected={effectiveSelected}
              onFilter={(value) => {
                setFilter(value);
                setSelected(null);
                setPage(0);
              }}
              onSelect={(value) => {
                setSelected(value);
                setQuery('');
                setPage(0);
              }}
            />
          </div>
          <div className="evaluation-case-toolbar flex flex-wrap items-center gap-2">
            <Input
              ref={searchRef}
              className="max-w-sm"
              aria-label="Search evaluation cases"
              placeholder="Find a case…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(null);
                setPage(0);
              }}
            />
            {query && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setPage(0);
                  searchRef.current?.focus();
                }}
              >
                Clear search
              </Button>
            )}
            {effectiveSelected && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSelected(null);
                  mapHeadingRef.current?.focus();
                }}
              >
                Show all pairs
              </Button>
            )}
          </div>
        </>
      )}
      {(!linkedPair || linkedRow) && (
        <Table
          className="comparison-evidence-table min-w-[32rem] table-fixed text-sm"
          aria-label="Evaluation case outcomes"
          role="table"
        >
          <TableHeader role="rowgroup">
            <TableRow role="row">
              <TableHead id={headers[0]} scope="col" role="columnheader" className="w-[24%]">
                Case / repetition
              </TableHead>
              <TableHead id={headers[1]} scope="col" role="columnheader" className="w-[38%]">
                Parent
              </TableHead>
              <TableHead id={headers[2]} scope="col" role="columnheader" className="w-[38%]">
                Candidate
              </TableHead>
            </TableRow>
          </TableHeader>
          {visible.map((row) => (
            <EvaluationPairRow
              key={row.id}
              row={row}
              headers={headers}
              comparison={comparison}
              initiallyOpen={!!linkedRow}
              caseHref={
                comparisonUrl && !linkedRow ? evaluationCaseHref(comparisonUrl, row) : undefined
              }
            />
          ))}
        </Table>
      )}
      {!linkedPair && !matches.length && (
        <p className="py-4 text-sm text-muted-foreground" role="status">
          No cases match this view.
        </p>
      )}
      {!linkedPair && (
        <div className="evaluation-case-pagination flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground" role="status">
            {matches.length
              ? `${currentPage * 25 + 1}–${Math.min((currentPage + 1) * 25, matches.length)} of ${matches.length} pairs`
              : '0 pairs'}
          </p>
          {matches.length > 25 && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous cases
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={currentPage === lastPage}
                onClick={() => setPage(currentPage + 1)}
              >
                Next cases
              </Button>
            </div>
          )}
        </div>
      )}
      {!compact && (
        <p className="comparison-evidence-note text-muted-foreground">
          Missing outcomes and grades remain missing. Unknown usage is not zero. Complete evidence
          alone is not a win, statistical proof or release approval.
        </p>
      )}
    </div>
  );
}
