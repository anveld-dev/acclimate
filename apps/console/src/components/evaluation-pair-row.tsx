import { useId } from 'react';
import type { Outcome } from '@acclimate/sdk';
import { type EvaluationPair, pairLabels } from '../lib/evaluation-pairs';
import { Badge } from './ui/badge';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { TableBody, TableRow, TableCell } from './ui/table';

function reward(outcome: Outcome) {
  return outcome.reward == null || !Number.isFinite(outcome.reward)
    ? 'missing'
    : `${outcome.reward > 0 ? '+' : ''}${outcome.reward}`;
}

function SideDetails({ name, outcome }: { name: string; outcome: Outcome | undefined }) {
  return (
    <section className="evaluation-pair-side">
      <h4>{name}</h4>
      {outcome ? (
        <dl>
          <div>
            <dt>Execution</dt>
            <dd>{outcome.executionStatus}</dd>
          </div>
          <div>
            <dt>Grading</dt>
            <dd>{outcome.gradingStatus}</dd>
          </div>
          <div>
            <dt>Reward</dt>
            <dd>{reward(outcome)}</dd>
          </div>
          <div>
            <dt>Reported cost</dt>
            <dd>{outcome.usage?.costUsd == null ? 'unknown' : `$${outcome.usage.costUsd}`}</dd>
          </div>
          <div>
            <dt>Error</dt>
            <dd>{outcome.error || 'None'}</dd>
          </div>
          <div>
            <dt>Output reference</dt>
            <dd>{outcome.outputRef || 'None'}</dd>
          </div>
        </dl>
      ) : (
        <p>Missing outcome · grade missing · cost unknown</p>
      )}
    </section>
  );
}

export function EvaluationPairRow({
  row,
  headers,
}: {
  row: EvaluationPair;
  headers: [string, string, string];
}) {
  const identityId = useId();
  const { key, pair, expected, change } = row;
  return (
    <Disclosure asChild>
      <TableBody role="rowgroup">
        <TableRow className="evaluation-pair-summary" role="row">
          <th
            id={identityId}
            scope="row"
            role="rowheader"
            headers={headers[0]}
            className="evaluation-pair-identity"
          >
            <DisclosureTrigger aria-label={`Inspect case ${key.caseId} / ${key.repetition}`}>
              {key.caseId} / {key.repetition}
            </DisclosureTrigger>
            <Badge variant="outline" className={`pair-change is-${change}`}>
              {expected ? pairLabels[change] : 'Unexpected pair'}
            </Badge>
          </th>
          {([pair?.parent, pair?.candidate] as const).map((outcome, index) => (
            <TableCell
              key={index}
              role="cell"
              headers={`${identityId} ${headers[index + 1]}`}
              data-label={index === 0 ? 'Parent' : 'Candidate'}
              className="evaluation-pair-outcome"
            >
              {outcome ? (
                <>
                  <span>Reward {reward(outcome)}</span>
                  <span className="evaluation-pair-status">
                    <span className="sr-only">Execution </span>
                    {outcome.executionStatus} · <span className="sr-only">Grading </span>
                    {outcome.gradingStatus}
                  </span>
                </>
              ) : (
                <p>Missing outcome · grade missing · cost unknown</p>
              )}
            </TableCell>
          ))}
        </TableRow>
        <DisclosureContent asChild>
          <TableRow className="evaluation-pair-detail" role="row">
            <TableCell colSpan={3} role="cell">
              <div className="evaluation-pair-sides">
                <SideDetails name="Parent" outcome={pair?.parent} />
                <SideDetails name="Candidate" outcome={pair?.candidate} />
              </div>
            </TableCell>
          </TableRow>
        </DisclosureContent>
      </TableBody>
    </Disclosure>
  );
}
