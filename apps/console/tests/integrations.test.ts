import { consoleEnvironment } from './console-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DeliveryReceipt, Page } from '@anveld/acclimate-sdk';
import {
  integrationCommand,
  readConnectionsState,
} from '../src/server/integration-core';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const key = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const env = {
  ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'fixture-console',
  CONSOLE_WORKSPACE: 'project',
  CONSOLE_BUNDLE: 'bundle',
  CONSOLE_CHANNEL: 'stable',
  CONSOLE_SESSION_TOKEN: 'fixture-session',
  CONSOLE_ALLOW_EDITS: 'true',
};
function fixture(
  role = 'admin',
  receipts: Page<DeliveryReceipt> = { items: [], nextCursor: null },
) {
  const requests: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || 'GET';
    requests.push({
      url,
      method,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    let body: unknown;
    if (url.includes('/v1/workspaces?'))
      body = { items: [{ id: 'project', name: 'Project', role }], nextCursor: null };
    else if (url.endsWith('/credentials'))
      body = { id: key, kind: 'receipt-write', secret: 'fixture-once' };
    else if (url.includes('/receipts')) body = receipts;
    else if (/\/bundles\?/.test(url))
      body = {
        items: [
          { id: 'bundle', name: 'Review' },
          { id: 'other-bundle', name: 'Support' },
        ],
        nextCursor: null,
      };
    else if (/\/channels\?/.test(url))
      body = { items: [{ name: 'stable', revision: '2' }], nextCursor: null };
    else if (url.endsWith('/revoke')) body = { revoked: true };
    else if (url.includes('/channels/stable'))
      body = { channel: 'stable', revision: '2', version: { id: 'current' } };
    else if (method === 'POST')
      body = {
        id,
        workspaceId: 'project',
        bundleId: 'bundle',
        channel: 'stable',
        displayName: 'App',
        enabled: true,
        createdAt: '2026-11-13T00:00:00Z',
      };
    else
      body = {
        items: [
          {
            id,
            workspaceId: 'project',
            bundleId: 'bundle',
            channel: 'stable',
            displayName: 'App',
            enabled: true,
            createdAt: '2026-11-13T00:00:00Z',
          },
          {
            id: other,
            workspaceId: 'project',
            bundleId: 'other-bundle',
            channel: 'stable',
            displayName: 'Other',
            enabled: true,
            createdAt: '2026-11-13T00:00:00Z',
          },
        ],
        nextCursor: null,
      };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetcher, requests };
}
test('connection details read only their receipts with the console session and never return secrets', async () => {
  const f = fixture();
  const result = await readConnectionsState(env, { workspaceId: 'project', connectionId: id }, f.fetcher);
  assert.equal(result.ok, true);
  if (!result.ok || !result.state) throw Error('Expected state');
  assert.equal(result.state.selected?.integration.id, id);
  assert.deepEqual(result.state.selected?.receipts.items, []);
  assert.equal(result.state.selected?.currentVersionId, 'current');
  assert.ok(!JSON.stringify(result).includes('fixture-console'));
  assert.equal(f.requests.filter((r) => r.url.includes('/receipts')).length, 1);
  for (const r of f.requests) {
    assert.equal(r.headers.get('authorization'), 'Bearer fixture-console');
    assert.equal(r.headers.get('x-acclimate-session'), 'fixture-session');
  }
});
test('connection details and receipt history preserve the selected page and reject a single out-of-scope item', async () => {
  const receipt: DeliveryReceipt = {
    workspaceId: 'project',
    connectionId: id,
    bundleId: 'bundle',
    channel: null,
    eventId: other,
    versionId: key,
    digest: `sha256:${'0'.repeat(64)}`,
    stage: 'verified',
    occurredAt: '2026-11-13T00:00:00Z',
    receivedAt: '2026-11-13T00:01:00Z',
    source: 'network',
    delayed: false,
  };
  const mismatches = [
    { workspaceId: 'other-project' },
    { bundleId: 'other-bundle' },
    { connectionId: other },
  ];
  for (const mismatch of [undefined, ...mismatches]) {
    const page = { items: [receipt, { ...receipt, eventId: key, ...mismatch }], nextCursor: other };
    const f = fixture('admin', page);
    const detail = await readConnectionsState(
      { ...env, CONSOLE_BUNDLE: 'other-bundle' },
      { workspaceId: 'project', connectionId: id },
      f.fetcher,
    );
    const history = await integrationCommand(
      env,
      { action: 'receipts', id, cursor: key },
      f.fetcher,
    );
    if (mismatch) {
      for (const result of [detail, history]) {
        assert.deepEqual(result, {
          ok: false,
          message:
            'Could not confirm the service response. Refresh to check current connections before repeating an action.',
        });
      }
    } else {
      assert(history.ok && detail.ok);
      assert.deepEqual(detail.state.selected?.receipts, page);
      assert.deepEqual(history.receipts, page);
      const queries = f.requests
        .filter((request) => request.url.includes('/receipts'))
        .map((request) => Object.fromEntries(new URL(request.url).searchParams));
      assert.deepEqual(queries, [{ limit: '20' }, { limit: '20', cursor: key }]);
    }
  }
});
test('server denies viewer and editor administration without issuing credentials', async () => {
  for (const role of ['viewer', 'editor']) {
    const f = fixture(role);
    const result = await integrationCommand(
      env,
      { action: 'issue', id, kind: 'receipt-write', key },
      f.fetcher,
    );
    assert.equal(result.ok, false);
    assert.equal(f.requests.length, 1);
  }
});
test('selected scope and edit gates apply before mutation', async () => {
  const f = fixture();
  assert.equal(
    (await integrationCommand(env, { action: 'revoke', id: other, key }, f.fetcher)).ok,
    false,
  );
  assert.ok(!f.requests.some((r) => r.method === 'POST'));
  const disabled = fixture();
  assert.equal(
    (
      await integrationCommand(
        { ...env, CONSOLE_ALLOW_EDITS: 'false' },
        { action: 'create', displayName: 'App', key },
        disabled.fetcher,
      )
    ).ok,
    false,
  );
  assert.equal(disabled.requests.length, 0);
  const signedOut = fixture();
  assert.equal(
    (await readConnectionsState({ ...env, CONSOLE_SESSION_TOKEN: undefined }, { workspaceId: 'project' }, signedOut.fetcher))
      .ok,
    false,
  );
  assert.equal(signedOut.requests.length, 0);
});
test('credential secret is confined to issuance response and creation scope comes from server selection', async () => {
  const f = fixture();
  const result = await integrationCommand(
    env,
    { action: 'issue', id, kind: 'receipt-write', key },
    f.fetcher,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.credential?.secret, 'fixture-once');
  const post = f.requests.find((r) => r.method === 'POST')!;
  assert.deepEqual(post.body, { kind: 'receipt-write' });
  assert.equal(post.headers.get('idempotency-key'), key);
  const created = fixture();
  assert.equal(
    (
      await integrationCommand(
        env,
        { action: 'create', displayName: ' Application ', key },
        created.fetcher,
      )
    ).ok,
    true,
  );
  assert.deepEqual(created.requests.find((r) => r.method === 'POST')?.body, {
    bundleId: 'bundle',
    channel: 'stable',
    displayName: 'Application',
  });
});
test('service denial produces safe error and never returns raw service message', async () => {
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ error: { code: 'denied', message: 'private-token-value' } }), {
      status: 403,
    });
  const result = await readConnectionsState(env, { workspaceId: 'project' }, fetcher);
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes('private-token-value'));
});

