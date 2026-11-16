import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AcclimateClient,
  createReceiptReporter,
  type DeliveryReceiptRequest,
} from '../../src/index.js';

test('optional reporter retains exact event across failure and bounds its queue', async () => {
  const bodies: string[] = [];
  const client = new AcclimateClient({
    baseUrl: 'https://example.test',
    token: 'receipt-only',
    scope: 'p',
    retries: 0,
    fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1 ? new Response('{}', { status: 503 }) : Response.json({});
    },
  });
  let clock = 0;
  const reporter = createReceiptReporter({
    client,
    projectId: 'p',
    integrationId: 'i',
    maxPending: 1,
    now: () => clock,
  });
  const event: DeliveryReceiptRequest = {
    eventId: 'event',
    integrationId: 'i',
    projectId: 'p',
    bundleId: 'b',
    versionId: 'v',
    digest: 'digest',
    stage: 'verified',
    occurredAt: new Date().toISOString(),
    source: 'network',
  };
  assert.equal(reporter.enqueue(event), true);
  event.digest = 'mutated';
  assert.equal(reporter.enqueue({ ...event, eventId: 'second' }), false);
  await reporter.flush();
  assert.equal(reporter.pendingCount, 1);
  await reporter.flush();
  assert.equal(reporter.pendingCount, 0);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[1]).digest, 'digest');
  reporter.enqueue(event);
  clock = 24 * 60 * 60 * 1000;
  await reporter.flush();
  assert.equal(reporter.pendingCount, 0);
  assert.equal(bodies.length, 2);
});


test('fresh receipt at the completed-pass boundary is sent by its awaited flush', async () => {
  const sent: string[] = [];
  const client = new AcclimateClient({ baseUrl: 'https://fixture.invalid', token: 'fixture', scope: 'p',
    fetch: async () => { throw Error('Injected transport should handle this receipt'); } });
  let later: Promise<void> | undefined;
  const event = (eventId: string): DeliveryReceiptRequest => ({ eventId, integrationId: 'i', projectId: 'p',
    bundleId: 'b', versionId: 'v', digest: 'sha256:test', stage: 'prepared', source: 'network', occurredAt: new Date(0).toISOString() });
  const reporter = createReceiptReporter({ client, projectId: 'p', integrationId: 'i' });
  client.reportDeliveryReceipt = async (_project, _integration, receipt) => {
    sent.push(receipt.eventId);
    if (receipt.eventId === 'first') queueMicrotask(() => queueMicrotask(() => {
      reporter.enqueue(event('later'));
      later = reporter.flush();
    }));
    return { ...receipt, receivedAt: new Date(0).toISOString(), delayed: false };
  };
  try {
    reporter.enqueue(event('first'));
    await reporter.flush();
    await Promise.resolve();
    assert.ok(later);
    await later;
    assert.deepEqual(sent, ['first', 'later']);
    assert.equal(reporter.pendingCount, 0);
    // Empty flushes do not leave a settled running promise blocking future work.
    await reporter.flush();
    reporter.enqueue(event('after-empty'));
    await reporter.flush();
    assert.deepEqual(sent, ['first', 'later', 'after-empty']);
    assert.equal(reporter.pendingCount, 0);
  } finally { reporter.close(); }
});
