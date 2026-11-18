import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Comparison, Evaluation, Outcome } from '@acclimate/sdk';
import { evaluationEvidenceSummary, notComparableReasons, requestEvidence } from '../src/lib/evaluation-history';
import { evaluationPairs } from '../src/lib/evaluation-pairs';
import { mergeHistory } from '../src/lib/improvement-history';

const outcome = (reward: number | null, extra: Partial<Outcome> = {}): Outcome => ({ executionStatus: 'completed', gradingStatus: 'scored', reward, outputRef: null, error: null, usage: { costUsd: 1 }, ...extra });
const request: Evaluation = { requireBoundEvidence: true, id: 'r', attemptId: 'a', comparisonId: 'c', parentVersionId: 'p', candidateVersionId: 'v', parentDigest: 'pd', candidateDigest: 'vd', datasetRevision: 'd', graderRevision: 'g', runtime: { b: '2', a: '1' }, expectedCases: [{ caseId: 'one', repetition: 0 }, { caseId: 'two', repetition: 0 }], proposalId: null, status: 'completed', evaluatorPrincipal: null, error: null, createdAt: '', updatedAt: '' };
const comparison: Comparison = { id: 'c', evaluation: { requestId: 'r', attemptId: 'a' }, parentVersionId: 'p', candidateVersionId: 'v', parentDigest: 'pd', candidateDigest: 'vd', datasetRevision: 'd', graderRevision: 'g', runtime: { a: '1', b: '2' }, expectedCases: [...request.expectedCases].reverse(), results: [{ caseId: 'one', repetition: 0, parent: outcome(-100, { executionStatus: 'task_failed' }), candidate: outcome(200) }, { caseId: 'extra', repetition: 0, parent: outcome(999), candidate: outcome(999) }], complete: true, submitter: '', createdAt: '' };

test('binding checks semantic settings and inventory as well as identifiers', () => {
  assert.equal(requestEvidence(request, comparison).status, 'bound');
  for (const change of [{ id: 'other' }, { candidateDigest: 'wrong' }, { parentVersionId: 'wrong' }])
    assert.equal(requestEvidence(request, { ...comparison, ...change }).status, 'mismatch');
  assert.equal(requestEvidence(request, { ...comparison, runtime: { a: 'wrong', b: '2' } }).status, 'mismatch');
  assert.equal(requestEvidence(request, { ...comparison, expectedCases: [request.expectedCases[0]] }).status, 'mismatch');
  assert.equal(requestEvidence(request, { ...comparison, evaluation: { requestId: 'r', attemptId: 'other' } }).status, 'mismatch');
  assert.equal(requestEvidence(request, { ...comparison, evaluation: undefined }).status, 'unbound');
});

test('summary isolates expected pairs, signed scores, failures and unknown cost', () => {
  const summary = evaluationEvidenceSummary(comparison);
  assert.deepEqual(summary, { pairedCount: 1, expectedCount: 2, parentMean: -100, candidateMean: 200, partial: true, notComparable: 1, expectedExecutionFailures: 1, expectedMissingGrades: 2, unexpectedCount: 1, expectedCostUsd: null });
  assert.deepEqual(notComparableReasons(evaluationPairs(comparison)[0]), ['Parent: missing outcome', 'Candidate: missing outcome']);
  assert.equal(evaluationEvidenceSummary({ ...comparison, expectedCases: [request.expectedCases[0]], complete: false }).partial, true);
  assert.equal(evaluationEvidenceSummary({ ...comparison, expectedCases: [request.expectedCases[0]] }).expectedCostUsd, 2);
});

test('nonfinite and infrastructure outcomes are not comparable', () => {
  const report = { ...comparison, expectedCases: [request.expectedCases[0]], results: [{ caseId: 'one', repetition: 0, parent: outcome(Infinity), candidate: outcome(0, { executionStatus: 'infrastructure_failed', gradingStatus: 'failed' }) }] };
  assert.equal(evaluationEvidenceSummary(report).pairedCount, 0);
  assert.deepEqual(notComparableReasons(evaluationPairs(report)[0]), ['Parent: null or nonfinite reward', 'Candidate: infrastructure failure', 'Candidate: failed grade']);
});

test('head refresh and older pages merge without duplicate identities', () => {
  const older = mergeHistory([{ id: 'a', value: 1 }], [{ id: 'a', value: 2 }, { id: 'b', value: 3 }], true);
  assert.deepEqual(mergeHistory(older, [{ id: 'c', value: 4 }, { id: 'a', value: 5 }]), [{ id: 'c', value: 4 }, { id: 'a', value: 5 }, { id: 'b', value: 3 }]);
});
