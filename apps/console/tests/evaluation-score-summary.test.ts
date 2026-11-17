import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { CasePair, Comparison, Outcome } from '@acclimate/sdk';
import { evaluationScoreSummary } from '../src/lib/evaluation-score-summary';
import { unequalRepetitionsComparison } from './fixtures/unequal-repetitions';

function outcome(reward: number | null, overrides: Partial<Outcome> = {}): Outcome {
  return {
    executionStatus: 'completed',
    gradingStatus: reward === null ? 'missing' : 'scored',
    reward,
    usage: { costUsd: 0 },
    outputRef: null,
    error: null,
    ...overrides,
  };
}
function pair(caseId: string, parent: Outcome, candidate: Outcome, repetition = 0): CasePair {
  return { caseId, repetition, parent, candidate };
}
function comparison(results: CasePair[], overrides: Partial<Comparison> = {}): Comparison {
  return {
    id: 'report',
    parentVersionId: 'parent',
    candidateVersionId: 'candidate',
    parentDigest: 'parent-digest',
    candidateDigest: 'candidate-digest',
    datasetRevision: 'fixture',
    graderRevision: 'fixture-grader',
    runtime: {},
    expectedCases: results.map(({ caseId, repetition }) => ({ caseId, repetition })),
    results,
    complete: true,
    submitter: 'fixture-app',
    createdAt: '2026-11-15T00:00:00Z',
    ...overrides,
  };
}

test('zero rewards and zero reported cost remain real values', () => {
  const result = evaluationScoreSummary(comparison([pair('zero', outcome(0), outcome(0))]));
  assert.equal(result.parentMean, 0);
  assert.equal(result.candidateMean, 0);
  assert.equal(result.pairedCount, 1);
  assert.equal(result.expectedCount, 1);
  assert.equal(result.costUsd, 0);
  assert.equal(result.complete, true);
  assert.ok(Number.isFinite(result.minimum) && Number.isFinite(result.maximum));
  assert.ok(result.maximum > result.minimum, 'The all-zero chart still needs a usable axis');
});

test('only matched expected pairs contribute to both observed means', () => {
  const result = evaluationScoreSummary(
    comparison(
      [pair('returned', outcome(2), outcome(4)), pair('unrequested', outcome(100), outcome(-100))],
      {
        complete: false,
        expectedCases: [
          { caseId: 'returned', repetition: 0 },
          { caseId: 'absent', repetition: 0 },
        ],
      },
    ),
  );
  assert.equal(result.pairedCount, 1);
  assert.equal(result.expectedCount, 2);
  assert.equal(result.parentMean, 2);
  assert.equal(result.candidateMean, 4);
  assert.equal(result.missingGrades, 2);
  assert.equal(result.costUsd, null, 'An absent expected outcome has unknown cost');
  assert.equal(result.complete, false, 'A good observed subset cannot become complete evidence');
});

test('one missing grade excludes the entire pair from both means', () => {
  const result = evaluationScoreSummary(
    comparison([pair('partial', outcome(1), outcome(null))], { complete: false }),
  );
  assert.equal(result.pairedCount, 0);
  assert.equal(result.parentMean, null);
  assert.equal(result.candidateMean, null);
  assert.equal(result.missingGrades, 1);
});

test('task and infrastructure failures stay failures rather than zero-score pairs', () => {
  const result = evaluationScoreSummary(
    comparison(
      [
        pair(
          'task',
          outcome(1),
          outcome(null, { executionStatus: 'task_failed', gradingStatus: 'failed' }),
        ),
        pair(
          'infra',
          outcome(null, {
            executionStatus: 'infrastructure_failed',
            gradingStatus: 'failed',
            usage: null,
          }),
          outcome(1),
        ),
      ],
      { complete: false },
    ),
  );
  assert.equal(result.pairedCount, 0);
  assert.equal(result.parentMean, null);
  assert.equal(result.candidateMean, null);
  assert.equal(result.executionFailures, 2);
  assert.equal(result.missingGrades, 2);
  assert.equal(result.costUsd, null);
});

test('a gradeable task failure contributes its reported zero without hiding the failure', () => {
  const result = evaluationScoreSummary(
    comparison([
      pair('graded-failure', outcome(1), outcome(0, { executionStatus: 'task_failed' })),
    ]),
  );
  assert.equal(result.pairedCount, 1);
  assert.equal(result.parentMean, 1);
  assert.equal(result.candidateMean, 0);
  assert.equal(result.executionFailures, 1);
  assert.equal(result.complete, true);
});

