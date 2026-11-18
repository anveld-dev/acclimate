import { useId, useState } from 'react';
import type { Comparison, Outcome } from '@acclimate/sdk';
import { type EvaluationPair, evaluationCaseJson, pairLabels } from '../lib/evaluation-pairs';
import { ConsoleLink } from './console-link';
import { CopyButton } from './copy-button';
import { CodeBlock, CodeBlockContent } from './ui/code-block';
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
  comparison,
  headers,
  initiallyOpen = false,
  caseHref,
}: {
  row: EvaluationPair;
  comparison: Comparison;
  initiallyOpen?: boolean;
  caseHref?: string;
  headers: [string, string, string];
}) {
  const identityId = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const { key, pair, expected, change } = row;
  const caseJson = open ? evaluationCaseJson(comparison, row) : '';
  return (
    <Disclosure asChild open={open} onOpenChange={setOpen}>
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
              {open && (
                <div className="case-export">
                  <Disclosure>
                    <div className="case-export-actions">
                      <DisclosureTrigger>View case JSON</DisclosureTrigger>
                      <div className="case-export-links">
                        {caseHref && (
                          <ConsoleLink data-case-handoff className="underline" href={caseHref}>
                            Case permalink
                          </ConsoleLink>
                        )}
                        <CopyButton value={caseJson} label="Copy case JSON" />
                      </div>
                    </div>
                    <DisclosureContent>
                      <CodeBlock size="sm">
                        <CodeBlockContent className="max-h-72" aria-label="Case evidence JSON" wrap>
                          {caseJson}
                        </CodeBlockContent>
                      </CodeBlock>
                    </DisclosureContent>
                  </Disclosure>
                </div>
              )}
              <div className="evaluation-pair-sides">
                <SideDetails name="Parent" outcome={pair?.parent} />
                <SideDetails name="Candidate" outcome={pair?.candidate} />
              </div>
              {(pair?.parent?.outputRef || pair?.candidate?.outputRef) && (
                <p className="evaluation-pair-artifacts">
                  Review artifacts are private to the app. Use its export command and selected
                  review mapper to share them.
                </p>
              )}
            </TableCell>
          </TableRow>
        </DisclosureContent>
      </TableBody>
    </Disclosure>
  );
}
