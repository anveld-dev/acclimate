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

test('the outcome strip counts cases, keeps the delta neutral and names the missing statistics', async () => {
  const { EvaluationOutcomeStrip } = await import('../src/components/evaluation-scorecard');
  const { receiptInferenceText } = await import('../src/components/evaluation-policy-receipts');
  const outcome = (reward: number | null): Outcome => ({
    executionStatus: 'completed',
    gradingStatus: reward === null ? 'missing' : 'scored',
    reward,
    usage: null,
    outputRef: null,
    error: null,
  });
  // Case "many" has four repetitions that all improve; "one" has a single loss. Per pair the bar
  // would read 4 higher vs 1 lower; per case it is 1 higher, 1 lower and 1 not comparable.
  const rows: Comparison['results'] = [
    ...[0, 1, 2, 3].map((repetition) => ({
      caseId: 'many',
      repetition,
      parent: outcome(0),
      candidate: outcome(1),
    })),
    { caseId: 'one', repetition: 0, parent: outcome(1), candidate: outcome(0) },
    { caseId: 'gap', repetition: 0, parent: outcome(1), candidate: outcome(null) },
  ];
  const comparison: Comparison = {
    id: 'comparison',
    complete: false,
    parentVersionId: 'parent',
    candidateVersionId: 'candidate',
    parentDigest: 'parent-digest',
    candidateDigest: 'candidate-digest',
    datasetRevision: 'dataset',
    graderRevision: 'grader',
    runtime: {},
    submitter: '',
    createdAt: '',
    expectedCases: rows.map(({ caseId, repetition }) => ({ caseId, repetition })),
    results: rows,
  };
  const html = renderToStaticMarkup(createElement(EvaluationOutcomeStrip, { comparison }));
  assert.match(html, /1 case higher reward/);
  assert.match(html, /1 case lower reward/);
  assert.match(html, /1 case not comparable/);
  assert.match(html, /Cases · 2 of 3 fully scored/);
  assert.match(html, /No confidence interval · observed means for these cases/);
  assert.match(html, /parent 0 · candidate 1 · missing on one arm only/);
  const bound = renderToStaticMarkup(
    createElement(EvaluationOutcomeStrip, {
      comparison,
      inference: {
        method: 'paired-t',
        confidence: 0.95,
        n: 12,
        lowerBound: -0.0123,
        threshold: -0.05,
        status: 'estimated',
      },
    }),
  );
  assert.match(bound, /Policy lower bound -0.012 vs threshold -0.05 · 95% one-sided · 12 cases/);
  const receipt = {
    inference: {
      method: 'paired-t',
      confidence: 0.9,
      lowerBound: 0.1,
      threshold: 0,
      n: 30,
      sd: 0.4,
      sdFloor: 0.1,
    },
  } as any;
  assert.equal(
    receiptInferenceText(receipt),
    'paired-t 90% · lower bound 0.1 vs threshold 0 · 30 cases · sd 0.4 (floor 0.1)',
  );
  assert.equal(receiptInferenceText({} as any), 'No statistics recorded with this receipt');
});

test('the headline delta has no success or danger tone without a known metric direction', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(
    new URL('../src/components/evaluation-workspace.css', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(css, /outcome-delta\[data-direction/);
});