test('canonical connection create keeps the rendered target when another tab changes selection', async () => {
  const { connectionCommand } = await import('../src/server/integration-core');
  const f = fixture();
  const result = await connectionCommand(
    {
      ...env,
      CONSOLE_WORKSPACE: 'other-project',
      CONSOLE_BUNDLE: 'other-bundle',
      CONSOLE_CHANNEL: 'canary',
    },
    {
      action: 'create',
      workspaceId: 'project',
      bundleId: 'bundle',
      channel: 'stable',
      displayName: ' Application ',
      key,
    },
    f.fetcher,
  );
  assert.equal(result.ok, true);
  const post = f.requests.find((request) => request.method === 'POST');
  assert.ok(post);
  assert.ok(post.url.endsWith('/workspaces/project/connections'));
  assert.deepEqual(post.body, {
    bundleId: 'bundle',
    channel: 'stable',
    displayName: 'Application',
  });
});

test('workspace connection index includes every bundle independently of the selection cookie', async () => {
  const { readConnectionsState } = await import('../src/server/integration-core');
  const f = fixture();
  const result = await readConnectionsState(
    { ...env, CONSOLE_BUNDLE: undefined, CONSOLE_CHANNEL: 'canary' },
    { workspaceId: 'project' },
    f.fetcher,
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw Error('Expected workspace connections');
  assert.deepEqual(
    result.state.integrations.map((item) => item.id),
    [id, other],
  );
  assert.deepEqual(
    result.state.bundles.map((item) => item.name),
    ['Review', 'Support'],
  );
  assert.equal(result.state.selected, undefined);
  assert.equal(f.requests.filter((request) => request.url.includes('/receipts')).length, 0);
});

test('workspace connection detail selects the bookmarked native ID and verifies its own bundle', async () => {
  const { readConnectionsState } = await import('../src/server/integration-core');
  const f = fixture();
  const result = await readConnectionsState(
    env,
    { workspaceId: 'project', connectionId: other },
    f.fetcher,
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw Error('Expected connection detail');
  assert.equal(result.state.selected?.integration.bundleId, 'other-bundle');
  assert.equal(result.state.selected?.currentRevision, '2');
  assert.ok(f.requests.some((request) => request.url.includes(`/connections/${other}/receipts`)));
  assert.ok(
    f.requests.some((request) => request.url.includes('/bundles/other-bundle/channels/stable')),
  );
});

test('canonical commands deny another workspace and a mismatched rendered record binding', async () => {
  const { connectionCommand } = await import('../src/server/integration-core');
  for (const target of [
    { workspaceId: 'outside-project', bundleId: 'bundle', channel: 'stable' },
    { workspaceId: 'project', bundleId: 'other-bundle', channel: 'stable' },
  ]) {
    const f = fixture();
    const result = await connectionCommand(
      env,
      { action: 'revoke', id, key, ...target },
      f.fetcher,
    );
    assert.equal(result.ok, false);
    assert.equal(
      f.requests.some((request) => request.method === 'POST'),
      false,
    );
  }
});

test('canonical commands reject missing scope rather than falling back to remembered scope', async () => {
  const { connectionCommand } = await import('../src/server/integration-core');
  const f = fixture();
  const input = {
    action: 'create',
    workspaceId: 'project',
    channel: 'stable',
    displayName: 'App',
    key,
  };
  const result = await connectionCommand(
    env,
    input as Parameters<typeof connectionCommand>[1],
    f.fetcher,
  );
  assert.equal(result.ok, false);
  assert.equal(f.requests.length, 0);
});

test('workspace connection index traverses independent integration cursor pages', async () => {
  const { readConnectionsState } = await import('../src/server/integration-core');
  const f = fixture();
  let pages = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const response = await f.fetcher(input, init);
    if (String(input).includes('/connections?')) {
      const body = await response.json();
      const second = String(input).includes('cursor=');
      pages++;
      return Response.json({
        items: [body.items[second ? 1 : 0]],
        nextCursor: second ? null : other,
      });
    }
    return response;
  };
  const result = await readConnectionsState(env, { workspaceId: 'project' }, fetcher);
  assert.equal(result.ok, true);
  if (!result.ok) throw Error('Expected paginated workspace connections');
  assert.deepEqual(
    result.state.integrations.map((item) => item.id),
    [id, other],
  );
  assert.equal(pages, 2);
});

test('an unavailable bookmarked connection never silently selects another record', async () => {
  const { readConnectionsState } = await import('../src/server/integration-core');
  const f = fixture();
  const result = await readConnectionsState(
    env,
    { workspaceId: 'project', connectionId: key },
    f.fetcher,
  );
  assert.equal(result.ok, false);
  assert.equal(
    f.requests.some((request) => request.url.includes('/receipts')),
    false,
  );
});

test('directory projects the latest service-received status without receipt or credential details', async () => {
  const { readConnectionsState } = await import('../src/server/integration-core');
  const f = fixture();
  const receivedAt = '2026-11-17T10:00:00Z';
  const result = await readConnectionsState(
    env,
    { workspaceId: 'project' },
    async (input, init) => {
      if (String(input).includes('/connection-observations?'))
        return Response.json({
          items: [
            {
              id,
              latestObservation: {
                stage: 'verified',
                receivedAt,
                eventId: 'excluded-event',
                credential: 'excluded-secret',
              },
            },
            { id: other, latestObservation: null },
          ],
          nextCursor: null,
        });
      return f.fetcher(input, init);
    },
  );
  assert(result.ok);
  assert.deepEqual(result.state.reports, {
    [id]: { stage: 'verified', receivedAt },
    [other]: null,
  });
});
