import { consoleEnvironment } from './console-fixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { draftCommand } from '../src/server/drafts';
const env = {
  ...consoleEnvironment,
  CONSOLE_ALLOW_EDITS: 'true',
  CONSOLE_SERVICE_TOKEN: 'private',
  CONSOLE_WORKSPACE: 'p',
  CONSOLE_BUNDLE: '11111111-1111-4111-8111-111111111111',
};
const key = 'a20bcde0-0000-4000-8000-000000000000';
const payload = {
  schemaVersion: 1 as const,
  files: [{ path: 'instructions/main.md', kind: 'instruction' as const, text: 'hello' }],
};
test('disabled edits cannot bypass server permission with direct create', async () => {
  let called = false;
  const result = await draftCommand(
    { ...env, CONSOLE_ALLOW_EDITS: 'false' },
    { action: 'create', baseVersionId: 'v', baseRevision: '1', payload, key },
    async () => {
      called = true;
      throw Error();
    },
  );
  assert.equal(result.ok, false);
  assert.equal(called, false);
});
test('invalid import rejects entire payload before a write', async () => {
  let called = false;
  const result = await draftCommand(
    env,
    {
      action: 'create',
      baseVersionId: 'v',
      baseRevision: '1',
      payload: {
        ...payload,
        files: [...payload.files, { ...payload.files[0], path: '../escape' }],
      },
      key,
    },
    async () => {
      called = true;
      throw Error();
    },
  );
  assert.equal(result.ok, false);
  assert.equal(called, false);
  if (!result.ok) assert.equal('uncertain' in result && result.uncertain, false);
});
test('save reaches idempotent service directly without stale channel preflight', async () => {
  const calls: string[] = [];
  const result = await draftCommand(
    env,
    {
      action: 'save',
      id: '22222222-2222-4222-8222-222222222222',
      expectedGeneration: 2,
      payload,
      key,
    },
    async (url, init) => {
      calls.push(String(url));
      if (!init?.method || init.method === 'GET')
        return Response.json({ status: 'not_observed', operationId: key });
      assert.equal(init?.headers && new Headers(init.headers).get('Idempotency-Key'), key);
      assert.deepEqual(JSON.parse(String(init?.body)), { expectedGeneration: 2, payload });
      return Response.json({ id: '22222222-2222-4222-8222-222222222222', generation: 3 });
    },
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /channels\/stable\/drafts\/22222222-2222-4222-8222-222222222222\/save$/);
});
test('lost mutation response remains unresolved; conflict is definite rejection', async () => {
  const unknown = await draftCommand(
    env,
    { action: 'discard', id: '22222222-2222-4222-8222-222222222222', expectedGeneration: 2, key },
    async () => {
      throw Error('connection lost');
    },
  );
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal('uncertain' in unknown && unknown.uncertain, true);
  const conflict = await draftCommand(
    env,
    { action: 'discard', id: '22222222-2222-4222-8222-222222222222', expectedGeneration: 2, key },
    async () =>
      Response.json(
        { error: { code: 'generation_conflict', message: 'private text' } },
        { status: 409 },
      ),
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal('uncertain' in conflict && conflict.uncertain, false);
    assert.doesNotMatch(conflict.message, /private text/);
  }
});
test('incomplete native skill packages remain generically saveable for repair', async () => {
  let called = false;
  const invalid = await draftCommand(
    env,
    {
      action: 'validate',
      payload: {
        schemaVersion: 1,
        files: [{ kind: 'skill', path: 'skills/retry/reference.md', text: 'reference' }],
      },
    },
    async () => {
      called = true;
      throw Error();
    },
  );
  assert.equal(invalid.ok, true);
  assert.equal(called, false);
  const valid = await draftCommand(
    env,
    {
      action: 'validate',
      payload: {
        schemaVersion: 1,
        files: [
          {
            kind: 'skill',
            path: 'skills/retry/SKILL.md',
            text: '---\nname: retry\ndescription: Safe retry policy\n---\n# Retry',
          },
          { kind: 'skill', path: 'skills/retry/reference.md', text: 'reference' },
        ],
      },
    },
    async () => {
      called = true;
      throw Error();
    },
  );
  assert.equal(valid.ok, true);
  assert.equal(called, false);
});

test('hosted draft commands require a session before contacting the service', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    throw new Error('must not contact service');
  };
  for (const command of [
    { action: 'list' as const },
    { action: 'recover' as const, key },
    { action: 'create' as const, key, baseVersionId: 'v', baseRevision: '1', payload },
  ]) {
    const result = await draftCommand(
      { ...env, CONSOLE_SESSION_TOKEN: undefined },
      command,
      fetcher,
    );
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 0);
});

test('draft history includes closed drafts on every page for the console filter', async () => {
  const cursor = '22222222-2222-4222-8222-222222222222';
  const requested: URL[] = [];
  for (const next of [undefined, cursor]) {
    const result = await draftCommand(env, { action: 'list', cursor: next }, async (url) => {
      requested.push(new URL(String(url)));
      return Response.json({ items: [], nextCursor: null });
    });
    assert.equal(result.ok, true);
  }
  for (const url of requested) {
    assert.equal(
      url.pathname,
      '/v1/workspaces/p/bundles/' + env.CONSOLE_BUNDLE + '/channels/stable/drafts',
    );
    assert.equal(url.searchParams.get('status'), 'all');
    assert.equal(url.searchParams.get('limit'), '20');
  }
  assert.equal(requested[0].searchParams.has('cursor'), false);
  assert.equal(requested[1].searchParams.get('cursor'), cursor);
});
