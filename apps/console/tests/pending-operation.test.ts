import { consoleEnvironment } from './console-fixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  freezePending,
  freezePendingExact,
  loadPending,
  forgetPending,
  resolvePending,
  clearPendingOperations,
  type PendingStorage,
} from '../src/lib/pending-operation';
import { restoreRequest } from '../src/lib/content-operation';
import { exactOperation, closeOperation } from '../src/server/exact-operation';
class MemoryStorage implements PendingStorage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}
const bundle = '11111111-1111-4111-8111-111111111111';
const version = '22222222-2222-4222-8222-222222222222';
const key = '33333333-3333-4333-8333-333333333333';
const path = `/v1/workspaces/p/bundles/${bundle}/channels/stable/releases`;
const scope = {
  owner: 'releases' as const,
  actorScope: 'session-one',
  serviceIdentity: 'service-one',
  workspaceId: 'p',
  bundleId: bundle,
  channel: 'stable',
};
const env = {
  ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'machine-test',
  CONSOLE_SESSION_TOKEN: 'current-session',
  CONSOLE_ALLOW_EDITS: 'true',
  CONSOLE_WORKSPACE: 'p',
  CONSOLE_BUNDLE: bundle,
};
const body = { versionId: version, expectedRevision: '2', unevaluatedReason: 'Restore' };

// The service fingerprints the exact route and body.
function fingerprint(path: string, body: string) {
  return (
    'sha256:' +
    createHash('sha256').update('POST\0').update(path).update('\0').update(body).digest('hex')
  );
}

test('lost response survives reload; not_observed retries exact bytes and original key', async () => {
  const storage = new MemoryStorage();
  const request = restoreRequest(
    { versionId: version, expectedRevision: '2', reason: 'Restore' },
    scope,
  );
  assert.equal(request.operationPath, path);
  assert.deepEqual(JSON.parse(request.body), {
    versionId: version,
    expectedRevision: '2',
    unevaluatedReason: 'Manual rollback (not evaluated): Restore',
  });
  const record = freezePendingExact(storage, scope, request.operationPath, request.body, key);
  const posts: Array<{ body: string; key: string | null; session: string | null }> = [];
  let writes = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === 'GET') return Response.json({ status: 'not_observed', operationId: key });
    const headers = new Headers(init?.headers);
    posts.push({
      body: String(init?.body),
      key: headers.get('Idempotency-Key'),
      session: headers.get('X-Acclimate-Session'),
    });
    assert.equal(headers.get('X-Acclimate-Durable-Operation'), 'true');
    assert.equal(init?.redirect, 'manual');
    if (++writes === 1) throw new TypeError('dropped response after commit');
    return Response.json({ id: version, revision: '3' });
  };
  await assert.rejects(
    exactOperation(
      env,
      { workspaceId: 'p', key, operationPath: record.action, body: record.body! },
      fetcher,
    ),
  );
  // Fresh UI state may contain unrelated later edits. Retry is reconstructed from session storage.
  const reloaded = loadPending(storage, scope)!;
  const result = await exactOperation<{ revision: string }>(
    env,
    { workspaceId: 'p', key: reloaded.key, operationPath: reloaded.action, body: reloaded.body! },
    fetcher,
  );
  assert.equal(result.revision, '3');
  assert.deepEqual(posts, [
    { body: request.body, key, session: 'current-session' },
    { body: request.body, key, session: 'current-session' },
  ]);
  resolvePending(storage, scope);
  assert.equal(loadPending(storage, scope), null);
});

test('changed exact bytes cannot adopt an existing receipt', async () => {
  await assert.rejects(
    exactOperation(
      env,
      {
        workspaceId: 'p',
        key,
        operationPath: path,
        body: JSON.stringify({ ...body, expectedRevision: '99' }),
      },
      async () =>
        Response.json({
          status: 'committed',
          path,
          requestFingerprint: fingerprint(path, JSON.stringify(body)),
          result: { id: version },
        }),
    ),
    (error: any) => error.code === 'idempotency_conflict',
  );
});

test('forgetting and expiry preserve uncertainty while account changes cannot reuse text', () => {
  const storage = new MemoryStorage();
  freezePending(storage, scope, path, body, key);
  assert.equal(loadPending(storage, { ...scope, actorScope: 'other-account' }), null);
  const forgotten = forgetPending(storage, scope)!;
  assert.equal(forgotten.body, undefined);
  assert.equal(forgotten.key, key);
  assert.throws(() => freezePending(storage, scope, path, body, key), /Resolve/);
  resolvePending(storage, scope);
  freezePending(storage, scope, path, body, key);
  clearPendingOperations(storage, false);
  assert.equal(loadPending(storage, scope)?.body, undefined);
  resolvePending(storage, scope);
  freezePending(storage, scope, path, body, key);
  const slot = storage.key(0)!;
  const expired = JSON.parse(storage.getItem(slot)!);
  expired.createdAt = Date.now() - 25 * 3600000;
  storage.setItem(slot, JSON.stringify(expired));
  assert.equal(loadPending(storage, scope)?.body, undefined);
});

