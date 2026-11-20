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
test('retired draft publication sends no write', async () => {
  let requests = 0;
  const result = await draftCommand(env, { action: 'publish' } as unknown as Parameters<typeof draftCommand>[1], async () => {
    requests++;
    throw Error('Unexpected request');
  });
  assert(!result.ok);
  assert.equal(requests, 0);
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
