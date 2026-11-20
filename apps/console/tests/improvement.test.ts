import { consoleEnvironment } from './console-fixture';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonSummary, improvement } from '../src/server/improvement';
import type { Comparison, Outcome } from '@acclimate/sdk';
import { appDescriptor } from './fixtures/app-evaluator';
const scored: Outcome = {
  executionStatus: 'completed',
  gradingStatus: 'scored',
  reward: 1,
  outputRef: null,
  error: null,
  usage: null,
};
test('missing inventory and unknown cost never become success or zero', () => {
  const report = {
    expectedCases: appDescriptor.expectedCases,
    results: [
      {
        caseId: 'instructions-present',
        repetition: 0,
        parent: scored,
        candidate: { ...scored, gradingStatus: 'failed', reward: null },
      },
    ],
  } as Comparison;
  assert.deepEqual(comparisonSummary(report), {
    expectedPairs: 4,
    scoredPairs: 0,
    missingGrades: 7,
    executionFailures: 0,
    costUsd: null,
  });
});
test('only fully known usage is totaled', () => {
  const report = {
    expectedCases: [{ caseId: 'a', repetition: 0 }],
    results: [
      {
        caseId: 'a',
        repetition: 0,
        parent: { ...scored, usage: { costUsd: 0 } },
        candidate: { ...scored, usage: { costUsd: 0.3 } },
      },
    ],
  } as Comparison;
  assert.equal(comparisonSummary(report).costUsd, 0.3);
});
test('unconfigured scope cannot create proposals or requests', async () => {
  let calls = 0;
  const result = await improvement({}, { action: 'evaluate' }, async () => {
    calls++;
    throw Error('unexpected');
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

function historyFixture() {
  const env = {
    ...consoleEnvironment,
    CONSOLE_SERVICE_TOKEN: 'fixture-only',
    CONSOLE_WORKSPACE: 'workspace',
    CONSOLE_BUNDLE: 'bundle',
    CONSOLE_CHANNEL: 'stable',
    CONSOLE_ALLOW_EDITS: 'true',
  };
  const payloads = {
    current: {
      schemaVersion: 1,
      files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'Current instructions.' }],
    },
    parent: {
      schemaVersion: 1,
      files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'Older base.' }],
    },
    candidate: {
      schemaVersion: 1,
      files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'Suggested change.' }],
    },
  };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/workspaces')
      return Response.json({
        items: [{ id: 'workspace', name: 'Workspace', role: 'admin' }],
        nextCursor: null,
      });
    calls.push(url.pathname + url.search);
    const version = url.pathname.split('/versions/')[1]?.split('/')[0] as keyof typeof payloads;
    if (url.pathname.endsWith('/payload')) return new Response(JSON.stringify(payloads[version]));
    if (version)
      return Response.json({
        id: version,
        bundleId: 'bundle',
        parentVersionId: version === 'candidate' ? 'parent' : null,
        digest:
          'sha256:' + createHash('sha256').update(JSON.stringify(payloads[version])).digest('hex'),
        createdAt: '2026-11-14T00:00:00Z',
      });
    if (url.pathname.endsWith('/channels/stable'))
      return Response.json({
        channel: 'stable',
        revision: '3',
        version: {
          id: 'current',
          bundleId: 'bundle',
          parentVersionId: null,
          digest:
            'sha256:' + createHash('sha256').update(JSON.stringify(payloads.current)).digest('hex'),
          createdAt: '2026-11-14T00:00:00Z',
        },
      });
    if (url.pathname.endsWith('/bundles'))
      return Response.json({
        items: [{ id: 'bundle', name: 'Bundle', origin: 'created' }],
        nextCursor: null,
      });
    if (url.pathname.endsWith('/releases'))
      return Response.json({ items: [], nextBeforeRevision: null });
    if (url.pathname.endsWith('/proposals') || url.pathname.endsWith('/evaluation-requests'))
      return Response.json({ items: [], nextCursor: null });
    throw Error('Unexpected fixture request: ' + url.pathname);
  };
  return { env, fetcher, calls };
}

test('selected request reads optional progress without allowing activity failure to hide durable state', async () => {
  const { env, fetcher } = historyFixture();
  const reads: string[] = [];
  const request = { id: 'request', attemptId: 'attempt', status: 'running' };
  const progress = {
    requestId: 'request',
    attemptId: 'attempt',
    activity: 'absent',
    observation: null,
  };
  for (const unavailable of [false, true]) {
    const result = await improvement(
      env,
      { action: 'request', id: 'request' },
      async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/evaluation-requests/request/progress')) {
          reads.push(init?.method ?? 'GET');
          return unavailable
            ? Response.json({ error: 'unavailable' }, { status: 503 })
            : Response.json(progress);
        }
        if (path.endsWith('/evaluation-requests/request')) return Response.json(request);
        return fetcher(input, init);
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.deepEqual(result.request, request);
    assert.deepEqual(result.progress, unavailable ? undefined : progress);
  }
  assert.deepEqual(reads, ['GET', 'GET']);
});

