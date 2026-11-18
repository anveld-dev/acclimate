import type { Comparison, EvaluationDescriptor } from '../types.js';
import { addGap, scalarGap, type EvidenceGaps } from './evidence-gaps.js';
import { validateEvaluationDescriptor, evaluationDescriptorDifferences } from '../validation.js';

/** Pure, descriptive policy calculation. It neither fetches nor authenticates evidence. */
export interface EvaluationPolicyV1 {
  schemaVersion: 1;
  id: string;
  revision: string;
  metric: { name: string; unit: string; direction: 'higher' | 'lower' };
  aggregation: 'equal-case-means';
  minimumMeanImprovement: number;
  maximumCaseRegression: number;
  candidateThreshold?: number;
  requiredCases: string[];
  maximumCandidateTaskFailures?: number;
  cost?: { maximumCandidateUsd?: number; maximumIncreaseUsd?: number };
  /** Each matching candidate repetition must meet its oriented reward threshold. */
  protectedCaseThresholds?: Record<string, number>;
  /** Require observed savings across the complete paired case inventory. */
  minimumCostSavingsUsd?: number;
  /** Minimum paired repetitions required for every case in the stage inventory. */
  minimumRepetitionsPerCase?: number;
}

export interface EvaluationPolicyV2 extends Omit<EvaluationPolicyV1, 'schemaVersion'> {
  schemaVersion: 2;
  nonInferiorityMargin?: number;
}

export type EvaluationPolicy = EvaluationPolicyV1 | EvaluationPolicyV2;

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
    worstCaseRegression: number | null;
    candidateTaskFailures: number;
    parentCostUsd: number | null;
    candidateCostUsd: number | null;
    costIncreaseUsd: number | null;
    parentUnknownCosts: number;
    candidateUnknownCosts: number;
  };
  interpretation: 'descriptive-policy-check';
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
  | 'evidence.malformed';
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

