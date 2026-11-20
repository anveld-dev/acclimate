import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { planEvaluation } from '../../src/evaluation/plan.js';
import type { EvaluationPolicy } from '../../src/evaluation/policy.js';

const policy: EvaluationPolicy = {
  schemaVersion: 1,
  id: 'quality',
  revision: '1',
  metric: { name: 'reward', unit: 'reward', direction: 'higher' },
  aggregation: 'equal-case-means',
  minimumMeanImprovement: 0,
  maximumCaseRegression: 1,
  requiredCases: [],
};
const descriptor = (cases: number, repetitions: number) => ({
  datasetRevision: 'cases-1',
  graderRevision: 'grader-1',
  runtime: { configId: 'app', configRevision: '1' },
  expectedCases: Array.from({ length: cases * repetitions }, (_, index) => ({
    caseId: `case-${Math.floor(index / repetitions)}`,
    repetition: index % repetitions,
  })),
});

test('the default policy passes no more than the nominal 5% when the candidate is no better', () => {
  // 400 simulated A/A comparisons through checkComparison: 12 cases x 2 repetitions, binary
  // rewards with per-case success rates drawn from U(0.2, 0.8). Three Monte Carlo SEs of slack.
  const plan = planEvaluation({
    policy,
    descriptor: descriptor(12, 2),
    effects: [0, 0.3],
    simulations: 400,
    seed: 20261119,
  });
  const [none, large] = plan.simulation.results;
  assert.equal(none.effect, 0);
  assert.ok(none.passRate <= 0.05 + 3 * Math.sqrt((0.05 * 0.95) / 400), `${none.passRate}`);
  assert.equal(none.indeterminateRate, 0);
  assert.ok(large.passRate > 0.5, `${large.passRate}`);
});

test('too few cases make every simulated verdict indeterminate and the plan says so', () => {
  const plan = planEvaluation({ policy, descriptor: descriptor(5, 1), simulations: 20 });
  assert.equal(plan.sufficient, false);
  assert.ok(plan.simulation.results.every((row) => row.indeterminateRate === 1));
  assert.match(plan.warnings.join('\n'), /needs at least 10/);
  assert.match(plan.warnings.join('\n'), /1 repetition\(s\); the policy needs 2/);
  const once = planEvaluation({
    policy: { ...policy, inference: { method: 'paired-t', minRepetitions: 1 } },
    descriptor: descriptor(12, 1),
    simulations: 0,
  });
  assert.equal(once.sufficient, true);
  assert.match(once.warnings.join('\n'), /Cases run once/);
});

test('the shared plan vectors match', () => {
  const vectors = JSON.parse(
    readFileSync(
      new URL(
        '../../../../contracts/fixtures/evaluation-policy/plan-vectors.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  for (const vector of vectors.vectors)
    assert.deepEqual(planEvaluation(vector.options), vector.expected, vector.name);
});

test('the plan warns about per-case checks that are too strict or check nothing', () => {
  const warnings = (patch: Partial<EvaluationPolicy>) =>
    planEvaluation({
      policy: { ...policy, ...patch } as EvaluationPolicy,
      descriptor: descriptor(12, 2),
      simulations: 0,
    }).warnings.join('\n');
  assert.match(
    warnings({ perCaseChecks: 'all-cases', maximumCaseRegression: 0 }),
    /one noisy case can fail the gate/,
  );
  assert.doesNotMatch(warnings({ maximumCaseRegression: 0 }), /noisy case/);
  assert.doesNotMatch(
    warnings({ perCaseChecks: 'all-cases', maximumCaseRegression: 0, maximumRegressedCases: 1 }),
    /noisy case/,
  );
  assert.match(
    warnings({ maximumCandidateTaskFailures: 0 }),
    /protects no case, so maximumCandidateTaskFailures never fails/,
  );
  assert.doesNotMatch(
    warnings({ maximumCandidateTaskFailures: 0, requiredCases: ['case-0'] }),
    /protects no case/,
  );
});

test('minimum detectable effect follows the declared confidence and an A/A calibration', () => {
  const worst = planEvaluation({ policy, descriptor: descriptor(30, 2), simulations: 0 });
  // threshold + (t(0.95, 29) + t(0.80, 29)) * sqrt(0.5 / 2) / sqrt(30)
  assert.ok(
    Math.abs(
      worst.minimumDetectableEffect! - ((1.699127026533 + 0.854191985882) * 0.5) / Math.sqrt(30),
    ) < 1e-12,
  );
  const strict = planEvaluation({
    policy: { ...policy, inference: { method: 'paired-t', confidence: 0.99 } },
    descriptor: descriptor(30, 2),
    simulations: 0,
  });
  assert.ok(strict.minimumDetectableEffect! > worst.minimumDetectableEffect!);
  const outcome = (reward: number) => ({
    executionStatus: 'completed' as const,
    gradingStatus: 'scored' as const,
    reward,
    outputRef: null,
    error: null,
    usage: null,
  });
  const calibration = {
    results: descriptor(30, 2).expectedCases.map(({ caseId, repetition }, index) => ({
      caseId,
      repetition,
      parent: outcome(1),
      candidate: outcome(index % 8 === 0 ? 0 : 1),
    })),
  } as any;
  const calibrated = planEvaluation({
    policy,
    descriptor: descriptor(30, 2),
    calibration,
    simulations: 0,
  });
  assert.equal(calibrated.noise.source, 'aa-calibration');
  assert.equal(calibrated.noise.aaCases, 30);
  assert.ok(calibrated.noise.sd < worst.noise.sd);
  assert.ok(calibrated.minimumDetectableEffect! < worst.minimumDetectableEffect!);
});
