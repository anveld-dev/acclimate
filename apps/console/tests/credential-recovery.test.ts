import { consoleEnvironment } from './console-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { integrationCommand } from '../src/server/integration-core';
import {
  credentialRecoveryKey,
  readCredentialRecovery,
  saveCredentialRecovery,
} from '../src/server/credential-recovery';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const original = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const key = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const nextKey = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const env = { ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'fixture',
  CONSOLE_SESSION_TOKEN: 'session',
  CONSOLE_ALLOW_EDITS: 'true',
  CONSOLE_PROJECT: 'project',
  CONSOLE_BUNDLE: 'bundle',
  CONSOLE_CHANNEL: 'stable',
};
function fixture(revokedAt: string | null, errorDetails?: unknown) {
  const writes: { key: string | null; body: unknown }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.includes('/v1/projects?'))
      return Response.json({ items: [{ id: 'project', role: 'admin' }] });
    if (path.endsWith('/credentials')) {
      writes.push({
        key: new Headers(init?.headers).get('idempotency-key'),
        body: JSON.parse(String(init?.body)),
      });
      if (errorDetails !== undefined)
        return Response.json(
          {
            error: {
              code: 'credential_already_issued',
              message: 'Untrusted secret: NEVER-EXPOSE',
              details: errorDetails,
            },
          },
          { status: 409 },
        );
      return Response.json({ id: nextKey, kind: 'content-read', secret: 'one-time-only' });
    }
    return Response.json({
      items: [
        {
          id,
          projectId: 'project',
          bundleId: 'bundle',
          channel: 'stable',
          credentials: [{ id: original, kind: 'content-read', revokedAt }],
        },
      ],
    });
  };
  return { fetcher, writes };
}
test('lost issuance returns typed original identity and no secret or human-message parsing', async () => {
  const f = fixture(null, {
    credentialId: original,
    kind: 'content-read',
    revokedAt: null,
    secret: 'NEVER-EXPOSE',
  });
  const result = await integrationCommand(
    env,
    { action: 'issue', id, kind: 'content-read', key },
    f.fetcher,
  );
  assert.deepEqual(result.ok ? undefined : result.issuedCredential, {
    credentialId: original,
    kind: 'content-read',
    revokedAt: null,
  });
  assert.equal(JSON.stringify(result).includes('NEVER-EXPOSE'), false);
  const malformed = fixture(null, {
    credentialId: 'not-an-id',
    kind: 'content-read',
    revokedAt: null,
  });
  const denied = await integrationCommand(
    env,
    { action: 'issue', id, kind: 'content-read', key },
    malformed.fetcher,
  );
  assert.equal(denied.ok ? true : denied.issuedCredential, undefined);
});
test('replacement requires current scoped confirmed revocation then submits a distinct reviewed key', async () => {
  const active = fixture(null);
  const denied = await integrationCommand(
    env,
    { action: 'issue', id, kind: 'content-read', key: nextKey, replacementOf: original },
    active.fetcher,
  );
  assert.equal(denied.ok, false);
  assert.equal(active.writes.length, 0);
  const revoked = fixture('2026-11-14T01:02:03Z');
  const result = await integrationCommand(
    env,
    { action: 'issue', id, kind: 'content-read', key: nextKey, replacementOf: original },
    revoked.fetcher,
  );
  assert.equal(result.ok, true);
  assert.equal(revoked.writes[0].key, nextKey);
  assert.deepEqual(revoked.writes[0].body, { kind: 'content-read' });
  const wrongKind = await integrationCommand(
    env,
    { action: 'issue', id, kind: 'receipt-write', key: nextKey, replacementOf: original },
    revoked.fetcher,
  );
  assert.equal(wrongKind.ok, false);
  assert.equal(revoked.writes.length, 1);
});
test('reload recovery stores only allowlisted metadata, binds actor scope, and tolerates corrupt records', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const storageKey = credentialRecoveryKey('actor-a', 'project', id);
  saveCredentialRecovery(storage, storageKey, {
    key,
    kind: 'content-read',
    credentialId: original,
    secret: 'NEVER-STORE',
  } as never);
  assert.equal([...values.values()].join().includes('NEVER-STORE'), false);
  assert.deepEqual(readCredentialRecovery(storage, storageKey), {
    key,
    kind: 'content-read',
    credentialId: original,
  });
  assert.equal(
    readCredentialRecovery(storage, credentialRecoveryKey('actor-b', 'project', id)),
    undefined,
  );
  values.set(storageKey, '{broken');
  assert.equal(readCredentialRecovery(storage, storageKey), undefined);
});
