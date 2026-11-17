import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Evaluation, EvaluationProgressView } from '@acclimate/sdk';
import { EvaluationActivity } from '../src/components/evaluation-activity';

const request = {
  id: 'request',
  attemptId: 'attempt',
  status: 'running',
} as Evaluation;
const progress: EvaluationProgressView = {
  schemaVersion: 1,
  requestId: request.id,
  status: request.status,
  attemptId: request.attemptId,
  activity: 'fresh',
  checkedAt: '2026-11-17T12:00:30Z',
  staleAfterSeconds: 60,
  observation: {
    attemptId: 'attempt',
    sequence: 2,
    phase: 'grading',
    completed: 3,
    total: 4,
    case: { caseId: '<literal-case>', repetition: 2 },
    receivedAt: '2026-11-17T12:00:00Z',
    evaluatorPrincipal: 'evaluator',
  },
};
const render = (view?: EvaluationProgressView | null) =>
  renderToStaticMarkup(createElement(EvaluationActivity, { request, progress: view }));

test('recent report shows server receipt and check times without asserting liveness or retry safety', () => {
  const html = render(progress);
  for (const text of [
    'Recent report at last check',
    'grading',
    '3 / 4',
    '&lt;literal-case&gt;',
    '2026-11-17T12:00:00Z',
    '2026-11-17T12:00:30Z',
    'Attempt attempt',
    'do not prove the worker',
    'that a retry is safe',
    'Request status remains running',
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<literal-case>/);
});

test('stale report retains reported counts without becoming stopped or completed', () => {
  const html = render({ ...progress, activity: 'stale' });
  assert.match(html, /Stale report/);
  assert.match(html, /3 \/ 4/);
  assert.match(html, /Request status remains running/);
  assert.doesNotMatch(html, /Recent report/);
});

test('absent, unavailable and wrong attempt reports keep activity unknown', () => {
  assert.match(
    render({ ...progress, observation: null, activity: 'absent' }),
    /No activity report.*activity is unknown/,
  );
  assert.match(render(null), /Activity unavailable.*activity is unknown/);
  for (const view of [
    { ...progress, requestId: 'other-request' },
    { ...progress, attemptId: 'other-attempt' },
    { ...progress, observation: { ...progress.observation!, attemptId: 'other-attempt' } },
  ]) {
    const html = render(view);
    assert.match(html, /activity is unknown/);
    assert.doesNotMatch(html, /literal-case|3 \/ 4|Recent report/);
  }
});
