import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Comparison, Outcome } from '@acclimate/sdk';
import { EvaluationScorecard } from '../src/components/evaluation-scorecard';

test('complete inventory with an ungradeable pair is partial and excludes unexpected outcomes', () => {
  const scored: Outcome = {
    executionStatus: 'completed', gradingStatus: 'scored', reward: -2,
    usage: { costUsd: 1 }, outputRef: null, error: null,
  };
  const report: Comparison = {
    id: 'comparison', complete: true, parentVersionId: 'parent', candidateVersionId: 'candidate',
    parentDigest: 'parent-digest', candidateDigest: 'candidate-digest',
    datasetRevision: 'dataset', graderRevision: 'grader', runtime: {}, submitter: '', createdAt: '',
    expectedCases: [{ caseId: 'expected', repetition: 0 }],
    results: [
      { caseId: 'expected', repetition: 0, parent: scored,
        candidate: { ...scored, gradingStatus: 'failed', reward: null } },
      { caseId: 'extra', repetition: 0, parent: { ...scored, usage: { costUsd: 1000 } },
        candidate: { ...scored, executionStatus: 'task_failed', usage: { costUsd: 1000 } } },
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
