import type { Comparison } from '@acclimate/sdk';
import { StatusBadge } from './status-badge';
import { evaluationScoreSummary } from '../lib/evaluation-score-summary';
import { evaluationEvidenceSummary } from '../lib/evaluation-history';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';
import { caseCounts, pairLabels, pairSymbols } from '../lib/evaluation-pairs';

/** The statistic a recorded policy verdict computed for this comparison, if any. */
export interface ScorecardInference {
  method: string;
  confidence?: number | null;
  n?: number;
  lowerBound?: number | null;
  threshold?: number;
  status?: string;
}

function reward(value: number) {
  return Math.abs(value) >= 10000 || (value !== 0 && Math.abs(value) < 0.001)
    ? value.toExponential(2)
    : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function inferenceNote(inference: ScorecardInference | undefined) {
  if (!inference || inference.method !== 'paired-t')
    return 'No confidence interval · observed means for these cases';
  if (inference.lowerBound == null || inference.status !== 'estimated')
    return `Policy test: insufficient data (${inference.n ?? 0} cases)`;
  return `Policy lower bound ${reward(inference.lowerBound)} vs threshold ${reward(
    inference.threshold ?? 0,
  )} · ${Math.round((inference.confidence ?? 0) * 1000) / 10}% one-sided · ${inference.n} cases`;
}

/**
 * The headline of a comparison: the mean reward change and how cases moved. The change is shown
 * in a neutral tone because the metric direction is not known here; a higher reward is not
 * necessarily better.
 */
export function EvaluationOutcomeStrip({
  comparison,
  inference,
}: {
  comparison: Comparison;
  inference?: ScorecardInference;
}) {
  const summary = evaluationScoreSummary(comparison);
  const evidence = evaluationEvidenceSummary(comparison);
  const counts = caseCounts(comparison);
  const { parentMean, candidateMean } = summary;
  const delta = parentMean === null || candidateMean === null ? null : candidateMean - parentMean;
  const direction =
    delta === null || !Number.isFinite(delta)
      ? 'unknown'
      : delta > 0
        ? 'up'
        : delta < 0
          ? 'down'
          : 'flat';
  const total = counts.higher + counts.same + counts.lower + counts.unscored;
  const segments = (['higher', 'same', 'lower', 'unscored'] as const).filter((key) => counts[key]);
  const caseLabel = (key: keyof typeof counts) =>
    `${counts[key]} ${counts[key] === 1 ? 'case' : 'cases'} ${pairLabels[key].toLowerCase()}`;
  const breakdown = segments.map(caseLabel);
  return (
    <section className="evaluation-outcome-strip" aria-label="Result summary">
      <div className="outcome-metric">
        <span className="outcome-label">Candidate mean reward</span>
        <span className="outcome-value">
          {candidateMean === null ? '—' : reward(candidateMean)}
          {delta !== null && Number.isFinite(delta) && (
            <span className="outcome-delta" data-direction={direction}>
              {/* Matches the change cards: direction is shown, not only colored. */}
              <span aria-hidden="true">{delta > 0 ? '▲ ' : delta < 0 ? '▼ ' : ''}</span>
              {delta > 0 ? '+' : ''}
              {reward(delta)}
            </span>
          )}
        </span>
        <span className="outcome-note">
          Parent {parentMean === null ? '—' : reward(parentMean)} · equal-case mean
        </span>
        <span className="outcome-note outcome-inference">{inferenceNote(inference)}</span>
      </div>
      <div className="outcome-pairs">
        <span className="outcome-label">
          Cases · {summary.comparableCaseCount} of {summary.expectedCaseCount} fully scored ·{' '}
          {summary.pairedCount} of {summary.expectedCount} pairs
        </span>
        {total > 0 && (
          <div className="outcome-bar" role="img" aria-label={breakdown.join(', ')}>
            {segments.map((key) => (
              <span
                key={key}
                data-change={key}
                style={{ flexGrow: counts[key] }}
                title={caseLabel(key)}
              />
            ))}
          </div>
        )}
        <ul className="outcome-legend" aria-hidden="true">
          {segments.map((key) => (
            <li key={key} data-change={key}>
              <span aria-hidden="true">{pairSymbols[key]}</span> {caseLabel(key)}
            </li>
          ))}
        </ul>
      </div>
      <StatusBadge tone={evidence.partial ? 'warning' : 'success'} className="outcome-completeness">
        {evidence.partial ? 'Partial evidence' : 'Complete evidence'}
      </StatusBadge>
      {evidence.partial && (
        <p className="outcome-missing">
          Unscored outcomes · parent {summary.parentUnusable} · candidate{' '}
          {summary.candidateUnusable}
          {summary.oneSidedMissing
            ? ' · missing on one arm only, so means of the complete pairs may be biased'
            : ''}
        </p>
      )}
    </section>
  );
}

export function EvaluationScorecard({
  comparison,
  compact = false,
}: {
  comparison: Comparison;
  compact?: boolean;
}) {
  const summary = evaluationScoreSummary(comparison);
  const evidence = evaluationEvidenceSummary(comparison);
  if (compact) {
    // The result summary above the evidence carries the reward change; this keeps coverage.
    return (
      <section className="review-section space-y-2 p-3" aria-label="Score summary">
        <h3 className="font-semibold">Evidence coverage</h3>
        <dl className="review-score-facts text-sm">
          <dt>Scored pairs</dt>
          <dd>
            {summary.pairedCount} / {summary.expectedCount}
          </dd>
          <dt>Missing grades</dt>
          <dd>{evidence.expectedMissingGrades}</dd>
          <dt>Execution failures</dt>
          <dd>{evidence.expectedExecutionFailures}</dd>
          <dt>Unscored · parent / candidate</dt>
          <dd>
            {summary.parentUnusable} / {summary.candidateUnusable}
          </dd>
          <dt>Reported cost</dt>
          <dd>
            {evidence.expectedCostUsd === null ? 'Unknown' : '$' + reward(evidence.expectedCostUsd)}
          </dd>
        </dl>
      </section>
    );
  }
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
          <dt>Unscored · parent / candidate</dt>
          <dd>
            {summary.parentUnusable} / {summary.candidateUnusable}
            {summary.oneSidedMissing ? ' · one-sided' : ''}
          </dd>
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
            These are observed means with no confidence interval. A recorded policy verdict shows
            its lower bound and threshold. Metric direction is not available here; a higher reward
            does not establish better quality or a passing policy.
          </p>
        </DisclosureContent>
      </Disclosure>
    </section>
  );
}
