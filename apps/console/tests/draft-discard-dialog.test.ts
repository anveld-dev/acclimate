import assert from 'node:assert/strict';
import test from 'node:test';
import { draftRequest } from '../src/lib/content-operation';
import {
  freezePendingExact,
  loadPending,
  resolvePending,
  type PendingStorage,
} from '../src/lib/pending-operation';

class MemoryStorage implements PendingStorage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
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
const scope = {
  owner: 'draft' as const,
  actorScope: 'actor',
  serviceIdentity: 'actor',
  projectId: 'p',
  bundleId: '11111111-1111-4111-8111-111111111111',
  channel: 'stable',
};
const key = '33333333-3333-4333-8333-333333333333';

test('discard recovery retains the exact draft, generation and operation key and blocks competing writes', () => {
  const storage = new MemoryStorage();
  const wire = draftRequest(
    { action: 'discard', id: '22222222-2222-4222-8222-222222222222', expectedGeneration: 7 },
    scope,
  );
  const record = freezePendingExact(storage, scope, wire.operationPath, wire.body, key);
  assert.deepEqual(loadPending(storage, scope), record);
  assert.match(record.action, /drafts\/22222222-2222-4222-8222-222222222222\/discard$/);
  assert.equal(record.body, '{"expectedGeneration":7}');
  assert.equal(record.key, key);
  assert.deepEqual(freezePendingExact(storage, scope, wire.operationPath, wire.body, key), record);
  assert.throws(
    () => freezePendingExact(storage, scope, wire.operationPath, '{"expectedGeneration":8}', key),
    /earlier operation/,
  );
  resolvePending(storage, scope);
  assert.equal(loadPending(storage, scope), null);
});

test('a storage failure prevents a discard request from being prepared', () => {
  const storage = new MemoryStorage();
  storage.setItem = () => {
    throw Error('storage unavailable');
  };
  const wire = draftRequest(
    { action: 'discard', id: '22222222-2222-4222-8222-222222222222', expectedGeneration: 7 },
    scope,
  );
  assert.throws(
    () => freezePendingExact(storage, scope, wire.operationPath, wire.body, key),
    /storage unavailable/,
  );
});

test('discard recovery rejects unsupported paths and oversized requests before storage', () => {
  const storage = new MemoryStorage();
  const wire = draftRequest(
    { action: 'discard', id: '22222222-2222-4222-8222-222222222222', expectedGeneration: 7 },
    scope,
  );
  for (const path of [
    '/discard',
    wire.operationPath.replace('/workspaces/p/', '/workspaces/other/'),
    wire.operationPath + '?x=1',
    wire.operationPath.replace('22222222-2222-4222-8222-222222222222', '..'),
  ]) {
    assert.throws(() => freezePendingExact(storage, scope, path, wire.body, key), /Unsupported/);
  }
  assert.throws(
    () =>
      freezePendingExact(
        storage,
        scope,
        wire.operationPath,
        JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }),
        key,
      ),
    /storage limit/,
  );
  assert.equal(storage.length, 0);
});
