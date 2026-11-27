import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionObservation } from '@anveld/sdk';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readDeliveryObservationsState } from '../src/server/delivery-observations-core';
import { WorkspaceDelivery } from '../src/components/workspace-delivery';
import { consoleEnvironment } from './console-fixture';
import { parseConsoleLocation, workspaceHref } from '../src/navigation';

const observation: ConnectionObservation = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'Agent service',
  bundleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  channel: 'stable',
  enabled: true,
  latestObservation: {
    eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    stage: 'started',
    versionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    digest: 'sha256:' + 'a'.repeat(64),
    occurredAt: '2026-11-15T10:00:00Z',
    receivedAt: '2026-11-16T10:00:00Z',
  },
};

test('workspace readers discover delivery without entering credential administration', async () => {
  for (const role of ['viewer', 'editor', 'admin']) {
    const requests: { url: string; method: string; headers: Headers }[] = [];
    const result = await readDeliveryObservationsState(
      consoleEnvironment,
      { workspaceId: 'project' },
      async (input, init) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
        if (url.includes('/v1/workspaces?'))
          return Response.json({
            items: [{ id: 'project', name: 'Project', role }],
            nextCursor: null,
          });
        assert.match(url, /\/connection-observations\?limit=50$/);
        return Response.json({
          items: [
            {
              ...observation,
              credentials: [{ secret: 'PRIVATE-CANARY' }],
              latestObservation: {
                ...observation.latestObservation,
                privateToken: 'PRIVATE-CANARY',
              },
            },
          ],
          nextCursor: null,
        });
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) throw Error('expected read access');
    assert.deepEqual(result.page.items, [observation]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CANARY|credentials|privateToken/);
    assert.equal(requests.length, 2);
    assert(requests.every((request) => request.method === 'GET'));
    assert(
      requests.every(
        (request) =>
          request.headers.get('x-acclimate-session') === consoleEnvironment.CONSOLE_SESSION_TOKEN,
      ),
    );
    assert(requests.every((request) => !request.url.includes('/connections?')));
  }
});

test('revoked membership and malformed pages do not query or issue credentials', async () => {
  let calls = 0;
  const denied = await readDeliveryObservationsState(
    consoleEnvironment,
    { workspaceId: 'project' },
    async () => {
      calls++;
      return Response.json({ items: [], nextCursor: null });
    },
  );
  assert.equal(denied.ok, false);
  assert.equal(calls, 1);
  const invalid = await readDeliveryObservationsState(
    consoleEnvironment,
    { workspaceId: 'project', cursor: '../bad' },
    async () => {
      throw Error('unexpected');
    },
  );
  assert.equal(invalid.ok, false);
});

test('delivery screen keeps one receipt identity and separates application and server times', () => {
  const html = renderToStaticMarkup(
    createElement(WorkspaceDelivery, {
      workspaceId: 'project',
      initial: {
        ok: true,
        workspaceId: 'project',
        workspaceName: 'Project',
        page: {
          items: [
            observation,
            { ...observation, id: 'empty', displayName: 'Silent app', latestObservation: null },
          ],
          nextCursor: null,
        },
      },
    }),
  );
  assert.match(html, /App observation time/);
  assert(html.includes(observation.latestObservation!.eventId));
  assert(
    html.includes(
      `Inspect reported files for Agent service · reported version ${observation.latestObservation!.versionId}`,
    ),
  );
  assert(!html.includes('Inspect reported files for Silent app'));
  assert.match(html, /Service received time/);
  assert.match(html, /2026-11-15T10:00:00Z/);
  assert.match(html, /2026-11-16T10:00:00Z/);
  assert.match(html, /delayed observation can refer to an older version/);
  assert.match(html, /Nothing reported within retention/);
  assert.doesNotMatch(html, /Issue credential|Revoke credential|secret/);
  assert.equal(workspaceHref('project', 'delivery'), '/w/project/delivery');
  assert.deepEqual(parseConsoleLocation('/w/project/delivery'), {
    workspaceId: 'project',
    view: 'delivery',
  });
});

test('delivery links administrators to the exact connection and gives readers bundle navigation', () => {
  function screen(canManage: boolean, items: ConnectionObservation[]) {
    return renderToStaticMarkup(
      createElement(WorkspaceDelivery, {
        workspaceId: 'team',
        canManage,
        initial: {
          ok: true,
          workspaceId: 'team',
          workspaceName: 'Team',
          page: { items, nextCursor: null },
        },
      }),
    );
  }

  const settings = '/w/team/connections?connection=' + observation.id;
  assert.match(screen(false, [observation]), /Bundle releases/);
  assert.ok(screen(true, [observation]).includes(settings));
  assert.ok(!screen(false, [observation]).includes(settings));
  assert.match(screen(true, []), /href="\/w\/team\/connections"/);
  assert.match(screen(false, []), /href="\/w\/team\/bundles"/);
});
