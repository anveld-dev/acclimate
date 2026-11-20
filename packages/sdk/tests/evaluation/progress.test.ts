import test from 'node:test';
import assert from 'node:assert/strict';
import { AcclimateClient } from '../../src/client.js';
import { createEvaluationProgressReporter } from '../../src/evaluation/progress.js';

const scope = {
  workspaceId: 'p',
  bundleId: '00000000-0000-0000-0000-000000000001',
  requestId: '00000000-0000-0000-0000-000000000002',
  attemptId: 'attempt',
};

test('optional reports send bounded public fields with exact attempt and sequence', async () => {
  const sent: { url: string; options: RequestInit }[] = [];
  const client = new AcclimateClient({
    baseUrl: 'https://fixture.example',
    token: 'token',
    scope: 'evaluator',
    fetch: async (url, options) => {
      sent.push({ url: String(url), options: options! });
      return new Response(JSON.stringify({ observation: null, activity: 'absent' }));
    },
  });
  const reporter = createEvaluationProgressReporter(client, scope);
  const update = {
    sequence: 1,
    phase: 'executing' as const,
    completed: 0,
    total: 2,
    case: { caseId: 'a', repetition: 0, rawOutput: 'private-case-canary' },
    rawOutput: 'private-output-canary',
  };
  assert.equal(await reporter.report(update), true);
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].url,
    `https://fixture.example/v1/workspaces/p/bundles/${scope.bundleId}/evaluation-requests/${scope.requestId}/progress`,
  );
  assert.deepEqual(JSON.parse(sent[0].options.body as string), {
    attemptId: 'attempt',
    sequence: 1,
    phase: 'executing',
    completed: 0,
    total: 2,
    case: { caseId: 'a', repetition: 0 },
  });
  assert.equal(JSON.stringify(sent).includes('private-'), false);
});

test('report failure, revoked authority and invalid data never fail callback work or retry execution', async () => {
  let requests = 0;
  const client = new AcclimateClient({
    baseUrl: 'https://fixture.example',
    token: 'token',
    scope: 'evaluator',
    retries: 0,
    fetch: async () => {
      requests++;
      throw new Error('private-provider-error');
    },
  });
  const reporter = createEvaluationProgressReporter(client, scope);
  let executions = 0;
  async function appCallback() {
    await reporter.report({ sequence: 1, phase: 'executing', completed: 0, total: 2 });
    executions++;
    return 'model output remains private';
  }
  assert.equal(await appCallback(), 'model output remains private');
  assert.equal(executions, 1);
  assert.equal(requests, 1);
  assert.equal(
    await reporter.report({ sequence: 2, phase: 'grading', completed: 3, total: 2 }),
    false,
  );
  assert.equal(requests, 1);
  const denied = createEvaluationProgressReporter(
    new AcclimateClient({
      baseUrl: 'https://fixture.example',
      token: 'revoked',
      scope: 'evaluator',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'denied', message: 'private-error' } }), {
          status: 403,
        }),
    }),
    scope,
  );
  assert.equal(
    await denied.report({ sequence: 2, phase: 'grading', completed: 1, total: 2 }),
    false,
  );
});

test('reporter creates no timer, background network call or lifecycle mutation', async () => {
  let requests = 0;
  const client = new AcclimateClient({
    baseUrl: 'https://fixture.example',
    token: 'token',
    scope: 'evaluator',
    fetch: async () => {
      requests++;
      return new Response('{}');
    },
  });
  createEvaluationProgressReporter(client, scope);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests, 0);
});
