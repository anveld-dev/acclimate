import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Comparison, Outcome } from '@acclimate/sdk';
import {
  ComparisonEvidence,
  comparisonIncompleteReason,
} from '../src/components/comparison-evidence';

const scored: Outcome = {
  executionStatus: 'completed',
  gradingStatus: 'scored',
  reward: 0,
  usage: { costUsd: 0 },
  outputRef: null,
  error: null,
};
const comparison: Comparison = {
  id: 'comparison',
  complete: true,
  parentVersionId: 'parent-version-11111111-1111-4111-8111-111111111111',
  candidateVersionId: 'candidate-version-22222222-2222-4222-8222-222222222222',
  parentDigest: 'parent-digest',
  candidateDigest: 'candidate-digest',
  evaluation: {
    requestId: 'request-33333333-3333-4333-8333-333333333333',
    attemptId: 'attempt-44444444-4444-4444-8444-444444444444',
  },
  datasetRevision: 'dataset-revision-55555555-5555-4555-8555-555555555555',
  graderRevision: 'grader-revision-66666666-6666-4666-8666-666666666666',
  runtime: {},
  submitter: 'app',
  createdAt: '',
  expectedCases: [{ caseId: 'returned', repetition: 0 }],
  results: [{ caseId: 'returned', repetition: 0, parent: scored, candidate: scored }],
};

function markup(report: Comparison) {
  return renderToStaticMarkup(createElement(ComparisonEvidence, { comparison: report }));
}

test('a scored task failure can be complete inventory without becoming a win or a new release block', () => {
  const report: Comparison = {
    ...comparison,
    results: [
      {
        ...comparison.results[0],
        candidate: { ...scored, executionStatus: 'task_failed' },
      },
    ],
  };
  const html = markup(report);
  assert.equal(comparisonIncompleteReason(report), null);
  assert.match(html, /Complete inventory/);
  assert.match(html, /1 scored pairs \/ 1 expected pairs/);
  assert.match(html, /<dt>Execution failures<\/dt><dd>1<\/dd>/);
  assert.match(html, /<dt>Execution<\/dt><dd>task_failed<\/dd>/);
  assert.match(html, /<dt>Grading<\/dt><dd>scored<\/dd>/);
  assert.match(html, /Complete evidence alone is not a win/);
  assert.doesNotMatch(html, /Incomplete evidence/);
});

test('scored zero rewards do not hide missing expected cases or turn unknown total usage into zero', () => {
  const report: Comparison = {
    ...comparison,
    complete: false,
    expectedCases: [
      ...comparison.expectedCases,
      { caseId: 'missing-first', repetition: 0 },
      { caseId: 'missing-second', repetition: 1 },
    ],
  };
  const html = markup(report);
  assert.equal(
    comparisonIncompleteReason(report),
    'Complete evidence is required before this release can be reviewed.',
  );
  assert.match(html, /Incomplete evidence; not a win/);
  assert.match(html, /1 scored pairs \/ 3 expected pairs/);
  assert.match(html, /<dt>Missing grades<\/dt><dd>4<\/dd>/);
  assert.match(html, /missing-first \/ 0/);
  assert.match(html, /missing-second \/ 1/);
  assert.equal((html.match(/Missing outcome · grade missing · cost unknown/g) ?? []).length, 8);
  assert.equal((html.match(/<span>Reward 0<\/span>/g) ?? []).length, 2);
  assert.equal((html.match(/<dt>Reported cost<\/dt><dd>\$0<\/dd>/g) ?? []).length, 2);
  assert.match(html, /<dt>Total cost<\/dt><dd>unknown<\/dd>/);
});

test('full binding and provenance remain visible while paired details keep literal outputs separate', () => {
  const report: Comparison = {
    ...comparison,
    results: [
      {
        ...comparison.results[0],
        parent: { ...scored, outputRef: 'parent-only-output' },
        candidate: { ...scored, outputRef: 'candidate-only-output', error: 'candidate-only-error' },
      },
    ],
  };
  const html = markup(report);
  for (const value of [
    report.parentVersionId,
    report.candidateVersionId,
    report.evaluation?.requestId,
    report.evaluation?.attemptId,
    report.datasetRevision,
    report.graderRevision,
  ]) {
    assert.ok(value && html.includes(value), `Missing full evidence identity: ${value}`);
  }
  const sides = [
    ...html.matchAll(/<section class="evaluation-pair-side">([\s\S]*?)<\/section>/g),
  ].map((match) => match[1]);
  assert.equal(sides.length, 2);
  const [parent, candidate] = sides;
  assert.match(html, /aria-label="Inspect case returned \/ 0"/);
  assert.match(html, /scope="row"/);
  assert.match(html, /headers="[^"]+ [^"]+"/);
  assert.match(html, /colSpan="3"/i);
  assert.match(parent, /parent-only-output/);
  assert.doesNotMatch(parent, /candidate-only/);
  assert.match(candidate, /candidate-only-output/);
  assert.match(candidate, /candidate-only-error/);
  assert.doesNotMatch(candidate, /parent-only/);
  assert.doesNotMatch(html, /href="(?:parent|candidate)-only-output"/);
});

test('standalone evidence uses expected gradeable pairs and excludes unexpected totals', () => {
  const report: Comparison = {
    ...comparison,
    expectedCases: [...comparison.expectedCases, { caseId: 'infra', repetition: 0 }],
    results: [
      {
        ...comparison.results[0],
        candidate: { ...scored, executionStatus: 'task_failed', reward: -1 },
      },
      {
        caseId: 'infra',
        repetition: 0,
        parent: scored,
        candidate: {
          ...scored,
          executionStatus: 'infrastructure_failed',
          reward: 999,
          usage: { costUsd: 2 },
        },
      },
      {
        caseId: 'unexpected',
        repetition: 0,
        parent: { ...scored, executionStatus: 'task_failed', usage: { costUsd: 1000 } },
        candidate: { ...scored, usage: { costUsd: 1000 } },
      },
    ],
  };
  const html = markup(report);
  assert.match(html, /1 scored pairs \/ 2 expected pairs/);
  assert.match(html, /Incomplete evidence; not a win/);
  assert.match(html, /<dt>Execution failures<\/dt><dd>2<\/dd>/);
  assert.match(html, /<dt>Total cost<\/dt><dd>\$2<\/dd>/);
  assert.match(html, /Unexpected pair/);
  const missing = markup({
    ...report,
    expectedCases: [...report.expectedCases, { caseId: 'missing', repetition: 0 }],
  });
  assert.match(missing, /1 scored pairs \/ 3 expected pairs/);
  assert.match(missing, /<dt>Total cost<\/dt><dd>unknown<\/dd>/);
  assert.match(missing, /<dt>Missing grades<\/dt><dd>2<\/dd>/);
});

test('an exact case link can inspect a repetition beyond the first results page', () => {
  const expectedCases = Array.from({ length: 32 }, (_, repetition) => ({
    caseId: 'path/has ? and #',
    repetition,
  }));
  const comparisonWithRepetitions = {
    ...comparison,
    expectedCases,
    results: expectedCases.map((key) => ({ ...key, parent: scored, candidate: scored })),
  };
  const html = renderToStaticMarkup(
    createElement(ComparisonEvidence, {
      comparison: comparisonWithRepetitions,
      linkedPair: 'case:' + JSON.stringify([expectedCases[31].caseId, 31]),
    }),
  );
  assert.match(html, /Inspect case path\/has \? and # \/ 31/);
  assert.doesNotMatch(html, /Inspect case path\/has \? and # \/ 0"/);
  assert.match(html, /aria-expanded="true"/);
});