test('storage quota failures prevent submission and retain a metadata-only recovery identity', () => {
  const storage = new MemoryStorage();
  let writes = 0;
  const original = storage.setItem.bind(storage);
  storage.setItem = (k, v) => {
    if (++writes === 2) throw Error('quota');
    original(k, v);
  };
  assert.throws(() => freezePending(storage, scope, path, body, key), /quota/);
  assert.equal(loadPending(storage, scope)?.key, key);
  assert.equal(loadPending(storage, scope)?.body, undefined);
});

test('closed operations do not send another write; close is repeatable and uses the target key', async () => {
  let posts = 0;
  await assert.rejects(
    exactOperation(
      env,
      { workspaceId: 'p', key, operationPath: path, body: JSON.stringify(body) },
      async (_url, init) => {
        if (init?.method === 'POST') posts++;
        return Response.json({ status: 'closed', operationId: key });
      },
    ),
    (error: any) => error.code === 'operation_closed',
  );
  assert.equal(posts, 0);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await closeOperation(env, { workspaceId: 'p', key }, async (url, init) => {
          assert.match(String(url), /\/close$/);
          assert.equal(new Headers(init?.headers).get('Idempotency-Key'), key);
          return Response.json({ status: 'closed', operationId: key });
        })
      ).status,
      'closed',
    );
});

test('disabled editing, auth loss, noncanonical routes and crossed scope send no mutation', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    throw Error('unexpected request');
  };
  for (const operationPath of [
    path.replace(bundle, '%2e%2e'),
    path.replace(bundle, bundle + '%2f'),
    path.replace('stable', '../other'),
    path.replace('stable', 'other'),
    path.replace('/releases', '/drafts'),
  ]) {
    await assert.rejects(
      exactOperation(
        { ...env, CONSOLE_CHANNEL: 'stable' },
        { workspaceId: 'p', key, operationPath, body: JSON.stringify(body) },
        fetcher,
      ),
    );
  }
  await assert.rejects(
    exactOperation(
      { ...env, CONSOLE_ALLOW_EDITS: 'false' },
      { workspaceId: 'p', key, operationPath: path, body: JSON.stringify(body) },
      fetcher,
    ),
  );
  await assert.rejects(
    closeOperation({ ...env, CONSOLE_ALLOW_EDITS: 'false' }, { workspaceId: 'p', key }, fetcher),
  );
  await assert.rejects(
    exactOperation(
      { ...env, CONSOLE_SESSION_TOKEN: undefined },
      { workspaceId: 'p', key, operationPath: path, body: JSON.stringify(body) },
      fetcher,
    ),
  );
  assert.equal(calls, 0);
  await assert.rejects(
    exactOperation(
      env,
      { workspaceId: 'p', key, operationPath: path, body: JSON.stringify(body) },
      async () =>
        Response.json({ error: { code: 'denied', message: 'lost permission' } }, { status: 403 }),
    ),
    (error: any) => error.status === 403,
  );
});

test('canonical operation families preserve exact bytes through browser freezing and server replay', async () => {
  const root = `/v1/workspaces/p/bundles/${bundle}`;
  const channel = `${root}/channels/stable`;
  const paths = ['/v1/workspaces/p/bundle-setups', `${channel}/releases`];
  const exact = ' { "expectedRevision" : "2" }\n';
  for (const action of paths) {
    const storage = new MemoryStorage();
    const record = freezePendingExact(storage, scope, action, exact, key);
    assert.equal(loadPending(storage, scope)?.body, exact);
    let posts = 0;
    await exactOperation(
      { ...env, CONSOLE_CHANNEL: 'stable' },
      { workspaceId: 'p', operationPath: record.action, body: record.body!, key: record.key },
      async (_url, init) => {
        if (init?.method === 'GET')
          return Response.json({ status: 'not_observed', operationId: key });
        posts++;
        assert.equal(init?.body, exact);
        assert.equal(new Headers(init?.headers).get('Idempotency-Key'), key);
        return Response.json({});
      },
    );
    assert.equal(posts, 1);
  }
});

test('invalid operation targets never enter recovery storage or reach transport', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    throw Error('unexpected request');
  };
  const invalid = [
    path.replace('/workspaces/p/', '/workspaces/other/'),
    path.replace(bundle, '44444444-4444-4444-8444-444444444444'),
    path.replace('stable', 'canary'),
    path.replace(bundle, 'not-a-bundle'),
    `/v1/workspaces/p/bundles/${bundle}/evaluation-requests`,
    `/v1/workspaces/p/bundles/${bundle}/proposals`,
    path.replace('stable', 'bad channel'),
    path + '/extra',
    path + '?x=1',
    path + '#fragment',
    path.replace(bundle, '%2e%2e'),
    path.replace('stable', '..'),
    path.replace('stable', 'a\\b'),
    path.replace('/releases', '/drafts'),
    `/v1/workspaces/p/bundles/${bundle}/channels/stable/promotions`,
  ];
  for (const operationPath of invalid) {
    const storage = new MemoryStorage();
    assert.throws(
      () => freezePendingExact(storage, scope, operationPath, '{}', key),
      /Unsupported pending operation/,
    );
    assert.equal(storage.length, 0);
    await assert.rejects(
      exactOperation(
        { ...env, CONSOLE_CHANNEL: 'stable' },
        { workspaceId: 'p', operationPath, body: '{}', key },
        fetcher,
      ),
    );
  }
  assert.equal(calls, 0);
});
