import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AcclimateClient, DeliveryError } from '../../packages/sdk/src/index.js';
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
function fixture(deny = false, parentBytes = p, parentDigest = parent.digest) {
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
    if (path.endsWith('/policy-receipts')) return Response.json({ items: [] });
    if (path.endsWith('/comparisons/cmp')) return Response.json(comparison);
    if (path.endsWith('/channels/live'))
      return Response.json({ channel: 'live', revision: '3', version: parent });
    if (path.endsWith('/versions/p/payload')) return new Response(parentBytes);
    if (path.endsWith('/versions/c/payload')) return new Response(c);
    if (path.endsWith('/versions/p')) return Response.json({ ...parent, digest: parentDigest });
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
const scope = ['--workspace', 'p', '--bundle', 'b', '--channel', 'live'];
test('parser rejects unknown and duplicate flags', () => {
  assert.throws(() => parseArgs(['review', '--unknown', 'x']));
  assert.throws(() => parseArgs(['review', '--comparison', 'a', '--comparison', 'b']));
});
test('review verifies payloads and never mutates or fetches output references', async () => {
  const { client, calls } = fixture();
  const text = await run(['review', ...scope, '--comparison', 'cmp', '--proposal', 'pr'], client);
  const review = JSON.parse(text);
  assert.deepEqual(review.policyReview, { status: 'available', receipts: [], blockers: [] });
  assert.equal(review.comparison.missingPairs, 1);
  assert.equal(review.comparison.parent.costUsd.unknownCount, 1);
  assert.equal(review.changes[0].before.text, 'old\u001b[31m');
  assert.ok(!text.includes('\u001b'));
  assert.ok(calls.every((call) => call.method === 'GET'));
  assert.equal(calls.length, 9);
});
test('denials propagate and do not promote', async () => {
  const { client, calls } = fixture(true);
  await assert.rejects(run(['review', ...scope, '--comparison', 'cmp'], client), /denied/);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('review preserves digest errors and does not misclassify authenticated malformed content', async () => {
  const malformed = Buffer.from('{');
  const mismatch = fixture(false, malformed);
  await assert.rejects(run(['review', ...scope, '--comparison', 'cmp'], mismatch.client),
    (error) => error instanceof Error && error.message === 'Payload digest mismatch' && !(error instanceof DeliveryError));
  const badJson = fixture(false, malformed, digest(malformed));
  await assert.rejects(run(['review', ...scope, '--comparison', 'cmp'], badJson.client), SyntaxError);
  const badSchema = Buffer.from('{"schemaVersion":1,"files":[]}');
  await assert.rejects(run(['review', ...scope, '--comparison', 'cmp'], fixture(false, badSchema, digest(badSchema)).client),
    (error) => error instanceof DeliveryError && error.code === 'unsupported_schema');
  assert.ok(mismatch.calls.every((call) => call.method === 'GET'));
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

test('promotion requires an explicit reason and exact receipt identities for an override', async () => {
  const { client, calls } = fixture();
  const args = ['promote', ...scope, '--version', 'c', '--comparison', 'cmp', '--expected-revision', '3'];
  const comparisonId = '5ea10529-8f9e-435f-8b6e-ac42343d69b4';
  const policyDigest = 'sha256:' + 'a'.repeat(64);
  const acknowledgement = ['--ack-policy', comparisonId + '@' + policyDigest];
  await assert.rejects(run([...args, ...acknowledgement], client), /override-reason/);
  assert.equal(calls.length, 0);
  await run([...args, ...acknowledgement, '--override-reason', 'Reviewed exception'], client);
  assert.deepEqual(calls[0].body.policyOverride, { reason: 'Reviewed exception', receipts: [{ comparisonId, policyDigest }] });
});

test('the packaged entry prints usage and reports errors as JSON with exit 1', async () => {
  const { operatorMain, operatorUsage } = await import('../../packages/sdk/src/operator/cli.js');
  const writes: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => (writes.push('out:' + chunk), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => (writes.push('err:' + chunk), true)) as typeof process.stderr.write;
  try {
    assert.equal(await operatorMain(['--help']), 0);
    assert.equal(await operatorMain([]), 1);
    assert.equal(await operatorMain(['promote', '--workspace', 'p']), 1);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  assert.equal(writes[0], 'out:' + operatorUsage + '\n');
  assert.match(operatorUsage, /^Usage: acclimate-operator COMMAND/);
  assert.deepEqual(JSON.parse(writes[2].slice(4)), { error: '--bundle is required' });
});
