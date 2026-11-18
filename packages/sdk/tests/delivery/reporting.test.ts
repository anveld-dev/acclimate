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

test('started receipts return exact event identity and refuse observation from a sibling connection', async () => {
  const integrationId = 'a7100000-0000-0000-0000-000000000001';
  const sibling = 'a7100000-0000-0000-0000-000000000002';
  const events: DeliveryReceiptRequest[] = [];
  const client = new AcclimateClient({
    baseUrl: 'https://service.test',
    token: 'receipt',
    scope: 'p',
    fetch: async (_url, init) => {
      events.push(JSON.parse(String(init?.body)));
      return Response.json({});
    },
  });
  const reporter = createReceiptReporter({ client, projectId: 'p', integrationId });
  const bundle = {
    version,
    payload: { schemaVersion: 1 as const, files: [] },
    resolvedAt: Date.now(),
    stale: false,
    resolution: { channel: 'main', revision: '3', version },
    connection: { projectId: 'p', integrationId },
  };
  const otherBundle = { ...bundle, connection: { projectId: 'p', integrationId: sibling } };
  const observation = {
    selection: { projectId: 'p', bundleId: 'b', channel: 'main' },
    bundle,
    source: 'cache' as const,
    downloaded: false,
  };
  assert.throws(() => reporter.observeDelivery({ ...observation, bundle: otherBundle }), /scope/);
  assert.throws(() => reporter.reportStartedReceipt(otherBundle), /has not been observed/);
  reporter.observeDelivery(observation);
  const started = reporter.reportStartedReceipt(bundle);
  assert.ok(started);
  assert.equal(started.integrationId, integrationId);
  assert.equal(started.revision, '3');
  assert.equal(started.stage, 'started');
  assert(Object.isFrozen(started));
  await reporter.flush();
  assert.deepEqual(
    events.find((event) => event.stage === 'started'),
    started,
  );
  assert(events.every((event) => event.integrationId === integrationId));
});

test('a prepared job retries a refused start at its original time and queues it once', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reporting-pressure-')));
  const reader = new AcclimateClient({
    baseUrl: 'https://service.test',
    token: 'read',
    scope: 'p',
    fetch: async (url) =>
      String(url).endsWith('/payload')
        ? new Response(bytes)
        : Response.json({ channel: 'main', revision: '1', version }),
  });
  let unblock!: () => void;
  const slowDelivery = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const events: DeliveryReceiptRequest[] = [];
  const writer = new AcclimateClient({
    baseUrl: 'https://service.test',
    token: 'write',
    scope: 'p',
    fetch: async (_url, init) => {
      await slowDelivery;
      events.push(JSON.parse(String(init?.body)));
      return Response.json({});
    },
  });
  let clock = Date.now();
  const reporter = createReceiptReporter({
    client: writer,
    projectId: 'p',
    integrationId: 'i',
    maxPending: 1,
    now: () => clock,
  });
  try {
    await using job = await reader.prepare({
      projectId: 'p',
      bundleId: 'b',
      channel: 'main',
      cacheDir: dir,
      reporter,
    });
    const startTime = new Date(clock).toISOString();
    assert.equal(job.reportStarted(), null);
    clock += 60_000;
    assert.equal(job.reportStarted(), null);
    unblock();
    await reporter.flush();
    const accepted = job.reportStarted();
    assert.ok(accepted);
    assert.equal(accepted.occurredAt, startTime);
    assert.equal(job.reportStarted(), accepted);
    await reporter.flush();
    assert.equal(job.reportStarted(), accepted);
    assert.deepEqual(
      events.filter((event) => event.stage === 'started'),
      [accepted],
    );
  } finally {
    unblock();
    reporter.close();
    await rm(dir, { recursive: true, force: true });
  }
});
