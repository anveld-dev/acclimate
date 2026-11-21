import { consoleEnvironment } from './console-fixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { allPages } from '../src/server/listing';
import { readAccessState } from '../src/server/access-core';
import { readConnectionsState } from '../src/server/integration-core';
import { listSetup } from '../src/server/setup';

test('listing preserves opaque cursors and rejects direct and longer cursor cycles', async () => {
  const cursor = 'opaque /+?=\u2603';
  const observed: (string | undefined)[] = [];
  const items = await allPages(async (next) => {
    observed.push(next);
    return next ? { items: [2], nextCursor: null } : { items: [1], nextCursor: cursor };
  });
  assert.deepEqual(items, [1, 2]);
  assert.deepEqual(observed, [undefined, cursor]);
  for (const cycle of [
    ['same', 'same'],
    ['first', 'second', 'first'],
  ]) {
    let calls = 0;
    await assert.rejects(
      allPages(async () => ({ items: [calls], nextCursor: cycle[calls++] })),
      /Repeated listing cursor/,
    );
    assert.equal(calls, cycle.length);
  }
});

const env = {
  ...consoleEnvironment,
  CONSOLE_WORKSPACE: 'project',
  CONSOLE_BUNDLE: 'bundle',
  CONSOLE_CHANNEL: 'stable',
};
const identity = {
  userId: '12345678-1234-4234-8234-123456789012',
  issuer: 'https://fixture.invalid',
  subject: 'person',
};

for (const [name, limit, read] of [
  ['setup', 1000, (fetcher: typeof fetch) => listSetup(env, fetcher)],
  ['access', 1001, (fetcher: typeof fetch) => readAccessState(env, fetcher)],
  ['integration', 1001, (fetcher: typeof fetch) => readConnectionsState(env, { workspaceId: 'project' }, fetcher)],
] as const) {
  test(`${name} retains its page limit and rejects continued listings without another read`, async () => {
    for (const continues of [false, true]) {
      let pages = 0;
      const result = await read(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/auth/session')) return Response.json(identity);
        if (url.pathname === '/v1/workspaces') {
          assert.equal(url.searchParams.get('cursor'), pages ? `page-${pages}` : null);
          pages++;
          return Response.json({
            items: pages === 1 ? [{ id: 'project', name: 'Project', role: 'admin' }] : [],
            nextCursor: pages < limit || continues ? `page-${pages}` : null,
          });
        }
        if (url.pathname.endsWith('/channels/stable'))
          return Response.json({ channel: 'stable', revision: '1', version: { id: 'version' } });
        return Response.json({ items: [], nextCursor: null });
      });
      assert.equal(result.ok, !continues);
      assert.equal(pages, limit);
      if (!result.ok) assert.doesNotMatch(result.message, /page-|cursor|safe page limit/);
    }
  });
}

test('access traverses encoded opaque cursors and projects only safe fields from every page', async () => {
  const cursor = 'opaque /+?=\u2603';
  let pages = 0;
  const result = await readAccessState(env, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/auth/session')) return Response.json(identity);
    assert.equal(url.searchParams.get('cursor'), pages ? cursor : null);
    pages++;
    return Response.json({
      items: [{ id: `project-${pages}`, name: 'Project', role: 'viewer', secret: 'PRIVATE' }],
      nextCursor: pages === 1 ? cursor : null,
    });
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.projects, [
    { id: 'project-1', name: 'Project', role: 'viewer' },
    { id: 'project-2', name: 'Project', role: 'viewer' },
  ]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('access rejects malformed later pages without exposing partial projects or cursor diagnostics', async () => {
  for (const malformed of [true, false]) {
    let pages = 0;
    const result = await readAccessState(env, async (input) => {
      if (String(input).includes('/auth/session')) return Response.json(identity);
      pages++;
      return Response.json({
        items: malformed && pages === 2 ? {} : [{ id: 'project', name: 'Project', role: 'admin' }],
        nextCursor: 'PRIVATE-CURSOR',
      });
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.projects, []);
    assert.equal(pages, 2);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-CURSOR'));
  }
});
