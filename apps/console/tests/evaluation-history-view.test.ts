import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Comparison, Evaluation, Outcome } from '@acclimate/sdk';
import type { EvaluationHistoryModel } from '../src/lib/changes-workspace';
import { EvaluationHistoryView } from '../src/components/evaluation-history-view';

const outcome: Outcome = {
  executionStatus: 'completed',
  gradingStatus: 'scored',
  reward: 0,
  outputRef: null,
  error: null,
  usage: { costUsd: 0 },
};
const request: Evaluation = {
  id: 'request-12345678',
  candidateVersionId: 'candidate-full',
  parentVersionId: 'parent-full',
  candidateDigest: 'candidate-digest',
  parentDigest: 'parent-digest',
  datasetRevision: 'dataset-real',
  graderRevision: 'grader-real',
  runtime: { model: 'runtime-real' },
  expectedCases: Array.from({ length: 8 }, (_, i) => ({ caseId: `case-${i}`, repetition: i })),
  status: 'completed',
  attemptId: 'attempt-real',
  comparisonId: 'comparison-real',
  error: null,
  proposalId: null,
  evaluatorPrincipal: null,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};
const comparison: Comparison = {
  ...request,
  id: 'comparison-real',
  evaluation: { requestId: request.id, attemptId: 'attempt-real' },
  complete: false,
  submitter: 'app',
  results: [
    {
      ...request.expectedCases[0],
      parent: outcome,
      candidate: { ...outcome, executionStatus: 'task_failed', reward: -2 },
    },
    {
      ...request.expectedCases[1],
      parent: outcome,
      candidate: { ...outcome, gradingStatus: 'failed', reward: null, usage: null },
    },
    { caseId: 'unexpected', repetition: 0, parent: outcome, candidate: outcome },
  ],
};
const model = (overrides: Partial<EvaluationHistoryModel> = {}): EvaluationHistoryModel => ({
  requests: [request],
  evidence: { [request.id]: { status: 'bound', comparison } },
  selectedRequest: request,
  selectedState: 'ready',
  selectedError: null,
  cursor: null,
  loading: false,
  error: null,
  loadMore: async () => {},
  ...overrides,
});
const render = (overrides: Partial<Parameters<typeof EvaluationHistoryView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(EvaluationHistoryView, {
      model: model(),
      selectedRequestId: request.id,
      onSelectRequest: () => {},
      reviewHref: () => '/review',
      ...overrides,
    }),
  );

test('bound evidence displays partial paired means, bounded preview and exact provenance', () => {
  const html = render();
  for (const text of [
    'dataset-real',
    'grader-real',
    'runtime-real',
    'parent-full',
    'candidate-digest',
    'attempt-real',
    'comparison-real',
    '1 / 8 · partial',
    'Candidate -2',
    '1 unexpected',
    'Showing 6 of 8',
    'task_failed',
    'grading scored',
    'failed grade',
    'Open full review',
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<strong>unexpected \/ 0/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-label="Evaluation history table"/);
  assert.match(html, /Cost · expected outcomes<\/dt><dd>unknown/);
  assert.match(html, /evaluation-ledger-case-sides/);
  assert.match(html, /<h5><span>Parent<\/span><strong>Reward 0<\/strong><\/h5>/);
  assert.match(html, /<h5><span>Candidate<\/span><strong>Reward -2<\/strong><\/h5>/);
  assert.doesNotMatch(html, /gradeable paired \/ 8 expected/);
  assert.match(html, /aria-describedby="[^"]+-coverage [^"]+-coverage-request-12345678"/);
});

test('unbound and mismatched reports never contribute aggregates', () => {
  for (const status of ['unbound', 'mismatch'] as const) {
    const html = render({
      model: model({
        evidence: { [request.id]: { status, comparison, message: 'Identity differs' } },
      }),
    });
    assert.match(
      html,
      status === 'unbound' ? /Legacy unbound evidence/ : /Evidence binding mismatch/,
    );
    assert.doesNotMatch(html, /1 \/ 8 · partial/);
    assert.match(html, /Inspect comparison independently/);
    assert.match(html, /href="\/review\?comparison=comparison-real"/);
  }
});

test('direct outside-page request is pinned without inflating loaded count', () => {
  const html = render({ model: model({ requests: [] }) });
  assert.match(html, /0 loaded requests/);
  assert.match(html, /Selected outside loaded history/);
  assert.equal((html.match(/dataset-real/g) ?? []).length, 2); // row and provenance
});

test('filtered empty state retains pagination and comparison-less handoff', () => {
  const empty = render({
    selectedRequestId: undefined,
    selectedCandidateId: 'other',
    model: model({ cursor: 'next' }),
  });
  assert.match(empty, /No loaded evaluations for this version/);
  assert.match(empty, /Load older evaluations/);
  const noComparison = { ...request, comparisonId: null, error: 'Interrupted externally' };
  const html = render({
    model: model({
      requests: [noComparison],
      selectedRequest: noComparison,
      evidence: { [request.id]: { status: 'none' } },
    }),
  });
  assert.match(html, /Interrupted externally/);
  assert.match(html, /Open evaluation/);
});
