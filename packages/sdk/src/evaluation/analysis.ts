import type { Comparison, EvaluationDescriptor } from '../types.js';
import { EvaluationError } from './errors.js';
import { addGap, scalarGap, type EvidenceGaps } from './evidence-gaps.js';
import { checkComparison, type ExpectedComparisonBinding } from './policy.js';
import { studentTQuantile } from './student-t.js';

/** App assertions, not execution attestation. Nothing here releases or promotes a version. */
export interface AnalysisMetric {
  id: string;
  name: string;
  unit: string;
  direction: 'higher' | 'lower';
  source: 'reward' | 'component';
}
export interface ComponentObservation {
  requestId: string;
  attemptId: string;
  comparisonId: string;
  graderRevision: string;
  caseId: string;
  repetition: number;
  side: 'parent' | 'candidate';
  versionId: string;
  bundleDigest: string;
  values: Record<string, number | null>;
}
/**
 * "These tasks again": resample repetitions within each fixed case. The resampled deviation is
 * scaled by sqrt(r / (r - 1)) so the interval does not undercover; at least 3 repetitions.
 */
export interface FixedCaseBootstrap {
  method: 'paired-within-case-bootstrap';
  estimand: 'fixed-cases';
  /** Retained application protocol describing collection, pairing and independence. */
  samplingProtocol: string;
  independentStochasticPairs: true;
  confidenceLevel: number;
  resamples: number;
  seed: number;
}
/**
 * "Tasks like these": a two-sided Student t interval on case means, treating cases as a sample.
 * It answers the same question as the default policy test. At least 2 cases.
 */
export interface SampledCaseT {
  method: 'paired-t';
  estimand: 'sampled-cases';
  samplingProtocol: string;
  /** Two-sided level: 0.8, 0.9, 0.95 or 0.98. */
  confidenceLevel: 0.8 | 0.9 | 0.95 | 0.98;
}
export type PairedUncertainty = FixedCaseBootstrap | SampledCaseT;
/** One-sided quantile behind each supported two-sided t interval level. */
const twoSidedT = new Map([
  [0.8, 0.9],
  [0.9, 0.95],
  [0.95, 0.975],
  [0.98, 0.99],
] as const);
/** Minimum repetitions per case for the fixed-case bootstrap. */
export const minimumBootstrapRepetitions = 3;
export interface AnalysisComparisonBinding extends ExpectedComparisonBinding {
  comparisonId: string;
}
export interface AnalysisOptions {
  comparison: Comparison;
  expectedDescriptor: EvaluationDescriptor;
  expectedBinding: AnalysisComparisonBinding;
  metrics?: AnalysisMetric[];
  observations?: ComponentObservation[];
  uncertainty?: PairedUncertainty;
}
export interface MetricAnalysis {
  evidenceGaps?: EvidenceGaps;
  metric: AnalysisMetric;
  status: 'descriptive' | 'indeterminate';
  code: string;
  counts: {
    distinctCases: number;
    expectedPairs: number;
    comparablePairs: number;
    missingPairs: number;
  };
  summary: null | { parentMean: number; candidateMean: number; orientedMeanImprovement: number };
  cases: Array<{
    caseId: string;
    pairs: number;
    parentMean: number;
    candidateMean: number;
    orientedMeanImprovement: number;
  }>;
  uncertainty: {
    status: 'not_requested' | 'insufficient_data' | 'estimated' | 'indeterminate';
    code: string;
    interval: null | { lower: number; upper: number };
    /** `fixed-cases`: these tasks again. `sampled-cases`: tasks like these. */
    estimand: 'fixed-cases' | 'sampled-cases' | null;
  };
}
export interface ComparisonAnalysis {
  schemaVersion: 1;
  interpretation: 'app-asserted-fixed-case-analysis' | 'app-asserted-sampled-case-analysis';
  executionAttested: false;
  aggregation: 'equal-case-means';
  expectedBinding: AnalysisOptions['expectedBinding'];
  graderRevision: string;
  uncertaintyProtocol: PairedUncertainty | null;
  metrics: MetricAnalysis[];
}
export class AnalysisError extends EvaluationError {
  declare readonly code:
    | 'analysis.invalid_config'
    | 'analysis.invalid_observations'
    | 'analysis.identity_mismatch';
  constructor(
    code: 'analysis.invalid_config' | 'analysis.invalid_observations' | 'analysis.identity_mismatch',
  ) {
    super(code, {
      phase: 'policy',
      message:
        'The analysis configuration or component observation is invalid or does not match trusted evidence.',
    });
    this.name = 'AnalysisError';
  }
}
const encoder = new TextEncoder();
const record = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Object.values(Object.getOwnPropertyDescriptors(value)).every((item) => !item.get && !item.set);
const fields = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
const string = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  encoder.encode(value).length <= 1024 &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const fail = (code: ConstructorParameters<typeof AnalysisError>[0]): never => {
  throw new AnalysisError(code);
};
const utf8 = (a: string, b: string) => {
  const left = encoder.encode(a),
    right = encoder.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
};
const key = (caseId: string, repetition: number, side?: string) =>
  JSON.stringify([caseId, repetition, side ?? null]);
