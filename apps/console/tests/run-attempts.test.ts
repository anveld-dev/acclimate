import assert from 'node:assert/strict';
import test from 'node:test';
import { groupAttempts, runLabel } from '../src/lib/run-attempts';

const request = (
  id: string,
  createdAt: string,
  extra: {
    runName?: string;
    retryOf?: string;
    parentVersionId?: string;
    candidateDigest?: string;
  } = {},
) => ({
  id,
  createdAt,
  parentVersionId: extra.parentVersionId ?? 'parent',
  candidateDigest: extra.candidateDigest ?? 'sha256:same',
  ...(extra.runName && { runName: extra.runName }),
  ...(extra.retryOf && { retryOf: extra.retryOf }),
});

test('a retry is shown once with the broken run nested under it', () => {
  const broken = {
    name: 'broken',
    request: request('a', '2026-11-19T10:00:00Z', { runName: 'first-change' }),
  };
  const retry = {
    name: 'retry',
    request: request('b', '2026-11-19T11:00:00Z', { runName: 'fixed-grader', retryOf: 'a' }),
  };
  const other = {
    name: 'other',
    request: request('c', '2026-11-19T09:00:00Z', { candidateDigest: 'sha256:different' }),
  };
  const draft = { name: 'draft', request: undefined };
  const grouped = groupAttempts([broken, other, retry, draft], (item) => item.request);
  assert.deepEqual(
    grouped.map(({ item, earlier }) => [item.name, earlier.map((attempt) => attempt.name)]),
    [
      ['retry', ['broken']],
      ['other', []],
      ['draft', []],
    ],
  );
});

test('runs without labels group by parent and candidate content, newest first', () => {
  const runs = ['2026-11-19T08:00:00Z', '2026-11-19T12:00:00Z', '2026-11-19T10:00:00Z'].map(
    (createdAt, index) => ({ index, request: request(String(index), createdAt) }),
  );
  const [{ item, earlier }] = groupAttempts(runs, (run) => run.request);
  assert.equal(item.index, 1);
  assert.deepEqual(
    earlier.map((run) => run.index),
    [2, 0],
  );
});

test('a retry joins its predecessor even when the parent moved, and cycles are ignored', () => {
  const first = { request: request('a', '2026-11-19T10:00:00Z', { retryOf: 'b' }) };
  const second = {
    request: request('b', '2026-11-19T11:00:00Z', { retryOf: 'a', parentVersionId: 'new-parent' }),
  };
  const grouped = groupAttempts([first, second], (item) => item.request);
  // A malformed cycle terminates and leaves both runs visible.
  assert.equal(grouped.length, 2);
  const moved = {
    request: request('c', '2026-11-19T12:00:00Z', { retryOf: 'd', parentVersionId: 'x' }),
  };
  const original = { request: request('d', '2026-11-19T09:00:00Z') };
  const joined = groupAttempts([original, moved], (item) => item.request);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].item, moved);
  assert.deepEqual(joined[0].earlier, [original]);
});

test('run labels come from the evaluator name only', () => {
  assert.equal(runLabel({ runName: 'first-change' }), 'first-change');
  assert.equal(runLabel({ runName: '  ' }), undefined);
  assert.equal(runLabel({}), undefined);
  assert.equal(runLabel(undefined), undefined);
});
