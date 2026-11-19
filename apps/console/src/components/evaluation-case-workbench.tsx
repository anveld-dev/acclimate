import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Comparison, Outcome } from '@acclimate/sdk';
import { ArrowUpRight, Braces, ChevronRight, Download, Link2, Search } from 'lucide-react';
import {
  evaluationCaseHref,
  evaluationCaseJson,
  evaluationPairs,
  pairCounts,
  pairLabels,
  pairSymbols,
  selectPairs,
  type EvaluationPair,
  type PairFilter,
} from '../lib/evaluation-pairs';
import { Button } from './ui/button';
import { CopyButton } from './copy-button';
import { ConsoleLink } from './console-link';
import { CodeBlock, CodeBlockContent } from './ui/code-block';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { Input } from './ui/input';

const fields: {
  name: string;
  read: (outcome: Outcome) => string | number | null | undefined;
  empty: string;
}[] = [
  { name: 'Reward', read: (o) => o.reward, empty: 'Missing' },
  { name: 'Execution', read: (o) => o.executionStatus, empty: 'Missing' },
  { name: 'Grading', read: (o) => o.gradingStatus, empty: 'Missing' },
  {
    name: 'Reported cost',
    read: (o) => (o.usage?.costUsd == null ? null : '$' + o.usage.costUsd),
    empty: 'Unknown',
  },
  { name: 'Error', read: (o) => o.error, empty: 'None reported' },
  { name: 'Output reference', read: (o) => o.outputRef, empty: 'None reported' },
];

