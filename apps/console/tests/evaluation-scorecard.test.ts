import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Comparison, Outcome } from '@acclimate/sdk';
import { EvaluationScorecard } from '../src/components/evaluation-scorecard';
import { unequalRepetitionsComparison } from './fixtures/unequal-repetitions';

test('complete inventory with an ungradeable pair is partial and excludes unexpected outcomes', () => {
  const scored: Outcome = {
    executionStatus: 'completed',
    gradingStatus: 'scored',
    reward: -2,
    usage: { costUsd: 1 },
    outputRef: null,
    error: null,
  };
  const report: Comparison = {
    id: 'comparison',
    complete: true,
    parentVersionId: 'parent',
    candidateVersionId: 'candidate',
    parentDigest: 'parent-digest',
    candidateDigest: 'candidate-digest',
    datasetRevision: 'dataset',
    graderRevision: 'grader',
    runtime: {},
    submitter: '',
    createdAt: '',
    expectedCases: [{ caseId: 'expected', repetition: 0 }],
    results: [
      {
        caseId: 'expected',
        repetition: 0,
        parent: scored,
        candidate: { ...scored, gradingStatus: 'failed', reward: null },
      },
      {
        caseId: 'extra',
        repetition: 0,
        parent: { ...scored, usage: { costUsd: 1000 } },
        candidate: { ...scored, executionStatus: 'task_failed', usage: { costUsd: 1000 } },
      },
    ],
  };
  const html = renderToStaticMarkup(createElement(EvaluationScorecard, { comparison: report }));
  assert.match(html, /Partial evidence/);
  assert.doesNotMatch(html, /Complete evidence/);
  assert.match(html, /<dt>Scored pairs<\/dt><dd>0 \/ 1<\/dd>/);
  assert.match(html, /<dt>Missing grades · expected outcomes<\/dt><dd>1<\/dd>/);
  assert.match(html, /<dt>Execution failures · expected outcomes<\/dt><dd>0<\/dd>/);
  assert.match(html, /<dt>Reported cost · expected outcomes<\/dt><dd>\$2<\/dd>/);
});

test('researcher unequal repetitions render equal-case values with per-pair coverage and unknown cost', () => {
  const html = renderToStaticMarkup(
    createElement(EvaluationScorecard, {
      comparison: unequalRepetitionsComparison(),
    }),
  );
  assert.match(html, /Observed equal-case mean · 2 \/ 2 expected cases/);
  assert.match(html, /<strong>0\.7<\/strong>/);
  assert.match(html, /<strong>0\.4<\/strong>/);
  assert.match(html, /<dt>Scored pairs<\/dt><dd>4 \/ 4<\/dd>/);
  assert.match(html, /<dt>Reported cost · expected outcomes<\/dt><dd>Unknown<\/dd>/);
  assert.doesNotMatch(
    html,
    /Observed per-pair mean|<strong>0\.55<\/strong>|<strong>0\.6<\/strong>/,
  );
});
