import type { Comparison, Evaluation } from '@acclimate/sdk';
import type { RequestEvidence } from './changes-workspace';
import { evaluationPairs, type EvaluationPair } from './evaluation-pairs';
import { evaluationScoreSummary } from './evaluation-score-summary';

/** Attach evidence only when its complete experiment identity matches the request. */
export function requestEvidence(
  request: Evaluation,
  comparison: Comparison | null | undefined,
): RequestEvidence {
  if (!comparison) return { status: 'none' };
  if (comparison.id !== request.comparisonId)
    return {
      status: 'mismatch',
      comparison,
      message: 'Comparison does not match this evaluation request.',
    };
  if (!comparison.evaluation)
    return {
      status: 'unbound',
      comparison,
      message: 'This standalone comparison cannot complete an evaluation request.',
    };
  const inventory = (cases: typeof request.expectedCases) =>
    cases.map(({ caseId, repetition }) => JSON.stringify([caseId, repetition])).sort();
  const runtime = (settings: Record<string, string>) =>
    Object.entries(settings).sort(([a], [b]) => a.localeCompare(b));
  const matches =
    comparison.id === request.comparisonId &&
    comparison.evaluation.requestId === request.id &&
    comparison.evaluation.attemptId === request.attemptId &&
    comparison.parentVersionId === request.parentVersionId &&
    comparison.candidateVersionId === request.candidateVersionId &&
    comparison.parentDigest === request.parentDigest &&
    comparison.candidateDigest === request.candidateDigest &&
    comparison.datasetRevision === request.datasetRevision &&
    comparison.graderRevision === request.graderRevision &&
    !!comparison.datasetRevision &&
    !!request.datasetRevision &&
    !!comparison.graderRevision &&
    !!request.graderRevision &&
    !!comparison.runtime &&
    !!request.runtime &&
    Array.isArray(comparison.expectedCases) &&
    Array.isArray(request.expectedCases) &&
    JSON.stringify(runtime(comparison.runtime)) === JSON.stringify(runtime(request.runtime)) &&
    JSON.stringify(inventory(comparison.expectedCases)) ===
      JSON.stringify(inventory(request.expectedCases));
  return matches
    ? { status: 'bound', comparison }
    : {
        status: 'mismatch',
        comparison,
        message: 'Comparison provenance does not match this evaluation request.',
      };
}

export function notComparableReasons(row: EvaluationPair): string[] {
  const reasons = new Set<string>();
  for (const [side, outcome] of [
    ['Parent', row.pair?.parent],
    ['Candidate', row.pair?.candidate],
  ] as const) {
    if (!outcome) {
      reasons.add(`${side}: missing outcome`);
      continue;
    }
    if (outcome.executionStatus === 'infrastructure_failed')
      reasons.add(`${side}: infrastructure failure`);
    if (outcome.gradingStatus !== 'scored')
      reasons.add(
        `${side}: ${outcome.gradingStatus === 'failed' ? 'failed grade' : 'missing grade'}`,
      );
    if (outcome.reward === null || !Number.isFinite(outcome.reward))
      reasons.add(`${side}: null or nonfinite reward`);
  }
  return [...reasons];
}

/** All counts and cost refer to expected case/repetition outcomes only. */
export function evaluationEvidenceSummary(comparison: Comparison) {
  const score = evaluationScoreSummary(comparison);
  const rows = evaluationPairs(comparison);
  let expectedExecutionFailures = 0,
    expectedMissingGrades = 0,
    total = 0,
    known = true;
  for (const row of rows.filter((item) => item.expected)) {
    for (const outcome of [row.pair?.parent, row.pair?.candidate]) {
      if (outcome && outcome.executionStatus !== 'completed') expectedExecutionFailures++;
      if (
        !outcome ||
        outcome.gradingStatus !== 'scored' ||
        outcome.reward === null ||
        !Number.isFinite(outcome.reward)
      )
        expectedMissingGrades++;
      const cost = outcome?.usage?.costUsd;
      if (cost === undefined || !Number.isFinite(cost)) known = false;
      else total += cost;
    }
  }
  return {
    pairedCount: score.pairedCount,
    expectedCount: score.expectedCount,
    parentMean: score.parentMean,
    candidateMean: score.candidateMean,
    partial: !comparison.complete || score.pairedCount < score.expectedCount,
    notComparable: score.expectedCount - score.pairedCount,
    expectedExecutionFailures,
    expectedMissingGrades,
    unexpectedCount: rows.filter((row) => !row.expected).length,
    expectedCostUsd: known ? total : null,
  };
}
