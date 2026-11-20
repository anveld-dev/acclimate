import type { Comparison, EvaluationDescriptor } from '../types.js';
import { validateEvaluationDescriptor } from '../validation.js';
import {
  checkComparison,
  resolveInference,
  validateEvaluationPolicy,
  type EvaluationPolicy,
} from './policy.js';
import { studentTQuantile } from './student-t.js';

/**
 * Plan an evaluation before running it: is the inventory large enough for the policy, what
 * effect can it detect, and how often does the policy pass when the candidate is no better?
 *
 * Nothing here runs an agent or a grader. The simulation feeds synthetic Bernoulli trials
 * through the same `checkComparison` used for real verdicts.
 */
export interface PlanOptions {
  policy: EvaluationPolicy;
  descriptor: EvaluationDescriptor;
  /**
   * An A/A comparison: the same version on both arms. Its case-mean differences estimate the
   * noise the policy will see. Without one, the plan assumes the worst case for binary rewards.
   */
  calibration?: Comparison;
  /** True mean differences to simulate, in reward units. Default: threshold, 0 and the MDE. */
  effects?: number[];
  /** Simulated comparisons per effect. Default 400, at most 5000. */
  simulations?: number;
  seed?: number;
}

export interface EvaluationPlan {
  schemaVersion: 1;
  method: 'paired-t' | 'none';
  confidence: number | null;
  threshold: number;
  cases: number;
  repetitions: number;
  minCases: number;
  minRepetitions: number;
  /** False when the inventory alone makes every verdict indeterminate. */
  sufficient: boolean;
  noise: {
    source: 'aa-calibration' | 'binary-worst-case';
    /** Standard deviation of case-mean differences used for planning. */
    sd: number;
    aaCases: number | null;
    /** Share of A/A cases whose arms disagreed. */
    aaFlipRate: number | null;
  };
  /** Smallest true effect with about 80% power: threshold + (t(conf) + t(0.80)) x sd / sqrt(n). */
  minimumDetectableEffect: number | null;
  simulation: {
    model: 'bernoulli-cases-uniform-0.2-0.8';
    runs: number;
    seed: number;
    results: Array<{ effect: number; passRate: number; indeterminateRate: number }>;
  };
  warnings: string[];
}

