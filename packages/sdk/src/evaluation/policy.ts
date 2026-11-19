import { isConfidenceLevel, studentTQuantile, type ConfidenceLevel } from './student-t.js';
import type { Comparison, EvaluationDescriptor } from '../types.js';
import { addGap, scalarGap, type EvidenceGaps } from './evidence-gaps.js';
import { validateEvaluationDescriptor, evaluationDescriptorDifferences } from '../validation.js';

/**
 * How the policy turns paired case means into a decision.
 *
 * `paired-t` (the default) treats the cases as a sample from the tasks you care about and
 * requires a one-sided Student t lower confidence bound on the equal-case mean difference to
 * clear the threshold. `none` compares point estimates for these exact cases and has no noise
 * model; use it only for deterministic graders or fixture tests.
 */
export interface PolicyInference {
  method: 'paired-t' | 'none';
  /** One-sided confidence level for the lower bound. Default 0.95. paired-t only. */
  confidence?: ConfidenceLevel;
  /** Fewer distinct cases make the verdict indeterminate. Default 10 (paired-t) or 1 (none). */
  minCases?: number;
  /** Fewer planned repetitions for any case make the verdict indeterminate. Default 1. */
  minRepetitions?: number;
  /** Lower limit on the case-difference standard deviation. Default 0.1 x reward-scale width. */
  sdFloor?: number;
  /** Missing or infrastructure-failed trials allowed per arm before evidence is incomplete. */
  maximumMissingPercent?: number;
}

export interface PolicyMetric {
  name: string;
  unit: string;
  direction: 'higher' | 'lower';
  /** Declared reward range. Scored rewards outside it are invalid evidence. */
  scale?: { minimum: number; maximum: number };
}

/** Pure policy calculation. It neither fetches nor authenticates evidence. */
export interface EvaluationPolicyV1 {
  schemaVersion: 1;
  id: string;
  revision: string;
  metric: PolicyMetric;
  aggregation: 'equal-case-means';
  /** Threshold for the lower confidence bound (or the point estimate when method is none). */
  minimumMeanImprovement: number;
  maximumCaseRegression: number;
  candidateThreshold?: number;
  requiredCases: string[];
  maximumCandidateTaskFailures?: number;
  cost?: { maximumCandidateUsd?: number; maximumIncreaseUsd?: number };
  /** Each matching candidate repetition must meet its oriented reward threshold. */
  protectedCaseThresholds?: Record<string, number>;
  /** Savings threshold across the full paired inventory. In v3 this can establish step benefit. */
  minimumCostSavingsUsd?: number;
  /** Minimum paired repetitions required for every case in the stage inventory. */
  minimumRepetitionsPerCase?: number;
  /** Statistical method and data requirements. Omitted means the paired-t defaults. */
  inference?: PolicyInference;
  /**
   * Cases covered by the per-case regression and task-failure checks. Default `all-cases` in every
   * schema version. `protected-cases` limits them to required and threshold-protected cases.
   */
  perCaseChecks?: 'all-cases' | 'protected-cases';
}

export interface EvaluationPolicyV2 extends Omit<EvaluationPolicyV1, 'schemaVersion'> {
  schemaVersion: 2;
  nonInferiorityMargin?: number;
}

export interface EvaluationPolicyV3 extends Omit<EvaluationPolicyV2, 'schemaVersion'> {
  schemaVersion: 3;
  stepMargin?: number;
  auditMode?: 'non-inferiority' | 'superiority';
  targetEffect?: number;
}

export type EvaluationPolicy = EvaluationPolicyV1 | EvaluationPolicyV2 | EvaluationPolicyV3;

/** Policy ids used by the service's connected-learning defaults. General policies cannot use them. */
/**
 * The explicit settings the service's connected-learning default policies declare. Development
 * and cumulative checks use a 90% bound; audits use 95%. Both rely on the A/A calibration floor
 * passed at check time instead of a fixed SD floor.
 */
export const connectedPolicyDefaults = {
  development: {
    inference: {
      method: 'paired-t',
      confidence: 0.9,
      minCases: 2,
      minRepetitions: 1,
      sdFloor: 0,
      maximumMissingPercent: 15,
    },
    perCaseChecks: 'protected-cases',
    scale: { minimum: 0, maximum: 1 },
  },
  audit: {
    inference: {
      method: 'paired-t',
      confidence: 0.95,
      minCases: 2,
      minRepetitions: 1,
      sdFloor: 0,
      maximumMissingPercent: 15,
    },
    perCaseChecks: 'protected-cases',
    scale: { minimum: 0, maximum: 1 },
  },
} as const satisfies Record<
  'development' | 'audit',
  {
    inference: PolicyInference;
    perCaseChecks: 'protected-cases';
    scale: { minimum: number; maximum: number };
  }
>;

export const reservedPolicyIds = ['connected-development', 'connected-audit'] as const;

/** Inference settings applied when a policy omits a field. */
export const defaultInference = {
  method: 'paired-t',
  confidence: 0.95,
  minCases: 10,
  minRepetitions: 1,
  sdFloorScaleFraction: 0.1,
  maximumMissingPercent: 15,
} as const;

export interface ExpectedComparisonBinding {
  parentVersionId: string;
  candidateVersionId: string;
  parentDigest: string;
  candidateDigest: string;
  requestId: string;
  attemptId: string;
  comparisonId?: string;
  submitter?: string;
}

