import test from 'node:test';
import assert from 'node:assert/strict';
import { AcclimateClient, ApiError } from '../../src/client.js';
import {
  assertGuidedTarget,
  validateEvaluationDescriptor,
  validateEvaluationServiceUrl,
} from '../../src/validation.js';
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
test('installed descriptor validation captures the case inventory and runtime', () => {
  const original = descriptor();
  const validated = validateEvaluationDescriptor(original);
  original.runtime.model = 'changed';
  original.expectedCases[0].caseId = 'changed';
  assert.equal(validated.runtime.model, 'none');
  assert.equal(validated.expectedCases[0].caseId, 'first');
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
  assert.doesNotThrow(() => assertGuidedTarget({ workspaceId: 'p-1.valid', bundleId }));
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
      client.listBundles('project'),
      (error) => error instanceof ApiError && error.code === 'response_too_large',
    );
    assert.equal(cancelled, true);
    assert.ok(pulls <= 4, 'The reader must stop instead of buffering an unbounded response');
  }
});

test('default response budget accepts operation wrappers larger than a payload', async () => {
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
