import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcclimateClient, AcclimateUsageError } from '../../src/index.js';

test('product commands retry identical bytes and keys with explicit server session', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new AcclimateClient({
    baseUrl: 'https://example.test',
    token: 'operator',
    scope: 'p',
    sessionToken: 'server-session',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return calls.length === 1
        ? new Response('{}', { status: 503 })
        : Response.json({ id: 'draft', generation: 2 });
    },
  });
  const result = await client.saveDraft(
    'p',
    'b',
    'review/main',
    'd',
    { expectedGeneration: 1, payload: { schemaVersion: 1, files: [] } },
    'stable-key',
  );
  assert.equal(result.generation, 2);
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    'https://example.test/v1/workspaces/p/bundles/b/channels/review%2Fmain/drafts/d/save',
  );
  assert.equal(calls[0].init.body, calls[1].init.body);
  assert.deepEqual(calls[0].init.headers, calls[1].init.headers);
  assert.equal(new Headers(calls[0].init.headers).get('x-acclimate-session'), 'server-session');
  assert.equal(new Headers(calls[0].init.headers).get('idempotency-key'), 'stable-key');
});

test('list cursors are encoded and absent session stays absent', async () => {
  const client = new AcclimateClient({
    baseUrl: 'https://example.test',
    token: 'operator',
    scope: 'p',
    fetch: async (url, init) => {
      assert.equal(
        String(url),
        'https://example.test/v1/workspaces/p/bundles/b/evaluation-requests?limit=3&cursor=a%2Fb%2B',
      );
      assert.equal(new Headers(init?.headers).has('x-acclimate-session'), false);
      return Response.json({ items: [], nextCursor: 'next' });
    },
  });
  assert.deepEqual(await client.listEvaluations('p', 'b', { limit: 3, cursor: 'a/b+' }), {
    items: [],
    nextCursor: 'next',
  });
});

test('invalid path or missing mutation key makes no request', async () => {
  const client = new AcclimateClient({
    baseUrl: 'https://example.test',
    token: 'operator',
    scope: 'p',
    fetch: async () => {
      throw new Error('must not fetch');
    },
  });
  assert.throws(() => client.getDraft('p', 'b', '.', 'd'), /path identifiers/);
  await assert.rejects(
    client.interruptEvaluation('p', 'b', 'e', { reason: 'stop' }, ''),
    /idempotency key/,
  );
});

test('draft status all preserves access to closed records', async () => {
  const client = new AcclimateClient({
    baseUrl: 'https://example.test',
    token: 'operator',
    scope: 'p',
    fetch: async (url) => {
      assert.equal(
        String(url),
        'https://example.test/v1/workspaces/p/bundles/b/channels/main/drafts?limit=20&status=all',
      );
      return Response.json({ items: [{ id: 'd', status: 'published' }], nextCursor: null });
    },
  });
  assert.equal(
    (await client.listDrafts('p', 'b', 'main', { limit: 20, status: 'all' })).items[0].status,
    'published',
  );
});

test('abandonEvaluation posts a reason with the caller idempotency key', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new AcclimateClient({
    baseUrl: 'https://example.test',
    token: 'acm_evaluator',
    scope: 'p',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ id: 'e', status: 'abandoned', abandonedBy: 'machine:ci' });
    },
  });
  const result = await client.abandonEvaluation(
    'p',
    'b',
    'e',
    { reason: 'CI job cancelled' },
    'abandon-key',
  );
  assert.equal(result.status, 'abandoned');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/v1/workspaces/p/bundles/b/evaluation-requests/e/abandon');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, JSON.stringify({ reason: 'CI job cancelled' }));
  assert.equal(new Headers(calls[0].init.headers).get('idempotency-key'), 'abandon-key');
  await assert.rejects(client.abandonEvaluation('p', 'b', 'e', { reason: 'x' }, ''), /idempotency key/);
});
