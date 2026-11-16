import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  largeDataset,
  consistency,
  inventorySchema,
} from '../../examples/self-improvement/large/domain.js';
import { expected } from '../../examples/self-improvement/twenty/domain.js';

const frozen = largeDataset('large-fixture-test');
test('large decoding fixes the inventory while leaving all policy decisions unconstrained', () => {
  const ids = frozen.batches[0]!.manifest.map((i) => i.id),
    s = inventorySchema(ids);
  assert.equal(s.properties.decisions.minItems, 32);
  assert.equal(s.properties.decisions.maxItems, 32);
  assert.deepEqual(s.properties.decisions.items.properties.id.enum, ids);
  assert.equal(s.properties.decisions.items.properties.action.enum.length, 6);
  assert.throws(() => inventorySchema([]));
  assert.throws(() => inventorySchema(['duplicate', 'duplicate']));
});
test('large suite contains 128 views, 12288 meaningful receipt records and disjoint new scopes', () => {
  assert.equal(frozen.metrics.baseEvents, 96);
  assert.equal(frozen.metrics.incidentViews, 128);
  assert.equal(frozen.metrics.records, 12288);
  assert.equal(frozen.batches.length, 4);
  assert(frozen.metrics.inputBytes > 5_000_000);
  assert(frozen.batches.every((b) => b.incidents.length === 32 && b.files.length === 44));
  assert(
    frozen.batches.every((b) =>
      b.incidents.every((i) => !['USD', 'EUR', 'GBP', 'JPY', 'CAD'].includes(i.original.currency)),
    ),
  );
});
test('every fact used by the grader is present in the agent-accessible files', () => {
  for (const b of frozen.batches) {
    const files = new Map(b.files.map((f) => [f.path, f.text]));
    for (const entry of b.manifest) {
      const request = JSON.parse(files.get(entry.requestFile)!);
      const receipts = entry.receiptFiles
        .flatMap((name) =>
          files
            .get(name)!
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        )
        .filter((r) => r.incidentId === entry.id)
        .map((r) => r.receipt);
      const original = b.incidents.find((i) => i.id === entry.id)!;
      const sort = (rows: typeof receipts) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(
        { ...request, receipts: sort(receipts) },
        { ...original, receipts: sort(original.receipts) },
      );
    }
  }
});
test('aliases preserve authoritative outcomes across jobs and omissions cannot count as consistency', () => {
  const all = frozen.batches.flatMap((b) => b.incidents);
  for (const group of frozen.groups)
    assert.deepEqual(
      expected(all.find((i) => i.id === group.baseId)!),
      expected(all.find((i) => i.id === group.aliasId)!),
    );
  const outputs = frozen.batches.map((batch) => ({
    batch,
    output: {
      decisions: batch.incidents.map((i) => ({
        id: i.id,
        ...expected(i),
        reason: 'Known fixture answer',
      })),
    },
  }));
  assert.deepEqual(consistency(frozen, outputs), {
    expected: 32,
    checked: 32,
    violations: 0,
    missing: 0,
  });
  assert(consistency(frozen, outputs.slice(0, 3)).missing > 0);
  const alias = frozen.groups[0]!.aliasId;
  outputs[3]!.output.decisions.find((d) => d.id === alias)!.action = 'reconcile';
  assert.equal(consistency(frozen, outputs).violations, 1);
});
