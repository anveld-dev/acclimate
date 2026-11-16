import assert from 'node:assert/strict';
import test from 'node:test';
import type { Comparison, Outcome } from '@acclimate/sdk';
import { comparisonSummary } from '../src/lib/comparison-summary';
const outcome: Outcome = {
  executionStatus: 'completed',
  gradingStatus: 'scored',
  reward: 1,
  usage: { costUsd: 0 },
  outputRef: null,
  error: null,
};
const comparison: Comparison = {
  id: 'comparison',
  complete: false,
  parentVersionId: 'parent',
  candidateVersionId: 'candidate',
  parentDigest: 'a',
  candidateDigest: 'b',
  datasetRevision: 'dataset',
  graderRevision: 'grader',
  runtime: {},
  submitter: 'app',
  createdAt: '',
  expectedCases: [
    { caseId: 'returned', repetition: 0 },
    { caseId: 'missing', repetition: 0 },
  ],
  results: [{ caseId: 'returned', repetition: 0, parent: outcome, candidate: outcome }],
};
test('missing case remains a visible row with missing grades and unknown cost', () => {
  const summary = comparisonSummary(comparison);
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.rows[1].pair, undefined);
  assert.equal(summary.missingGrades, 2);
  assert.equal(summary.scoredPairs, 1);
  assert.equal(summary.costUsd, null);
});
test('failed execution, missing reward, and unknown usage stay distinct', () => {
  const summary = comparisonSummary({
    ...comparison,
    expectedCases: comparison.expectedCases.slice(0, 1),
    results: [
      {
        ...comparison.results[0],
        candidate: { ...outcome, executionStatus: 'task_failed', reward: null, usage: null },
      },
    ],
  });
  assert.equal(summary.missingGrades, 1);
  assert.equal(summary.executionFailures, 1);
  assert.equal(summary.scoredPairs, 0);
  assert.equal(summary.costUsd, null);
});
test('reported zero usage is a known cost', () => {
  assert.equal(
    comparisonSummary({ ...comparison, expectedCases: comparison.expectedCases.slice(0, 1) })
      .costUsd,
    0,
  );
});
