import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluationRunName,
  isDigestRevision,
  shortRevision,
} from '../src/lib/evaluation-run-name';

const digest = 'sha256:7de587398d0ff2f5c9a1ce7921f4568b5f3c9f32f0b169d60d29b9ca7d156edd';

test('named dataset revisions read as words', () => {
  assert.equal(evaluationRunName('pr-review-2026-01-0123456789abcdef'), 'PR review 2026–01');
  assert.equal(evaluationRunName('dataset-real'), 'Dataset real');
  assert.equal(evaluationRunName(''), 'Unavailable');
});

test('digest revisions use the evaluator configuration or a short digest', () => {
  assert.equal(evaluationRunName(digest, 'app-agent'), 'App agent');
  assert.equal(evaluationRunName(digest), 'Dataset 7de58739');
  assert.equal(evaluationRunName(digest, 'not a name!'), 'Dataset 7de58739');
  assert.equal(isDigestRevision(digest), true);
  assert.equal(isDigestRevision('dataset-real'), false);
  assert.equal(shortRevision(digest), 'sha256:7de587398d0f');
  assert.equal(shortRevision('dataset-real'), 'dataset-real');
});
