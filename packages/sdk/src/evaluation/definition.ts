import type { EvaluationDescriptor } from '../types.js';
import { types as nodeTypes } from 'node:util';
import { validateEvaluationDescriptor } from '../validation.js';
import { EvaluationError } from './errors.js';
import type { EvaluationApp, EvaluationCase, EvaluationDefinition, Json } from './types.js';
import { COLLECTION_RUNTIME_KEYS, collectionRuntime, collectionSchedule } from './collection.js';
import type { CollectionSchedule } from './collection.js';
export const MAX_ARTIFACT = 1024 * 1024,
  MAX_REQUEST = 2 * 1024 * 1024,
  MAX_PRIVATE = 128 * 1024 * 1024;
export interface CapturedDefinition<I = unknown, E = unknown, O = unknown> {
  descriptor: EvaluationDescriptor;
  execution: 'model-free' | 'live';
  cases: readonly EvaluationCase<I, E>[];
  execute: EvaluationDefinition<I, E, O>['execute'];
  grade: EvaluationDefinition<I, E, O>['grade'];
  collection?: CollectionSchedule;
}
const definitions = new WeakMap<object, CapturedDefinition<any, any, any>>();
/** Local adapter diagnostic. Field names are private and must stay off the wire. */
export class OutputValidationError extends TypeError {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`${field}: ${reason}`);
  }
}
function validateJson(value: unknown, maximum: number): asserts value is Json {
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
  visit(value, 'output');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum)
    throw new OutputValidationError(
      'output',
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
  if (!value) throw new EvaluationError('config.schema');
  return value;
}
/** Preserve the installed callbacks, fixtures and schedule while binding runtime evidence. */
export function bindEvaluationRuntime<I, E, O>(
  app: EvaluationApp<I, E, O>,
  commitments: Record<string, string>,
): EvaluationApp<I, E, O> {
  const captured = captureDefinition(app);
  if (Object.keys(commitments).some((key) => Object.hasOwn(captured.descriptor.runtime, key)))
    throw new EvaluationError('config.schema');
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
export function defineEvaluation<I, E, O>(
  definition: EvaluationDefinition<I, E, O>,
): EvaluationApp<I, E, O> {
  if (
    !definition ||
    typeof definition !== 'object' ||
    typeof definition.execute !== 'function' ||
    typeof definition.grade !== 'function' ||
    !['model-free', 'live'].includes(definition.execution) ||
    !Array.isArray(definition.cases)
  )
    throw new EvaluationError('config.schema');
  const reserved: readonly string[] = [
    'configId',
    'configRevision',
    'execution',
    'concurrency',
    'gradeRetries',
    ...COLLECTION_RUNTIME_KEYS,
  ];
  assertJson(definition.runtime, 512 * 1024);
  if (
    !definition.runtime ||
    typeof definition.runtime !== 'object' ||
    Object.keys(definition.runtime).some((k) => reserved.includes(k))
  )
    throw new EvaluationError('config.schema');
  assertJson(definition.cases, 16 * 1024 * 1024);
  const cases = structuredClone(definition.cases) as unknown as EvaluationCase<I, E>[],
    seen = new Set<string>();
  const expectedCases = cases.flatMap((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      !Object.hasOwn(item, 'input') ||
      !Object.hasOwn(item, 'expected') ||
      Object.keys(item).some((k) => !['caseId', 'input', 'expected', 'repetitions'].includes(k))
    )
      throw new EvaluationError('config.schema');
    const repetitions = item.repetitions ?? 1;
    if (
      !item.caseId ||
      seen.has(item.caseId) ||
      !Number.isInteger(repetitions) ||
      repetitions < 1 ||
      repetitions > 1000
    )
      throw new EvaluationError('config.schema');
    seen.add(item.caseId);
    return Array.from({ length: repetitions }, (_, repetition) => ({
      caseId: item.caseId,
      repetition,
    }));
  });
  if (definition.collection !== undefined) assertJson(definition.collection);
  const collection =
    definition.collection === undefined
      ? undefined
      : deepFreeze(collectionSchedule(definition.collection, expectedCases));
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
  } catch {
    throw new EvaluationError('config.schema');
  }
  assertReportBudget(descriptor);
  const app = Object.freeze({
    descriptor: deepFreeze(structuredClone(descriptor)),
  }) as EvaluationApp<I, E, O>;
  definitions.set(app, {
    descriptor: deepFreeze(descriptor),
    execution: definition.execution,
    cases: deepFreeze(cases),
    execute: definition.execute,
    grade: definition.grade,
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
