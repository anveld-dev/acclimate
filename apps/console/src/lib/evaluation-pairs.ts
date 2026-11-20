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
/**
 * One change per expected case, from the means of its repetitions. This matches the equal-case
 * mean: a case with many repetitions counts once. A case with any unscored pair is not comparable.
 */
export function caseChanges(comparison: Comparison) {
  const cases = new Map<string, { parent: number[]; candidate: number[]; complete: boolean }>();
  for (const row of evaluationPairs(comparison)) {
    if (!row.expected) continue;
    const entry = cases.get(row.key.caseId) ?? { parent: [], candidate: [], complete: true };
    if (row.change === 'unscored') entry.complete = false;
    else {
      entry.parent.push(row.pair!.parent.reward!);
      entry.candidate.push(row.pair!.candidate.reward!);
    }
    cases.set(row.key.caseId, entry);
  }
  const mean = (values: number[]) =>
    values.reduce((value, next, index) => value * (index / (index + 1)) + next / (index + 1), 0);
  return [...cases].map(([caseId, entry]) => {
    const parent = mean(entry.parent),
      candidate = mean(entry.candidate);
    const change: PairChange = !entry.complete
      ? 'unscored'
      : candidate > parent
        ? 'higher'
        : candidate < parent
          ? 'lower'
          : 'same';
    return { caseId, change };
  });
}
export function caseCounts(comparison: Comparison) {
  const counts = { higher: 0, lower: 0, same: 0, unscored: 0 };
  for (const row of caseChanges(comparison)) counts[row.change]++;
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

export function evaluationCaseHref(reviewHref: string, row: EvaluationPair) {
  const url = new URL(reviewHref, 'https://console.invalid');
  url.searchParams.set('pair', 'case:' + row.id);
  return url.pathname + url.search + '#linked-case';
}

export function evaluationCaseJson(comparison: Comparison, row: EvaluationPair) {
  const { key, pair, expected } = row;
  return JSON.stringify(
    {
      caseId: key.caseId,
      repetition: key.repetition,
      expected,
      parent: pair?.parent ?? null,
      candidate: pair?.candidate ?? null,
      comparisonId: comparison.id,
      evaluation: comparison.evaluation ?? null,
      parentVersionId: comparison.parentVersionId,
      parentDigest: comparison.parentDigest,
      candidateVersionId: comparison.candidateVersionId,
      candidateDigest: comparison.candidateDigest,
      datasetRevision: comparison.datasetRevision,
      graderRevision: comparison.graderRevision,
      runtime: comparison.runtime,
    },
    null,
    2,
  );
}
