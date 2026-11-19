import { consoleEnvironment } from './console-fixture';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { editChannel } from '../src/server/edit-channel';
const env = {
  ...consoleEnvironment,
  CONSOLE_ALLOW_EDITS: 'true',
  CONSOLE_SERVICE_TOKEN: 'local-private',
  CONSOLE_PROJECT: 'demo',
  CONSOLE_BUNDLE: '11111111-1111-4111-8111-111111111111',
};
const payload = {
  schemaVersion: 1,
  files: [
    { path: 'instructions/main.md', kind: 'instruction', text: 'Original' },
    { path: 'memory/main.md', kind: 'memory', text: 'Keep me' },
  ],
};
const bytes = JSON.stringify(payload) + '\n';
const version = {
  id: 'parent',
  bundleId: env.CONSOLE_BUNDLE,
  parentVersionId: null,
  createdAt: '2026-11-13T00:00:00Z',
  digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
};
function fixture(parent = 'parent', conflict = false) {
  const writes: Array<{ url: string; body: any }> = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input);
    if (url.includes('/v1/workspaces?'))
      return Response.json({
        items: [{ id: env.CONSOLE_PROJECT, name: 'Workspace', role: 'admin' }],
        nextCursor: null,
      });
    if (url.includes('/operations/'))
      return Response.json({ status: 'not_observed', operationId: 'key' });
    if (url.includes('/bundles?'))
      return Response.json({
        items: [{ id: env.CONSOLE_BUNDLE, origin: 'created', compatibilityTarget: 'generic' }],
        nextCursor: null,
      });
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body as string);
      writes.push({ url, body });
      if (url.endsWith('/releases'))
        return Response.json(
          conflict
            ? { error: { code: 'revision_conflict', message: 'changed' } }
            : { revision: '3', version: { ...version, id: 'draft' } },
          { status: conflict ? 409 : 201 },
        );
      return Response.json({ ...version, id: 'draft', parentVersionId: 'parent' });
    }
    if (url.includes('/releases?')) return Response.json({ items: [], nextBeforeRevision: null });
    if (url.endsWith('/payload')) return new Response(bytes);
    if (url.endsWith('/versions/draft'))
      return Response.json({ ...version, id: 'draft', parentVersionId: parent });
    return Response.json({ channel: 'stable', revision: '2', version });
  };
  return { writes, fetcher };
}
test('editing must be explicitly enabled, including direct server calls', async () => {
  const result = await editChannel({}, { action: 'save' }, async () => {
    throw new Error('No network allowed');
  });
  assert.equal(result.ok, false);
});
test('save changes only the selected existing file and does not promote', async () => {
  const f = fixture();
  const result = await editChannel(
    env,
    {
      action: 'save',
      path: 'instructions/main.md',
      text: 'Updated',
      expectedRevision: '2',
      key: randomUUID(),
    },
    f.fetcher,
  );
  assert.equal(result.ok, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].body.parentVersionId, 'parent');
  assert.deepEqual(f.writes[0].body.payload.files, [
    { ...payload.files[0], text: 'Updated' },
    payload.files[1],
  ]);
});
test('an out-of-date edit cannot write', async () => {
  const f = fixture();
  const result = await editChannel(
    env,
    {
      action: 'save',
      path: 'instructions/main.md',
      text: 'Updated',
      expectedRevision: '1',
      key: randomUUID(),
    },
    f.fetcher,
  );
  assert.equal(result.ok, false);
  assert.equal(f.writes.length, 0);
});
test('publishing requires a reason and a draft based on the current version', async () => {
  const f = fixture('older-parent');
  const result = await editChannel(
    env,
    {
      action: 'publish',
      versionId: 'draft',
      expectedRevision: '2',
      reason: 'Manual review',
      key: randomUUID(),
    },
    f.fetcher,
  );
  assert.equal(result.ok, false);
  assert.equal(f.writes.length, 0);
  const blank = await editChannel(
    env,
    {
      action: 'publish',
      versionId: 'draft',
      expectedRevision: '2',
      reason: ' ',
      key: randomUUID(),
    },
    f.fetcher,
  );
  assert.equal(blank.ok, false);
  assert.equal(f.writes.length, 0);
});
test('publish records an honest unevaluated reason and the expected revision', async () => {
  const f = fixture();
  const result = await editChannel(
    env,
    {
      action: 'publish',
      versionId: 'draft',
      expectedRevision: '2',
      reason: 'Clarify retries',
      key: randomUUID(),
    },
    f.fetcher,
  );
  assert.equal(result.ok, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].body.expectedRevision, '2');
  assert.match(f.writes[0].body.unevaluatedReason, /not evaluated/);
});
test('a concurrent release conflict is visible, with no blind overwrite', async () => {
  const f = fixture('parent', true);
  const result = await editChannel(
    env,
    {
      action: 'publish',
      versionId: 'draft',
      expectedRevision: '2',
      reason: 'Clarify retries',
      key: randomUUID(),
    },
    f.fetcher,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /release changed/);
});
test('rollback is gated, requires a reason, and rejects stale revisions', async () => {
  const f = fixture('older-parent');
  const command = {
    action: 'rollback',
    versionId: 'draft',
    expectedRevision: '2',
    reason: 'Restore',
    key: randomUUID(),
  };
  assert.equal(
    (await editChannel({ ...env, CONSOLE_ALLOW_EDITS: 'false' }, command, f.fetcher)).ok,
    false,
  );
  assert.equal((await editChannel(env, { ...command, reason: ' ' }, f.fetcher)).ok, false);
  assert.equal(
    (await editChannel(env, { ...command, expectedRevision: '1' }, f.fetcher)).ok,
    false,
  );
  assert.equal(f.writes.length, 0);
});
test('rollback accepts an older version and uses CAS with an honest reason', async () => {
  const f = fixture('older-parent');
  const command = {
    action: 'rollback',
    versionId: 'draft',
    expectedRevision: '2',
    reason: 'Restore',
    key: randomUUID(),
  };
  assert.equal((await editChannel(env, command, f.fetcher)).ok, true);
  assert.equal(f.writes[0].body.expectedRevision, '2');
  assert.match(f.writes[0].body.unevaluatedReason, /rollback \(not evaluated\)/);
  const conflict = fixture('older-parent', true);
  assert.equal((await editChannel(env, command, conflict.fetcher)).ok, false);
});
