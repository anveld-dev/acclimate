import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeliveryDetailState, readSetupReportState } from '../src/server/delivery-detail-core';
import { consoleEnvironment } from './console-fixture';
const scope = {
  workspaceId: 'project',
  bundleId: '22222222-2222-4222-8222-222222222222',
  channel: 'stable',
};
const appId = '33333333-3333-4333-8333-333333333333';
const receipt = {
  eventId: 'event',
  versionId: 'historical',
  digest: 'reported-digest',
  occurredAt: '2026-01-01T00:00:00.123Z',
  receivedAt: '2026-01-01T00:00:02.223Z',
  stage: 'started',
  connectionId: appId,
  ...scope,
  source: 'network',
  delayed: false,
  credential: 'private-canary',
};
const app = { ...scope, id: appId, displayName: 'App', enabled: true, latestObservation: receipt };
const page = (items: unknown[], nextCursor: string | null = null) =>
  Response.json({ items, nextCursor });
test('detail binds a receipt and promotion to the selected app scope and projects only public fields', async () => {
  for (const mismatch of [false, true]) {
    const result = await readDeliveryDetailState(
      consoleEnvironment,
      { workspaceId: scope.workspaceId, connectionId: appId },
      async (request, init) => {
        assert.equal(
          new Headers(init?.headers).get('x-acclimate-session'),
          consoleEnvironment.CONSOLE_SESSION_TOKEN,
        );
        const path = String(request);
        if (path.includes('/connection-observations?')) return page([app]);
        if (path.includes('/receipts?'))
          return page([{ ...receipt, bundleId: mismatch ? 'outside' : scope.bundleId }]);
        assert(path.includes('/channels/stable/releases?limit=1'));
        return page([
          {
            channel: 'stable',
            version: { id: 'current', digest: 'channel-digest', bundleId: scope.bundleId },
            revision: '2',
            createdAt: '2026-01-03',
          },
        ]);
      },
    );
    assert.equal(result.ok, !mismatch);
    if (result.ok) {
      assert.equal(result.detail.receipts.items[0].versionId, 'historical');
      assert.equal(result.detail.current?.versionId, 'current');
      assert(!JSON.stringify(result).includes('private-canary'));
    }
  }
});
test('SDK checkpoint chooses the last received receipt across all scoped app pages and excludes private fields', async () => {
  const result = await readSetupReportState(consoleEnvironment, scope, async (req) => {
    if (!String(req).includes('cursor=')) return page([app], 'later');
    return page([
      {
        ...app,
        id: 'other',
        channel: 'preview',
        latestObservation: { ...receipt, receivedAt: '2027-01-01' },
      },
      {
        ...app,
        id: 'sibling',
        latestObservation: { ...receipt, receivedAt: '2026-01-01T00:00:02.223009Z' },
      },
    ]);
  });
  assert.equal(result.state, 'received');
  if (result.state === 'received') {
    assert.equal(result.appId, 'sibling');
    assert(!JSON.stringify(result).includes('private-canary'));
  }
  assert.equal(
    (await readSetupReportState(consoleEnvironment, scope, async () => page([]))).state,
    'empty',
  );
  assert.equal(
    (
      await readSetupReportState(
        consoleEnvironment,
        scope,
        async () => new Response(null, { status: 403 }),
      )
    ).state,
    'error',
  );
});