function OutcomeComparison({
  row,
  comparison,
  href,
}: {
  row: EvaluationPair;
  comparison: Comparison;
  href: string;
}) {
  const json = evaluationCaseJson(comparison, row);
  const { parent, candidate } = row.pair ?? {};
  // Lead with what differs; identical evidence folds into one row instead of repeating.
  const values = fields.map((field) => {
    const a = parent ? (field.read(parent) ?? field.empty) : 'Missing outcome';
    const b = candidate ? (field.read(candidate) ?? field.empty) : 'Missing outcome';
    return { name: field.name, a, b, same: a === b };
  });
  const identical = values.filter(({ name, same }) => same && name !== 'Reward');
  function download() {
    const url = URL.createObjectURL(new Blob([json + '\n'], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'evaluation-case.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <div className="case-review-top">
        <div>
          <p>Case / repetition {row.key.repetition}</p>
          <h3>{row.key.caseId}</h3>
        </div>
        <span className={'case-review-change is-' + row.change}>
          <span aria-hidden="true">{pairSymbols[row.change]}</span>
          {row.expected ? pairLabels[row.change] : 'Unexpected pair'}
        </span>
      </div>
      <table className="case-review-matrix" aria-label="Selected parent and candidate outcomes">
        <colgroup>
          <col className="case-review-field-col" />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Evidence</th>
            <th scope="col">
              Parent<span>{comparison.parentVersionId.slice(0, 8)}</span>
            </th>
            <th scope="col">
              Candidate<span>{comparison.candidateVersionId.slice(0, 8)}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {values
            .filter(({ name, same }) => name === 'Reward' || !same)
            .map(({ name, a, b }) => {
              return (
                <tr
                  key={name}
                  data-different={a !== b || undefined}
                  data-reward={name === 'Reward' || undefined}
                  data-reference={name === 'Output reference' || undefined}
                >
                  <th scope="row">
                    {name}
                    {a !== b && <span className="case-review-difference">Differs</span>}
                  </th>
                  <td>{a}</td>
                  <td data-candidate-change={name === 'Reward' ? row.change : undefined}>{b}</td>
                </tr>
              );
            })}
          {identical.length > 0 && (
            <tr className="case-review-identical">
              <th scope="row">Same on both</th>
              <td colSpan={2}>
                <ul>
                  {identical.map(({ name, a }) => (
                    <li key={name}>
                      <span>{name}</span> {a}
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="case-review-tools">
        <ConsoleLink
          data-review-handoff
          className="case-review-link"
          href={evaluationCaseHref(href, row)}
        >
          <Link2 aria-hidden="true" />
          Case permalink
          <ArrowUpRight aria-hidden="true" />
        </ConsoleLink>
        <CopyButton label="Copy case JSON" value={json} />
        <Button size="sm" variant="outline" onClick={download}>
          <Download aria-hidden="true" />
          Download case JSON
        </Button>
      </div>
      <Disclosure>
        <DisclosureTrigger>
          <Braces aria-hidden="true" />
          View case JSON
        </DisclosureTrigger>
        <DisclosureContent>
          <CodeBlock size="sm">
            <CodeBlockContent wrap className="max-h-72" aria-label="Case evidence JSON">
              {json}
            </CodeBlockContent>
          </CodeBlock>
        </DisclosureContent>
      </Disclosure>
    </>
  );
}

export function EvaluationCaseWorkbench({
  comparison,
  reviewHref,
  linkedPair,
}: {
  comparison: Comparison;
  reviewHref: string;
  linkedPair?: string;
}) {
  const rows = evaluationPairs(comparison);
  const counts = pairCounts(rows);
  const defaultFilter = counts.lower ? 'lower' : 'all';
  const [filter, setFilter] = useState<PairFilter>(defaultFilter);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState('');
  const [page, setPage] = useState(0);
  const linkedIndex = linkedPair ? rows.findIndex((r) => 'case:' + r.id === linkedPair) : -1;
  const linked = rows[linkedIndex];
  const linkedId = linked?.id;
  const matches = linkedPair ? (linked ? [linked] : []) : selectPairs(rows, filter, query);
  const pageStart = linkedPair
    ? 0
    : Math.min(page, Math.max(0, Math.ceil(matches.length / 25) - 1)) * 25;
  const visible = matches.slice(pageStart, pageStart + 25);
  const row =
    visible.find((r) => r.id === chosen) ??
    visible.find((r) => r.change === 'higher' || r.change === 'lower') ??
    visible[0];
  const heading = useRef<HTMLHeadingElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const keyboard = useRef(false);
  const id = useId();
  const searchId = useId();
  useLayoutEffect(() => {
    const target = linkedPair ? inspector.current : heading.current;
    if (linkedPair) target?.scrollIntoView({ block: 'start' });
    if (keyboard.current) target?.focus({ preventScroll: true });
    keyboard.current = false;
    setQuery('');
    setFilter(defaultFilter);
    if (linkedId) {
      setChosen(linkedId);
      setPage(Math.floor(linkedIndex / 25));
    }
  }, [linkedPair, linkedIndex, linkedId, defaultFilter]);
  function choose(id: string) {
    setChosen(id);
    const pane = inspector.current;
    if (
      pane &&
      pane.getBoundingClientRect().top - (heading.current?.getBoundingClientRect().top ?? 0) > 100
    ) {
      pane.focus({ preventScroll: true });
      pane.scrollIntoView({ block: 'start' });
    }
  }
  return (
    <section
      className="case-review-workbench"
      aria-label="Evaluation case comparison"
      id="case-evidence"
      tabIndex={-1}
      onClickCapture={(e) => {
        if ((e.target as Element).closest('a[data-review-handoff]'))
          keyboard.current = e.detail === 0 && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      }}
    >
      <aside className="case-review-browser" aria-label="Evaluation case browser">
        <header>
          <h3 ref={heading} tabIndex={-1}>
            Cases
          </h3>
          <span>
            {linkedPair ? matches.length : rows.length}{' '}
            {(!linkedPair ? rows.length : matches.length) === 1 ? 'pair' : 'pairs'}
          </span>
        </header>
        {linkedPair ? (
          <ConsoleLink
            data-review-handoff
            className="case-review-back"
            href={reviewHref + '#case-evidence'}
          >
            View all pairs
          </ConsoleLink>
        ) : (
          <div className="case-browser-controls">
            <label className="case-browser-search" htmlFor={searchId}>
              <span className="sr-only">Search evaluation cases</span>
              <Search aria-hidden="true" />
              <Input
                id={searchId}
                placeholder="Find a case…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <select
              aria-label="Filter case results"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value as PairFilter);
                setPage(0);
              }}
            >
              <option value="all">All reward changes ({rows.length})</option>
              {(['lower', 'higher', 'same', 'unscored'] as const).map((k) => (
                <option key={k} value={k}>
                  {pairLabels[k]} ({counts[k]})
                </option>
              ))}
            </select>
          </div>
        )}
        <ul>
          {visible.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                aria-controls={linkedPair ? 'linked-case' : id}
                aria-pressed={r.id === row?.id}
                onClick={() => choose(r.id)}
              >
                <span>
                  <strong>{r.key.caseId}</strong>
                  <small>
                    Rep {r.key.repetition}{' '}
                    <span className={'case-list-status is-' + r.change}>
                      <span aria-hidden="true">{pairSymbols[r.change]}</span>{' '}
                      {r.expected ? pairLabels[r.change] : 'Unexpected pair'}
                    </span>
                  </small>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        {!linkedPair && matches.length > 25 && (
          <div className="case-review-paging">
            <span>
              {pageStart + 1}–{pageStart + visible.length} of {matches.length}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={pageStart === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pageStart + visible.length >= matches.length}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        )}
        {!visible.length && (
          <p role="status">{linkedPair ? 'Case unavailable' : 'No matching cases.'}</p>
        )}
      </aside>
      <section
        ref={inspector}
        id={linkedPair ? 'linked-case' : id}
        tabIndex={-1}
        className="case-review-inspector"
        aria-label={row ? 'Outcomes for ' + row.key.caseId : 'Case outcomes'}
      >
        {linkedPair && (
          <span className="case-review-linked">{linked ? 'Linked case' : 'Case unavailable'}</span>
        )}
        {row ? (
          <OutcomeComparison key={row.id} row={row} comparison={comparison} href={reviewHref} />
        ) : (
          <p>
            {linkedPair
              ? 'This comparison contains no case with the linked identifier and repetition.'
              : 'Choose another reward change or search term to inspect a pair.'}
          </p>
        )}
      </section>
    </section>
  );
}
