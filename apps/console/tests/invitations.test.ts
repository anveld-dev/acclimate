import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invitationCommand } from '../src/server/invitation-core';
import { consoleEnvironment } from './console-fixture';

const id = '12345678-1234-4234-8234-123456789012';
const env = {
  ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'transport-fixture',
  CONSOLE_SESSION_TOKEN: 'session-fixture',
};

test('email invitation sends only recipient and role using the server-selected credentials', async () => {
  const result = await invitationCommand(
    env,
    { kind: 'create', workspaceId: 'p', email: 'person@example.test', role: 'editor' },
    async (url, init) => {
      assert.equal(new URL(String(url)).pathname, '/v1/workspaces/p/invitations');
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer transport-fixture');
      assert.equal(new Headers(init?.headers).get('x-acclimate-session'), 'session-fixture');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        email: 'person@example.test',
        role: 'editor',
      });
      return Response.json({ id });
    },
  );
  assert.equal(result.ok, true);
});

test('a preview does not accept an invitation; acceptance uses an explicit POST', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(`${init?.method} ${new URL(String(url)).pathname}`);
    return Response.json(
      init?.method === 'POST' ? { workspaceId: 'p' } : { id, status: 'pending' },
    );
  };
  await invitationCommand(env, { kind: 'preview', id }, fetcher);
  assert.deepEqual(calls, [`GET /v1/invitations/${id}`]);
  const accepted = await invitationCommand(env, { kind: 'accept', id }, fetcher);
  assert.deepEqual(accepted, { ok: true, workspaceId: 'p' });
  assert.equal(calls[1], `POST /v1/invitations/${id}/accept`);
});

test('invalid paths and missing sessions never reach the service', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    throw new Error();
  };
  assert.equal(
    (await invitationCommand(env, { kind: 'preview', id: '../escape' }, fetcher)).ok,
    false,
  );
  assert.equal(
    (await invitationCommand(env, { kind: 'list', workspaceId: '..' }, fetcher)).ok,
    false,
  );
  assert.equal(
    (
      await invitationCommand(
        { ...env, CONSOLE_SESSION_TOKEN: undefined },
        { kind: 'accept', id },
        fetcher,
      )
    ).ok,
    false,
  );
  assert.equal(calls, 0);
});

test('verified-email and closed-invitation failures remain actionable, generic failures stay private', async () => {
  for (const [status, code, message] of [
    [403, 'email_not_verified', 'Verify your email first'],
    [410, 'invitation_closed', 'Invitation has expired'],
  ] as const) {
    const result = await invitationCommand(env, { kind: 'accept', id }, async () =>
      Response.json({ error: { code, message } }, { status }),
    );
    assert.deepEqual(result, { ok: false, message });
  }
  const result = await invitationCommand(env, { kind: 'accept', id }, async () =>
    Response.json(
      { error: { code: 'internal_error', message: 'private upstream diagnostic' } },
      { status: 500 },
    ),
  );
  assert.equal(JSON.stringify(result).includes('private upstream'), false);
});