const arithmetic = (value: number) => {
  if (!Number.isFinite(value)) throw new RangeError();
  return value;
};
const mean = (values: number[]) => {
  let sum = 0;
  for (const value of values) sum = arithmetic(sum + value);
  return arithmetic(sum / values.length);
};

/**
 * Default: descriptive scalar reward. Optional intervals are labeled by question:
 * `paired-within-case-bootstrap` answers "these tasks again" (fixed cases, caller-declared
 * independent stochastic repetitions); `paired-t` answers "tasks like these" (cases sampled
 * from the tasks you care about), like the default policy test. Neither is causal evidence.
 */
export function analyzeComparison(options: AnalysisOptions): ComparisonAnalysis {
  const metrics = options.metrics ?? [
    { id: 'reward', name: 'Scalar reward', unit: 'reward', direction: 'higher', source: 'reward' },
  ];
  if (
    !Array.isArray(metrics) ||
    metrics.length < 1 ||
    metrics.length > 32 ||
    metrics.some(
      (metric) =>
        !record(metric) ||
        !fields(metric, ['id', 'name', 'unit', 'direction', 'source']) ||
        ![metric.id, metric.name, metric.unit].every(string) ||
        !['higher', 'lower'].includes(metric.direction) ||
        !['reward', 'component'].includes(metric.source),
    ) ||
    new Set(metrics.map((metric) => metric.id)).size !== metrics.length ||
    !record(options.expectedBinding) ||
    !string(options.expectedBinding.comparisonId)
  )
    fail('analysis.invalid_config');
  const protocol = options.uncertainty ?? undefined;
  if (
    protocol !== undefined &&
    (!record(protocol) ||
      !string(protocol.samplingProtocol) ||
      (protocol.method === 'paired-t'
        ? !fields(protocol, ['method', 'estimand', 'samplingProtocol', 'confidenceLevel']) ||
          protocol.estimand !== 'sampled-cases' ||
          !twoSidedT.has(protocol.confidenceLevel)
        : !fields(protocol, [
            'method',
            'estimand',
            'samplingProtocol',
            'independentStochasticPairs',
            'confidenceLevel',
            'resamples',
            'seed',
          ]) ||
          protocol.method !== 'paired-within-case-bootstrap' ||
          protocol.estimand !== 'fixed-cases' ||
          protocol.independentStochasticPairs !== true ||
          !finite(protocol.confidenceLevel) ||
          protocol.confidenceLevel < 0.8 ||
          protocol.confidenceLevel > 0.99 ||
          !Number.isInteger(protocol.resamples) ||
          protocol.resamples < 100 ||
          protocol.resamples > 10000 ||
          !Number.isInteger(protocol.seed) ||
          protocol.seed < 0 ||
          protocol.seed > 0xffffffff))
  )
    fail('analysis.invalid_config');
  const estimand = protocol?.estimand ?? null;
  // Reuse the supported strict descriptor, inventory, outcome and identity validation.
  // Its descriptive policy verdict is deliberately ignored; analysis never becomes a gate.
  checkComparison({
    ...options,
    policy: {
      schemaVersion: 1,
      id: 'analysis-validation',
      revision: '1',
      metric: { name: 'Scalar reward', unit: 'reward', direction: 'higher' },
      aggregation: 'equal-case-means',
      minimumMeanImprovement: 0,
      maximumCaseRegression: 0,
      requiredCases: [],
      inference: { method: 'none' },
    },
  });
  const { comparison, expectedDescriptor: descriptor, expectedBinding: binding } = options;
  const ordered = [...descriptor.expectedCases].sort(
    (a, b) => utf8(a.caseId, b.caseId) || a.repetition - b.repetition,
  );
  const expected = new Set(ordered.map((row) => key(row.caseId, row.repetition)));
  const pairs = new Map(comparison.results.map((row) => [key(row.caseId, row.repetition), row]));
  const observations = options.observations ?? [];
  const components = new Set(
    metrics.filter((metric) => metric.source === 'component').map((metric) => metric.id),
  );
  if (!Array.isArray(observations) || observations.length > ordered.length * 2)
    fail('analysis.invalid_observations');
  const observed = new Map<string, ComponentObservation>();
  for (const row of observations) {
    if (
      !record(row) ||
      !fields(row, [
        'requestId',
        'attemptId',
        'comparisonId',
        'graderRevision',
        'caseId',
        'repetition',
        'side',
        'versionId',
        'bundleDigest',
        'values',
      ]) ||
      !string(row.caseId) ||
      !Number.isInteger(row.repetition) ||
      !['parent', 'candidate'].includes(row.side) ||
      !expected.has(key(row.caseId, row.repetition)) ||
      !record(row.values) ||
      !Object.keys(row.values).length ||
      Object.entries(row.values).some(
        ([id, value]) => !components.has(id) || (value !== null && !finite(value)),
      )
    )
      fail('analysis.invalid_observations');
    if (
      row.requestId !== binding.requestId ||
      row.attemptId !== binding.attemptId ||
      row.comparisonId !== binding.comparisonId ||
      row.graderRevision !== descriptor.graderRevision ||
      row.versionId !== binding[row.side === 'parent' ? 'parentVersionId' : 'candidateVersionId'] ||
      row.bundleDigest !== binding[row.side === 'parent' ? 'parentDigest' : 'candidateDigest']
    )
      fail('analysis.identity_mismatch');
    const id = key(row.caseId, row.repetition, row.side);
    if (observed.has(id)) fail('analysis.invalid_observations');
    observed.set(id, row);
  }
  const results: MetricAnalysis[] = metrics.map((metric) => {
    const groups = new Map<string, Array<{ parent: number; candidate: number }>>();
    const incompleteCases = new Set<string>();
    const gaps: EvidenceGaps = { total: 0, rows: [] };
    let comparable = 0,
      nonfinite = false;
    for (const row of ordered) {
      if (!groups.has(row.caseId)) groups.set(row.caseId, []);
      const pair = pairs.get(key(row.caseId, row.repetition));
      const values = (['parent', 'candidate'] as const).map((side) => {
        const outcome = pair?.[side];
        const gap = scalarGap(outcome);
        if (gap || !outcome) {
          if (gap) addGap(gaps, row, side, ...gap);
          if (gap?.[1] === 'invalid_reward' && typeof outcome?.reward === 'number')
            nonfinite = true;
          return null;
        }
        const value =
          metric.source === 'reward'
            ? outcome.reward
            : observed.get(key(row.caseId, row.repetition, side))?.values[metric.id];
        if (typeof value === 'number' && !Number.isFinite(value)) nonfinite = true;
        if (finite(value)) return value;
        addGap(gaps, row, side, 'metric', 'missing_component');
        return null;
      });
      if (values[0] !== null && values[1] !== null) {
        comparable++;
        groups.get(row.caseId)!.push({ parent: values[0], candidate: values[1] });
      } else incompleteCases.add(row.caseId);
    }
    const result: MetricAnalysis = {
      ...(gaps.total ? { evidenceGaps: gaps } : {}),
      metric: { ...metric },
      status: 'indeterminate',
      code: nonfinite ? 'analysis.nonfinite' : 'evidence.incomplete',
      counts: {
        distinctCases: groups.size,
        expectedPairs: ordered.length,
        comparablePairs: comparable,
        missingPairs: ordered.length - comparable,
      },
      summary: null,
      cases: [],
      uncertainty: {
        status: protocol ? 'indeterminate' : 'not_requested',
        code: protocol ? 'evidence.incomplete' : 'uncertainty.not_requested',
        interval: null,
        estimand,
      },
    };
    const direction = metric.direction === 'higher' ? 1 : -1;
    try {
      const differences: number[][] = [];
      for (const [caseId, rows] of groups) {
        if (incompleteCases.has(caseId)) continue;
        const parentMean = mean(rows.map((row) => row.parent)),
          candidateMean = mean(rows.map((row) => row.candidate));
        result.cases.push({
          caseId,
          pairs: rows.length,
          parentMean,
          candidateMean,
          orientedMeanImprovement: arithmetic(direction * arithmetic(candidateMean - parentMean)),
        });
        differences.push(
          rows.map((row) => arithmetic(direction * arithmetic(row.candidate - row.parent))),
        );
      }
      if (comparable !== ordered.length) return result;
      result.summary = {
        parentMean: mean(result.cases.map((row) => row.parentMean)),
        candidateMean: mean(result.cases.map((row) => row.candidateMean)),
        orientedMeanImprovement: mean(result.cases.map((row) => row.orientedMeanImprovement)),
      };
      result.status = 'descriptive';
      result.code = 'analysis.descriptive';
      if (!protocol) return result;
      const insufficient = (code: string) => {
        result.uncertainty = { status: 'insufficient_data', code, interval: null, estimand };
        return result;
      };
      if (protocol.method === 'paired-t') {
        const means = result.cases.map((row) => row.orientedMeanImprovement);
        if (means.length < 2) return insufficient('uncertainty.insufficient_cases');
        if (means.every((value) => value === means[0]))
          return insufficient('uncertainty.no_observed_paired_variation');
        const center = result.summary.orientedMeanImprovement;
        let squares = 0;
        for (const value of means)
          squares = arithmetic(squares + arithmetic((value - center) * (value - center)));
        const halfWidth = arithmetic(
          (studentTQuantile(twoSidedT.get(protocol.confidenceLevel)!, means.length - 1) *
            Math.sqrt(squares / (means.length - 1))) /
            Math.sqrt(means.length),
        );
        result.uncertainty = {
          status: 'estimated',
          code: 'uncertainty.sampled_case_t_interval',
          interval: {
            lower: arithmetic(center - halfWidth),
            upper: arithmetic(center + halfWidth),
          },
          estimand,
        };
        return result;
      }
      if (groups.size < 2 || differences.some((rows) => rows.length < minimumBootstrapRepetitions))
        return insufficient('uncertainty.insufficient_repetitions');
      if (differences.every((rows) => rows.every((value) => value === rows[0])))
        return insufficient('uncertainty.no_observed_paired_variation');
      // Independent stream per metric: input metric ordering cannot change an interval.
      let state = protocol.seed;
      const draw = (length: number) => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return Math.floor((state / 4294967296) * length);
      };
      // Resampling r values understates the case-mean variance by (r - 1) / r. Scale each
      // resampled deviation from the case mean back up so intervals keep their coverage.
      const centers = differences.map((rows) => mean(rows));
      const factors = differences.map((rows) => Math.sqrt(rows.length / (rows.length - 1)));
      const draws: number[] = [];
      for (let i = 0; i < protocol.resamples; i++)
        draws.push(
          mean(
            differences.map((rows, index) =>
              arithmetic(
                centers[index] +
                  factors[index] * (mean(rows.map(() => rows[draw(rows.length)])) - centers[index]),
              ),
            ),
          ),
        );
      draws.sort((a, b) => a - b);
      const quantile = (p: number) => draws[Math.max(0, Math.ceil(p * draws.length) - 1)];
      const alpha = (1 - protocol.confidenceLevel) / 2;
      const lower = quantile(alpha),
        upper = quantile(1 - alpha);
      result.uncertainty =
        lower === upper
          ? {
              status: 'insufficient_data',
              code: 'uncertainty.degenerate_resamples',
              interval: null,
              estimand,
            }
          : {
              status: 'estimated',
              code: 'uncertainty.approximate_fixed_case_interval',
              interval: { lower, upper },
              estimand,
            };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      result.status = 'indeterminate';
      result.code = 'analysis.nonfinite';
      result.summary = null;
      result.cases = [];
      result.uncertainty = {
        status: protocol ? 'indeterminate' : 'not_requested',
        code: protocol ? 'analysis.nonfinite' : 'uncertainty.not_requested',
        interval: null,
        estimand,
      };
    }
    return result;
  });
  return {
    schemaVersion: 1,
    interpretation:
      estimand === 'sampled-cases'
        ? 'app-asserted-sampled-case-analysis'
        : 'app-asserted-fixed-case-analysis',
    executionAttested: false,
    aggregation: 'equal-case-means',
    expectedBinding: { ...binding },
    graderRevision: descriptor.graderRevision,
    uncertaintyProtocol: protocol ? { ...protocol } : null,
    metrics: results,
  };
}
