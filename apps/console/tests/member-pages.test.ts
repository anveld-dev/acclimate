import { consoleEnvironment } from './console-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readMembershipPage, accessCommand } from '../src/server/access-core';
const userId = '12345678-1234-4234-8234-123456789012';
const env = { ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'fixture',
  CONSOLE_SESSION_TOKEN: 'session',
};
test('member page is bounded, explicit, projected and retains a continuation cursor', async () => {
  let path = '';
  const result = await readMembershipPage(env, 'workspace', 'abcd', async (url) => {
    path = String(url);
    return Response.json({
      items: [
        {
          id: userId,
          issuer: 'https://fixture.invalid',
          subject: 'person',
          role: 'editor',
          secret: 'NO-LEAK',
        },
      ],
      nextCursor: 'def0',
    });
  });
  assert.match(path, /\/v1\/projects\/workspace\/memberships\?limit=25&cursor=abcd$/);
  assert.deepEqual(result, {
    ok: true,
    items: [{ id: userId, issuer: 'https://fixture.invalid', subject: 'person', role: 'editor' }],
    nextCursor: 'def0',
  });
  const excessive = await readMembershipPage(env, 'workspace', undefined, async () =>
    Response.json({ items: Array(26).fill({}) }),
  );
  assert.equal(excessive.ok, false);
});
test('last administrator conflict is actionable while unknown service messages remain private', async () => {
  const result = await accessCommand(
    env,
    {
      kind: 'removeMembership',
      projectId: 'workspace',
      userId,
      confirmedIdentity: { issuer: 'https://fixture.invalid', subject: 'person' },
    },
    async (url, init) => {
      if (init?.method === 'DELETE')
        return Response.json(
          { error: { code: 'last_admin', message: 'PRIVATE' } },
          { status: 409 },
        );
      if (String(url).includes('/users/'))
        return Response.json({
          id: userId,
          issuer: 'https://fixture.invalid',
          subject: 'person',
          role: 'admin',
        });
      return Response.json({});
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /another administrator/);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('member names are display metadata and never replace the verified identity', async () => {
  const result = await readMembershipPage(env, 'workspace', undefined, async () => Response.json({
    items: [{ id: userId, issuer: 'https://fixture.invalid', subject: 'opaque-subject', role: 'viewer', displayName: '<script>not markup</script>', email: 'not-requested@example.invalid' }], nextCursor: null,
  }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.items[0], { id: userId, issuer: 'https://fixture.invalid', subject: 'opaque-subject', role: 'viewer', displayName: '<script>not markup</script>' });
  const changedName = await accessCommand(env, {
    kind: 'setMembership', projectId: 'workspace', userId, role: 'editor',
    confirmedIdentity: { issuer: 'https://fixture.invalid', subject: 'different-subject' },
  }, async () => Response.json(result.items[0]));
  assert.equal(changedName.ok, false, 'A familiar display name must not bypass issuer/subject matching');
});
