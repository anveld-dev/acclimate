import assert from 'node:assert/strict';
import test from 'node:test';
import { EvaluationError, defineEvaluation, type EvaluationDefinition } from '../../src/evaluation/index.js';
import { captureDefinition } from '../../src/evaluation/definition.js';
import { redactDiagnosticText } from '../../src/evaluation/runner.js';

const defaultDefinition = (): EvaluationDefinition<
  { task: string },
  { answer: string },
  { answer: string }
> => ({
  configId: 'custom-review',
  configRevision: '1',
  datasetRevision: 'saved-tasks-1',
  graderRevision: 'exact-1',
  runtime: { app: 'fixture' },
  execution: 'model-free',
  cases: [
    {
      caseId: 'one',
      input: { task: 'execute' },
      expected: { answer: 'private-answer' },
      repetitions: 2,
    },
  ],
  execute: async () => ({ output: { answer: 'private-answer' } }),
  grade: async ({ output, expected }) => ({
    reward: Number(output.answer === expected.answer),
    explanation: { reason: 'exact' },
  }),
});
test('definition captures immutable public descriptor/inventory and keeps expected values private', () => {
  const definition = defaultDefinition(),
    app = defineEvaluation(definition);
  definition.cases[0].input.task = 'changed';
  definition.runtime = { app: 'changed' };
  assert.equal(captureDefinition(app).cases[0].input.task, 'execute');
  assert.equal(app.descriptor.runtime.concurrency, '1');
  assert.equal(app.descriptor.expectedCases.length, 2);
  assert.ok(!JSON.stringify(app).includes('private-answer'));
  assert.throws(() => {
    app.descriptor.runtime.configRevision = 'oops';
  });
  for (const bad of [
    NaN,
    Infinity,
    undefined,
    new Date(),
    new Map(),
    { ['\ud800']: 'invalid property name' },
    { nested: { ['\udfff']: true } },
    {
      get task() {
        throw new Error('getter must not run');
      },
    },
  ]) {
    assert.throws(
      () =>
        defineEvaluation({
          ...defaultDefinition(),
          cases: [{ caseId: 'x', input: bad as never, expected: { answer: 'x' } }],
        }),
      EvaluationError,
    );
  }
  assert.throws(
    () => defineEvaluation({ ...defaultDefinition(), runtime: { configId: 'overridden' } }),
    EvaluationError,
  );
});


test('redactDiagnosticText hides credentials in evaluator diagnostics', () => {
  assert.equal(
    redactDiagnosticText('Bearer fixture-secret and opaque-secret', ['opaque-secret']),
    'Bearer [redacted] and [redacted]',
  );
});
