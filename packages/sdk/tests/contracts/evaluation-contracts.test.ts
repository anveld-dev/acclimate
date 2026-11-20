import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AcclimateClient, ApiError } from '../../src/client.js';
import {
  assertGuidedTarget,
  evaluationDescriptorDifferences,
  validateEvaluationDescriptor,
  validateEvaluationHandoff,
  validateEvaluationServiceUrl,
} from '../../src/validation.js';
import {
  createEvaluationTransport,
  evaluationFingerprint,
  evaluationOperationPath,
} from '../../src/internal/evaluation-transport.js';

const bundleId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const descriptor = () => ({
  datasetRevision: 'tasks-1',
  graderRevision: 'grader-1',
  runtime: { configId: 'fixture', configRevision: '1', model: 'none' },
  expectedCases: [
    { caseId: 'first', repetition: 0 },
    { caseId: 'second', repetition: 0 },
  ],
});
const handoff = () => ({
  schemaVersion: 1,
  serviceUrl: 'https://api.example',
  workspaceId: 'project',
  bundleId,
  requestId,
  descriptor: descriptor(),
});

test('public descriptor validation isolates caller mutation and detects inventory drift', () => {
  const original = descriptor();
  const frozen = validateEvaluationDescriptor(original);
  original.runtime.model = 'changed';
  original.expectedCases[0].caseId = 'changed';
  assert.equal(frozen.runtime.model, 'none');
  assert.equal(frozen.expectedCases[0].caseId, 'first');
  const reordered = {
    ...descriptor(),
    runtime: { model: 'none', configRevision: '1', configId: 'fixture' },
    expectedCases: [...descriptor().expectedCases].reverse(),
  };
  assert.deepEqual(evaluationDescriptorDifferences(frozen, reordered), []);
  assert.deepEqual(
    evaluationDescriptorDifferences(frozen, {
      ...reordered,
      runtime: { ...reordered.runtime, model: 'other' },
    }),
    ['runtime'],
  );
  assert.throws(() =>
    validateEvaluationDescriptor({
      ...descriptor(),
      expectedCases: [frozen.expectedCases[0], frozen.expectedCases[0]],
    }),
  );
});

test('public handoff rejects private fields and malformed targets without echoing values', () => {
  assert.deepEqual(validateEvaluationHandoff(handoff()), handoff());
  const canary = 'private-token-canary-do-not-print';
  for (const invalid of [
    { ...handoff(), evaluatorToken: canary },
    { ...handoff(), workspaceId: '../other' },
    { ...handoff(), descriptor: { ...descriptor(), privatePath: canary } },
    { ...handoff(), serviceUrl: `https://${canary}@api.example` },
  ])
    assert.throws(
      () => validateEvaluationHandoff(invalid),
      (error) => error instanceof Error && !error.message.includes(canary),
    );
  const accessor = Object.defineProperty({}, 'schemaVersion', {
    get() {
      throw new Error(canary);
    },
    enumerable: true,
  });
  assert.throws(
    () => validateEvaluationHandoff(accessor),
    (error) => error instanceof Error && !error.message.includes(canary),
  );
});


test('public inventory rejects accessors and custom arrays without invoking app code', () => {
  let invoked = 0;
  const expectedCases = [{ caseId: 'first', repetition: 0 }];
  Object.defineProperty(expectedCases, '0', {
    get() {
      invoked++;
      throw new Error('private-canary');
    },
    enumerable: true,
  });
  assert.throws(() => validateEvaluationDescriptor({ ...descriptor(), expectedCases }));
  assert.equal(invoked, 0);
  const serializing = [...descriptor().expectedCases];
  Object.defineProperty(serializing, 'toJSON', {
    value() {
      invoked++;
      return [];
    },
  });
  assert.throws(() =>
    validateEvaluationDescriptor({ ...descriptor(), expectedCases: serializing }),
  );
  assert.equal(invoked, 0);
});

