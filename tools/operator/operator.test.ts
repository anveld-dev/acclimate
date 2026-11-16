import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AcclimateClient } from '../../packages/sdk/src/index.js';
import { parseArgs, run } from './cli.js';

const payload = (text: string) =>
  Buffer.from(
    JSON.stringify({ schemaVersion: 1, files: [{ path: 'skill.md', kind: 'skill', text }] }) + '\n',
  );
const p = payload('old\u001b[31m'),
  c = payload('new');
const digest = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const parent = {
  id: 'p',
  bundleId: 'b',
  parentVersionId: null,
  digest: digest(p),
  createdAt: 'now',
};
const candidate = {
  id: 'c',
  bundleId: 'b',
  parentVersionId: 'p',
  digest: digest(c),
  createdAt: 'now',
};
const outcome = {
  executionStatus: 'completed',
  gradingStatus: 'scored',
  reward: 1,
  error: null,
  outputRef: 'https://invalid.example/never-fetch',
  usage: { inputTokens: 3 },
};
const comparison = {
  id: 'cmp',
  parentVersionId: 'p',
  candidateVersionId: 'c',
  parentDigest: digest(p),
  candidateDigest: digest(c),
  datasetRevision: 'd',
  runtime: {},
  graderRevision: 'g',
  expectedCases: [
    { caseId: 'x', repetition: 0 },
    { caseId: 'y', repetition: 0 },
  ],
  results: [{ caseId: 'x', repetition: 0, parent: outcome, candidate: outcome }],
  complete: false,
  submitter: 's',
  createdAt: 'now',
};
function fixture(deny = false) {
  const calls: { method: string; path: string; body: any }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname,
      method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (deny)
      return Response.json(
        { error: { code: 'denied', message: 'denied', requestId: 'r' } },
        { status: 403 },
      );
    if (method === 'POST') return Response.json({ id: 'promoted' }, { status: 201 });
    if (path.endsWith('/comparisons/cmp')) return Response.json(comparison);
    if (path.endsWith('/channels/live'))
      return Response.json({ channel: 'live', revision: '3', version: parent });
    if (path.endsWith('/versions/p/payload')) return new Response(p);
    if (path.endsWith('/versions/c/payload')) return new Response(c);
    if (path.endsWith('/versions/p')) return Response.json(parent);
    if (path.endsWith('/versions/c')) return Response.json(candidate);
    if (path.endsWith('/proposals/pr'))
      return Response.json({ id: 'pr', parentVersionId: 'p', candidate });
    return new Response('', { status: 404 });
  };
  return {
    calls,
    client: new AcclimateClient({
      baseUrl: 'http://fixture',
      token: 'test',
      scope: 'test',
      fetch: fetcher,
      retries: 0,
    }),
  };
}
const scope = ['--project', 'p', '--bundle', 'b', '--channel', 'live'];
test('parser rejects unknown and duplicate flags', () => {
  assert.throws(() => parseArgs(['review', '--unknown', 'x']));
  assert.throws(() => parseArgs(['review', '--comparison', 'a', '--comparison', 'b']));
});
test('review verifies payloads and never mutates or fetches output references', async () => {
  const { client, calls } = fixture();
  const text = await run(['review', ...scope, '--comparison', 'cmp', '--proposal', 'pr'], client);
  const review = JSON.parse(text);
  assert.equal(review.comparison.missingPairs, 1);
  assert.equal(review.comparison.parent.costUsd.unknownCount, 1);
  assert.equal(review.changes[0].before.text, 'old\u001b[31m');
  assert.ok(!text.includes('\u001b'));
  assert.ok(calls.every((call) => call.method === 'GET'));
  assert.equal(calls.length, 7);
});
test('denials propagate and do not promote', async () => {
  const { client, calls } = fixture(true);
  await assert.rejects(run(['review', ...scope, '--comparison', 'cmp'], client), /denied/);
  assert.ok(calls.every((call) => call.method === 'GET'));
});
test('promotion and rollback require their explicit evidence and revision', async () => {
  const { client, calls } = fixture();
  await assert.rejects(
    run(['promote', ...scope, '--version', 'c', '--comparison', 'cmp'], client),
    /expected-revision/,
  );
  await run(
    [
      'promote',
      ...scope,
      '--version',
      'c',
      '--comparison',
      'cmp',
      '--expected-revision',
      '3',
      '--key',
      'k',
    ],
    client,
  );
  await run(
    ['rollback', ...scope, '--version', 'p', '--reason', 'regression', '--expected-revision', '4'],
    client,
  );
  assert.deepEqual(
    calls.map((c) => c.body),
    [
      { versionId: 'c', expectedRevision: '3', comparisonId: 'cmp' },
      { versionId: 'p', expectedRevision: '4', unevaluatedReason: 'regression' },
    ],
  );
});
