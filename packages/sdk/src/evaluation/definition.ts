import type { BundleFile, EvaluationDescriptor } from '../types.js';
import { types as nodeTypes } from 'node:util';
import { validateEvaluationDescriptor } from '../validation.js';
import { DefinitionError, EvaluationError, OutputValidationError } from './errors.js';
import type {
  EvaluationApp,
  EvaluationCase,
  EvaluationDefinition,
  EvaluationExecutionResult,
  EvaluationGradeResult,
  ExecuteInput,
  Json,
  JsonOutputCheck,
} from './types.js';
import { COLLECTION_RUNTIME_KEYS, collectionRuntime, collectionSchedule } from './collection.js';
import type { CollectionSchedule } from './collection.js';
export { OutputValidationError } from './errors.js';
export const MAX_ARTIFACT = 1024 * 1024,
  MAX_REQUEST = 2 * 1024 * 1024,
  MAX_PRIVATE = 128 * 1024 * 1024;
export interface CapturedDefinition<I = unknown, E = unknown, O = unknown> {
  descriptor: EvaluationDescriptor;
  execution: 'model-free' | 'live';
  cases: readonly EvaluationCase<I, E>[];
  execute: (input: Omit<ExecuteInput<I>, BundleHelper>) => Promise<EvaluationExecutionResult<O>>;
  grade: (input: Parameters<EvaluationDefinition<I, E, O>['grade']>[0]) => Promise<EvaluationGradeResult>;
  collection?: CollectionSchedule;
}
type BundleHelper = 'instructions' | 'instructionFiles' | 'skillFiles' | 'memoryFiles';
const definitions = new WeakMap<object, CapturedDefinition<any, any, any>>();
function validateJson(value: unknown, maximum: number, root = 'output'): asserts value is Json {
  const active = new Set<object>();
  const visit = (x: unknown, field: string): void => {
    const invalid = (reason: string): never => {
      throw new OutputValidationError(field, reason);
    };
    if (x === null || typeof x === 'boolean') return;
    if (typeof x === 'string') {
      if (/[\ud800-\udfff]/u.test(x)) invalid('Use a valid Unicode string.');
      return;
    }
    if (typeof x === 'number') {
      if (!Number.isFinite(x) || (Number.isInteger(x) && !Number.isSafeInteger(x)))
        invalid('Use a finite JSON number or encode large integers as strings.');
      return;
    }
    if (!x || typeof x !== 'object') return invalid('Use a JSON value or omit this object field.');
    if (nodeTypes.isProxy(x)) invalid('Return a plain JSON object instead of a proxy.');
    if (active.has(x)) invalid('Remove the circular reference.');
    if (nodeTypes.isDate(x)) invalid('Convert Date to an ISO string with toISOString().');
    if (
      !Array.isArray(x) &&
      Object.getPrototypeOf(x) !== Object.prototype &&
      Object.getPrototypeOf(x) !== null
    )
      invalid('Convert class instances and collections to plain JSON objects or arrays.');
    if (Reflect.ownKeys(x).some((k) => typeof k !== 'string' || /[\ud800-\udfff]/u.test(k)))
      invalid('Use Unicode string property names.');
    active.add(x);
    if (Array.isArray(x)) {
      if (Object.getPrototypeOf(x) !== Array.prototype) invalid('Use a plain array.');
      const entries = Object.getOwnPropertyDescriptors(x) as unknown as Record<
        string,
        PropertyDescriptor
      >;
      const length = entries.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || Object.keys(entries).length !== length + 1)
        invalid('Use a dense array without extra properties.');
      for (let i = 0; i < length; i++) {
        const item = entries[String(i)];
        if (!item || !('value' in item) || !item.enumerable)
          invalid('Use ordinary array elements.');
        visit(item.value, `${field}[${i}]`.slice(0, 512));
      }
    } else {
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(x))) {
        const child = (field + '[' + JSON.stringify(key.slice(0, 100)) + ']').slice(0, 512);
        if (!('value' in descriptor) || !descriptor.enumerable)
          throw new OutputValidationError(
            child,
            'Use an enumerable data field instead of an accessor.',
          );
        visit(descriptor.value, child);
      }
    }
    active.delete(x);
  };
  visit(value, root);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum)
    throw new OutputValidationError(
      root,
      `Return at most ${maximum} bytes of JSON. Store larger evidence privately and return a digest.`,
    );
}
/** Check a real adapter result locally before returning it to the durable runner. */
export function assertEvaluationOutput(value: unknown): asserts value is Json {
  validateJson(value, MAX_ARTIFACT);
}
export function assertJson(value: unknown, maximum = MAX_ARTIFACT): asserts value is Json {
  try {
    validateJson(value, maximum);
  } catch {
    throw new EvaluationError('config.schema');
  }
}
export function deepFreeze<T>(x: T): T {
  if (x && typeof x === 'object') {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}
export function captureDefinition(
  app: EvaluationApp<any, any, any>,
): CapturedDefinition<any, any, any> {
  const value = definitions.get(app);
  if (!value)
    throw new DefinitionError('app', 'Pass the value returned by defineEvaluation().');
  return value;
}
/** Preserve the installed callbacks, fixtures and schedule while binding runtime evidence. */
export function bindEvaluationRuntime<I, E, O>(
  app: EvaluationApp<I, E, O>,
  commitments: Record<string, string>,
): EvaluationApp<I, E, O> {
  const captured = captureDefinition(app);
  if (Object.keys(commitments).some((key) => Object.hasOwn(captured.descriptor.runtime, key)))
    throw new DefinitionError('runtime', 'Runtime commitments cannot replace existing settings.');
  const descriptor = deepFreeze(
    validateEvaluationDescriptor({
      ...captured.descriptor,
      runtime: { ...captured.descriptor.runtime, ...commitments },
    }),
  );
  assertReportBudget(descriptor);
  const bound = Object.freeze({ descriptor }) as EvaluationApp<I, E, O>;
  definitions.set(bound, { ...captured, descriptor });
  return bound;
}
/** Bind a connected request's trial inventory after capturing the installed fixtures. */
export function bindEvaluationRepetitions<I, E, O>(
  app: EvaluationApp<I, E, O>,
  expectedCases: EvaluationDescriptor['expectedCases'],
): EvaluationApp<I, E, O> {
  const captured = captureDefinition(app);
  if (captured.collection) return app;
  const repetitions = new Map<string, Set<number>>();
  for (const key of expectedCases) {
    const indices = repetitions.get(key.caseId) ?? new Set<number>();
    indices.add(key.repetition);
    repetitions.set(key.caseId, indices);
  }
  if (repetitions.size !== captured.cases.length) return app;
  const cases = captured.cases.map((item) => ({
    ...item,
    repetitions: repetitions.get(item.caseId)?.size ?? 0,
  }));
  if (
    expectedCases.length !== cases.reduce((sum, item) => sum + item.repetitions, 0) ||
    cases.some((item) => {
      const indices = repetitions.get(item.caseId);
      return !indices || [...indices].some((index) => index < 0 || index >= item.repetitions);
    })
  )
    return app;
  const descriptor = deepFreeze(
    validateEvaluationDescriptor({ ...captured.descriptor, expectedCases }),
  );
  assertReportBudget(descriptor);
  const bound = Object.freeze({ descriptor }) as EvaluationApp<I, E, O>;
  definitions.set(bound, { ...captured, descriptor, cases: deepFreeze(cases) });
  return bound;
}

const filesOf = (bundle: ExecuteInput['bundle'], kind: BundleFile['kind']) =>
  Object.freeze((bundle?.payload?.files ?? []).filter((file) => file.kind === kind));
/** Add read-only helpers for the bundle's instructions, skills and memory files. */
function withBundleHelpers<I>(input: Omit<ExecuteInput<I>, BundleHelper>): ExecuteInput<I> {
  const helpers: PropertyDescriptorMap = {
    instructionFiles: { get: () => filesOf(input.bundle, 'instruction'), enumerable: false },
    skillFiles: { get: () => filesOf(input.bundle, 'skill'), enumerable: false },
    memoryFiles: { get: () => filesOf(input.bundle, 'memory'), enumerable: false },
    instructions: {
      get: () =>
        filesOf(input.bundle, 'instruction')
          .map((file) => file.text)
          .join('\n\n'),
      enumerable: false,
    },
  };
  return Object.defineProperties({ ...input }, helpers) as ExecuteInput<I>;
}

const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  Buffer.byteLength(value) <= maximum &&
  !/[\ud800-\udfff]/u.test(value);
function json(value: unknown, maximum: number, root: string): void {
  try {
    validateJson(value, maximum, root);
  } catch (error) {
    if (error instanceof OutputValidationError) throw new DefinitionError(error.field, error.reason);
    throw error;
  }
}

/**
 * Check a case array and return a private clone plus its public inventory. Errors name
 * the case index and field, for example `cases[2].caseId`.
 */
export function assertCaseInventory<I, E>(value: unknown, root = 'cases') {
  if (!Array.isArray(value)) throw new DefinitionError(root, 'Supply cases as an array.');
  if (!value.length) throw new DefinitionError(root, 'cases is empty. Add at least one case.');
  json(value, 16 * 1024 * 1024, root);
  const cases = structuredClone(value) as unknown as EvaluationCase<I, E>[],
    seen = new Map<string, number>();
  const expectedCases = cases.flatMap((item, index) => {
    const at = `${root}[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new DefinitionError(at, 'Use an object with caseId, input and expected.');
    const unknown = Object.keys(item).find(
      (k) => !['caseId', 'input', 'expected', 'repetitions'].includes(k),
    );
    if (unknown)
      throw new DefinitionError(
        `${at}.${unknown}`,
        unknown === 'case_id'
          ? 'Use caseId.'
          : 'Unknown case field. Use caseId, input, expected and optional repetitions.',
      );
    for (const name of ['input', 'expected'] as const)
      if (!Object.hasOwn(item, name))
        throw new DefinitionError(`${at}.${name}`, `Add ${name}. Use null when there is none.`);
    if (!text(item.caseId, 1024))
      throw new DefinitionError(`${at}.caseId`, 'Use a nonempty string of at most 1024 bytes.');
    if (seen.has(item.caseId))
      throw new DefinitionError(
        `${at}.caseId`,
        `Duplicate caseId ${JSON.stringify(item.caseId)}; cases[${seen.get(item.caseId)}] uses it too.`,
      );
    const repetitions = item.repetitions ?? 1;
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 1000)
      throw new DefinitionError(
        `${at}.repetitions`,
        'Use an integer count from 1 to 1000. Each run receives a 0-based repetition index.',
      );
    seen.set(item.caseId, index);
    return Array.from({ length: repetitions }, (_, repetition) => ({
      caseId: item.caseId,
      repetition,
    }));
  });
  if (expectedCases.length > 1000)
    throw new DefinitionError(
      root,
      `The cases expand to ${expectedCases.length} runs. Use at most 1000 case repetitions in one evaluation.`,
    );
  return { cases, expectedCases };
}

/**
 * Capture an evaluation's cases and callbacks. Callbacks may return values directly or
 * as promises. The output type must be plain JSON; when it is not, the compiler names
 * the first field to convert.
 */
export function defineEvaluation<I, E, O>(
  definition: EvaluationDefinition<I, E, O> & JsonOutputCheck<O>,
): EvaluationApp<I, E, O> {
  if (!definition || typeof definition !== 'object')
    throw new DefinitionError('definition', 'Pass an object to defineEvaluation().');
  for (const name of ['execute', 'grade'] as const)
    if (typeof definition[name] !== 'function')
      throw new DefinitionError(name, `Supply ${name} as a function.`);
  if (!['model-free', 'live'].includes(definition.execution))
    throw new DefinitionError('execution', 'Use "model-free" or "live".');
  for (const [name, limit] of [
    ['configId', 128],
    ['configRevision', 1024],
    ['datasetRevision', 1024],
    ['graderRevision', 1024],
  ] as const)
    if (!text(definition[name], limit))
      throw new DefinitionError(name, `Use a nonempty string of at most ${limit} bytes.`);
  const reserved: readonly string[] = [
    'configId',
    'configRevision',
    'execution',
    'concurrency',
    'gradeRetries',
    ...COLLECTION_RUNTIME_KEYS,
  ];
  if (!definition.runtime || typeof definition.runtime !== 'object' || Array.isArray(definition.runtime))
    throw new DefinitionError('runtime', 'Supply runtime as an object of string settings.');
  json(definition.runtime, 512 * 1024, 'runtime');
  const runtimeEntries = Object.entries(definition.runtime);
  if (runtimeEntries.length > 64 - 5 - (definition.collection === undefined ? 0 : 3))
    throw new DefinitionError('runtime', 'Use at most 59 runtime settings.');
  for (const [key, setting] of runtimeEntries) {
    if (reserved.includes(key))
      throw new DefinitionError(
        `runtime.${key}`,
        'This key is reserved. Set it with the matching definition field or remove it.',
      );
    if (!text(key, 128))
      throw new DefinitionError(`runtime[${JSON.stringify(key)}]`, 'Use a nonempty key of at most 128 bytes.');
    if (!text(setting, 4096))
      throw new DefinitionError(`runtime.${key}`, 'Use a nonempty string of at most 4096 bytes.');
  }
  const { cases, expectedCases } = assertCaseInventory<I, E>(definition.cases);
  let collection: CollectionSchedule | undefined;
  if (definition.collection !== undefined) {
    json(definition.collection, MAX_ARTIFACT, 'collection');
    try {
      collection = deepFreeze(collectionSchedule(definition.collection, expectedCases));
    } catch (error) {
      if (!(error instanceof EvaluationError)) throw error;
      throw new DefinitionError(
        'collection',
        'Use { protocol: "seeded-balanced-v1", seed } with a nonempty seed of at most 256 bytes.',
      );
    }
  }
  const descriptor: EvaluationDescriptor = {
    datasetRevision: definition.datasetRevision,
    graderRevision: definition.graderRevision,
    runtime: {
      ...definition.runtime,
      configId: definition.configId,
      configRevision: definition.configRevision,
      execution: definition.execution,
      concurrency: '1',
      gradeRetries: '0',
      ...(collection ? collectionRuntime(collection) : {}),
    },
    expectedCases,
  };
  try {
    validateEvaluationDescriptor(descriptor);
  } catch (error) {
    throw new DefinitionError('descriptor', 'The definition does not form a valid public descriptor.', {
      cause: error,
    });
  }
  assertReportBudget(descriptor);
  const app = Object.freeze({
    descriptor: deepFreeze(structuredClone(descriptor)),
  }) as EvaluationApp<I, E, O>;
  const execute = definition.execute.bind(definition);
  const grade = definition.grade.bind(definition);
  definitions.set(app, {
    descriptor: deepFreeze(descriptor),
    execution: definition.execution,
    cases: deepFreeze(cases),
    execute: async (input) => execute(withBundleHelpers(input)),
    grade: async (input) => grade(input),
    ...(collection ? { collection } : {}),
  });
  return app;
}
export function assertReportBudget(descriptor: EvaluationDescriptor): void {
  const worst = {
    executionStatus: 'infrastructure_failed',
    gradingStatus: 'missing',
    reward: -Number.MAX_VALUE,
    outputRef: '\\'.repeat(1024),
    error: 'e'.repeat(128),
    usage: {
      inputTokens: Number.MAX_VALUE,
      outputTokens: Number.MAX_VALUE,
      costUsd: Number.MAX_VALUE,
    },
  };
  const report = {
    ...descriptor,
    parentVersionId: '0'.repeat(36),
    candidateVersionId: '0'.repeat(36),
    parentDigest: 'sha256:' + '0'.repeat(64),
    candidateDigest: 'sha256:' + '0'.repeat(64),
    evaluation: { requestId: '0'.repeat(36), attemptId: '0'.repeat(36) },
    results: descriptor.expectedCases.map((k) => ({ ...k, parent: worst, candidate: worst })),
  };
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const estimatedBytes = bytes(report);
  if (estimatedBytes <= MAX_REQUEST) return;
  const fixedBytes = bytes({ ...report, expectedCases: [], results: [] });
  // Reserve the largest pair in both arrays so the suggested size fits even after regrouping.
  const largestPairBytes = Math.max(
    ...report.results.map((row, i) => bytes(descriptor.expectedCases[i]) + bytes(row) + 2),
  );
  const maxPairsPerPartition = Math.floor((MAX_REQUEST - fixedBytes + 2) / largestPairBytes);
  const error = new EvaluationError('definition.report_budget_exceeded', { phase: 'preflight' });
  error.diagnostic.reportBudget = {
    estimatedBytes,
    limitBytes: MAX_REQUEST,
    expectedPairs: report.results.length,
    maxPairsPerPartition,
  };
  error.message = `definition.report_budget_exceeded: estimated ${estimatedBytes} bytes for ${report.results.length} pairs, limit ${MAX_REQUEST}. Partition the cases into groups of at most ${maxPairsPerPartition} pairs using this configuration.`;
  throw error;
}