test('guided grammar never advertises legacy long, Unicode, encoded or non-string targets', () => {
  assert.doesNotThrow(() => assertGuidedTarget({ workspaceId: 'p-1.valid', bundleId, requestId }));
  for (const workspaceId of ['', '.', '..', 'p'.repeat(129), 'café', 'a%2Fb', 'a/b', undefined, 123])
    assert.throws(() => assertGuidedTarget({ workspaceId: workspaceId as string }));
  assert.throws(() =>
    assertGuidedTarget({ workspaceId: 'p', bundleId: bundleId.toUpperCase().replace('1', 'A') }),
  );
  assert.throws(() => assertGuidedTarget({ workspaceId: 'p', principalId: '\ud800' }));
  assert.equal(validateEvaluationServiceUrl('https://API.EXAMPLE/'), 'https://API.EXAMPLE/');
  assert.equal(validateEvaluationServiceUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  for (const value of [
    'http://remote.example',
    'https://api.example/path',
    'https://api.example?token=x',
  ])
    assert.throws(() => validateEvaluationServiceUrl(value));
});

test('retained transport retries exact Unicode request bytes and the same authorization/key', async () => {
  const body = '{\n "attemptId": "é", "value": 0.10\n}';
  const sent: Array<{ path: string; body: unknown; headers: Headers }> = [];
  const transport = createEvaluationTransport({
    serviceUrl: 'https://api.example',
    workspaceId: 'project',
    evaluatorPrincipalId: 'evaluator',
    evaluatorToken: 'fixture-token',
    fetch: async (input, init) => {
      sent.push({ path: String(input), body: init?.body, headers: new Headers(init?.headers) });
      if (sent.length === 1) throw new TypeError('lost response');
      return Response.json({ status: 'running' });
    },
  });
  const scope = { workspaceId: 'project', bundleId, requestId };
  assert.deepEqual(await transport.mutate('start', scope, body, 'same-key'), { status: 'running' });
  assert.equal(sent.length, 2);
  for (const call of sent) {
    assert.equal(call.body, body);
    assert.equal(call.headers.get('authorization'), 'Bearer fixture-token');
    assert.equal(call.headers.get('idempotency-key'), 'same-key');
    assert.equal(call.headers.get('x-acclimate-durable-operation'), 'true');
  }
  const path = evaluationOperationPath('start', scope);
  assert.equal(
    evaluationFingerprint('start', scope, body),
    'sha256:' +
      createHash('sha256')
        .update('POST\0' + path + '\0' + body)
        .digest('hex'),
  );
  assert.throws(() => transport.mutate('start', { ...scope, workspaceId: 'other' }, body, 'key'));
  assert.throws(() => evaluationOperationPath('start', { workspaceId: 'project', bundleId }));
  assert.throws(() =>
    evaluationOperationPath('createDraft', { workspaceId: 'project', bundleId, channel: '../other' }),
  );
});

test('JSON budget cancels a growing response before draining it, including HTTP errors', async () => {
  for (const status of [200, 500]) {
    let cancelled = false,
      pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(512).fill(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new AcclimateClient({
      baseUrl: 'https://api.example',
      token: 'fixture',
      scope: 'p',
      maxJsonResponseBytes: 1024,
      retries: 0,
      fetch: async () => new Response(stream, { status }),
    });
    await assert.rejects(
      client.getEvaluationCapabilities('project'),
      (error) => error instanceof ApiError && error.code === 'response_too_large',
    );
    assert.equal(cancelled, true);
    assert.ok(pulls <= 4, 'The reader must stop instead of buffering an unbounded response');
  }
});

test('default response budget accepts comparison and operation wrappers larger than a report request', async () => {
  const reportSized = { content: 'x'.repeat(2 * 1024 * 1024 - 100) };
  const wrapped = {
    status: 'committed',
    operationId: 'k',
    path: '/v1/workspaces/project',
    result: {
      ...reportSized,
      id: requestId,
      submitter: 'e'.repeat(1024),
      createdAt: new Date(0).toISOString(),
    },
  };
  const bytes = JSON.stringify(wrapped);
  assert.ok(Buffer.byteLength(bytes) > 2 * 1024 * 1024);
  const client = new AcclimateClient({
    baseUrl: 'https://api.example',
    token: 'fixture',
    scope: 'p',
    fetch: async () => new Response(bytes),
  });
  assert.deepEqual(await client.getOperation('project', 'k'), wrapped);
});
