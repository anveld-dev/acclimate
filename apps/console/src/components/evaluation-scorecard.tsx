import type { Comparison } from '@acclimate/sdk';
import { StatusBadge } from './status-badge';
import { evaluationScoreSummary } from '../lib/evaluation-score-summary';
import { evaluationEvidenceSummary } from '../lib/evaluation-history';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';

function reward(value: number) {
  return Math.abs(value) >= 10000 || (value !== 0 && Math.abs(value) < 0.001)
    ? value.toExponential(2)
    : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function EvaluationScorecard({ comparison }: { comparison: Comparison }) {
  const summary = evaluationScoreSummary(comparison);
  const evidence = evaluationEvidenceSummary(comparison);
  // Normalize before subtracting so even opposite finite extremes keep a valid axis.
  const scale = Math.max(Math.abs(summary.minimum), Math.abs(summary.maximum));
  const low = summary.minimum / scale;
  const range = summary.maximum / scale - low;
  const position = (value: number) => ((value / scale - low) / range) * 100;
  const zero = position(0);
  return (
    <section className="evaluation-scorecard" aria-label="Observed paired rewards">
      <div className="evaluation-score-heading">
        <div>
          <h3>Parent vs. candidate</h3>
          <p>
            Observed equal-case mean · {summary.comparableCaseCount} / {summary.expectedCaseCount}{' '}
            expected cases
            {evidence.partial ? ' · partial' : ''}
          </p>
        </div>
        <StatusBadge
          tone={evidence.partial ? 'warning' : 'success'}
          className="evaluation-completeness"
        >
          {evidence.partial ? 'Partial evidence' : 'Complete evidence'}
        </StatusBadge>
      </div>
      <div className="evaluation-score-rows">
        {(
          [
            ['Parent', summary.parentMean, 'parent'],
            ['Saved candidate', summary.candidateMean, 'candidate'],
          ] as const
        ).map(([label, value, side]) => (
          <div className={`evaluation-score-row evaluation-score-${side}`} key={side}>
            <span>{label}</span>
            <div className="evaluation-score-track" aria-hidden="true">
              <span className="evaluation-score-zero" style={{ left: `${zero}%` }} />
              {value !== null && (
                <span
                  className="evaluation-score-bar"
                  style={{
                    left: `${Math.min(zero, position(value))}%`,
                    width: `${Math.abs(position(value) - zero)}%`,
                  }}
                />
              )}
            </div>
            <strong>{value === null ? '—' : reward(value)}</strong>
          </div>
        ))}
      </div>
      <div className="evaluation-score-axis" aria-hidden="true">
        <span>{reward(summary.minimum)}</span>
        <span>{reward(summary.maximum)}</span>
      </div>
      <dl className="evaluation-coverage">
        <div>
          <dt>Scored pairs</dt>
          <dd>
            {summary.pairedCount} / {summary.expectedCount}
          </dd>
        </div>
        <div>
          <dt>Missing grades · expected outcomes</dt>
          <dd>{evidence.expectedMissingGrades}</dd>
        </div>
        <div>
          <dt>Execution failures · expected outcomes</dt>
          <dd>{evidence.expectedExecutionFailures}</dd>
        </div>
        <div>
          <dt>Reported cost · expected outcomes</dt>
          <dd>
            {evidence.expectedCostUsd === null ? 'Unknown' : `$${reward(evidence.expectedCostUsd)}`}
          </dd>
        </div>
      </dl>
      <Disclosure>
        <DisclosureTrigger className="text-muted-foreground text-sm">
          How scores are calculated
        </DisclosureTrigger>
        <DisclosureContent>
          <p className="evaluation-score-note">
            Repetitions are averaged within each case, then cases receive equal weight. Means use{' '}
            {summary.pairedCount} of {summary.expectedCount} expected pairs with two scored,
            gradeable outcomes, across {summary.comparableCaseCount} of {summary.expectedCaseCount}{' '}
            expected cases. Graded task failures stay included; missing grades and infrastructure
            failures are excluded and remain visible below.{' '}
            {evidence.partial
              ? 'This partial view is not an overall result.'
              : 'Complete evidence alone is not a win or release approval.'}{' '}
            Metric direction and application policy are not available here; a higher reward does not
            establish better quality or a passing policy.
          </p>
        </DisclosureContent>
      </Disclosure>
    </section>
  );
}
