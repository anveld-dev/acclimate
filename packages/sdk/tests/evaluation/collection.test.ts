import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineEvaluation, captureDefinition } from '../../src/evaluation/definition.js';
import { collectionSchedule, COLLECTION_RUNTIME_KEYS } from '../../src/evaluation/collection.js';
import { assertDescriptor, runCapturedEvaluation } from '../../src/evaluation/runner.js';
import { EvaluationError } from '../../src/evaluation/errors.js';
import { journalDirectory } from '../../src/evaluation/journal.js';
import type {
  EvaluationDefinition,
  ExecutionContext,
  EvaluatorConfig,
} from '../../src/evaluation/types.js';
import type { EvaluationHandoff } from '../../src/types.js';
import type { createEvaluationTransport } from '../../src/internal/evaluation-transport.js';
import {
  fixture,
  workspaceId,
  bundleId,
  requestId,
  evaluatorPrincipalId,
  serviceUrl,
} from '../../../../scripts/evaluator-tests/fixture.js';

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

test('collection is captured privately, committed into descriptor, and drift is refused', () => {
  const input = {
    ...definition(),
    collection: { protocol: 'seeded-balanced-v1' as const, seed: 'original' },
  };
  const app = defineEvaluation(input);
  const other = defineEvaluation({
    ...definition(),
    collection: { protocol: 'seeded-balanced-v1', seed: 'changed' },
  });
  input.collection.seed = 'mutated-after-definition';
  assert.equal(app.descriptor.runtime['acclimate.collection.seed'], 'original');
  assert.equal(captureDefinition(app).collection?.seed, 'original');
  assert.ok(Object.isFrozen(captureDefinition(app).collection!.pairs[0]));
  assert.throws(
    () => assertDescriptor(app.descriptor, other.descriptor),
    (error: unknown) => error instanceof EvaluationError && error.code === 'descriptor.mismatch',
  );
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

for (const optedIn of [false, true]) {
  test(`${optedIn ? 'balanced' : 'default'} runner preserves pair identity and retains observed collection order`, async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-collection-'));
    const contexts: ExecutionContext[] = [];
    const input = definition();
    if (optedIn) input.collection = { protocol: 'seeded-balanced-v1', seed: 'runner-seed' };
    input.execute = async ({ context }) => {
      contexts.push(context);
      return { output: null };
    };
    const app = defineEvaluation(input),
      captured = captureDefinition(app),
      f = fixture(app.descriptor);
    const config: EvaluatorConfig = {
      schemaVersion: 1,
      serviceUrl,
      workspaceId,
      evaluatorPrincipalId,
      evaluatorToken: 'fixture-only',
      journalRoot: root,
    };
    const handoff: EvaluationHandoff = {
      schemaVersion: 1,
      serviceUrl,
      workspaceId,
      bundleId,
      requestId,
      descriptor: structuredClone(app.descriptor),
    };
    const transport = {
      client: f.api,
      mutate: async <T>(
        operation: string,
        _scope: unknown,
        body: string,
        key: string,
      ): Promise<T> => {
        const value = JSON.parse(body);
        if (operation === 'start')
          return (await f.api.startEvaluation(workspaceId, bundleId, requestId, value, key)) as T;
        if (operation === 'submit')
          return (await f.api.createComparison(workspaceId, bundleId, value, key)) as T;
        if (operation === 'finish')
          return (await f.api.finishEvaluation(workspaceId, bundleId, requestId, value, key)) as T;
        throw new Error('unexpected operation');
      },
    } as ReturnType<typeof createEvaluationTransport>;
    try {
      const result = await runCapturedEvaluation({ captured, config, handoff, transport });
      assert.equal(result.evaluation.status, 'completed');
      assert.equal(contexts.length, 8);
      for (let index = 0; index < 4; index++) {
        const pair = contexts.slice(index * 2, index * 2 + 2);
        const firstSide = captured.collection?.pairs[index].firstSide ?? 'parent';
        assert.deepEqual(
          pair.map((context) => context.side),
          firstSide === 'parent' ? ['parent', 'candidate'] : ['candidate', 'parent'],
        );
        for (const [armIndex, context] of pair.entries()) {
          const binding = JSON.parse(
            await readFile(path.join(context.privateJobDirectory, 'binding.json'), 'utf8'),
          );
          assert.equal(binding.side, context.side);
          assert.equal(binding.repetition, index);
          assert.equal(
            Object.hasOwn(binding, 'collection'),
            false,
            'existing native binding shape stays compatible',
          );
          if (optedIn) {
            assert.equal(context.collection!.pairIndex, index);
            assert.equal(context.collection!.armIndex, armIndex);
            const collection = JSON.parse(
              await readFile(
                path.join(context.privateJobDirectory, 'collection-binding.json'),
                'utf8',
              ),
            );
            assert.equal(collection.scheduleDigest, captured.collection!.digest);
            assert.equal(collection.side, context.side);
          } else assert.equal(context.collection, undefined);
        }
      }
      const directory = journalDirectory(root, {
        serviceUrl,
        workspaceId,
        bundleId,
        requestId,
        evaluatorPrincipalId,
      });
      if (optedIn) {
        const saved = JSON.parse(await readFile(path.join(directory, 'collection.json'), 'utf8'));
        assert.deepEqual(saved.pairs, captured.collection!.pairs);
        assert.equal(saved.digest, app.descriptor.runtime['acclimate.collection.schedule']);
      } else {
        assert.equal(
          COLLECTION_RUNTIME_KEYS.some((key) => Object.hasOwn(app.descriptor.runtime, key)),
          false,
        );
        await assert.rejects(readFile(path.join(directory, 'collection.json')), { code: 'ENOENT' });
      }
      assert.deepEqual(
        result.comparison!.results.map((pair) => pair.repetition),
        [0, 1, 2, 3],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
