import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dataset, expected, grade, screen } from '../../examples/self-improvement/twenty/domain.js';
import { seedPayload } from '../../examples/self-improvement/domain.js';
import { findings, learningEvidence } from '../../examples/self-improvement/twenty/feedback.js';

test('v2 curriculum checks the complete receipt, time, scope and precedence contract', () => {
  const cases = dataset('oracle').development.flatMap((b) => b.incidents);
  assert.deepEqual(
    cases.map((i) => expected(i).action),
    [
      'retry_original',
      'retry_original',
      'retry_original',
      'reconcile',
      'reconcile',
      'reconcile',
      'reconcile',
      'wait',
      'complete',
      'complete',
      'retry_original',
      'retry_original',
      'reconcile',
      'reconcile',
      'retry_fresh',
      'cancel',
      'reconcile',
      'reconcile',
      'wait',
      'reconcile',
      'complete',
      'wait',
      'reconcile',
      'reconcile',
    ],
  );
  assert.equal(expected(cases[12]!).receiptId, null);
  assert.equal(expected(cases[13]!).receiptId, null);
  assert.equal(expected(cases[9]!).receiptId, cases[9]!.receipts.find((r) => r.sequence === 4)!.id);
});
test('provider-specific lifetime, uncertainty and cooldown are exact inclusive calculations', () => {
  const base = dataset('boundaries').development[0]!.incidents[0]!;
  for (const provider of ['meridian', 'harbor'] as const) {
    const lifetime = provider === 'meridian' ? 300000 : 120000;
    for (const delta of [-1, 0, 1]) {
      const i = structuredClone(base);
      i.provider = provider;
      i.startedAtMs = i.snapshotAtMs - lifetime - delta;
      assert.equal(expected(i).action, delta <= 0 ? 'retry_original' : 'reconcile');
      i.startedAtMs = i.snapshotAtMs - lifetime + 10;
      i.clockUncertaintyMs = 10;
      assert.equal(expected(i).action, 'retry_original');
      i.clockUncertaintyMs = 11;
      assert.equal(expected(i).action, 'reconcile');
      i.startedAtMs = i.snapshotAtMs - lifetime + 100;
      i.clockUncertaintyMs = 0;
      i.cooldownUntilMs = i.snapshotAtMs + 100;
      assert.equal(expected(i).waitMs, 100);
      i.cooldownUntilMs++;
      assert.equal(expected(i).action, 'reconcile');
    }
  }
});
test('accepted and committed receipts precede holds/cancellation but unavailable evidence fails closed', () => {
  const i = structuredClone(dataset('precedence').development[0]!.incidents[0]!);
  i.hold = true;
  i.cancelRequested = true;
  i.requested.currency = 'other';
  i.original.fence = null;
  const r = i.receipts[0]!;
  r.state = 'committed';
  assert.equal(expected(i).action, 'complete');
  r.state = 'accepted';
  r.retryAfterMs = 100000;
  assert.equal(expected(i).waitMs, 30000);
  r.retryAfterMs = -10;
  assert.equal(expected(i).waitMs, 1000);
  r.retryAfterMs = null;
  assert.equal(expected(i).waitMs, 5000);
  i.ledgerAvailable = false;
  assert.deepEqual(expected(i), {
    action: 'reconcile',
    receiptId: null,
    fence: null,
    waitMs: null,
  });
});
test('exact outputs retain every incident and unsafe key/receipt reuse cannot pass', () => {
  const batch = dataset('grades').development[0]!;
  const decisions = batch.incidents.map((i) => ({
    id: i.id,
    ...expected(i),
    reason: 'Checked policy',
  }));
  assert.equal(grade(batch, { decisions }).correct, 12);
  const bad = structuredClone(decisions);
  bad[0]!.fence = 'new-key';
  assert.equal(grade(batch, { decisions: bad }).unsafe, 1);
  bad[0]!.fence = decisions[0]!.fence;
  bad[0]!.receiptId = 'untrusted-receipt';
  assert.equal(grade(batch, { decisions: bad }).unsafe, 1);
  for (const output of [
    null,
    { decisions: decisions.slice(1) },
    { decisions: decisions.map((r) => ({ ...r, id: decisions[0]!.id })) },
  ]) {
    const result = grade(batch, output);
    assert.equal(result.correct, 0);
    assert.equal(result.total, 12);
  }
});
test('audit has new combinations and disjoint identities, currencies and regions', () => {
  const d = dataset('separation'),
    dev = d.development.flatMap((b) => b.incidents),
    audit = d.audit.flatMap((b) => b.incidents);
  assert.equal(dev.length, 24);
  assert.equal(audit.length, 32);
  const ids = new Set(dev.flatMap((i) => [i.id, ...i.receipts.map((r) => r.id)]));
  assert(audit.every((i) => !ids.has(i.id) && i.receipts.every((r) => !ids.has(r.id))));
  assert(
    audit.every(
      (i) =>
        !dev.some(
          (j) =>
            j.original.currency === i.original.currency || j.original.region === i.original.region,
        ),
    ),
  );
  assert(
    audit.some(
      (i) => i.hold && i.cancelRequested && i.receipts.some((r) => r.state === 'committed'),
    ),
  );
  assert(
    audit.every(
      (i) => !Object.keys(i).some((key) => ['kind', 'family', 'expected', 'grade'].includes(key)),
    ),
  );
});
test('reusable files cannot memorize receipt identities', () => {
  const d = dataset('screen');
  screen(seedPayload, d.development);
  const receipt = d.development[0]!.incidents[0]!.receipts[0]!.id;
  assert.throws(() =>
    screen(
      { ...seedPayload, files: [{ path: 'memory/gateway.md', kind: 'memory', text: receipt }] },
      d.development,
    ),
  );
});
test('rejected candidate mistakes reach the next proposer even when the incumbent is correct', () => {
  const batches = dataset('feedback').development;
  const observations = batches.map((batch) => ({
    batch,
    grade: grade(batch, {
      decisions: batch.incidents.map((i) => ({
        id: i.id,
        ...expected(i),
        reason: 'Known correct',
      })),
    }),
  }));
  const mistake = {
    ...findings(observations)[0]!,
    correct: false,
    unsafe: true,
    actual: {
      id: batches[0]!.incidents[0]!.id,
      action: 'complete' as const,
      fence: null,
      receiptId: null,
      waitMs: null,
      reason: 'Mistaken completion',
    },
  };
  const entries = learningEvidence({ observations, rejected: [mistake], round: 2, bytes: 2000 });
  const feedback = entries
    .map((entry) => {
      try {
        return JSON.parse(entry);
      } catch {
        return null;
      }
    })
    .find((entry) => entry?.rejectedCandidateMistake);
  assert.equal(feedback.rejectedCandidateMistake.actual.action, 'complete');
  assert.equal(feedback.rejectedCandidateMistake.expected.action, 'retry_original');
  assert(entries.length <= 20 && entries.every((entry) => entry.length <= 4096));
});