export class PlanError extends Error {
  constructor(readonly code: 'plan.invalid') {
    super('The plan options are invalid.');
    this.name = 'PlanError';
  }
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function calibrate(comparison: Comparison, direction: 1 | -1) {
  const cases = new Map<string, number[]>();
  for (const pair of comparison.results) {
    const usable = [pair.parent, pair.candidate].every(
      (outcome) => outcome.executionStatus !== 'infrastructure_failed' && finite(outcome.reward),
    );
    if (!usable) continue;
    const rows = cases.get(pair.caseId) ?? [];
    rows.push(direction * ((pair.candidate.reward as number) - (pair.parent.reward as number)));
    cases.set(pair.caseId, rows);
  }
  const means = [...cases.values()].map(
    (rows) => rows.reduce((sum, value) => sum + value, 0) / rows.length,
  );
  if (means.length < 2) throw new PlanError('plan.invalid');
  const center = means.reduce((sum, value) => sum + value, 0) / means.length;
  // Root mean square around zero: an A/A difference has true mean zero.
  const sd = Math.sqrt(means.reduce((sum, value) => sum + value * value, 0) / means.length);
  return {
    sd,
    cases: means.length,
    flipRate: means.filter((value) => value !== 0).length / means.length,
    center,
  };
}

export function planEvaluation(options: PlanOptions): EvaluationPlan {
  let descriptor: EvaluationDescriptor;
  try {
    descriptor = validateEvaluationDescriptor(options.descriptor);
  } catch {
    throw new PlanError('plan.invalid');
  }
  const policy = validateEvaluationPolicy(options.policy, descriptor);
  const simulations = options.simulations ?? 400;
  const seed = options.seed ?? 1;
  if (
    !Number.isInteger(simulations) ||
    simulations < 0 ||
    simulations > 5000 ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    (options.effects !== undefined &&
      (!Array.isArray(options.effects) ||
        options.effects.length > 16 ||
        !options.effects.every(
          (effect) =>
            finite(effect) &&
            Math.abs(effect) <=
              (policy.metric.scale ? policy.metric.scale.maximum - policy.metric.scale.minimum : 1),
        )))
  )
    throw new PlanError('plan.invalid');
  const settings = resolveInference(policy);
  const counts = new Map<string, number>();
  for (const { caseId } of descriptor.expectedCases)
    counts.set(caseId, (counts.get(caseId) ?? 0) + 1);
  const cases = counts.size;
  const repetitions = Math.min(...counts.values());
  const scale = policy.metric.scale ?? { minimum: 0, maximum: 1 };
  const width = scale.maximum - scale.minimum;
  const direction = policy.metric.direction === 'higher' ? 1 : -1;
  const threshold = policy.minimumMeanImprovement;
  const warnings: string[] = [];
  const aa = options.calibration ? calibrate(options.calibration, direction) : null;
  // Worst case for binary rewards: both arms at p = 0.5, per-trial difference variance 0.5.
  const sd = aa ? aa.sd : width * Math.sqrt(0.5 / repetitions);
  const statistical = settings.method === 'paired-t';
  const sufficient = cases >= settings.minCases && repetitions >= settings.minRepetitions;
  if (cases < settings.minCases)
    warnings.push(
      `The inventory has ${cases} cases; the policy needs at least ${settings.minCases}. Every verdict will be indeterminate.`,
    );
  if (repetitions < settings.minRepetitions)
    warnings.push(
      `Some cases have ${repetitions} repetition(s); the policy needs ${settings.minRepetitions}. Every verdict will be indeterminate.`,
    );
  else if (repetitions < 2)
    warnings.push(
      'Cases run once. Repetitions 2-3 separate run-to-run noise from real case differences and are required for the fixed-case bootstrap.',
    );
  const perCaseChecks = policy.perCaseChecks ?? 'protected-cases';
  if (
    perCaseChecks === 'all-cases' &&
    policy.maximumCaseRegression === 0 &&
    policy.maximumRegressedCases === undefined
  )
    warnings.push(
      'perCaseChecks is all-cases with maximumCaseRegression 0: one noisy case can fail the gate. Use protected-cases, a nonzero maximumCaseRegression or maximumRegressedCases.',
    );
  const protectedCases = new Set([
    ...policy.requiredCases,
    ...Object.keys(policy.protectedCaseThresholds ?? {}),
  ]);
  const caseLimits = (['maximumCandidateTaskFailures', 'maximumRegressedCases'] as const).filter(
    (name) => policy[name] !== undefined,
  );
  if (perCaseChecks === 'protected-cases' && protectedCases.size === 0 && caseLimits.length)
    warnings.push(
      `perCaseChecks is protected-cases and the policy protects no case, so ${caseLimits.join(' and ')} never fails. Declare requiredCases or protectedCaseThresholds, or set perCaseChecks to all-cases.`,
    );
  if (!statistical)
    warnings.push(
      'inference.method is none: the policy compares point estimates and its false-pass rate is not controlled.',
    );
  if (aa && Math.abs(aa.center) > (2 * aa.sd) / Math.sqrt(aa.cases))
    warnings.push(
      'The A/A comparison has a nonzero mean difference. Check that both arms ran the same version and grader.',
    );
  // Binary rewards span the scale, so the observed-range floor equals the scale floor.
  const floor = settings.sdFloor ?? 0.1 * width;
  const sdUsed = Math.max(sd, statistical ? floor : 0);
  const minimumDetectableEffect =
    statistical && cases >= 2
      ? threshold +
        ((studentTQuantile(settings.confidence, cases - 1) + studentTQuantile(0.8, cases - 1)) *
          sdUsed) /
          Math.sqrt(cases)
      : null;
  const effects = [
    ...new Set(
      options.effects ??
        [threshold, 0, minimumDetectableEffect].filter(
          (value): value is number => value !== null && Math.abs(value) <= width,
        ),
    ),
  ].sort((a, b) => a - b);
  // mulberry32: a plain LCG's serially correlated draws inflate the simulated false-pass rate.
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const ids = [...counts.keys()];
  const outcome = (success: boolean) => ({
    executionStatus: 'completed' as const,
    gradingStatus: 'scored' as const,
    reward: success === direction > 0 ? scale.maximum : scale.minimum,
    outputRef: null,
    error: null,
    usage: null,
  });
  const binding = {
    parentVersionId: 'plan-parent',
    candidateVersionId: 'plan-candidate',
    parentDigest: 'sha256:' + '0'.repeat(64),
    candidateDigest: 'sha256:' + '1'.repeat(64),
    requestId: 'plan-request',
    attemptId: 'plan-attempt',
  };
  const results = effects.map((effect) => {
    let passed = 0,
      indeterminate = 0;
    const shift = effect / width;
    for (let run = 0; run < simulations; run++) {
      const rows = ids.flatMap((caseId) => {
        const base = 0.2 + 0.6 * uniform();
        const better = Math.min(1, Math.max(0, base + shift));
        return Array.from({ length: counts.get(caseId)! }, (_, repetition) => ({
          caseId,
          repetition,
          parent: outcome(uniform() < base),
          candidate: outcome(uniform() < better),
        }));
      });
      const verdict = checkComparison({
        comparison: {
          id: 'plan-comparison',
          complete: true,
          submitter: 'plan',
          createdAt: '1970-01-01T00:00:00Z',
          parentVersionId: binding.parentVersionId,
          candidateVersionId: binding.candidateVersionId,
          parentDigest: binding.parentDigest,
          candidateDigest: binding.candidateDigest,
          datasetRevision: descriptor.datasetRevision,
          graderRevision: descriptor.graderRevision,
          runtime: descriptor.runtime,
          expectedCases: descriptor.expectedCases,
          results: rows,
          evaluation: { requestId: binding.requestId, attemptId: binding.attemptId },
        } as Comparison,
        expectedDescriptor: descriptor,
        expectedBinding: binding,
        policy,
      }).verdict;
      if (verdict === 'pass') passed++;
      else if (verdict === 'indeterminate') indeterminate++;
    }
    return {
      effect,
      passRate: simulations ? passed / simulations : 0,
      indeterminateRate: simulations ? indeterminate / simulations : 0,
    };
  });
  return {
    schemaVersion: 1,
    method: settings.method,
    confidence: statistical ? settings.confidence : null,
    threshold,
    cases,
    repetitions,
    minCases: settings.minCases,
    minRepetitions: settings.minRepetitions,
    sufficient,
    noise: {
      source: aa ? 'aa-calibration' : 'binary-worst-case',
      sd,
      aaCases: aa?.cases ?? null,
      aaFlipRate: aa?.flipRate ?? null,
    },
    minimumDetectableEffect,
    simulation: { model: 'bernoulli-cases-uniform-0.2-0.8', runs: simulations, seed, results },
    warnings,
  };
}
