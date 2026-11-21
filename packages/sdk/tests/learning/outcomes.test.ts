import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcclimateClient, type VerifiedVersion } from '../../src/index.js';
import { addEvolveCases, createLearningOutcomeReporter } from '../../src/learning/index.js';

test('outcome reporter uses verified identity and evolve case helper validates before sending', async () => {
  const calls: { url: string; body: unknown; key: string | null }[] = [];
  const client = new AcclimateClient({
    baseUrl: 'http://127.0.0.1:8000',
    token: 'token',
    scope: 'scope',
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        key: new Headers(init?.headers).get('Idempotency-Key'),
      });
      return Response.json({});
    },
  });
  const target = { workspaceId: 'w', bundleId: 'b' };
  const report = createLearningOutcomeReporter({ client, ...target });
  const version: VerifiedVersion = {
    version: {
      id: 'v',
      bundleId: 'b',
      parentVersionId: null,
      createdAt: 'now',
      digest: 'sha256:' + 'a'.repeat(64),
    },
    payload: { schemaVersion: 1, files: [] },
    resolvedAt: 0,
    stale: false,
  };
  const body = {
    outcomeId: '00000000-0000-4000-8000-000000000001',
    input: { job: 1 },
    expected: null,
  };
  await assert.rejects(report(version, { ...body, outcomeId: 'invalid' }), /UUID/);
  await assert.rejects(
    report({ ...version, version: { ...version.version, bundleId: 'other' } }, body),
    /different bundle/,
  );
  await report(version, body);
  assert.deepEqual(calls[0], {
    url: 'http://127.0.0.1:8000/v1/workspaces/w/bundles/b/learning/outcomes',
    body: { ...body, versionId: 'v', digest: version.version.digest },
    key: body.outcomeId,
  });

  const item = { caseId: 'a', input: null, expected: 1 };
  for (const invalid of [
    {},
    { cases: [item, item] },
    { retire: ['a', 'a'] },
    { cases: [{ ...item, caseId: 'outcome:a' }] },
    { retire: Array.from({ length: 101 }, (_, index) => String(index)) },
    { cases: [{ ...item, expected: 'a'.repeat(64 * 1024) }] },
  ])
    await assert.rejects(addEvolveCases(client, target, invalid));
  const change = { cases: [item], retire: ['outcome:earlier'] };
  await addEvolveCases(client, target, change);
  assert.deepEqual(calls[1], {
    url: 'http://127.0.0.1:8000/v1/workspaces/w/bundles/b/learning/evolve-cases',
    body: change,
    key: null,
  });
  assert.equal(calls.length, 2);
});
