import type { Comparison } from '@acclimate/sdk';

/** Report missing evidence explicitly, including expected cases with no returned pair. */
export function comparisonSummary(comparison: Comparison) {
  const identity = (key: { caseId: string; repetition: number }) =>
    JSON.stringify([key.caseId, key.repetition]);
  const pairs = new Map(comparison.results.map((pair) => [identity(pair), pair]));
  const expected = new Set(comparison.expectedCases.map(identity));
  const rows = [
    ...comparison.expectedCases.map((key) => ({ key, pair: pairs.get(identity(key)) })),
    ...comparison.results
      .filter((pair) => !expected.has(identity(pair)))
      .map((pair) => ({ key: pair, pair })),
  ];
  let scoredPairs = 0,
    missingGrades = 0,
    executionFailures = 0,
    total = 0;
  let knownCost = true;
  for (const { pair } of rows) {
    if (
      pair &&
      [pair.parent, pair.candidate].every(
        (outcome) => outcome.gradingStatus === 'scored' && outcome.reward !== null,
      )
    )
      scoredPairs++;
    for (const outcome of [pair?.parent, pair?.candidate]) {
      if (!outcome || outcome.gradingStatus !== 'scored' || outcome.reward === null)
        missingGrades++;
      if (outcome && outcome.executionStatus !== 'completed') executionFailures++;
      if (outcome?.usage?.costUsd === undefined) knownCost = false;
      else total += outcome.usage.costUsd;
    }
  }
  return { rows, scoredPairs, missingGrades, executionFailures, costUsd: knownCost ? total : null };
}
