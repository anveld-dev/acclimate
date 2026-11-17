import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  checkComparison,
  parseEvaluationPolicy,
  PolicyError,
  validateEvaluationPolicy,
} from '../../src/evaluation/policy.js';

const fixtures = JSON.parse(
  readFileSync(
    new URL('../../../../contracts/fixtures/evaluation-policy/vectors.json', import.meta.url),
    'utf8',
  ),
);

for (const vector of fixtures.vectors) {
  test(`shared policy vector: ${vector.name}`, () => {
    const execute = () =>
      checkComparison({
        comparison: vector.comparison,
        expectedDescriptor: vector.descriptor,
        expectedBinding: vector.binding,
        policy: vector.policy,
      });
    if (vector.expected.error) {
      assert.throws(
        execute,
        (error: unknown) => error instanceof PolicyError && error.code === vector.expected.error,
      );
    } else {
      const result = execute();
      assert.equal(result.verdict, vector.expected.verdict);
      assert.equal(result.code, vector.expected.code);
      if ('improvement' in vector.expected)
        assert.equal(result.summary.orientedMeanImprovement, vector.expected.improvement);
      assert.equal(result.interpretation, 'descriptive-policy-check');
      assert.equal(result.policy.sha256, null);
      assert.deepEqual(result.expectedBinding, vector.binding);
    }
  });
}

test('policy parser rejects duplicate decoded keys at every nesting level without echoing input', () => {
  for (const text of [
    '{"secret-canary":"a","secret-canary":"b"}',
    '{"id":"a","\\u0069d":"b"}',
    '{"metric":{"name":"a","name":"b"}}',
    '[{"a":1,"a":2}]',
  ]) {
    assert.throws(
      () => parseEvaluationPolicy(text),
      (error: unknown) =>
        error instanceof PolicyError &&
        error.code === 'policy.invalid' &&
        !error.message.includes('secret-canary'),
    );
  }
});

test('policy parser hashes the exact UTF-8 bytes including whitespace and Unicode', () => {
  const policy = structuredClone(fixtures.vectors[0].policy);
  policy.metric.name = 'reward 🐿';
  const texts = [JSON.stringify(policy), JSON.stringify(policy, null, 2) + '\r\n'];
  const parsed = texts.map((text) => parseEvaluationPolicy(text, fixtures.vectors[0].descriptor));
  for (let index = 0; index < texts.length; index++) {
    assert.equal(
      parsed[index].sha256,
      'sha256:' + createHash('sha256').update(texts[index]).digest('hex'),
    );
    assert.deepEqual(parsed[index].policy, policy);
  }
  assert.notEqual(parsed[0].sha256, parsed[1].sha256);
});

test('invalid JSON, booleans, nonfinite numbers and unknown fields are authoring errors', () => {
  for (const text of [
    '',
    '{} trailing',
    '{"a":1,}',
    '{"a":01}',
    'NaN',
    '\ufeff{}',
    '{"a":"bad\nstring"}',
  ])
    assert.throws(() => parseEvaluationPolicy(text), PolicyError);
  for (const patch of [
    { minimumMeanImprovement: true },
    { maximumCaseRegression: false },
    { minimumMeanImprovement: Infinity },
    { candidateThreshold: NaN },
    { unknown: 1 },
    { cost: { maximumCandidateUsd: false } },
    { requiredCases: ['ordinary', 'ordinary'] },
  ])
    assert.throws(
      () => validateEvaluationPolicy({ ...fixtures.vectors[0].policy, ...patch }),
      PolicyError,
    );
});

test('validation returns detached policy data and does not change evidence', () => {
  const source = structuredClone(fixtures.vectors[0]);
  const before = JSON.stringify(source);
  const validated = validateEvaluationPolicy(source.policy, source.descriptor);
  validated.requiredCases.push('new');
  validated.metric.name = 'changed';
  const parsed = parseEvaluationPolicy(JSON.stringify(source.policy));
  const result = checkComparison({
    comparison: source.comparison,
    expectedDescriptor: source.descriptor,
    expectedBinding: source.binding,
    policy: parsed.policy,
    policyDigest: parsed.sha256,
  });
  assert.equal(result.policy.sha256, parsed.sha256);
  assert.equal(JSON.stringify(source), before);
  result.expectedBinding.requestId = 'changed';
  assert.equal(JSON.stringify(source), before);
});

