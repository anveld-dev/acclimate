import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BundlePayload, Comparison, Outcome } from '@acclimate/sdk';
import { evaluationPairs, pairCounts, selectPairs } from '../src/lib/evaluation-pairs';
import { artifactChanges } from '../src/lib/artifact-changes';
import { ContentDiff } from '../src/components/diff-content';
import { ComparisonEvidence } from '../src/components/comparison-evidence';

const outcome = (reward: number | null, overrides: Partial<Outcome> = {}): Outcome => ({
  executionStatus: 'completed',
  gradingStatus: reward === null ? 'missing' : 'scored',
  reward,
  usage: null,
  outputRef: null,
  error: null,
  ...overrides,
});
const report: Comparison = {
  id: 'example-evidence',
  complete: false,
  parentVersionId: 'parent',
  candidateVersionId: 'candidate',
  parentDigest: 'p',
  candidateDigest: 'c',
  datasetRevision: 'synthetic',
  graderRevision: 'grader',
  runtime: {},
  submitter: 'fixture',
  createdAt: '2026-11-15T00:00:00Z',
  expectedCases: [
    { caseId: 'retry', repetition: 0 },
    { caseId: 'retry', repetition: 1 },
    { caseId: 'zero', repetition: 0 },
    { caseId: 'missing', repetition: 0 },
    { caseId: 'infra', repetition: 0 },
    { caseId: 'bad-number', repetition: 0 },
  ],
  results: [
    { caseId: 'retry', repetition: 0, parent: outcome(-2), candidate: outcome(3) },
    {
      caseId: 'retry',
      repetition: 1,
      parent: outcome(1),
      candidate: outcome(0, { executionStatus: 'task_failed' }),
    },
    { caseId: 'zero', repetition: 0, parent: outcome(0), candidate: outcome(0) },
    {
      caseId: 'infra',
      repetition: 0,
      parent: outcome(0),
      candidate: outcome(10, { executionStatus: 'infrastructure_failed' }),
    },
    { caseId: 'bad-number', repetition: 0, parent: outcome(0), candidate: outcome(NaN) },
    { caseId: 'unexpected', repetition: 0, parent: outcome(0), candidate: outcome(1000) },
  ],
};

test('the map exposes regressions, zero ties and missing pairs without counting unexpected gains', () => {
  const rows = evaluationPairs(report);
  assert.deepEqual(pairCounts(rows), { higher: 1, lower: 1, same: 1, unscored: 3 });
  assert.equal(rows.length, 7);
  assert.equal(rows[3].pair, undefined);
  assert.equal(rows[6].expected, false);
  assert.equal(rows[6].change, 'unscored');
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(rows[1].change, 'lower', 'a scored task failure stays visible as a regression');
});

test('case filters preserve repetitions and search, and do not reinterpret infrastructure scores', () => {
  const rows = evaluationPairs(report);
  assert.deepEqual(
    selectPairs(rows, 'lower', ' RETRY ').map((row) => row.key.repetition),
    [1],
  );
  assert.equal(selectPairs(rows, 'higher', '').length, 1);
  assert.equal(selectPairs(rows, 'unscored', '').length, 3);
  assert.equal(selectPairs(rows, 'all', 'unexpected').length, 1);
  assert.equal(selectPairs(rows, 'all', 'retry / 1').length, 1);
  assert.equal(selectPairs(rows, 'same', 'missing').length, 0);
});

test('finite extremes compare directly without overflowing a reward delta', () => {
  const extreme = {
    ...report,
    expectedCases: [report.expectedCases[0]],
    results: [
      {
        ...report.results[0],
        parent: outcome(-Number.MAX_VALUE),
        candidate: outcome(Number.MAX_VALUE),
      },
    ],
  };
  assert.equal(evaluationPairs(extreme)[0].change, 'higher');
});

test('the rendered evidence offers labeled tiles, filters and outcomes, with unsafe strings escaped', () => {
  const html = renderToStaticMarkup(
    createElement(ComparisonEvidence, {
      comparison: {
        ...report,
        expectedCases: [{ caseId: '<img src=x onerror=alert(1)>', repetition: 0 }],
        results: [],
      },
    }),
  );
  assert.match(html, /Where did it change/);
  assert.match(html, /aria-label="Filter case results"/);
  assert.match(html, /aria-label="Search evaluation cases"/);
  assert.match(html, /No comparable pair of scores/);
  assert.match(html, /Missing outcome · grade missing · cost unknown/);
  assert.doesNotMatch(html, /<img/);
});

test('large evidence inventories paginate the outcomes while retaining the full case map', () => {
  const expectedCases = Array.from({ length: 60 }, (_, i) => ({
    caseId: `case-${i}`,
    repetition: 0,
  }));
  const html = renderToStaticMarkup(
    createElement(ComparisonEvidence, { comparison: { ...report, expectedCases, results: [] } }),
  );
  assert.match(html, /1–25 of 60 pairs/);
  assert.match(html, /Next cases/);
  assert.equal((html.match(/No comparable pair of scores/g) || []).length, 60);
  assert.equal((html.match(/Missing outcome · grade missing · cost unknown/g) || []).length, 100);
});

test('artifact map identifies actual added, removed and retyped files without inventing learning', () => {
  const base: BundlePayload = {
    schemaVersion: 1,
    files: [
      { path: 'AGENTS.md', kind: 'instruction', text: 'same' },
      { path: 'memory/old.md', kind: 'memory', text: 'old' },
      { path: 'notes.md', kind: 'memory', text: 'unchanged text' },
    ],
  };
  const current: BundlePayload = {
    schemaVersion: 1,
    files: [
      { path: 'AGENTS.md', kind: 'instruction', text: 'same' },
      { path: 'notes.md', kind: 'instruction', text: 'unchanged text' },
      { path: 'skills/triage/scripts/triage.py', kind: 'skill', text: 'print(1)' },
    ],
  };
  assert.deepEqual(
    artifactChanges(base, current).map(({ path, kind, operation }) => ({ path, kind, operation })),
    [
      { path: 'memory/old.md', kind: 'memory', operation: 'Removed' },
      { path: 'notes.md', kind: 'instruction', operation: 'Changed' },
      { path: 'skills/triage/scripts/triage.py', kind: 'skill', operation: 'Added' },
    ],
  );
  const html = renderToStaticMarkup(createElement(ContentDiff, { base, current }));
  assert.match(html, /Changed artifact map/);
  assert.match(html, /Skills and resources/);
  assert.match(html, /triage.py/);
  assert.match(html, /Type changed/);
  assert.doesNotMatch(html, /learned|qualified|approved/i);
});
