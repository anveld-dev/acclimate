import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleDetailLabel, channelSwitchSearch } from '../src/navigation';
import { requestEvidence } from '../src/lib/evaluation-history';
import type { Comparison, Evaluation } from '@acclimate/sdk';

test('channel switch preserves only valid history selection and file context', () => {
  assert.deepEqual(
    channelSwitchSearch('changes', {
      history: '1',
      candidate: 'candidate',
      request: 'request',
      tab: 'files',
      path: 'a.md',
      comparison: 'old',
    }),
    { history: 1, candidate: 'candidate', request: 'request', tab: 'files', path: 'a.md' },
  );
  assert.deepEqual(
    channelSwitchSearch('changes', { history: 1, request: 'request', tab: 'files', path: 'a.md' }),
    { history: 1, request: 'request' },
  );
  assert.deepEqual(
    channelSwitchSearch('changes', { history: '1', candidate: 'c', tab: 'invalid', path: 'a.md' }),
    { history: 1, candidate: 'c' },
  );
  assert.deepEqual(channelSwitchSearch('changes', { draft: 'd', history: '1', request: 'r' }), {});
  assert.deepEqual(
    channelSwitchSearch('changes', { candidate: 'c', request: 'r', comparison: 'cmp' }),
    { candidate: 'c', request: 'r', comparison: 'cmp' },
  );
  assert.equal(
    bundleDetailLabel('changes', { history: '1', candidate: 'candidate', request: 'request' }),
    undefined,
  );
  assert.equal(
    bundleDetailLabel('changes', { candidate: 'candidate', request: 'request' }),
    'Review candidate',
  );
});

test('request evidence requires complete matching binding and semantic settings', () => {
  const request = {
    id: 'r',
    attemptId: 'a',
    comparisonId: 'c',
    parentVersionId: 'p',
    candidateVersionId: 'v',
    parentDigest: 'pd',
    candidateDigest: 'vd',
    datasetRevision: 'dataset',
    graderRevision: 'grader',
    runtime: { b: '2', a: '1' },
    expectedCases: [{ caseId: 'one', repetition: 0 }],
    proposalId: null,
    status: 'completed',
    evaluatorPrincipal: null,
    error: null,
    createdAt: '',
    updatedAt: '',
  } satisfies Evaluation;
  const comparison = {
    ...request,
    id: 'c',
    evaluation: { requestId: 'r', attemptId: 'a' },
    runtime: { a: '1', b: '2' },
    complete: true,
    submitter: '',
    results: [],
  } satisfies Comparison;
  assert.equal(requestEvidence(request, comparison).status, 'bound');
  for (const change of [
    { id: 'other' },
    { candidateDigest: 'wrong' },
    { parentVersionId: 'wrong' },
    { runtime: { a: 'different', b: '2' } },
    { evaluation: { requestId: 'r', attemptId: 'other' } },
    { expectedCases: [] },
  ])
    assert.equal(requestEvidence(request, { ...comparison, ...change }).status, 'mismatch');
  assert.equal(
    requestEvidence(request, { ...comparison, evaluation: undefined }).status,
    'unbound',
  );
});