test('infrastructure failure stays outside paired means even if it carries a score', () => {
  const result = evaluationScoreSummary(
    comparison(
      [pair('infra-score', outcome(1), outcome(0, { executionStatus: 'infrastructure_failed' }))],
      { complete: false },
    ),
  );
  assert.equal(result.pairedCount, 0);
  assert.equal(result.parentMean, null);
  assert.equal(result.candidateMean, null);
  assert.equal(result.complete, false);
});

test('signed and unbounded rewards keep their value on a common axis', () => {
  const result = evaluationScoreSummary(
    comparison([pair('first', outcome(-8), outcome(4)), pair('second', outcome(-4), outcome(2))]),
  );
  assert.equal(result.parentMean, -6);
  assert.equal(result.candidateMean, 3);
  assert.ok(result.minimum <= -6 && result.maximum >= 3);
  assert.ok(result.minimum <= 0 && result.maximum >= 0);
});

test('nonfinite rewards do not poison means or chart bounds', () => {
  const result = evaluationScoreSummary(
    comparison(
      [
        pair('bad', outcome(Number.NaN), outcome(Number.POSITIVE_INFINITY)),
        pair('valid', outcome(-2), outcome(0)),
      ],
      { complete: false },
    ),
  );
  assert.equal(result.pairedCount, 1);
  assert.equal(result.parentMean, -2);
  assert.equal(result.candidateMean, 0);
  assert.ok(Number.isFinite(result.minimum) && Number.isFinite(result.maximum));
});

test('repetition is part of the case identity', () => {
  const result = evaluationScoreSummary(
    comparison([
      pair('retry', outcome(0), outcome(1), 0),
      pair('retry', outcome(2), outcome(3), 1),
    ]),
  );
  assert.equal(result.pairedCount, 2);
  assert.equal(result.expectedCount, 2);
  assert.equal(result.parentMean, 1);
  assert.equal(result.candidateMean, 2);
});

test('unknown usage remains unknown when rewards are fully observed', () => {
  const result = evaluationScoreSummary(
    comparison([pair('measured', outcome(0, { usage: null }), outcome(1))]),
  );
  assert.equal(result.pairedCount, 1);
  assert.equal(result.costUsd, null);
});

test('unequal repetitions weight cases equally and reverse the pooled-row conclusion', () => {
  const report = unequalRepetitionsComparison();
  const acceptance = JSON.parse(
    readFileSync(
      new URL(
        '../../../docs/acceptance/developer-personas-20261117/evaluation-researcher.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.deepEqual(
    report.results.map(({ caseId, repetition, parent, candidate }) => ({
      caseId,
      repetition,
      parent: parent.reward,
      candidate: candidate.reward,
    })),
    acceptance.observedRewards,
  );
  const result = evaluationScoreSummary(report);
  const pooled = (side: 'parent' | 'candidate') =>
    report.results.reduce((sum, item) => sum + item[side].reward!, 0) / report.results.length;
  assert.ok(Math.abs(pooled('parent') - 0.55) < 1e-12);
  assert.ok(Math.abs(pooled('candidate') - 0.6) < 1e-12);
  assert.ok(Math.abs(result.parentMean! - 0.7) < 1e-12);
  assert.ok(Math.abs(result.candidateMean! - 0.4) < 1e-12);
  assert.ok(Math.abs(result.parentMean! - acceptance.policies.higher.summary.parentMean) < 1e-12);
  assert.ok(
    Math.abs(result.candidateMean! - acceptance.policies.higher.summary.candidateMean) < 1e-12,
  );
  assert.equal(result.comparableCaseCount, 2);
  assert.equal(result.expectedCaseCount, 2);
  assert.equal(result.pairedCount, 4);
  assert.equal(result.expectedCount, 4);
  assert.equal(result.costUsd, null);
});

test('partial unequal repetitions preserve paired exclusion and absent case coverage', () => {
  const report = unequalRepetitionsComparison();
  report.complete = false;
  report.results[0].candidate = outcome(null);
  report.results.pop();
  const result = evaluationScoreSummary(report);
  assert.equal(result.pairedCount, 2);
  assert.equal(result.expectedCount, 4);
  assert.equal(result.comparableCaseCount, 1);
  assert.equal(result.expectedCaseCount, 2);
  assert.ok(Math.abs(result.parentMean! - 0.4) < 1e-12);
  assert.ok(Math.abs(result.candidateMean! - 0.8) < 1e-12);
  assert.equal(result.missingGrades, 3);
  assert.equal(result.costUsd, null);
  assert.equal(result.complete, false);
});
