import type { Comparison } from '@acclimate/sdk';
import { comparisonSummary } from './comparison-summary';
import { gradeable } from './evaluation-pairs';

/** Compare only expected cases with two gradeable, scored outcomes. Task failures can carry valid grades. */
export function evaluationScoreSummary(comparison: Comparison) {
  const summary = comparisonSummary(comparison);
  const pairs = summary.rows
    .slice(0, comparison.expectedCases.length)
    .flatMap(({ pair }) => (pair && [pair.parent, pair.candidate].every(gradeable) ? [pair] : []));
  const mean = (side: 'parent' | 'candidate') =>
    pairs.length
      ? pairs.reduce(
          (value, pair, index) => value * (index / (index + 1)) + pair[side].reward! / (index + 1),
          0,
        )
      : null;
  const parentMean = mean('parent');
  const candidateMean = mean('candidate');
  const minimum = Math.min(0, parentMean ?? 0, candidateMean ?? 0);
  const maximum = Math.max(0, parentMean ?? 0, candidateMean ?? 0);
  return {
    pairedCount: pairs.length,
    expectedCount: comparison.expectedCases.length,
    parentMean,
    candidateMean,
    minimum,
    maximum: maximum === minimum ? 1 : maximum,
    missingGrades: summary.missingGrades,
    executionFailures: summary.executionFailures,
    complete: comparison.complete,
    costUsd: summary.costUsd,
  };
}
