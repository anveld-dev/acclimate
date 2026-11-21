import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AcclimateClient,
  type LearningCandidate,
  type LearningMemory,
  type LearningRound,
  type LearningSelection,
} from '../../src/index.js';

test('learning reads preserve candidate diagnostics, selection and revision zero', async () => {
  const paths: string[] = [];
  const candidate = {
    sample: 1,
    status: 'dropped',
    dropReason: 'scanner-rejected',
    diagnosis: { problem: { id: 'P1' }, predicted: ['case-a'] },
    rationale: null,
    changes: null,
    scan: { clean: false, findings: [{ rule: 'email', field: 'rationale', path: null }] },
    screen: null,
    versionId: null,
    evaluationId: null,
    evolveScore: null,
  } satisfies LearningCandidate;
  const selection = {
    decision: 'keep',
    sample: null,
    versionId: null,
    digest: null,
    reason: 'Keep the incumbent',
    model: 'optimizer',
    inputDigest: 'sha256:input',
  } satisfies LearningSelection;
  const round = {
    id: 'r',
    number: 1,
    state: 'completed',
    decision: 'kept',
    reason: 'selector-kept',
    parentVersionId: 'v',
    adoptedSample: null,
    adoptedVersionId: null,
    incumbentScore: 0.5,
    heldOutScore: 0.5,
    heldOutError: null,
    createdAt: 'now',
    endedAt: 'now',
    channel: 'stable',
    channelRevision: '1',
    evolveRevision: 2,
    memoryRevision: 0,
    memoryDigest: 'sha256:memory',
    historyDigest: null,
    setting: { domain: 'support', benchmark: 'tickets', policyModel: 'policy' },
    heldOut: { digest: 'sha256:held-out', cases: 2 },
    optimizerModel: 'optimizer',
    selection,
    candidates: [candidate],
    evaluations: [],
  } satisfies LearningRound;
  const memory = {
    currentRevision: 1,
    memoryRevision: 0,
    memoryDigest: 'sha256:memory',
    improvementMemory: { schemaVersion: 1, memoryRevision: 0, problems: [] },
    records: [],
  } satisfies LearningMemory;
  const client = new AcclimateClient({
    baseUrl: 'http://127.0.0.1:8000',
    token: 'console',
    sessionToken: 'session',
    scope: 'test',
    fetch: async (input, init) => {
      const { pathname, search } = new URL(String(input));
      paths.push(pathname + search);
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).get('x-acclimate-session'), 'session');
      return Response.json(pathname.endsWith('/memory') ? memory : round);
    },
  });
  assert.deepEqual(await client.getLearningRound('w', 'b', 'r'), round);
  assert.deepEqual(await client.getLearningMemory('w', 'b'), memory);
  assert.deepEqual(await client.getLearningMemory('w', 'b', { revision: 0 }), memory);
  assert.deepEqual(paths, [
    '/v1/workspaces/w/bundles/b/learning/rounds/r',
    '/v1/workspaces/w/bundles/b/learning/memory',
    '/v1/workspaces/w/bundles/b/learning/memory?revision=0',
  ]);
});
