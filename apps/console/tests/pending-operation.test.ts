import { consoleEnvironment } from './console-fixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  freezePending,
  loadPending,
  forgetPending,
  resolvePending,
  clearPendingOperations,
  findRelatedPending,
  type PendingStorage,
} from '../src/lib/pending-operation';
import { exactOperation, closeOperation } from '../src/server/exact-operation';
import { uniqueSkillName } from '../src/lib/unique-skill-name';
import { draftCommand } from '../src/server/drafts';
import { editChannel } from '../src/server/edit-channel';
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
const draft = '22222222-2222-4222-8222-222222222222';
const key = '33333333-3333-4333-8333-333333333333';
const path = `/v1/projects/p/bundles/${bundle}/channels/stable/drafts/${draft}/save`;
const scope = {
  actorScope: 'session-one',
  serviceIdentity: 'service-one',
  projectId: 'p',
  bundleId: bundle,
  channel: 'stable',
};
const env = { ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'machine-test',
  CONSOLE_SESSION_TOKEN: 'current-session',
  CONSOLE_ALLOW_EDITS: 'true',
  CONSOLE_PROJECT: 'p',
  CONSOLE_BUNDLE: bundle,
};
const body = {
  expectedGeneration: 2,
  payload: {
    schemaVersion: 1,
    files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'reviewed\ntext' }],
  },
};

test('different page property order cannot hide or overwrite an unresolved submission', () => {
  const storage = new MemoryStorage();
  const otherPage = {
    actorScope: scope.actorScope,
    projectId: scope.projectId,
    bundleId: scope.bundleId,
    channel: scope.channel,
    serviceIdentity: scope.serviceIdentity,
  };
  const original = freezePending(storage, scope, path, body, key);
  assert.equal(findRelatedPending(storage, otherPage)?.key, key);
  assert.throws(() => freezePending(storage, otherPage, path, body), /earlier operation/);
  assert.equal(storage.length, 1);
  assert.deepEqual(loadPending(storage, scope), original);
  resolvePending(storage, original.scope);
  assert.equal(findRelatedPending(storage, otherPage), null);
});

test('related recovery recognizes legacy draft identity while isolating other actors, channels and services', () => {
  const storage = new MemoryStorage();
  const legacy = { ...scope, serviceIdentity: scope.actorScope };
  freezePending(storage, legacy, path, body, key);
  assert.equal(findRelatedPending(storage, scope)?.key, key);
  assert.equal(findRelatedPending(storage, { ...scope, actorScope: 'other-person' }), null);
  assert.equal(findRelatedPending(storage, { ...scope, channel: 'canary' }), null);
  resolvePending(storage, legacy);
  freezePending(storage, scope, path, body, key);
  assert.equal(findRelatedPending(storage, { ...scope, serviceIdentity: 'other-service' }), null);
});
function fingerprint(path: string, body: string) {
  return (
    'sha256:' +
    createHash('sha256').update('POST\0').update(path).update('\0').update(body).digest('hex')
  );
}

test('lost response survives reload; not_observed retries exact bytes and original key', async () => {
  const storage = new MemoryStorage();
  const record = freezePending(storage, scope, path, body, key);
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
    return Response.json({ id: draft, generation: 3 });
  };
  await assert.rejects(
    exactOperation(
      env,
      { projectId: 'p', key, operationPath: record.action, body: record.body! },
      fetcher,
    ),
  );
  // Fresh UI state may contain unrelated later edits. Retry is reconstructed from session storage.
  const reloaded = loadPending(storage, scope)!;
  const result = await exactOperation<{ generation: number }>(
    env,
    { projectId: 'p', key: reloaded.key, operationPath: reloaded.action, body: reloaded.body! },
    fetcher,
  );
  assert.equal(result.generation, 3);
  assert.deepEqual(posts, [
    { body: JSON.stringify(body), key, session: 'current-session' },
    { body: JSON.stringify(body), key, session: 'current-session' },
  ]);
  resolvePending(storage, scope);
  assert.equal(loadPending(storage, scope), null);
});

test('receipt reconciliation wins before stale generation/revision preflight and uses current session', async () => {
  const exact = JSON.stringify(body);
  let calls = 0;
  const result = await draftCommand(
    env,
    { action: 'retry', key, operationPath: path, body: exact },
    async (_url, init) => {
      calls++;
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).get('X-Acclimate-Session'), 'current-session');
      return Response.json({
        status: 'committed',
        operationId: key,
        path,
        requestFingerprint: fingerprint(path, exact),
        result: { id: draft, generation: 3 },
      });
    },
  );
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  const releasePath = `/v1/projects/p/bundles/${bundle}/channels/stable/promotions`;
  const restored = await editChannel(
    env,
    { action: 'rollback', key, expectedRevision: '1', versionId: 'old-version', reason: 'Restore' },
    async (_url, init) => {
      assert.equal(init?.method, 'GET');
      return Response.json({
        status: 'committed',
        operationId: key,
        path: releasePath,
        requestFingerprint: fingerprint(
          releasePath,
          JSON.stringify({
            versionId: 'old-version',
            expectedRevision: '1',
            unevaluatedReason: 'Manual rollback (not evaluated): Restore',
          }),
        ),
        result: { revision: '2', version: { id: 'old-version' } },
      });
    },
  );
  assert.equal(restored.ok, true);
});

test('changed exact bytes cannot adopt an existing receipt', async () => {
  await assert.rejects(
    exactOperation(
      env,
      {
        projectId: 'p',
        key,
        operationPath: path,
        body: JSON.stringify({ ...body, expectedGeneration: 99 }),
      },
      async () =>
        Response.json({
          status: 'committed',
          path,
          requestFingerprint: fingerprint(path, JSON.stringify(body)),
          result: { id: draft },
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
      { projectId: 'p', key, operationPath: path, body: JSON.stringify(body) },
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
        await closeOperation(env, { projectId: 'p', key }, async (url, init) => {
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
    path.replace('/drafts/', '/credentials/'),
  ]) {
    await assert.rejects(
      exactOperation(
        { ...env, CONSOLE_CHANNEL: 'stable' },
        { projectId: 'p', key, operationPath, body: JSON.stringify(body) },
        fetcher,
      ),
    );
  }
  await assert.rejects(
    exactOperation(
      { ...env, CONSOLE_ALLOW_EDITS: 'false' },
      { projectId: 'p', key, operationPath: path, body: JSON.stringify(body) },
      fetcher,
    ),
  );
  await assert.rejects(
    closeOperation({ ...env, CONSOLE_ALLOW_EDITS: 'false' }, { projectId: 'p', key }, fetcher),
  );
  await assert.rejects(
    exactOperation(
      { ...env, CONSOLE_SESSION_TOKEN: undefined },
      { projectId: 'p', key, operationPath: path, body: JSON.stringify(body) },
      fetcher,
    ),
  );
  assert.equal(calls, 0);
  await assert.rejects(
    exactOperation(
      env,
      { projectId: 'p', key, operationPath: path, body: JSON.stringify(body) },
      async () =>
        Response.json({ error: { code: 'denied', message: 'lost permission' } }, { status: 403 }),
    ),
    (error: any) => error.status === 403,
  );
});

test('new skill allocation reserves all support paths and case collisions', () => {
  assert.equal(uniqueSkillName([]), 'new-skill');
  assert.equal(
    uniqueSkillName([
      { path: 'skills/New-Skill/reference.md' },
      { path: 'skills/new-skill-2/SKILL.md' },
    ]),
    'new-skill-3',
  );
});
