// Monte Carlo calibration of the quality-policy test. Prints the Markdown table published in
// apps/docs/content/docs/concepts/methodology.mdx and examples/evaluation-starter/ANALYSIS.md.
//
//   node_modules/.bin/tsx scripts/evaluation/policy-calibration.ts [simulations]
//
// Each cell simulates comparisons with binary rewards: per-case success rates drawn from
// U(0.2, 0.8) and the candidate shifted by the true effect. Pass rates at effect 0 are the
// false-pass rate of a superiority threshold of 0. The per-case regression check is disabled
// (maximumCaseRegression: 1) so the table isolates the mean-difference test.
import { planEvaluation } from '../../packages/sdk/src/evaluation/plan.js';
import type { EvaluationPolicy } from '../../packages/sdk/src/evaluation/policy.js';

const simulations = Number(process.argv[2] ?? 2000);
const base: EvaluationPolicy = {
  schemaVersion: 1,
  id: 'calibration',
  revision: '1',
  metric: { name: 'reward', unit: 'reward', direction: 'higher' },
  aggregation: 'equal-case-means',
  minimumMeanImprovement: 0,
  maximumCaseRegression: 1,
  requiredCases: [],
};
const policies: Array<[string, EvaluationPolicy]> = [
  ['paired-t 95% (default)', base],
  ['point estimate (method none)', { ...base, inference: { method: 'none' } }],
];
const cells = [
  [5, 1],
  [10, 1],
  [10, 3],
  [30, 1],
  [30, 3],
  [60, 3],
];
const effects = [0, 0.05, 0.1];
const percent = (value: number) => (value * 100).toFixed(1) + '%';
console.log(
  `| Policy | Cases × reps | Δ = 0 (false pass) | Δ = +0.05 | Δ = +0.10 | Indeterminate |`,
);
console.log(`| --- | --- | --- | --- | --- | --- |`);
for (const [label, policy] of policies)
  for (const [cases, repetitions] of cells) {
    const plan = planEvaluation({
      policy,
      descriptor: {
        datasetRevision: 'calibration',
        graderRevision: 'calibration',
        runtime: { configId: 'calibration', configRevision: '1' },
        expectedCases: Array.from({ length: cases * repetitions }, (_, index) => ({
          caseId: `case-${Math.floor(index / repetitions)}`,
          repetition: index % repetitions,
        })),
      },
      effects,
      simulations,
      seed: 20261119,
    });
    const rates = plan.simulation.results.map((row) => percent(row.passRate));
    const indeterminate = Math.max(...plan.simulation.results.map((row) => row.indeterminateRate));
    console.log(
      `| ${label} | ${cases} × ${repetitions} | ${rates.join(' | ')} | ${percent(indeterminate)} |`,
    );
  }
