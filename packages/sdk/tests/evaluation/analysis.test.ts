import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  analyzeComparison,
  AnalysisError,
  type AnalysisOptions,
} from '../../src/evaluation/analysis.js';
import { PolicyError } from '../../src/evaluation/policy.js';

const fixtures = JSON.parse(
  readFileSync(
    new URL('../../../../contracts/fixtures/evaluation-analysis/vectors.json', import.meta.url),
    'utf8',
  ),
);
function input(vector: (typeof fixtures.vectors)[number]): AnalysisOptions {
  const value = structuredClone(fixtures.input);
  for (const patch of vector.patches) {
    let target = value;
    for (const segment of patch.path.slice(0, -1)) target = target[segment];
    const last = patch.path.at(-1);
    if (patch.remove) delete target[last];
    else target[last] = structuredClone(patch.value);
  }
  return value;
}
for (const vector of fixtures.vectors)
  test(`shared analysis vector: ${vector.name}`, () => {
    const source = input(vector),
      before = JSON.stringify(source);
    if (vector.expected.error)
      assert.throws(
        () => analyzeComparison(source),
        (error: unknown) =>
          (error instanceof AnalysisError || error instanceof PolicyError) &&
          error.code === vector.expected.error,
      );
    else assert.deepEqual(analyzeComparison(source), vector.expected.result);
    assert.equal(JSON.stringify(source), before);
  });

test('equal-case means, paired differences and lower units have an independent arithmetic oracle', () => {
  const result = analyzeComparison(structuredClone(fixtures.input));
  for (const metric of result.metrics) {
    // routine: +2 (three pairs); critical: -3 (two pairs). Pooled rows would yield 0.
    assert.equal(metric.summary?.orientedMeanImprovement, (2 + -3) / 2);
    assert.deepEqual(metric.counts, {
      distinctCases: 2,
      expectedPairs: 5,
      comparablePairs: 5,
      missingPairs: 0,
    });
  }
  assert.equal(result.metrics[0].summary?.parentMean, (2 + 8) / 2);
  assert.equal(result.metrics[0].summary?.candidateMean, (4 + 5) / 2);
  assert.equal(result.executionAttested, false);
});

test('invalid protocol, unknown fields, nonfinite components and boolean numbers fail closed', () => {
  for (const patch of [
    { seed: -1 },
    { seed: 4294967296 },
    { seed: 1.5 },
    { seed: true },
    { resamples: 99 },
    { resamples: 10001 },
    { confidenceLevel: NaN },
    { independentStochasticPairs: false },
    { estimand: 'population' },
    { unknown: 1 },
  ]) {
    const value = structuredClone(fixtures.input);
    Object.assign(value.uncertainty, patch);
    assert.throws(() => analyzeComparison(value), AnalysisError);
  }
  for (const value of [NaN, Infinity, -Infinity, true]) {
    const source = structuredClone(fixtures.input);
    source.observations[0].values.latency = value;
    assert.throws(() => analyzeComparison(source), AnalysisError);
  }
});

test('protocol is opt-in, per-metric stream independent of metric ordering, and result detached', () => {
  const value = structuredClone(fixtures.input);
  const expected = analyzeComparison(value);
  value.metrics.reverse();
  const reversed = analyzeComparison(value);
  assert.deepEqual(reversed.metrics, [...expected.metrics].reverse());
  expected.expectedBinding.requestId = 'changed';
  expected.metrics[0].metric.unit = 'changed';
  expected.uncertaintyProtocol!.samplingProtocol = 'changed';
  assert.notEqual(value.expectedBinding.requestId, 'changed');
  assert.notEqual(value.uncertainty.samplingProtocol, 'changed');
  delete value.uncertainty;
  assert.deepEqual(
    analyzeComparison(value).metrics.map(({ metric, uncertainty }) => [metric.id, uncertainty.status]),
    value.metrics.map(({ id }: { id: string }) => [id, 'not_requested']),
  );
});

test('scored nonfinite scalar never creates an interval', () => {
  const value = structuredClone(fixtures.input);
  value.comparison.results[0].parent.reward = Infinity;
  const result = analyzeComparison(value);
  assert.equal(result.metrics[0].code, 'analysis.nonfinite');
  assert.equal(result.metrics[0].summary, null);
  assert.equal(result.metrics[0].uncertainty.interval, null);
  assert.equal(result.metrics[1].code, 'analysis.nonfinite');
  assert.equal(result.metrics[1].uncertainty.interval, null);
});
