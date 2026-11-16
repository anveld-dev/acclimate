import type { Comparison, Outcome } from '@acclimate/sdk';
import { comparisonSummary } from './comparison-summary';

export type PairChange = 'higher' | 'lower' | 'same' | 'unscored';
export type PairFilter = 'all' | PairChange;
export const pairLabels: Record<PairChange, string> = {
  higher: 'Higher reward',
  lower: 'Lower reward',
  same: 'Same reward',
  unscored: 'Not comparable',
};
export const pairSymbols: Record<PairChange, string> = {
  higher: '↑',
  lower: '↓',
  same: '=',
  unscored: '?',
};
export const caseIdentity = (key: { caseId: string; repetition: number }) =>
  JSON.stringify([key.caseId, key.repetition]);

export function gradeable(outcome: Outcome | undefined): outcome is Outcome & { reward: number } {
  return (
    !!outcome &&
    outcome.executionStatus !== 'infrastructure_failed' &&
    outcome.gradingStatus === 'scored' &&
    outcome.reward !== null &&
    Number.isFinite(outcome.reward)
  );
}

/** Only expected, paired evidence can describe a reward change. Missing is never zero. */
export function evaluationPairs(comparison: Comparison) {
  return comparisonSummary(comparison).rows.map(({ key, pair }, index) => {
    const expected = index < comparison.expectedCases.length;
    const change: PairChange =
      !expected || !gradeable(pair?.parent) || !gradeable(pair?.candidate)
        ? 'unscored'
        : pair.candidate.reward > pair.parent.reward
          ? 'higher'
          : pair.candidate.reward < pair.parent.reward
            ? 'lower'
            : 'same';
    return { key, pair, expected, change, id: caseIdentity(key) };
  });
}
export type EvaluationPair = ReturnType<typeof evaluationPairs>[number];
export function pairCounts(rows: EvaluationPair[]) {
  const counts = { higher: 0, lower: 0, same: 0, unscored: 0 };
  for (const row of rows) if (row.expected) counts[row.change]++;
  return counts;
}
export function selectPairs(rows: EvaluationPair[], filter: PairFilter, query: string) {
  const search = query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (filter === 'all' || (row.expected && row.change === filter)) &&
      (!search || `${row.key.caseId} / ${row.key.repetition}`.toLocaleLowerCase().includes(search)),
  );
}
export function formatReward(value: number) {
  return Math.abs(value) >= 10000 || (value !== 0 && Math.abs(value) < 0.001)
    ? value.toExponential(2)
    : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}