export function validateEvaluationPolicy(
  value: unknown,
  expectedDescriptor?: EvaluationDescriptor,
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
      ],
      [],
    ) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    (value.nonInferiorityMargin != null &&
      (value.schemaVersion !== 2 || !nonnegative(value.nonInferiorityMargin))) ||
    !policyString(value.id, 128) ||
    !policyString(value.revision) ||
    value.aggregation !== 'equal-case-means' ||
    !finite(value.minimumMeanImprovement) ||
    !nonnegative(value.maximumCaseRegression) ||
    !record(metric) ||
    !fields(metric, requiredMetricFields, []) ||
    !policyString(metric.name, 128) ||
    !policyString(metric.unit, 128) ||
    !['higher', 'lower'].includes(metric.direction as string) ||
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
  return {
    ...(value.schemaVersion === 2
      ? {
          schemaVersion: 2 as const,
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
  };
}

/** Parse strict JSON including duplicate decoded property names; retain exact file-byte identity. */
export function parseEvaluationPolicy(
  text: string,
  expectedDescriptor?: EvaluationDescriptor,
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
    policy: validateEvaluationPolicy(value, expectedDescriptor),
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

export function checkComparison(options: {
  comparison: Comparison;
  expectedDescriptor: EvaluationDescriptor;
  expectedBinding: ExpectedComparisonBinding;
  policy: EvaluationPolicy;
  policyDigest?: string;
  stage?: 'development' | 'audit';
  calibratedStandardDeviation?: number;
}): PolicyVerdict {
  let descriptor: EvaluationDescriptor;
  try {
    descriptor = validateEvaluationDescriptor(options.expectedDescriptor);
  } catch {
    return invalid();
  }
  const policy = validateEvaluationPolicy(options.policy, descriptor);
  const confidenceGate =
    policy.schemaVersion === 2 ||
    options.stage !== undefined ||
    policy.id === 'connected-development' ||
    policy.id === 'connected-audit';
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
  const comparable = ordered.filter((item) => {
    const pair = pairs.get(key(item));
    return (
      pair &&
      [pair.parent, pair.candidate].every(
        (outcome) =>
          outcome.executionStatus !== 'infrastructure_failed' &&
          outcome.gradingStatus === 'scored' &&
          finite(outcome.reward),
      )
    );
  });
  const distinctCases = new Set(ordered.map((item) => item.caseId)).size;
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
      parentCostUsd: null,
      candidateCostUsd: null,
      costIncreaseUsd: null,
      parentUnknownCosts: 0,
      candidateUnknownCosts: 0,
    },
    interpretation: 'descriptive-policy-check',
  };
  for (const side of ['parent', 'candidate'] as const) {
    const unknown = ordered.filter(
      (item) => pairs.get(key(item))?.[side].usage?.costUsd === undefined,
    ).length;
    result.summary[side === 'parent' ? 'parentUnknownCosts' : 'candidateUnknownCosts'] = unknown;
  }
  const protectedCase = (id: string) =>
    policy.requiredCases.includes(id) || own(policy.protectedCaseThresholds ?? {}, id);
  result.summary.candidateTaskFailures = ordered.filter((item) => {
    const outcome = pairs.get(key(item))?.candidate;
    return (
      outcome &&
      (confidenceGate
        ? protectedCase(item.caseId) &&
          (outcome.executionStatus !== 'completed' || !finite(outcome.reward))
        : outcome.executionStatus === 'task_failed')
    );
  }).length;
  const missing = ordered.reduce((count, item) => {
    const pair = pairs.get(key(item));
    if (!pair) return count + 2;
    return (
      count +
      [pair.parent, pair.candidate].filter(
        (outcome) => outcome.executionStatus === 'infrastructure_failed' || !finite(outcome.reward),
      ).length
    );
  }, 0);
  if (
    pairs.size !== ordered.length ||
    missing * 100 > ordered.length * 2 * (confidenceGate ? 15 : 0)
  ) {
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
  try {
    const groups = new Map<string, typeof comparison.results>();
    for (const item of ordered) {
      const rows = groups.get(item.caseId) ?? [];
      rows.push(pairs.get(key(item))!);
      groups.set(item.caseId, rows);
    }
    const parentMeans: number[] = [],
      candidateMeans: number[] = [],
      improvements: number[] = [];
    const orientation = policy.metric.direction === 'higher' ? 1 : -1;
    const scored = (outcome: Comparison['results'][number]['parent']) =>
      outcome.executionStatus === 'infrastructure_failed' ? null : outcome.reward;
    let worstReward = orientation > 0 ? 0 : 1;
    for (const pair of pairs.values()) {
      for (const outcome of [pair.parent, pair.candidate]) {
        const reward = scored(outcome);
        if (reward !== null && orientation * reward < orientation * worstReward)
          worstReward = reward;
      }
    }
    let protectedRegression = 0;
    for (const [id, rows] of groups) {
      const parent = mean(rows.map((pair) => scored(pair.parent) ?? worstReward));
      const candidate = mean(rows.map((pair) => scored(pair.candidate) ?? worstReward));
      const gain = arithmetic(orientation * arithmetic(candidate - parent));
      parentMeans.push(parent);
      candidateMeans.push(candidate);
      improvements.push(gain);
      if (protectedCase(id)) protectedRegression = Math.max(protectedRegression, -gain);
      const thresholds = policy.protectedCaseThresholds ?? {};
      if (own(thresholds, id))
        check(
          'policy.protected_case_threshold',
          rows.every(
            ({ candidate: outcome }) =>
              outcome.executionStatus === 'completed' &&
              outcome.reward !== null &&
              orientation * outcome.reward >= orientation * thresholds[id],
          ),
        );
    }
    const parentMean = mean(parentMeans),
      candidateMean = mean(candidateMeans),
      improvement = mean(improvements);
    const worstRegression = Math.max(0, ...improvements.map((value) => -value));
    result.summary.parentMean = parentMean;
    result.summary.candidateMean = candidateMean;
    result.summary.orientedMeanImprovement = improvement;
    result.summary.worstCaseRegression = worstRegression;
    const audit =
      (options.stage ?? (policy.id === 'connected-audit' ? 'audit' : 'development')) === 'audit';
    const threshold = audit
      ? -(policy.schemaVersion === 2 ? (policy.nonInferiorityMargin ?? 0) : 0)
      : policy.minimumMeanImprovement;
    const z = audit ? 1.6448536269514722 : 1.2815515655446004;
    const variance =
      total(improvements.map((gain) => (gain - improvement) ** 2)) /
      Math.max(1, improvements.length - 1);
    const calibrated = options.calibratedStandardDeviation ?? 0;
    if (!nonnegative(calibrated)) throw new RangeError();
    const bound = arithmetic(
      improvement -
        (z * Math.max(Math.sqrt(variance), calibrated)) / Math.sqrt(improvements.length),
    );
    check(
      'policy.minimum_mean_improvement',
      confidenceGate ? bound > threshold : improvement >= policy.minimumMeanImprovement,
    );
    check(
      'policy.maximum_case_regression',
      (confidenceGate ? protectedRegression : worstRegression) <= policy.maximumCaseRegression,
    );
    if (policy.candidateThreshold !== undefined)
      check(
        'policy.candidate_threshold',
        arithmetic(orientation * candidateMean) >=
          arithmetic(orientation * policy.candidateThreshold),
      );
    if (policy.maximumCandidateTaskFailures !== undefined)
      check(
        'policy.maximum_candidate_task_failures',
        result.summary.candidateTaskFailures <= policy.maximumCandidateTaskFailures,
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
    if (policy.minimumCostSavingsUsd !== undefined) {
      if (result.summary.costIncreaseUsd === null)
        result.checks.push({ code: 'cost.unknown', result: 'unknown' });
      else
        check(
          'policy.minimum_cost_savings',
          -result.summary.costIncreaseUsd >= policy.minimumCostSavingsUsd,
        );
    }
  } catch {
    result.code = 'analysis.nonfinite';
    result.checks.push({ code: 'analysis.nonfinite', result: 'unknown' });
    return result;
  }
  if (
    !result.checks.some((check) => check.result === 'fail') &&
    result.checks.some((check) => check.result === 'unknown')
  ) {
    result.code = 'cost.unknown';
    return result;
  }
  result.verdict = result.checks.some((check) => check.result === 'fail') ? 'fail' : 'pass';
  result.code = result.verdict === 'pass' ? 'policy.pass' : 'policy.fail';
  return result;
}