/** The statistics behind the mean-difference decision. Every field is reported, even when null. */
export interface PolicyInferenceResult {
  method: 'paired-t' | 'none';
  /**
   * `sampled-cases`: would the change hold on tasks like these (cases are a sample)?
   * `observed-cases`: what happened on these exact tasks (no generalization claim)?
   */
  estimand: 'sampled-cases' | 'observed-cases';
  status: 'estimated' | 'insufficient_data' | 'incomplete' | 'not_applicable';
  stage: 'general' | 'development' | 'cumulative' | 'audit';
  /** The check this statistic decides, for example `policy.minimum_mean_improvement`. */
  check: string;
  confidence: number | null;
  /** Effective threshold the lower bound (or point estimate for `none`) must clear. */
  threshold: number;
  thresholdSource: 'minimumMeanImprovement' | 'stepMargin' | 'nonInferiorityMargin';
  /** Distinct cases and the minimums that make the evidence sufficient. */
  n: number;
  minCases: number;
  minRepetitions: number;
  /** Smallest planned repetitions for any case. */
  repetitions: number;
  meanDifference: number | null;
  /** Observed standard deviation of the oriented case differences. */
  sd: number | null;
  sdFloor: number | null;
  sdFloorSource: 'declared' | 'scale' | 'observed-range' | null;
  /** Calibrated standard deviation supplied by connected learning, after repetition scaling. */
  calibratedSd: number | null;
  /** max(sd, sdFloor, calibratedSd), the value used in the standard error. */
  sdUsed: number | null;
  standardError: number | null;
  df: number | null;
  criticalValue: number | null;
  lowerBound: number | null;
  /** Missing trials replaced by the worst (candidate) or best (parent) observed reward. */
  imputed: { parent: number; candidate: number };
  maximumMissingPercent: number;
}

export interface PolicyVerdict {
  evidenceGaps?: EvidenceGaps;
  schemaVersion: 1;
  verdict: 'pass' | 'fail' | 'indeterminate';
  code: string;
  policy: { id: string; revision: string; sha256: string | null };
  comparisonId: string;
  expectedBinding: ExpectedComparisonBinding;
  checks: Array<{ code: string; result: 'pass' | 'fail' | 'unknown' }>;
  counts: { distinctCases: number; expectedPairs: number; comparablePairs: number };
  summary: {
    parentMean: number | null;
    candidateMean: number | null;
    orientedMeanImprovement: number | null;
    /** Largest oriented case regression over all cases. */
    worstCaseRegression: number | null;
    /** Candidate task failures over all cases (task failed, infrastructure failed or unscored). */
    candidateTaskFailures: number;
    /** The same count for required and threshold-protected cases only. */
    protectedCandidateTaskFailures: number;
    parentTaskFailures: number;
    parentCostUsd: number | null;
    candidateCostUsd: number | null;
    costIncreaseUsd: number | null;
    parentUnknownCosts: number;
    candidateUnknownCosts: number;
  };
  perCaseChecks: 'all-cases' | 'protected-cases';
  inference: PolicyInferenceResult;
  interpretation: 'descriptive-policy-check' | 'statistical-policy-check';
}

const requiredPolicyFields = [
  'schemaVersion',
  'id',
  'revision',
  'metric',
  'aggregation',
  'minimumMeanImprovement',
  'maximumCaseRegression',
  'requiredCases',
];
const requiredMetricFields = ['name', 'unit', 'direction'];
const publicPolicyFields = new Set([
  ...requiredPolicyFields,
  ...requiredMetricFields.map((name) => 'metric.' + name),
]);

type PolicyErrorCode =
  | 'policy.invalid'
  | 'policy.inventory_incompatible'
  | 'evidence.identity_mismatch'
  | 'evidence.malformed'
  | 'evidence.reward_out_of_range';
