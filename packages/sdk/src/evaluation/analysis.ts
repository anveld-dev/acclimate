import type { Comparison, EvaluationDescriptor } from '../types.js';
import { checkComparison, type ExpectedComparisonBinding } from './policy.js';

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
export interface PairedUncertainty {
  method: 'paired-within-case-bootstrap';
  estimand: 'fixed-cases';
  /** Retained application protocol describing collection, pairing and independence. */
  samplingProtocol: string;
  independentStochasticPairs: true;
  confidenceLevel: number;
  resamples: number;
  seed: number;
}
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
  };
}
export interface ComparisonAnalysis {
  schemaVersion: 1;
  interpretation: 'app-asserted-fixed-case-analysis';
  executionAttested: false;
  aggregation: 'equal-case-means';
  expectedBinding: AnalysisOptions['expectedBinding'];
  graderRevision: string;
  uncertaintyProtocol: PairedUncertainty | null;
  metrics: MetricAnalysis[];
}
export class AnalysisError extends Error {
  constructor(
    readonly code:
      | 'analysis.invalid_config'
      | 'analysis.invalid_observations'
      | 'analysis.identity_mismatch',
  ) {
    super(
      'The analysis configuration or component observation is invalid or does not match trusted evidence.',
    );
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
 * Default: descriptive scalar reward. Optional intervals condition on the fixed task
 * inventory and caller-declared independent stochastic paired repetitions. They are
 * approximate percentile bootstrap intervals, not population or causal evidence.
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
      !fields(protocol, [
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
      !string(protocol.samplingProtocol) ||
      protocol.independentStochasticPairs !== true ||
      !finite(protocol.confidenceLevel) ||
      protocol.confidenceLevel < 0.8 ||
      protocol.confidenceLevel > 0.99 ||
      !Number.isInteger(protocol.resamples) ||
      protocol.resamples < 100 ||
      protocol.resamples > 10000 ||
      !Number.isInteger(protocol.seed) ||
      protocol.seed < 0 ||
      protocol.seed > 0xffffffff)
  )
    fail('analysis.invalid_config');
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
    let comparable = 0,
      nonfinite = false;
    for (const row of ordered) {
      if (!groups.has(row.caseId)) groups.set(row.caseId, []);
      const pair = pairs.get(key(row.caseId, row.repetition));
      if (!pair) continue;
      const values = (['parent', 'candidate'] as const).map((side) => {
        const outcome = pair[side];
        if (
          outcome.executionStatus === 'infrastructure_failed' ||
          outcome.gradingStatus !== 'scored'
        )
          return null;
        if (!finite(outcome.reward)) {
          if (typeof outcome.reward === 'number') nonfinite = true;
          return null;
        }
        const value =
          metric.source === 'reward'
            ? outcome.reward
            : observed.get(key(row.caseId, row.repetition, side))?.values[metric.id];
        if (typeof value === 'number' && !Number.isFinite(value)) nonfinite = true;
        return finite(value) ? value : null;
      });
      if (values[0] !== null && values[1] !== null) {
        comparable++;
        groups.get(row.caseId)!.push({ parent: values[0], candidate: values[1] });
      }
    }
    const result: MetricAnalysis = {
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
      },
    };
    if (comparable !== ordered.length) return result;
    const direction = metric.direction === 'higher' ? 1 : -1;
    try {
      const differences: number[][] = [];
      for (const [caseId, rows] of groups) {
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
      result.summary = {
        parentMean: mean(result.cases.map((row) => row.parentMean)),
        candidateMean: mean(result.cases.map((row) => row.candidateMean)),
        orientedMeanImprovement: mean(result.cases.map((row) => row.orientedMeanImprovement)),
      };
      result.status = 'descriptive';
      result.code = 'analysis.descriptive';
      if (!protocol) return result;
      if (groups.size < 2 || differences.some((rows) => rows.length < 2)) {
        result.uncertainty = {
          status: 'insufficient_data',
          code: 'uncertainty.insufficient_repetitions',
          interval: null,
        };
        return result;
      }
      if (differences.every((rows) => rows.every((value) => value === rows[0]))) {
        result.uncertainty = {
          status: 'insufficient_data',
          code: 'uncertainty.no_observed_paired_variation',
          interval: null,
        };
        return result;
      }
      // Independent stream per metric: input metric ordering cannot change an interval.
      let state = protocol.seed;
      const draw = (length: number) => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return Math.floor((state / 4294967296) * length);
      };
      const draws: number[] = [];
      for (let i = 0; i < protocol.resamples; i++)
        draws.push(mean(differences.map((rows) => mean(rows.map(() => rows[draw(rows.length)])))));
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
            }
          : {
              status: 'estimated',
              code: 'uncertainty.approximate_fixed_case_interval',
              interval: { lower, upper },
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
      };
    }
    return result;
  });
  return {
    schemaVersion: 1,
    interpretation: 'app-asserted-fixed-case-analysis',
    executionAttested: false,
    aggregation: 'equal-case-means',
    expectedBinding: { ...binding },
    graderRevision: descriptor.graderRevision,
    uncertaintyProtocol: protocol ? { ...protocol } : null,
    metrics: results,
  };
}
