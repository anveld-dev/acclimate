import type { Comparison, Outcome } from '@acclimate/sdk';

/** Arithmetic from the actual researcher persona, with synthetic transport identities.
 * Source: docs/acceptance/developer-personas-20261117/evaluation-researcher.json observedRewards.
 * Unknown usage is deliberately retained. This fixture makes no quality verdict.
 */
export function unequalRepetitionsComparison(): Comparison {
  const outcome = (reward: number): Outcome => ({
    executionStatus: 'completed',
    gradingStatus: 'scored',
    reward,
    usage: null,
    outputRef: null,
    error: null,
  });
  const results = [
    ...[0, 1, 2].map((repetition) => ({
      caseId: 'routine',
      repetition,
      parent: outcome(0.4),
      candidate: outcome(0.8),
    })),
    { caseId: 'critical', repetition: 0, parent: outcome(1), candidate: outcome(0) },
  ];
  return {
    id: 'unequal-repetitions-fixture',
    complete: true,
    parentVersionId: 'parent',
    candidateVersionId: 'candidate',
    parentDigest: 'parent-digest',
    candidateDigest: 'candidate-digest',
    datasetRevision: 'researcher-unequal-repetitions',
    graderRevision: 'label-match-fixture',
    runtime: {},
    expectedCases: results.map(({ caseId, repetition }) => ({ caseId, repetition })),
    results,
    submitter: 'fixture',
    createdAt: '2026-11-17T00:00:00Z',
  };
}
