import test from 'node:test';
import assert from 'node:assert/strict';
import { defineEvaluation, captureDefinition } from '../../src/evaluation/definition.js';
import { collectionSchedule, COLLECTION_RUNTIME_KEYS } from '../../src/evaluation/collection.js';
import { EvaluationError } from '../../src/evaluation/errors.js';
import type { EvaluationDefinition } from '../../src/evaluation/types.js';

const definition = (): EvaluationDefinition<null, null, null> => ({
  configId: 'collection-check',
  configRevision: '1',
  datasetRevision: 'pairs-1',
  graderRevision: 'grade-1',
  runtime: { app: 'fixture' },
  execution: 'model-free',
  cases: [{ caseId: 'one', input: null, expected: null, repetitions: 4 }],
  execute: async () => ({ output: null }),
  grade: async () => ({ reward: 1 }),
});

test('seeded arm allocation is reproducible and balanced for even and odd inventories', () => {
  for (const count of [1, 2, 5, 20]) {
    const inventory = Array.from({ length: count }, (_, repetition) => ({
      caseId: 'a',
      repetition,
    }));
    const schedule = collectionSchedule(
      { protocol: 'seeded-balanced-v1', seed: 'frozen-seed' },
      inventory,
    );
    assert.deepEqual(
      schedule,
      collectionSchedule({ protocol: 'seeded-balanced-v1', seed: 'frozen-seed' }, inventory),
    );
    const parentFirst = schedule.pairs.filter((pair) => pair.firstSide === 'parent').length;
    assert.ok(Math.abs(parentFirst - (count - parentFirst)) <= 1);
    assert.match(schedule.digest, /^sha256:[a-f0-9]{64}$/);
  }
});

test('collection is captured privately, committed into descriptor, and distinguishes seeds', () => {
  const input = {
    ...definition(),
    collection: { protocol: 'seeded-balanced-v1' as const, seed: 'original' },
  };
  const app = defineEvaluation(input);
  const other = defineEvaluation({
    ...definition(),
    collection: { protocol: 'seeded-balanced-v1', seed: 'changed' },
  });
  assert.notDeepEqual(app.descriptor, other.descriptor);
  input.collection.seed = 'mutated-after-definition';
  assert.equal(app.descriptor.runtime['acclimate.collection.seed'], 'original');
  assert.equal(captureDefinition(app).collection?.seed, 'original');
  assert.ok(Object.isFrozen(captureDefinition(app).collection!.pairs[0]));
  for (const reserved of COLLECTION_RUNTIME_KEYS)
    assert.throws(
      () => defineEvaluation({ ...definition(), runtime: { [reserved]: 'override' } }),
      EvaluationError,
    );
  assert.throws(
    () =>
      defineEvaluation({
        ...definition(),
        collection: { protocol: 'seeded-balanced-v1', seed: '' },
      }),
    EvaluationError,
  );
  assert.throws(
    () =>
      defineEvaluation({
        ...definition(),
        collection: { protocol: 'seeded-balanced-v1', seed: 'x', extra: true } as any,
      }),
    EvaluationError,
  );
});

test('Unicode schedule digest matches the Python evaluator', () => {
  const pairs = Array.from({ length: 4 }, (_, repetition) => ({ caseId: 'one🍊', repetition }));
  const schedule = collectionSchedule({ protocol: 'seeded-balanced-v1', seed: 'parity🍊' }, pairs);
  assert.equal(
    schedule.digest,
    'sha256:e4e68691c20042ee820793c8c9404ace8a7187ff21e75c63fe81e4f032e1dcaa',
  );
  assert.deepEqual(
    schedule.pairs.map((pair) => pair.firstSide),
    ['parent', 'candidate', 'candidate', 'parent'],
  );
});
