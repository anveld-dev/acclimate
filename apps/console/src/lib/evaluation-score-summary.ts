import type { Comparison } from '@acclimate/sdk';
import { comparisonSummary } from './comparison-summary';
import { gradeable } from './evaluation-pairs';

/** Average comparable repetitions within each expected case, then weight cases equally.
 * Incomplete evidence describes only the observed subset; it never supplies a policy verdict.
 */
export function evaluationScoreSummary(comparison: Comparison) {
  const summary = comparisonSummary(comparison);
  const pairs = summary.rows
    .slice(0, comparison.expectedCases.length)
    .flatMap(({ pair }) => (pair && [pair.parent, pair.candidate].every(gradeable) ? [pair] : []));
  const cases = new Map<string, typeof pairs>();
  for (const pair of pairs) {
    const repetitions = cases.get(pair.caseId) ?? [];
    repetitions.push(pair);
    cases.set(pair.caseId, repetitions);
  }
  // Weighted running means avoid overflowing a sum of otherwise finite rewards.
  const average = (values: number[]) =>
    values.reduce((value, next, index) => value * (index / (index + 1)) + next / (index + 1), 0);
  const mean = (side: 'parent' | 'candidate') =>
    cases.size
      ? average(
          [...cases.values()].map((repetitions) =>
            average(repetitions.map((pair) => pair[side].reward!)),
          ),
        )
      : null;
  const parentMean = mean('parent');
  const candidateMean = mean('candidate');
  const minimum = Math.min(0, parentMean ?? 0, candidateMean ?? 0);
  const maximum = Math.max(0, parentMean ?? 0, candidateMean ?? 0);
  return {
    pairedCount: pairs.length,
    expectedCount: comparison.expectedCases.length,
    comparableCaseCount: cases.size,
    expectedCaseCount: new Set(comparison.expectedCases.map(({ caseId }) => caseId)).size,
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
