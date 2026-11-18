import { useId, useRef, useState } from 'react';
import type { Comparison, Outcome } from '@acclimate/sdk';
import { ArrowUpRight, ChevronRight, FileJson, Link2 } from 'lucide-react';
import {
  evaluationCaseHref,
  evaluationCaseJson,
  evaluationPairs,
  formatReward,
  pairLabels,
  pairSymbols,
  selectPairs,
  type EvaluationPair,
  type PairFilter,
} from '../lib/evaluation-pairs';
import { ConsoleLink } from './console-link';
import { CopyButton } from './copy-button';
import { CodeBlock, CodeBlockContent } from './ui/code-block';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';

function score(outcome?: Outcome) {
  return outcome && outcome.reward !== null && Number.isFinite(outcome.reward)
    ? formatReward(outcome.reward)
    : '—';
}

function CaseInspector({
  row,
  comparison,
  reviewHref,
}: {
  row: EvaluationPair;
  comparison: Comparison;
  reviewHref: string;
}) {
  const { pair } = row;
  const json = evaluationCaseJson(comparison, row);
  return (
    <>
      <div className="triage-selection-identity">
        <span className="triage-pane-label">Selected case</span>
        <h3>{row.key.caseId}</h3>
        <p>Repetition {row.key.repetition}</p>
      </div>
      <div className={'triage-case-signal is-' + row.change}>
        <span aria-hidden="true">{pairSymbols[row.change]}</span>
        <strong>{row.expected ? pairLabels[row.change] : 'Unexpected pair'}</strong>
      </div>
      <table className="triage-case-metrics" aria-label="Selected case outcome metrics">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">Parent</th>
            <th scope="col">Candidate</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Reward</th>
            <td>{score(pair?.parent)}</td>
            <td>{score(pair?.candidate)}</td>
          </tr>
          <tr>
            <th scope="row">Execution</th>
            <td>{pair?.parent?.executionStatus ?? 'Missing'}</td>
            <td>{pair?.candidate?.executionStatus ?? 'Missing'}</td>
          </tr>
          <tr>
            <th scope="row">Grade</th>
            <td>{pair?.parent?.gradingStatus ?? 'Missing'}</td>
            <td>{pair?.candidate?.gradingStatus ?? 'Missing'}</td>
          </tr>
        </tbody>
      </table>
      <h4>Output references</h4>
      <dl className="triage-case-outputs">
        {(['parent', 'candidate'] as const).map((side) => (
          <div key={side}>
            <dt>{side === 'parent' ? 'Parent' : 'Candidate'}</dt>
            <dd>{pair?.[side]?.outputRef || 'None reported'}</dd>
          </div>
        ))}
      </dl>
      <Disclosure>
        <DisclosureTrigger>
          <FileJson aria-hidden="true" />
          Source JSON
        </DisclosureTrigger>
        <DisclosureContent>
          <CodeBlock size="sm">
            <CodeBlockContent wrap className="max-h-64" aria-label="Selected case JSON">
              {json}
            </CodeBlockContent>
          </CodeBlock>
          <CopyButton value={json} label="Copy case JSON" />
        </DisclosureContent>
      </Disclosure>
      <ConsoleLink className="triage-case-permalink" href={evaluationCaseHref(reviewHref, row)}>
        <Link2 aria-hidden="true" />
        Case permalink
        <ArrowUpRight aria-hidden="true" />
      </ConsoleLink>
    </>
  );
}

export function ChangesCaseTriage({
  comparison,
  reviewHref,
  filter,
}: {
  comparison: Comparison;
  reviewHref: string;
  filter: PairFilter;
}) {
  const [chosen, setChosen] = useState('');
  const [limit, setLimit] = useState(25);
  const rows = selectPairs(evaluationPairs(comparison), filter, '');
  const visible = rows.slice(0, limit);
  const selected =
    visible.find((row) => row.id === chosen) ??
    visible.find((row) => row.change === 'higher' || row.change === 'lower') ??
    visible[0];
  const ledger = useRef<HTMLElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const inspectorId = useId();
  function inspect(row: EvaluationPair) {
    setChosen(row.id);
    if (
      inspector.current &&
      ledger.current &&
      inspector.current.offsetTop >= ledger.current.offsetTop + ledger.current.offsetHeight - 1
    ) {
      inspector.current.focus({ preventScroll: true });
      inspector.current.scrollIntoView({ block: 'start' });
    }
  }
  return (
    <>
      <section className="triage-case-ledger" aria-label="Case ledger" ref={ledger}>
        <header className="triage-ledger-heading">
          <h2>{filter === 'all' ? 'All cases' : pairLabels[filter]}</h2>
          <span>
            {rows.length} {rows.length === 1 ? 'pair' : 'pairs'}
          </span>
        </header>
        {visible.length ? (
          <>
            <div className="triage-case-columns" aria-hidden="true">
              <span>Case / repetition</span>
              <span>Parent</span>
              <span>Candidate</span>
              <span className="triage-outcome-label">Reward change</span>
              <span />
            </div>
            <ul className="triage-case-list">
              {visible.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    aria-pressed={row.id === selected?.id}
                    aria-controls={inspectorId}
                    onClick={() => inspect(row)}
                  >
                    <span className="triage-case-name">
                      <strong>{row.key.caseId}</strong>
                      <small>Rep {row.key.repetition}</small>
                    </span>
                    <span className="triage-case-score">
                      <span className="sr-only">Parent </span>
                      {score(row.pair?.parent)}
                    </span>
                    <span className="triage-case-score">
                      <span className="sr-only">Candidate </span>
                      {score(row.pair?.candidate)}
                    </span>
                    <span className={'triage-row-outcome is-' + row.change}>
                      <span aria-hidden="true">{pairSymbols[row.change]}</span>
                      {row.expected ? pairLabels[row.change] : 'Unexpected pair'}
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            {visible.length < rows.length && (
              <button
                type="button"
                className="triage-case-more"
                onClick={() => setLimit(limit + 25)}
              >
                Show more cases ({visible.length} of {rows.length})
              </button>
            )}
          </>
        ) : (
          <p className="triage-case-empty">No case pairs match this queue.</p>
        )}
      </section>
      <section
        id={inspectorId}
        ref={inspector}
        tabIndex={-1}
        className="triage-case-inspector"
        aria-label={selected ? 'Case details for ' + selected.key.caseId : 'Case details'}
      >
        {selected ? (
          <CaseInspector
            key={comparison.id + selected.id}
            comparison={comparison}
            row={selected}
            reviewHref={reviewHref}
          />
        ) : (
          <>
            <h3>Case details</h3>
            <p className="triage-case-empty">
              Choose a queue with recorded cases to inspect an outcome.
            </p>
          </>
        )}
      </section>
    </>
  );
}