export class PolicyError extends Error {
  readonly phase = 'policy';
  readonly executionState = 'finished';
  readonly nextAction = 'fix_config';
  readonly diagnostic: {
    code: PolicyErrorCode;
    phase: 'policy';
    executionState: 'finished';
    nextAction: 'fix_config';
    missingFields?: string[];
  };
  constructor(
    readonly code: PolicyErrorCode,
    missingFields: string[] = [],
  ) {
    super(
      code === 'policy.inventory_incompatible'
        ? 'The policy requires cases absent from the trusted evaluation inventory.'
        : code === 'policy.invalid'
          ? 'The evaluation policy or trusted inventory is invalid.'
          : code === 'evidence.identity_mismatch'
            ? 'The comparison does not match the expected evaluation identity.'
            : code === 'evidence.reward_out_of_range'
              ? 'A scored reward is outside the reward scale declared by the policy.'
              : 'The comparison evidence is malformed.',
    );
    this.name = 'PolicyError';
    this.diagnostic = {
      code,
      phase: 'policy',
      executionState: 'finished',
      nextAction: 'fix_config',
      ...(missingFields.length && {
        missingFields: missingFields.filter((field) => publicPolicyFields.has(field)),
      }),
    };
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => !entry.get && !entry.set);
const encoder = new TextEncoder();
const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  encoder.encode(value).length <= max &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const string = (value: unknown, max = 1024): value is string =>
  boundedString(value, max) && !!value.trim();
const policyString = (value: unknown, max = 1024): value is string =>
  boundedString(value, max) && /[^\p{White_Space}]/u.test(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const fields = (value: Record<string, unknown>, allowed: string[], required: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(value, key));
const own = (value: object, name: string) => Object.hasOwn(value, name);
function invalid(): never {
  throw new PolicyError('policy.invalid');
}

const integerIn = (value: unknown, minimum: number, maximum: number): value is number =>
  Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;

function validateInference(value: unknown): PolicyInference {
  if (
    !record(value) ||
    !fields(
      value,
      ['method', 'confidence', 'minCases', 'minRepetitions', 'sdFloor', 'maximumMissingPercent'],
      ['method'],
    ) ||
    (value.method !== 'paired-t' && value.method !== 'none') ||
    (value.method === 'none' && (own(value, 'confidence') || own(value, 'sdFloor'))) ||
    (own(value, 'confidence') && !isConfidenceLevel(value.confidence)) ||
    (own(value, 'minCases') &&
      !integerIn(value.minCases, value.method === 'paired-t' ? 2 : 1, 1000)) ||
    (own(value, 'minRepetitions') && !integerIn(value.minRepetitions, 1, 1000)) ||
    (own(value, 'sdFloor') && !nonnegative(value.sdFloor)) ||
    (own(value, 'maximumMissingPercent') && !integerIn(value.maximumMissingPercent, 0, 50))
  )
    invalid();
  return {
    method: value.method,
    ...(own(value, 'confidence') && { confidence: value.confidence as ConfidenceLevel }),
    ...(own(value, 'minCases') && { minCases: value.minCases as number }),
    ...(own(value, 'minRepetitions') && { minRepetitions: value.minRepetitions as number }),
    ...(own(value, 'sdFloor') && { sdFloor: value.sdFloor as number }),
    ...(own(value, 'maximumMissingPercent') && {
      maximumMissingPercent: value.maximumMissingPercent as number,
    }),
  };
}

export interface PolicyValidationOptions {
  /**
   * Accept the service's reserved connected-learning ids. Only offline checks of a connected
   * selection policy need this; the id never changes how the policy is evaluated.
   */
  connected?: boolean;
}

export function validateEvaluationPolicy(
  value: unknown,
  expectedDescriptor?: EvaluationDescriptor,
  options: PolicyValidationOptions = {},
): EvaluationPolicy {
  if (!record(value)) invalid();
  const missing = requiredPolicyFields.filter((key) => !own(value, key));
  const metric = value.metric;
  if (record(metric)) {
    for (const key of requiredMetricFields) if (!own(metric, key)) missing.push('metric.' + key);
  }
  if (missing.length) throw new PolicyError('policy.invalid', missing);
  if (
    !fields(
      value,
      [
        ...requiredPolicyFields,
        'candidateThreshold',
        'maximumCandidateTaskFailures',
        'cost',
        'protectedCaseThresholds',
        'minimumCostSavingsUsd',
        'minimumRepetitionsPerCase',
        'nonInferiorityMargin',
        'stepMargin',
        'auditMode',
        'targetEffect',
        'inference',
        'perCaseChecks',
      ],
      [],
    ) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) ||
    [value.stepMargin, value.targetEffect].some(
      (entry) => entry != null && (value.schemaVersion !== 3 || !nonnegative(entry) || entry > 1),
    ) ||
    (value.auditMode != null &&
      (value.schemaVersion !== 3 ||
        (value.auditMode !== 'non-inferiority' && value.auditMode !== 'superiority'))) ||
    (value.nonInferiorityMargin != null &&
      (value.schemaVersion === 1 || !nonnegative(value.nonInferiorityMargin))) ||
    !policyString(value.id, 128) ||
    (!options.connected && (reservedPolicyIds as readonly unknown[]).includes(value.id)) ||
    !policyString(value.revision) ||
    value.aggregation !== 'equal-case-means' ||
    !finite(value.minimumMeanImprovement) ||
    !nonnegative(value.maximumCaseRegression) ||
    !record(metric) ||
    !fields(metric, [...requiredMetricFields, 'scale'], []) ||
    !policyString(metric.name, 128) ||
    !policyString(metric.unit, 128) ||
    !['higher', 'lower'].includes(metric.direction as string) ||
    (own(metric, 'scale') &&
      (!record(metric.scale) ||
        !fields(metric.scale, ['minimum', 'maximum'], ['minimum', 'maximum']) ||
        !finite(metric.scale.minimum) ||
        !finite(metric.scale.maximum) ||
        !(metric.scale.maximum > metric.scale.minimum) ||
        !Number.isFinite(metric.scale.maximum - metric.scale.minimum))) ||
    (value.perCaseChecks != null &&
      value.perCaseChecks !== 'all-cases' &&
      value.perCaseChecks !== 'protected-cases') ||
    !Array.isArray(value.requiredCases) ||
    value.requiredCases.length > 1000 ||
    value.requiredCases.some((caseId) => !policyString(caseId)) ||
    new Set(value.requiredCases).size !== value.requiredCases.length ||
    (value.candidateThreshold != null && !finite(value.candidateThreshold)) ||
    (value.maximumCandidateTaskFailures != null &&
      (!Number.isSafeInteger(value.maximumCandidateTaskFailures) ||
        (value.maximumCandidateTaskFailures as number) < 0)) ||
    (value.minimumCostSavingsUsd != null && !nonnegative(value.minimumCostSavingsUsd)) ||
    (value.minimumRepetitionsPerCase != null &&
      (!nonnegative(value.minimumRepetitionsPerCase) ||
        !Number.isInteger(value.minimumRepetitionsPerCase) ||
        value.minimumRepetitionsPerCase < 1 ||
        value.minimumRepetitionsPerCase > 1000))
  )
    invalid();
  const inference = value.inference != null ? validateInference(value.inference) : undefined;
  let cost: EvaluationPolicyV1['cost'];
  if (value.cost != null) {
    if (
      !record(value.cost) ||
      !Object.values(value.cost).some(nonnegative) ||
      !fields(value.cost, ['maximumCandidateUsd', 'maximumIncreaseUsd'], []) ||
      Object.values(value.cost).some((item) => item != null && !nonnegative(item))
    )
      invalid();
    cost = Object.fromEntries(Object.entries(value.cost).filter(([, amount]) => amount != null));
  }
  let protectedCaseThresholds: EvaluationPolicyV1['protectedCaseThresholds'];
  if (own(value, 'protectedCaseThresholds')) {
    const thresholds = value.protectedCaseThresholds;
    if (!record(thresholds)) invalid();
    const entries = Object.entries(thresholds);
    if (
      entries.length > 1000 ||
      entries.some(([id, threshold]) => !policyString(id) || !finite(threshold))
    )
      invalid();
    protectedCaseThresholds = { ...thresholds } as Record<string, number>;
  }
  const minimumRepetitions = value.minimumRepetitionsPerCase;
  if (expectedDescriptor !== undefined) {
    let descriptor: EvaluationDescriptor;
    try {
      descriptor = validateEvaluationDescriptor(expectedDescriptor);
    } catch {
      return invalid();
    }
    const counts = new Map<string, number>();
    for (const { caseId } of descriptor.expectedCases)
      counts.set(caseId, (counts.get(caseId) ?? 0) + 1);
    if (
      [...value.requiredCases, ...Object.keys(protectedCaseThresholds ?? {})].some(
        (caseId) => !counts.has(caseId),
      ) ||
      (typeof minimumRepetitions === 'number' &&
        [...counts.values()].some((count) => count < minimumRepetitions))
    )
      throw new PolicyError('policy.inventory_incompatible');
  }
  const scale = record(metric.scale)
    ? { minimum: metric.scale.minimum as number, maximum: metric.scale.maximum as number }
    : undefined;
  return {
    ...(value.schemaVersion !== 1
      ? {
          schemaVersion: value.schemaVersion,
          ...(value.schemaVersion === 3 && {
            ...(typeof value.stepMargin === 'number' && { stepMargin: value.stepMargin }),
            ...(typeof value.targetEffect === 'number' && { targetEffect: value.targetEffect }),
            ...(value.auditMode != null && {
              auditMode: value.auditMode as EvaluationPolicyV3['auditMode'],
            }),
          }),
          ...(typeof value.nonInferiorityMargin === 'number'
            ? { nonInferiorityMargin: value.nonInferiorityMargin }
            : {}),
        }
      : { schemaVersion: 1 as const }),
    id: value.id as string,
    revision: value.revision as string,
    metric: {
      name: metric.name as string,
      unit: metric.unit as string,
      direction: metric.direction as 'higher' | 'lower',
      ...(scale && { scale }),
    },
    aggregation: 'equal-case-means',
    minimumMeanImprovement: value.minimumMeanImprovement as number,
    maximumCaseRegression: value.maximumCaseRegression as number,
    requiredCases: [...(value.requiredCases as string[])],
    ...(value.candidateThreshold != null
      ? { candidateThreshold: value.candidateThreshold as number }
      : {}),
    ...(value.maximumCandidateTaskFailures != null
      ? { maximumCandidateTaskFailures: value.maximumCandidateTaskFailures as number }
      : {}),
    ...(cost ? { cost } : {}),
    ...(protectedCaseThresholds && Object.keys(protectedCaseThresholds).length
      ? { protectedCaseThresholds }
      : {}),
    ...(typeof value.minimumCostSavingsUsd === 'number'
      ? { minimumCostSavingsUsd: value.minimumCostSavingsUsd }
      : {}),
    ...(typeof minimumRepetitions === 'number'
      ? { minimumRepetitionsPerCase: minimumRepetitions }
      : {}),
    ...(inference && { inference }),
    ...(value.perCaseChecks != null && {
      perCaseChecks: value.perCaseChecks as 'all-cases' | 'protected-cases',
    }),
  };
}

/** Parse strict JSON including duplicate decoded property names; retain exact file-byte identity. */
export function parseEvaluationPolicy(
  text: string,
  expectedDescriptor?: EvaluationDescriptor,
  options: PolicyValidationOptions = {},
): {
  policy: EvaluationPolicy;
  sha256: string;
} {
  if (typeof text !== 'string' || encoder.encode(text).length > 2 * 1024 * 1024) invalid();
  let value: unknown;
  try {
    value = strictJson(text);
  } catch {
    return invalid();
  }
  return {
    policy: validateEvaluationPolicy(value, expectedDescriptor, options),
    sha256: sha256(encoder.encode(text)),
  };
}

function strictJson(text: string): unknown {
  let cursor = 0;
  const whitespace = () => {
    while (cursor < text.length && /[ \t\r\n]/.test(text[cursor])) cursor++;
  };
  const quoted = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (text[cursor++] === '"') return JSON.parse(text.slice(start, cursor));
    }
    throw new Error();
  };
  const parse = (depth: number, unsignedInteger = false): unknown => {
    if (depth > 32) throw new Error();
    whitespace();
    const first = text[cursor];
    if (first === '"') return quoted();
    if (first === '{') {
      cursor++;
      whitespace();
      const object: Record<string, unknown> = Object.create(null);
      if (text[cursor] === '}') {
        cursor++;
        return object;
      }
      while (true) {
        whitespace();
        if (text[cursor] !== '"') throw new Error();
        const key = quoted();
        if (own(object, key)) throw new Error();
        whitespace();
        if (text[cursor++] !== ':') throw new Error();
        object[key] = parse(
          depth + 1,
          depth === 0 &&
            (key === 'schemaVersion' ||
              key === 'maximumCandidateTaskFailures' ||
              key === 'minimumRepetitionsPerCase'),
        );
        whitespace();
        if (text[cursor] === '}') {
          cursor++;
          return object;
        }
        if (text[cursor++] !== ',') throw new Error();
      }
    }
    if (first === '[') {
      cursor++;
      whitespace();
      const array: unknown[] = [];
      if (text[cursor] === ']') {
        cursor++;
        return array;
      }
      while (true) {
        array.push(parse(depth + 1));
        whitespace();
        if (text[cursor] === ']') {
          cursor++;
          return array;
        }
        if (text[cursor++] !== ',') throw new Error();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      text.slice(cursor),
    );
    if (!token || (unsignedInteger && token[0] !== 'null' && !/^\d+$/.test(token[0])))
      throw new Error();
    cursor += token[0].length;
    return JSON.parse(token[0]);
  };
  const result = parse(0);
  whitespace();
  if (cursor !== text.length) throw new Error();
  return result;
}

