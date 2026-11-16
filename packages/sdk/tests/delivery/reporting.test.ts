import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AcclimateClient,
  resolveAndCache,
  createReceiptReporter,
  type DeliveryReceiptRequest,
} from '../../src/index.js';

const bytes = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    files: [{ path: 'instructions/main.md', kind: 'instruction', text: 'test' }],
  }),
);
const version = {
  id: 'v',
  bundleId: 'b',
  parentVersionId: null,
  digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  createdAt: new Date().toISOString(),
};
test('opt-in delivery reports actual network/cache/offline source and explicit prepared/started', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reporting-')));
  let offline = false;
  const events: DeliveryReceiptRequest[] = [];
  const client = new AcclimateClient({
    baseUrl: 'https://service.test',
    token: 'read',
    scope: 'p',
    retries: 0,
    fetch: async (url) => {
      if (offline) throw new TypeError('offline');
      return String(url).endsWith('/payload')
        ? new Response(bytes)
        : Response.json({ channel: 'main', revision: '1', version });
    },
  });
  const reportingClient = new AcclimateClient({
    baseUrl: 'https://service.test',
    token: 'receipt',
    scope: 'p',
    retries: 0,
    fetch: async (_url, init) => {
      events.push(JSON.parse(String(init?.body)));
      return Response.json({});
    },
  });
  const reporter = createReceiptReporter({
    client: reportingClient,
    projectId: 'p',
    integrationId: 'i',
  });
  const selection = { projectId: 'p', bundleId: 'b', channel: 'main' };
  try {
    const verified = await resolveAndCache(client, selection, { cacheDir: dir, reporter });
    reporter.reportPrepared(verified);
    reporter.reportStarted(verified);
    await reporter.flush();
    assert.deepEqual(
      events.map((e) => e.stage),
      ['resolved', 'downloaded', 'verified', 'prepared', 'started'],
    );
    assert(events.every((e) => e.source === 'network' && e.digest === version.digest));
    events.length = 0;
    await resolveAndCache(client, selection, { cacheDir: dir, reporter });
    await reporter.flush();
    assert.deepEqual(
      events.map((e) => [e.stage, e.source]),
      [
        ['resolved', 'cache'],
        ['verified', 'cache'],
      ],
    );
    events.length = 0;
    offline = true;
    await resolveAndCache(client, selection, {
      cacheDir: dir,
      offline: { maxAgeMs: 10000 },
      reporter,
    });
    await reporter.flush();
    assert(events.every((e) => e.source === 'offline' && e.stale === true));
    assert.equal(events.length, 2);
    await resolveAndCache(client, selection, {
      cacheDir: dir,
      offline: { maxAgeMs: 10000 },
      reporter: {
        observeDelivery() {
          throw new Error('reporter broken');
        },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('closing optional reporting stops claiming queued events after an in-flight call', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const client = new AcclimateClient({
    baseUrl: 'https://service.test',
    token: 'receipt',
    scope: 'p',
    retries: 0,
    fetch: async () => {
      calls++;
      entered();
      await blocked;
      return Response.json({});
    },
  });
  const reporter = createReceiptReporter({ client, projectId: 'p', integrationId: 'i' });
  const bundle = {
    version,
    payload: { schemaVersion: 1 as const, files: [] },
    resolvedAt: Date.now(),
    stale: false,
  };
  reporter.observeDelivery({
    selection: { projectId: 'p', bundleId: 'b', versionId: 'v' },
    bundle,
    source: 'cache',
    downloaded: false,
  });
  await started;
  reporter.reportPrepared(bundle);
  const inFlight = reporter.flush();
  reporter.close();
  release();
  await inFlight;
  assert.equal(calls, 1);
  assert.equal(reporter.pendingCount, 1);
  assert.equal(reporter.reportStarted(bundle), false);
  await reporter.flush();
  assert.equal(calls, 1);
});
