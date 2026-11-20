import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeReviewAdapter } from '../../examples/service-proposer/evaluation-adapter.js';
import { runCheckoutEvaluation } from './runner.js';
import { simulatePayment } from './payment.js';
import { fixture, workspaceId, bundleId, requestId, evaluatorPrincipalId, serviceUrl } from './fixture.js';
import type { BundlePayload, ComparisonRequest } from '../../packages/sdk/src/types.js';

const payload = (idempotency: string, maxAttempts = 2): BundlePayload => ({ schemaVersion: 1, files: [
  { path: 'payment-policy.json', kind: 'memory', text: JSON.stringify({ idempotency, maxAttempts }) },
] });

test('payment simulation grades actual charge traces, including wrong key scope and response loss', () => {
  const unsafe = simulatePayment(payload('none'), 'response-lost');
  assert.equal(unsafe.charges, 2);
  assert.equal(unsafe.succeeded, true);
  assert.equal(simulatePayment(payload('attempt'), 'response-lost').charges, 2);
  const safe = simulatePayment(payload('request'), 'response-lost');
  assert.equal(safe.charges, 1);
  assert.equal(safe.succeeded, true);
  assert.ok(safe.events.some((e) => e.event === 'deduplicated'));
  assert.equal(simulatePayment(payload('request', 1), 'transient-before-charge').succeeded, false);
  assert.equal(simulatePayment({ schemaVersion: 1, files: [] }, 'clean').policyError, 'Missing or invalid declarative payment policy');
  assert.equal(simulatePayment(payload('request', 100000), 'clean').charges, 0);
});

test('native dataset and independent grader run through the same interface with explicitly fake runtime labeling', async () => {
  let turns = 0;
  const adapter = nativeReviewAdapter({ review: async (_bundle, snapshot) => {
    turns++;
    return { text: JSON.stringify({ unsafeRetry: !snapshot.diff.includes('idempotencyKey') }), usage: null };
  } }, { wiringOnly: true });
  assert.equal(adapter.describe().runtime.model, 'fake-native-review');
  const f = fixture(adapter.describe());
  const journalRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-native-wiring-'));
  try {
    const result = await runCheckoutEvaluation({ api: f.api, adapter, journalRoot, workspaceId, bundleId, requestId, evaluatorPrincipalId, serviceUrl });
    assert.equal(turns, 4);
    assert.equal(result.status, 'completed');
    const report = f.events.find((e) => e.kind === 'submit')!.body as ComparisonRequest;
    assert.ok(report.results.every((r) => r.parent.reward === 1 && r.candidate.reward === 1));
    assert.equal(report.runtime.app, 'native-review-wiring-test');
  } finally { await rm(journalRoot, { recursive: true, force: true }); }
});