// Small synchronous SHA-256 keeps policy parsing browser-pure and exact-byte, without Node crypto.
function sha256(input: Uint8Array): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const length = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(length);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(length - 4, input.length * 8);
  const words = new Uint32Array(64);
  const rotate = (value: number, count: number) => (value >>> count) | (value << (32 - count));
  for (let offset = 0; offset < length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15],
        b = words[index - 2];
      words[index] =
        (words[index - 16] +
          (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) +
          words[index - 7] +
          (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>>
        0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const t1 =
        (h +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          constants[index] +
          words[index]) >>>
        0;
      const t2 =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => {
      state[index] = (state[index] + value) >>> 0;
    });
  }
  return 'sha256:' + state.map((value) => value.toString(16).padStart(8, '0')).join('');
}

const key = (value: { caseId: string; repetition: number }) =>
  JSON.stringify([value.caseId, value.repetition]);
const compareUtf8 = (left: string, right: string): number => {
  const a = encoder.encode(left),
    b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++)
    if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
};

/**
 * Check a comparison against a policy.
 *
 * Without `stage`, the mean-difference check compares the bound with `minimumMeanImprovement`.
 * Connected learning passes `stage` to select its development, cumulative or audit threshold;
 * the policy id never changes the calculation.
 */
export function checkComparison(options: {
  comparison: Comparison;
  expectedDescriptor: EvaluationDescriptor;
  expectedBinding: ExpectedComparisonBinding;
  policy: EvaluationPolicy;
  policyDigest?: string;
  stage?: 'development' | 'cumulative' | 'audit';
  /** Independently attested replay result for the correction targeted by this step. */
  replayPassed?: boolean;
  /** Harmonic mean of scored paired repetitions per calibration case. */
  calibrationEffectiveRepetitions?: number;
  calibratedStandardDeviation?: number;
}): PolicyVerdict {
  let descriptor: EvaluationDescriptor;
  try {
    descriptor = validateEvaluationDescriptor(options.expectedDescriptor);
  } catch {
    return invalid();
  }
  const policy = validateEvaluationPolicy(options.policy, descriptor, {
    connected: options.stage !== undefined,
  });
  if (
    (options.stage !== undefined &&
      !['development', 'cumulative', 'audit'].includes(options.stage)) ||
    (options.replayPassed !== undefined && typeof options.replayPassed !== 'boolean')
  )
    invalid();
  const binding = options.expectedBinding;
  if (
    !record(binding) ||
    !fields(
      binding,
      [
        'parentVersionId',
        'candidateVersionId',
        'parentDigest',
        'candidateDigest',
        'requestId',
        'attemptId',
        'comparisonId',
        'submitter',
      ],
      [
        'parentVersionId',
        'candidateVersionId',
        'parentDigest',
        'candidateDigest',
        'requestId',
        'attemptId',
      ],
    ) ||
    Object.values(binding).some((value) => !string(value)) ||
    !/^sha256:[0-9a-f]{64}$/.test(binding.parentDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(binding.candidateDigest) ||
    (options.policyDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(options.policyDigest))
  )
    invalid();
  const comparison = options.comparison;
  const malformed = (): never => {
    throw new PolicyError('evidence.malformed');
  };
  const mismatch = (): never => {
    throw new PolicyError('evidence.identity_mismatch');
  };
  if (
    !record(comparison) ||
    !fields(
      comparison,
      [
        'id',
        'complete',
        'submitter',
        'createdAt',
        'parentVersionId',
        'candidateVersionId',
        'parentDigest',
        'candidateDigest',
        'datasetRevision',
        'graderRevision',
        'runtime',
        'expectedCases',
        'results',
        'evaluation',
      ],
      [
        'id',
        'complete',
        'submitter',
        'createdAt',
        'parentVersionId',
        'candidateVersionId',
        'parentDigest',
        'candidateDigest',
        'datasetRevision',
        'graderRevision',
        'runtime',
        'expectedCases',
        'results',
      ],
    ) ||
    !string(comparison.id, 128) ||
    !string(comparison.submitter) ||
    !string(comparison.createdAt, 128) ||
    typeof comparison.complete !== 'boolean' ||
    !Array.isArray(comparison.results) ||
    comparison.results.length > 1000
  )
    malformed();
  for (const name of [
    'parentVersionId',
    'candidateVersionId',
    'parentDigest',
    'candidateDigest',
  ] as const)
    if (comparison[name] !== binding[name]) mismatch();
  if (
    (binding.comparisonId !== undefined && comparison.id !== binding.comparisonId) ||
    (binding.submitter !== undefined && comparison.submitter !== binding.submitter) ||
    !record(comparison.evaluation) ||
    !fields(comparison.evaluation, ['requestId', 'attemptId'], ['requestId', 'attemptId']) ||
    comparison.evaluation.requestId !== binding.requestId ||
    comparison.evaluation.attemptId !== binding.attemptId
  )
    mismatch();
  try {
    validateEvaluationDescriptor({
      datasetRevision: comparison.datasetRevision,
      graderRevision: comparison.graderRevision,
      runtime: comparison.runtime,
      expectedCases: comparison.expectedCases,
    });
  } catch {
    return malformed();
  }
  if (evaluationDescriptorDifferences(comparison, descriptor).length) mismatch();
  const expected = new Map(descriptor.expectedCases.map((item) => [key(item), item]));
  const pairs = new Map<string, (typeof comparison.results)[number]>();
  for (const pair of comparison.results) {
    if (
      !record(pair) ||
      !fields(
        pair,
        ['caseId', 'repetition', 'parent', 'candidate'],
        ['caseId', 'repetition', 'parent', 'candidate'],
      ) ||
      !string(pair.caseId) ||
      !Number.isInteger(pair.repetition) ||
      pair.repetition < 0 ||
      pair.repetition > 0xffffffff ||
      !expected.has(key(pair)) ||
      pairs.has(key(pair))
    )
      malformed();
    for (const outcome of [pair.parent, pair.candidate]) {
      if (
        !record(outcome) ||
        !fields(
          outcome,
          ['executionStatus', 'gradingStatus', 'reward', 'outputRef', 'error', 'usage'],
          ['executionStatus', 'gradingStatus', 'reward', 'outputRef', 'error', 'usage'],
        ) ||
        !['completed', 'task_failed', 'infrastructure_failed'].includes(outcome.executionStatus) ||
        !['scored', 'missing', 'failed'].includes(outcome.gradingStatus) ||
        (outcome.reward !== null && typeof outcome.reward !== 'number') ||
        (outcome.outputRef !== null && typeof outcome.outputRef !== 'string') ||
        (outcome.error !== null && typeof outcome.error !== 'string') ||
        (outcome.usage !== null &&
          (!record(outcome.usage) ||
            !fields(outcome.usage, ['inputTokens', 'outputTokens', 'costUsd'], []) ||
            Object.values(outcome.usage).some((value) => !nonnegative(value))))
      )
        malformed();
      if (outcome.gradingStatus !== 'scored' && outcome.reward !== null) malformed();
    }
    pairs.set(key(pair), pair);
  }
  const ordered = [...expected.values()].sort(
    (a, b) => compareUtf8(a.caseId, b.caseId) || a.repetition - b.repetition,
  );
  const usable = (outcome: Comparison['results'][number]['parent'] | undefined) =>
    !!outcome && outcome.executionStatus !== 'infrastructure_failed' && finite(outcome.reward);
  const comparable = ordered.filter((item) => {
    const pair = pairs.get(key(item));
    return (
      pair &&
      [pair.parent, pair.candidate].every(
        (outcome) => usable(outcome) && outcome.gradingStatus === 'scored',
      )
    );
  });
  const repetitionsByCase = new Map<string, number>();
  for (const item of ordered)
    repetitionsByCase.set(item.caseId, (repetitionsByCase.get(item.caseId) ?? 0) + 1);
  const distinctCases = repetitionsByCase.size;
  const gaps: EvidenceGaps = { total: 0, rows: [] };
  for (const item of ordered) {
    const pair = pairs.get(key(item));
    for (const side of ['parent', 'candidate'] as const) {
      const outcome = pair?.[side];
      const gap = scalarGap(outcome);
      if (gap) addGap(gaps, item, side, ...gap);
      if (
        outcome &&
        outcome.usage?.costUsd === undefined &&
        (policy.cost?.maximumIncreaseUsd !== undefined ||
          (side === 'candidate' && policy.cost?.maximumCandidateUsd !== undefined))
      )
        addGap(gaps, item, side, 'usage', 'missing_cost');
    }
  }
  const settings = resolveInference(policy);
  const statistical = settings.method === 'paired-t';
  const stage = options.stage ?? 'general';
  const audit = stage === 'audit';
  const modern = policy.schemaVersion === 3;
  const decision: Pick<PolicyInferenceResult, 'check' | 'threshold' | 'thresholdSource'> =
    audit && (!modern || policy.auditMode !== 'superiority')
      ? {
          check: 'policy.non_inferiority',
          threshold: -(policy.schemaVersion === 1
            ? 0
            : (policy.nonInferiorityMargin ?? (modern ? 0.03 : 0))),
          thresholdSource: 'nonInferiorityMargin',
        }
      : modern && stage === 'development'
        ? {
            check: 'policy.step_non_inferiority',
            threshold: -(policy.stepMargin ?? 0.03),
            thresholdSource: 'stepMargin',
          }
        : {
            check: 'policy.minimum_mean_improvement',
            threshold: policy.minimumMeanImprovement,
            thresholdSource: 'minimumMeanImprovement',
          };
  const perCaseChecks = policy.perCaseChecks ?? 'all-cases';
  const result: PolicyVerdict = {
    ...(gaps.total ? { evidenceGaps: gaps } : {}),
    schemaVersion: 1,
    verdict: 'indeterminate',
    code: 'evidence.incomplete',
    policy: { id: policy.id, revision: policy.revision, sha256: options.policyDigest ?? null },
    comparisonId: comparison.id,
    expectedBinding: { ...binding },
    checks: [],
    counts: { distinctCases, expectedPairs: ordered.length, comparablePairs: comparable.length },
    summary: {
      parentMean: null,
      candidateMean: null,
      orientedMeanImprovement: null,
      worstCaseRegression: null,
      candidateTaskFailures: 0,
      protectedCandidateTaskFailures: 0,
      parentTaskFailures: 0,
      parentCostUsd: null,
      candidateCostUsd: null,
      costIncreaseUsd: null,
      parentUnknownCosts: 0,
      candidateUnknownCosts: 0,
    },
    perCaseChecks,
    inference: {
      method: settings.method,
      estimand: statistical ? 'sampled-cases' : 'observed-cases',
      status: 'incomplete',
      stage,
      ...decision,
      confidence: statistical ? settings.confidence : null,
      n: distinctCases,
      minCases: settings.minCases,
      minRepetitions: settings.minRepetitions,
      repetitions: Math.min(...repetitionsByCase.values()),
      meanDifference: null,
      sd: null,
      sdFloor: null,
      sdFloorSource: null,
      calibratedSd: null,
      sdUsed: null,
      standardError: null,
      df: null,
      criticalValue: null,
      lowerBound: null,
      imputed: { parent: 0, candidate: 0 },
      maximumMissingPercent: settings.maximumMissingPercent,
    },
    interpretation: statistical ? 'statistical-policy-check' : 'descriptive-policy-check',
  };
  for (const side of ['parent', 'candidate'] as const) {
    const unknown = ordered.filter(
      (item) => pairs.get(key(item))?.[side].usage?.costUsd === undefined,
    ).length;
    result.summary[side === 'parent' ? 'parentUnknownCosts' : 'candidateUnknownCosts'] = unknown;
  }
  const protectedCase = (id: string) =>
    policy.requiredCases.includes(id) || own(policy.protectedCaseThresholds ?? {}, id);
  const taskFailed = (outcome: Comparison['results'][number]['parent'] | undefined) =>
    !!outcome && (outcome.executionStatus === 'task_failed' || !usable(outcome));
  const failures = (side: 'parent' | 'candidate', only?: (id: string) => boolean) =>
    ordered.filter(
      (item) => (!only || only(item.caseId)) && taskFailed(pairs.get(key(item))?.[side]),
    ).length;
  result.summary.candidateTaskFailures = failures('candidate');
  result.summary.protectedCandidateTaskFailures = failures('candidate', protectedCase);
  result.summary.parentTaskFailures = failures('parent');
  const missing = (side: 'parent' | 'candidate') =>
    ordered.filter((item) => !usable(pairs.get(key(item))?.[side])).length;
  result.inference.imputed = { parent: missing('parent'), candidate: missing('candidate') };
  if (
    pairs.size !== ordered.length ||
    (['parent', 'candidate'] as const).some(
      (side) => missing(side) * 100 > ordered.length * settings.maximumMissingPercent,
    )
  ) {
    result.inference.imputed = { parent: 0, candidate: 0 };
    result.checks.push({ code: 'evidence.incomplete', result: 'unknown' });
    return result;
  }
  const mean = (values: number[]): number => {
    let total = +0.0;
    for (const value of values) {
      total = total + value;
      if (!Number.isFinite(total)) throw new RangeError();
    }
    const value = total / values.length;
    if (!Number.isFinite(value)) throw new RangeError();
    return value;
  };
  const total = (values: number[]): number => {
    let result = +0.0;
    for (const value of values) {
      result = result + value;
      if (!Number.isFinite(result)) throw new RangeError();
    }
    return result;
  };
  const arithmetic = (value: number) => {
    if (!Number.isFinite(value)) throw new RangeError();
    return value;
  };
  const check = (code: string, passed: boolean) =>
    result.checks.push({ code, result: passed ? 'pass' : 'fail' });
  const scale = policy.metric.scale;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const item of ordered) {
    const pair = pairs.get(key(item))!;
    for (const outcome of [pair.parent, pair.candidate]) {
      if (!usable(outcome)) continue;
      const reward = outcome.reward as number;
      if (scale && (reward < scale.minimum || reward > scale.maximum))
        throw new PolicyError('evidence.reward_out_of_range');
      minimum = Math.min(minimum, reward);
      maximum = Math.max(maximum, reward);
    }
  }
  try {
    const groups = new Map<string, Array<(typeof comparison.results)[number]>>();
    for (const item of ordered) {
      const rows = groups.get(item.caseId) ?? [];
      rows.push(pairs.get(key(item))!);
      groups.set(item.caseId, rows);
    }
    const parentMeans: number[] = [],
      candidateMeans: number[] = [],
      improvements: number[] = [];
    const orientation = policy.metric.direction === 'higher' ? 1 : -1;
    const worstReward = orientation > 0 ? minimum : maximum;
    const bestReward = orientation > 0 ? maximum : minimum;
    const reward = (outcome: Comparison['results'][number]['parent'], fallback: number) =>
      usable(outcome) ? (outcome.reward as number) : fallback;
    let checkedRegression = 0;
    for (const [id, rows] of groups) {
      const parent = mean(rows.map((pair) => reward(pair.parent, bestReward)));
      const candidate = mean(rows.map((pair) => reward(pair.candidate, worstReward)));
      const gain = arithmetic(orientation * arithmetic(candidate - parent));
      parentMeans.push(parent);
      candidateMeans.push(candidate);
      improvements.push(gain);
      if (perCaseChecks === 'all-cases' || protectedCase(id))
        checkedRegression = Math.max(checkedRegression, -gain);
      const thresholds = policy.protectedCaseThresholds ?? {};
      if (own(thresholds, id))
        check(
          'policy.protected_case_threshold',
          rows.every(
            ({ candidate: outcome }) =>
              outcome.executionStatus === 'completed' &&
              usable(outcome) &&
              orientation * (outcome.reward as number) >= orientation * thresholds[id],
          ),
        );
    }
    const parentMean = mean(parentMeans),
      candidateMean = mean(candidateMeans),
      improvement = mean(improvements);
    result.summary.parentMean = parentMean;
    result.summary.candidateMean = candidateMean;
    result.summary.orientedMeanImprovement = improvement;
    result.summary.worstCaseRegression = Math.max(0, ...improvements.map((value) => -value));
    const inference = result.inference;
    const n = improvements.length;
    inference.meanDifference = improvement;
    // Identical case differences have exactly zero observed variance, whatever the rounding of
    // their mean, so the check is on the values themselves.
    const sd =
      n < 2
        ? null
        : improvements.every((gain) => gain === improvements[0])
          ? 0
          : Math.sqrt(
              total(improvements.map((gain) => (gain - improvement) * (gain - improvement))) /
                (n - 1),
            );
    inference.sd = sd;
    const insufficient: string[] = [];
    if (n < settings.minCases) insufficient.push('inference.minimum_cases');
    if (inference.repetitions < settings.minRepetitions)
      insufficient.push('inference.minimum_repetitions');
    let passed: boolean | null;
    if (!statistical) {
      inference.status = 'not_applicable';
      passed = improvement >= decision.threshold;
    } else {
      let calibrated = options.calibratedStandardDeviation ?? 0;
      if (!nonnegative(calibrated)) throw new RangeError();
      if (options.calibrationEffectiveRepetitions !== undefined) {
        if (!nonnegative(options.calibrationEffectiveRepetitions)) throw new RangeError();
        const inverseRepetitions = total([...groups.values()].map((rows) => 1 / rows.length));
        const evaluated = groups.size / inverseRepetitions;
        calibrated *= Math.sqrt(options.calibrationEffectiveRepetitions / evaluated);
      }
      inference.calibratedSd =
        options.calibratedStandardDeviation === undefined ? null : calibrated;
      const floor =
        settings.sdFloor !== undefined
          ? { value: settings.sdFloor, source: 'declared' as const }
          : scale
            ? { value: 0.1 * (scale.maximum - scale.minimum), source: 'scale' as const }
            : { value: 0.1 * arithmetic(maximum - minimum), source: 'observed-range' as const };
      inference.sdFloor = floor.value;
      inference.sdFloorSource = floor.source;
      if (n >= 2) {
        const used = Math.max(sd ?? 0, floor.value, calibrated);
        inference.sdUsed = used;
        inference.df = n - 1;
        inference.criticalValue = studentTQuantile(settings.confidence, n - 1);
        inference.standardError = used / Math.sqrt(n);
        if (used === 0) insufficient.push('inference.zero_variance');
        else
          inference.lowerBound = arithmetic(
            improvement - (inference.criticalValue * used) / Math.sqrt(n),
          );
      }
      inference.status = insufficient.length ? 'insufficient_data' : 'estimated';
      passed = insufficient.length ? null : inference.lowerBound! > decision.threshold;
    }
    if (insufficient.length) {
      passed = null;
      for (const code of insufficient) result.checks.push({ code, result: 'unknown' });
      inference.status = 'insufficient_data';
    }
    if (passed !== null) check(decision.check, passed);
    check('policy.maximum_case_regression', checkedRegression <= policy.maximumCaseRegression);
    if (policy.candidateThreshold !== undefined)
      check(
        'policy.candidate_threshold',
        arithmetic(orientation * candidateMean) >=
          arithmetic(orientation * policy.candidateThreshold),
      );
    if (policy.maximumCandidateTaskFailures !== undefined)
      check(
        'policy.maximum_candidate_task_failures',
        (perCaseChecks === 'all-cases'
          ? result.summary.candidateTaskFailures
          : result.summary.protectedCandidateTaskFailures) <= policy.maximumCandidateTaskFailures,
      );
    for (const side of ['parent', 'candidate'] as const) {
      if (result.summary[side === 'parent' ? 'parentUnknownCosts' : 'candidateUnknownCosts'] === 0)
        result.summary[side === 'parent' ? 'parentCostUsd' : 'candidateCostUsd'] = total(
          ordered.map((item) => pairs.get(key(item))![side].usage!.costUsd!),
        );
    }
    if (result.summary.parentCostUsd !== null && result.summary.candidateCostUsd !== null)
      result.summary.costIncreaseUsd = arithmetic(
        result.summary.candidateCostUsd - result.summary.parentCostUsd,
      );
    if (policy.cost?.maximumCandidateUsd !== undefined) {
      if (result.summary.candidateCostUsd === null)
        result.checks.push({ code: 'cost.unknown', result: 'unknown' });
      else
        check(
          'policy.maximum_candidate_cost',
          result.summary.candidateCostUsd <= policy.cost.maximumCandidateUsd,
        );
    }
    if (policy.cost?.maximumIncreaseUsd !== undefined) {
      if (result.summary.costIncreaseUsd === null)
        result.checks.push({ code: 'cost.unknown', result: 'unknown' });
      else
        check(
          'policy.maximum_cost_increase',
          result.summary.costIncreaseUsd <= policy.cost.maximumIncreaseUsd,
        );
    }
    if (modern && stage === 'development') {
      // A step needs a benefit beyond non-inferiority: a point gain that reaches the policy's
      // minimumMeanImprovement (and is positive), an attested replay, or a cost saving.
      const increase = result.summary.costIncreaseUsd;
      check(
        'policy.development_benefit',
        (improvement > 0 && improvement >= policy.minimumMeanImprovement) ||
          options.replayPassed === true ||
          (policy.cost !== undefined &&
            increase !== null &&
            increase < 0 &&
            -increase >= (policy.minimumCostSavingsUsd ?? 0)),
      );
    }
    if (!modern && policy.minimumCostSavingsUsd !== undefined) {
      if (result.summary.costIncreaseUsd === null)
        result.checks.push({ code: 'cost.unknown', result: 'unknown' });
      else
        check(
          'policy.minimum_cost_savings',
          -result.summary.costIncreaseUsd >= policy.minimumCostSavingsUsd,
        );
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    result.code = 'analysis.nonfinite';
    result.checks.push({ code: 'analysis.nonfinite', result: 'unknown' });
    return result;
  }
  const failed = result.checks.some((check) => check.result === 'fail');
  if (!failed && result.checks.some((check) => check.result === 'unknown')) {
    result.code = result.checks.some(
      (check) => check.result === 'unknown' && check.code.startsWith('inference.'),
    )
      ? 'inference.insufficient_data'
      : 'cost.unknown';
    return result;
  }
  result.verdict = failed ? 'fail' : 'pass';
  result.code = result.verdict === 'pass' ? 'policy.pass' : 'policy.fail';
  return result;
}

interface ResolvedInference {
  method: 'paired-t' | 'none';
  confidence: ConfidenceLevel;
  minCases: number;
  minRepetitions: number;
  sdFloor?: number;
  maximumMissingPercent: number;
}

/** Fill omitted inference fields with the documented defaults. */
export function resolveInference(policy: EvaluationPolicy): ResolvedInference {
  const declared = policy.inference ?? { method: 'paired-t' as const };
  const statistical = declared.method === 'paired-t';
  return {
    method: declared.method,
    confidence: declared.confidence ?? defaultInference.confidence,
    minCases: declared.minCases ?? (statistical ? defaultInference.minCases : 1),
    minRepetitions: declared.minRepetitions ?? defaultInference.minRepetitions,
    ...(declared.sdFloor !== undefined && { sdFloor: declared.sdFloor }),
    maximumMissingPercent:
      declared.maximumMissingPercent ?? (statistical ? defaultInference.maximumMissingPercent : 0),
  };
}

/** Fixed-precision terminal number. JSON output keeps full precision. */
export function formatStatistic(value: number | null | undefined): string {
  if (value == null) return 'unknown';
  if (!Number.isFinite(value)) return String(value);
  if (value !== 0 && Math.abs(value) < 1e-4) return value.toExponential(2);
  return String(Number(value.toFixed(4)));
}

/** Terminal lines describing the statistic behind a verdict. */
export function describePolicyInference(inference: PolicyInferenceResult): string[] {
  const f = formatStatistic;
  if (inference.method === 'none')
    return [
      `Inference           none: point estimates for these cases, no noise model`,
      `  mean difference ${f(inference.meanDifference)} vs threshold ${f(inference.threshold)} (${inference.check})`,
    ];
  const lines = [
    `Inference           paired-t ${f((inference.confidence ?? 0) * 100)}% one-sided · cases treated as a sample (${inference.check})`,
    `  n ${inference.n} (minimum ${inference.minCases}) · repetitions ${inference.repetitions} (minimum ${inference.minRepetitions}) · imputed parent ${inference.imputed.parent}, candidate ${inference.imputed.candidate}`,
  ];
  if (inference.meanDifference !== null)
    lines.push(
      `  mean difference ${f(inference.meanDifference)} · sd ${f(inference.sd)} · floor ${f(inference.sdFloor)} (${inference.sdFloorSource ?? 'none'})${inference.calibratedSd !== null ? ` · calibrated ${f(inference.calibratedSd)}` : ''} · df ${inference.df ?? 'none'} · t ${f(inference.criticalValue)}`,
      `  lower bound ${f(inference.lowerBound)} vs threshold ${f(inference.threshold)} (${inference.thresholdSource})`,
    );
  if (inference.status === 'insufficient_data')
    lines.push('  insufficient data: the verdict is indeterminate, not a pass');
  return lines;
}
