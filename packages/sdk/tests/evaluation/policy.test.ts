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

const selectionPolicies = JSON.parse(
  readFileSync(
    new URL('../../../../contracts/fixtures/connected-selection-policy.json', import.meta.url),
    'utf8',
  ),
);
for (const { name, policy, valid } of selectionPolicies.cases) {
  test(`connected selection policy conformance: ${name}`, () => {
    const parse = () => parseEvaluationPolicy(JSON.stringify(policy), selectionPolicies.descriptor);
    if (valid) {
      const parsed = parse().policy;
      for (const field of [
        'protectedCaseThresholds',
        'minimumRepetitionsPerCase',
        'minimumCostSavingsUsd',
      ] as const)
        assert.deepEqual(parsed[field], policy[field] ?? undefined);
    } else {
      assert.throws(parse, PolicyError);
    }
  });
}

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
  assert.equal(incomplete.verdict, 'fail');
  assert.equal(incomplete.evidenceGaps?.rows[0].reason, 'missing_cost');
  assert.ok(incomplete.checks.some((item) => item.result === 'fail'));
  assert.ok(incomplete.checks.some((item) => item.result === 'unknown'));
});

test('missing pairs report bounded public arm diagnostics', () => {
  const source = structuredClone(fixtures.vectors[0]);
  const keys = Array.from({ length: 20 }, (_, repetition) => ({ caseId: 'ordinary', repetition }));
  source.descriptor.expectedCases = source.comparison.expectedCases = keys;
  source.comparison.results = [];
  const result = checkComparison({
    comparison: source.comparison,
    expectedDescriptor: source.descriptor,
    expectedBinding: source.binding,
    policy: source.policy,
  });
  assert.equal(result.evidenceGaps?.total, 40);
  assert.equal(result.evidenceGaps?.rows.length, 32);
  assert.deepEqual(result.evidenceGaps?.rows[0], {
    caseId: 'ordinary',
    repetition: 0,
    side: 'parent',
    stage: 'collection',
    reason: 'missing_pair',
  });
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

const confidence = JSON.parse(
  readFileSync(
    new URL('../../../../contracts/fixtures/connected-confidence-decisions.json', import.meta.url),
    'utf8',
  ),
);
for (const decision of confidence) {
  test(`shared confidence decision: ${decision.name}`, () => {
    const { comparison, binding, descriptor, policy } = structuredClone(fixtures.vectors[0]);
    const template = comparison.results[0];
    const offset = decision.rewardOffset ?? 0;
    comparison.results = decision.gains.flatMap((gain: number, index: number) =>
      Array.from({ length: decision.evaluationRepetitions ?? 1 }, (_, repetition) => ({
        ...template,
        repetition,
        caseId: String(index),
        parent: {
          ...template.parent,
          reward: decision.missingParent?.includes(index) ? null : offset + Math.max(0, -gain),
          ...(decision.missingParent?.includes(index) && { gradingStatus: 'missing' }),
        },
        candidate: {
          ...template.candidate,
          reward: decision.missingParent?.includes(index)
            ? 1
            : decision.missingCandidate?.includes(index)
              ? null
              : offset + Math.max(0, gain),
          ...(decision.missingCandidate?.includes(index) && { gradingStatus: 'missing' }),
        },
      })),
    );
    descriptor.expectedCases = comparison.results.map(
      ({ caseId, repetition }: { caseId: string; repetition: number }) => ({ caseId, repetition }),
    );
    comparison.expectedCases = descriptor.expectedCases;
    const result = checkComparison({
      comparison,
      expectedBinding: binding,
      expectedDescriptor: descriptor,
      policy: {
        ...policy,
        schemaVersion: decision.schemaVersion ?? 2,
        auditMode: decision.auditMode,
        nonInferiorityMargin: decision.nonInferiorityMargin,
      },
      replayPassed: decision.replayPassed,
      stage: decision.stage,
      calibratedStandardDeviation: decision.calibratedStandardDeviation,
      calibrationEffectiveRepetitions: decision.calibrationEffectiveRepetitions,
    });
    assert.equal(result.verdict === 'pass', decision.pass);
  });
}
