import { consoleEnvironment } from './console-fixture';
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentDiff } from '../src/components/diff-content';
import { mergeHistory, refreshKnownActive } from '../src/lib/improvement-history';
import { improvement } from '../src/server/improvement';
import { localEvaluationDescriptor } from '../../../scripts/evaluator-tests/descriptors';

test('a frozen proposal needs consent matching exactly the evidence being disclosed', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    throw Error('unexpected');
  };
  const command = {
    action: 'submitFrozen',
    key: '11111111-1111-4111-8111-111111111111',
    operationPath: '/v1/workspaces/project/bundles/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/proposals',
    body: JSON.stringify({ evidence: ['selected trace'] }),
  };
  assert.equal((await improvement(env, command, fetcher)).ok, false);
  assert.equal(
    (
      await improvement(
        env,
        {
          ...command,
          disclosure: {
            consent: true,
            wholeParentBundle: true,
            authorizedEvidence: ['different trace'],
          },
        },
        fetcher,
      )
    ).ok,
    false,
  );
  assert.equal(calls, 0);
});

const env = {
  ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'fixture',
  CONSOLE_WORKSPACE: 'project',
  CONSOLE_BUNDLE: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  CONSOLE_CHANNEL: 'stable',
  CONSOLE_ALLOW_EDITS: 'true',
};
const operationPath =
  '/v1/workspaces/project/bundles/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/evaluation-requests';
const key = '11111111-1111-4111-8111-111111111111';
const frozenBody = JSON.stringify({ ...localEvaluationDescriptor, requireBoundEvidence: true });
// The service fingerprints the exact route and body.
const fingerprint = `sha256:${createHash('sha256')
  .update('POST\0')
  .update(operationPath)
  .update('\0')
  .update(frozenBody)
  .digest('hex')}`;

test('exact uncertain evaluation retry returns receipt before mutable channel preflight', async () => {
  const calls: string[] = [];
  const request = { id: 'recorded', requireBoundEvidence: true };
  const result = await improvement(
    env,
    {
      action: 'submitFrozen',
      operationPath,
      key,
      body: frozenBody,
    },
    async (input) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      assert.ok(url.pathname.endsWith('/operations/' + key));
      return Response.json({
        status: 'committed',
        operationId: key,
        path: operationPath,
        requestFingerprint: fingerprint,
        result: request,
      });
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.result, request);
  assert.equal(calls.length, 1);
});

test('explicit new requests use new keys while an exact retry reuses the original identity', async () => {
  const seen: string[] = [];
  const receipts = new Map<string, object>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'GET') {
      const id = url.pathname.split('/').at(-1)!;
      return Response.json(
        receipts.has(id)
          ? {
              status: 'committed',
              operationId: id,
              path: operationPath,
              requestFingerprint: fingerprint,
              result: receipts.get(id),
            }
          : { status: 'not_observed', operationId: id },
      );
    }
    const headers = new Headers(init?.headers);
    const id = headers.get('Idempotency-Key')!;
    assert.equal(headers.get('X-Acclimate-Durable-Operation'), 'true');
    seen.push(id);
    const value = { id: `evaluation-${seen.length}`, requireBoundEvidence: true };
    receipts.set(id, value);
    return Response.json(value);
  };
  const command = {
    action: 'submitFrozen',
    operationPath,
    body: frozenBody,
  };
  const first = await improvement(env, { ...command, key }, fetcher);
  const retry = await improvement(env, { ...command, key }, fetcher);
  const second = await improvement(
    env,
    { ...command, key: '22222222-2222-4222-8222-222222222222' },
    fetcher,
  );
  assert.deepEqual(first, retry);
  assert.notDeepEqual(first, second);
  assert.deepEqual(seen, [key, '22222222-2222-4222-8222-222222222222']);
});

test('new console requests require bound evidence and exact commands cannot cross selected scope', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    throw Error('unexpected');
  };
  assert.equal(
    (await improvement(env, { action: 'submitFrozen', operationPath, key, body: '{}' }, fetcher))
      .ok,
    false,
  );
  assert.equal(
    (
      await improvement(
        env,
        {
          action: 'submitFrozen',
          operationPath: operationPath.replace(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          ),
          key,
          body: '{}',
        },
        fetcher,
      )
    ).ok,
    false,
  );
  assert.equal(calls, 0);
});

test('direct polling reaches known active rows beyond twenty entries with bounded concurrency', async () => {
  const rows = Array.from({ length: 31 }, (_, i) => ({
    id: String(i),
    status: i === 1 ? 'completed' : 'running',
  }));
  let active = 0,
    peak = 0;
  const seen: string[] = [];
  const result = await refreshKnownActive(
    rows,
    async (id) => {
      active++;
      peak = Math.max(peak, active);
      seen.push(id);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return { id, status: 'completed' };
    },
    () => true,
  );
  assert.equal(result.length, 30);
  assert.ok(seen.includes('30'));
  assert.ok(!seen.includes('1'));
  assert.equal(peak, 4);
  const merged = mergeHistory(rows.slice(0, 20), rows.slice(20), true);
  assert.deepEqual(merged, rows);
  assert.deepEqual(mergeHistory(merged, [{ id: 'new', status: 'requested' }, rows[0]])[0], {
    id: 'new',
    status: 'requested',
  });
});

test('scope changes discard direct polling results and stop claiming later batches', async () => {
  let current = true,
    calls = 0;
  const result = await refreshKnownActive(
    Array.from({ length: 30 }, (_, i) => ({ id: String(i), status: 'running' })),
    async (id) => {
      calls++;
      current = false;
      return { id, status: 'completed' };
    },
    () => current,
  );
  assert.deepEqual(result, []);
  assert.equal(calls, 4);
});

test('final ContentDiff includes kind-only changes and empty added/removed files', () => {
  const html = renderToStaticMarkup(
    createElement(ContentDiff, {
      base: {
        schemaVersion: 1,
        files: [
          { path: 'kind.md', kind: 'instruction', text: '' },
          { path: 'removed.md', kind: 'skill', text: '' },
        ],
      },
      current: {
        schemaVersion: 1,
        files: [
          { path: 'kind.md', kind: 'memory', text: '' },
          { path: 'added.md', kind: 'skill', text: '' },
        ],
      },
    }),
  );
  assert.match(html, /Changed: kind.md/);
  assert.match(html, /Kind: instruction/);
  assert.match(html, /memory/);
  assert.match(html, /Removed: removed.md/);
  assert.match(html, /Added: added.md/);
  assert.match(html, /Download original entry JSON/);
  assert.match(html, /Download current entry JSON/);
});

test('large diff opens the shared merge view with complete downloadable changed lines', () => {
  const text = Array.from({ length: 700 }, (_, i) => `line-${i}`).join('\n');
  const html = renderToStaticMarkup(
    createElement(ContentDiff, {
      base: { schemaVersion: 1, files: [] },
      current: { schemaVersion: 1, files: [{ path: 'large.md', kind: 'instruction', text }] },
    }),
  );
  assert.match(html, /Changed lines in large.md/);
  assert.match(html, /Download all changed lines/);
  assert.match(decodeURIComponent(html), /line-699/);
});
