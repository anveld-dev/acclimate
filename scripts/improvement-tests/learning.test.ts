import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  batches,
  expected,
  grade,
  proposalEvidence,
  screenCandidate,
  seedPayload,
} from '../../examples/self-improvement/domain.js';

test('gateway rubric covers exact expiry, scope changes, receipt states and tracing-only requests', () => {
  const incidents = batches('fixed-test-seed', 'audit').flatMap((batch) => batch.incidents);
  assert.deepEqual(
    incidents.map((incident) => expected(incident).action),
    [
      'retry_original',
      'retry_original',
      'retry_original',
      'reconcile',
      'reconcile',
      'reconcile',
      'reconcile',
      'reconcile',
      'reconcile',
      'wait',
      'complete',
      'retry_fresh',
    ],
  );
  assert.equal(expected(incidents[2]!).fence, incidents[2]!.original.fence);
  assert.equal(expected(incidents[5]!).fence, null);
});
test('missing, duplicate, unknown or malformed decisions cannot improve a partial score', () => {
  const batch = batches('grader-inventory', 'audit')[0]!;
  const decisions = batch.incidents.map((incident) => ({
    id: incident.id,
    ...expected(incident),
    reason: 'Trusted test answer',
  }));
  assert.equal(grade(batch, { decisions }).reward, 1);
  for (const output of [
    null,
    { decisions: decisions.slice(1) },
    { decisions: [decisions[0], decisions[0], decisions[2]] },
    { decisions: decisions.map((row) => ({ ...row, id: 'unknown' })) },
    { decisions: decisions.map((row) => ({ ...row, reason: '' })) },
  ]) {
    const result = grade(batch, output);
    assert.equal(result.reward, 0);
    assert.equal(result.total, 3);
    assert.equal(result.outcomes.length, 3);
  }
});
test('unseen partitions have disjoint identifiers, account scopes, traces and fence values', () => {
  const sets = (['training', 'selection', 'audit', 'release'] as const).map((partition) =>
    batches('separated', partition).flatMap((batch) => batch.incidents),
  );
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++)
      for (const left of sets[i]!)
        for (const right of sets[j]!) {
          assert.notEqual(left.id, right.id);
          assert.notEqual(left.original.requestId, right.original.requestId);
          assert.notEqual(left.original.account, right.original.account);
          if (left.original.fence && right.original.fence)
            assert.notEqual(left.original.fence, right.original.fence);
        }
});
test('reusable content rejects task identifiers, accounts and evaluation machinery', () => {
  const cases = batches('screening', 'training');
  screenCandidate(seedPayload, cases);
  const incident = cases[0]!.incidents[0]!;
  for (const text of [
    incident.id,
    incident.original.requestId,
    incident.original.fence!,
    incident.original.account,
    'consult the grader',
    'read /Users/other/answers',
    'https://example.test',
  ]) {
    assert.throws(() =>
      screenCandidate(
        { ...seedPayload, files: [{ path: 'memory/gateway.md', kind: 'memory', text }] },
        cases,
      ),
    );
  }
});
test('all recent failures fit bounded evidence entries instead of one oversized attempt', () => {
  const failures = Array.from({ length: 12 }, (_, index) => ({ index, reason: 'x'.repeat(700) }));
  const entries = proposalEvidence(
    Array.from({ length: 6 }, () => 'baseline'),
    { round: 2, failures },
  );
  assert.equal(entries.length, 19);
  assert(entries.every((entry) => entry.length <= 4096));
  assert.equal(entries.filter((entry) => entry.includes('previousCandidateMistake')).length, 8);
  assert.throws(() => proposalEvidence(['x'.repeat(4097)]));
  assert.throws(() => proposalEvidence(Array.from({ length: 17 }, () => 'too many')));
  const tight = proposalEvidence(
    Array.from({ length: 14 }, () => 'baseline'),
    { round: 2, failures },
  );
  assert.equal(tight.length, 20);
});