test('policy recomputes completeness instead of trusting complete=true', () => {
  const source = structuredClone(fixtures.vectors[0]);
  source.comparison.results[0].candidate.executionStatus = 'infrastructure_failed';
  const result = checkComparison({
    comparison: source.comparison,
    expectedDescriptor: source.descriptor,
    expectedBinding: source.binding,
    policy: source.policy,
  });
  assert.equal(result.verdict, 'indeterminate');
  assert.equal(result.counts.comparablePairs, 0);
  assert.equal(result.summary.candidateMean, null);
});

test('equal-case aggregate is not pair-weighted and unknown does not hide known failure', () => {
  const source = fixtures.vectors.find((item: any) => item.name === 'unequal-repetitions');
  const result = checkComparison({
    comparison: source.comparison,
    expectedDescriptor: source.descriptor,
    expectedBinding: source.binding,
    policy: source.policy,
  });
  assert.equal(result.summary.parentMean, 0.5);
  assert.equal(result.summary.candidateMean, 0.5);
  assert.equal(result.summary.worstCaseRegression, 1);
  assert.equal(result.counts.distinctCases, 2);
  assert.equal(result.counts.expectedPairs, 10);
  const uncertain = fixtures.vectors.find(
    (item: any) => item.name === 'known-failure-and-unknown-cost',
  );
  const incomplete = checkComparison({
    comparison: uncertain.comparison,
    expectedDescriptor: uncertain.descriptor,
    expectedBinding: uncertain.binding,
    policy: uncertain.policy,
  });
  assert.equal(incomplete.verdict, 'indeterminate');
  assert.ok(incomplete.checks.some((item) => item.result === 'fail'));
  assert.ok(incomplete.checks.some((item) => item.result === 'unknown'));
});

test('nonfinite reward and scored missing output are never converted to quality zero', () => {
  for (const reward of [NaN, Infinity, null]) {
    const source = structuredClone(fixtures.vectors[0]);
    source.comparison.results[0].candidate.reward = reward;
    const result = checkComparison({
      comparison: source.comparison,
      expectedDescriptor: source.descriptor,
      expectedBinding: source.binding,
      policy: source.policy,
    });
    assert.equal(result.verdict, 'indeterminate');
  }
});

test('extra unexpected inventory/results and wrong descriptor reject before calculation', () => {
  for (const mutate of [
    (source: any) => {
      source.comparison.results[0].caseId = 'unexpected';
    },
    (source: any) => {
      source.comparison.runtime.configRevision = 'wrong';
    },
    (source: any) => {
      source.comparison.evaluation = undefined;
    },
    (source: any) => {
      source.binding.comparisonId = 'wrong';
    },
    (source: any) => {
      source.binding.submitter = 'wrong';
    },
  ]) {
    const source = structuredClone(fixtures.vectors[0]);
    mutate(source);
    assert.throws(
      () =>
        checkComparison({
          comparison: source.comparison,
          expectedDescriptor: source.descriptor,
          expectedBinding: source.binding,
          policy: source.policy,
        }),
      PolicyError,
    );
  }
});

test('all generated diagnostics and verdict checks exclude arbitrary error strings and runtime values', () => {
  const source = structuredClone(fixtures.vectors[0]);
  source.comparison.results[0].candidate.error = 'secret-canary';
  source.comparison.results[0].candidate.outputRef = 'file:///private/secret-canary';
  source.comparison.runtime.privateName = 'secret-canary';
  source.descriptor.runtime.privateName = 'secret-canary';
  const result = checkComparison({
    comparison: source.comparison,
    expectedDescriptor: source.descriptor,
    expectedBinding: source.binding,
    policy: source.policy,
  });
  assert.ok(!JSON.stringify(result).includes('secret-canary'));
});