test('new requests freeze the selected app configuration and immutable content identities', async () => {
  const { env, fetcher } = historyFixture();
  const withCurrentParent: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init);
    if (new URL(String(input)).pathname.endsWith('/versions/candidate')) {
      return Response.json({ ...(await response.json()), parentVersionId: 'current' });
    }
    return response;
  };
  const configuration = {
    datasetRevision: 'own-data-v3',
    graderRevision: 'own-grader-v2',
    runtime: { configId: 'my-runner', configRevision: '7' },
    expectedCases: [{ caseId: 'real-work', repetition: 0 }],
  };
  const result = await improvement(
    env,
    {
      action: 'evaluate',
      versionId: 'candidate',
      expectedRevision: '3',
      key: '11111111-1111-4111-8111-111111111111',
      configuration,
    },
    withCurrentParent,
  );
  assert.equal(result.ok, true);
  if (!result.ok || !result.command) throw Error('missing prepared command');
  const body = JSON.parse(result.command.body);
  assert.deepEqual(body.runtime, configuration.runtime);
  assert.deepEqual(body.expectedCases, configuration.expectedCases);
  assert.equal(body.parentVersionId, 'current');
  assert.equal(body.candidateVersionId, 'candidate');
  assert.match(body.parentDigest, /^sha256:/);
  assert.equal(body.requireBoundEvidence, true);
});

test('a historical candidate stays inspectable against its actual parent without becoming releasable', async () => {
  const { env, fetcher } = historyFixture();
  const result = await improvement(env, { action: 'candidate', versionId: 'candidate' }, fetcher);
  assert.ok(result.ok && 'parent' in result);
  assert.equal(result.parent!.id, 'parent');
  assert.equal(result.parentPayload!.files[0].text, 'Older base.');
  const publication = await improvement(
    env,
    {
      action: 'publish',
      versionId: 'candidate',
      expectedRevision: '3',
      reason: 'Reviewed',
      key: '11111111-1111-4111-8111-111111111111',
    },
    fetcher,
  );
  assert.equal(publication.ok, false);
});

test('suggestion and request pagination use independent cursors and do not masquerade as a merged queue', async () => {
  const { env, fetcher, calls } = historyFixture();
  const proposalCursor = '11111111-1111-4111-8111-111111111111';
  await improvement(env, { action: 'proposals', proposalCursor }, fetcher);
  assert.ok(calls.some((url) => url.includes('/proposals?limit=20&cursor=' + proposalCursor)));
  assert.equal(
    calls.some((url) => url.includes('/evaluation-requests')),
    false,
  );
  calls.length = 0;
  const requestCursor = '22222222-2222-4222-8222-222222222222';
  await improvement(env, { action: 'requests', requestCursor }, fetcher);
  assert.ok(
    calls.some((url) => url.includes('/evaluation-requests?limit=20&cursor=' + requestCursor)),
  );
  assert.equal(
    calls.some((url) => url.includes('/proposals')),
    false,
  );
});

test('a new request requires explicit configuration and never supplies an example default', async () => {
  const { env, fetcher, calls } = historyFixture();
  const result = await improvement(
    env,
    {
      action: 'evaluate',
      versionId: 'candidate',
      expectedRevision: '3',
      key: '11111111-1111-4111-8111-111111111111',
    },
    fetcher,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /public configuration/);
  assert.equal(calls.length, 0);
});

test('reviewing a current candidate freezes the explicitly selected public descriptor before any write', async () => {
  const { env, fetcher } = historyFixture();
  let writes = 0;
  const prepared = await improvement(
    env,
    {
      action: 'evaluate',
      versionId: 'candidate',
      expectedRevision: '3',
      key: '11111111-1111-4111-8111-111111111111',
      configuration: appDescriptor,
    },
    async (input, init) => {
      if (init?.method === 'POST') writes++;
      const response = await fetcher(input, init);
      if (new URL(String(input)).pathname.endsWith('/versions/candidate')) {
        const metadata = await response.json();
        return Response.json({ ...metadata, parentVersionId: 'current' });
      }
      return response;
    },
  );
  assert.ok(prepared.ok && prepared.command);
  assert.equal(writes, 0);
  const body = JSON.parse(prepared.command.body);
  assert.equal(body.requireBoundEvidence, true);
  assert.equal(body.runtime.configId, 'app-agent');
  assert.equal(body.runtime.configRevision, '1');
  assert.equal(body.expectedCases.length, 4);
  assert.equal(body.parentVersionId, 'current');
  assert.equal(body.candidateVersionId, 'candidate');
});
