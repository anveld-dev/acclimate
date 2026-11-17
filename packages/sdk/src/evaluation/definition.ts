import type { EvaluationDescriptor } from '../types.js';
import { types as nodeTypes } from 'node:util';
import { validateEvaluationDescriptor } from '../validation.js';
import { EvaluationError } from './errors.js';
import type { EvaluationApp, EvaluationCase, EvaluationDefinition, Json } from './types.js';
export const MAX_ARTIFACT = 1024 * 1024,
  MAX_REQUEST = 2 * 1024 * 1024,
  MAX_PRIVATE = 128 * 1024 * 1024;
export interface CapturedDefinition<I = unknown, E = unknown, O = unknown> {
  descriptor: EvaluationDescriptor;
  execution: 'model-free' | 'live';
  cases: readonly EvaluationCase<I, E>[];
  execute: EvaluationDefinition<I, E, O>['execute'];
  grade: EvaluationDefinition<I, E, O>['grade'];
}
const definitions = new WeakMap<object, CapturedDefinition<any, any, any>>();
export function assertJson(value: unknown, maximum = MAX_ARTIFACT): asserts value is Json {
  const active = new Set<object>();
  const visit = (x: unknown): void => {
    if (x === null || typeof x === 'boolean') return;
    if (typeof x === 'string') {
      if (/[\ud800-\udfff]/u.test(x)) throw new Error();
      return;
    }
    if (typeof x === 'number') {
      if (!Number.isFinite(x) || (Number.isInteger(x) && !Number.isSafeInteger(x)))
        throw new Error();
      return;
    }
    if (!x || typeof x !== 'object' || active.has(x) || nodeTypes.isProxy(x)) throw new Error();
    if (
      !Array.isArray(x) &&
      Object.getPrototypeOf(x) !== Object.prototype &&
      Object.getPrototypeOf(x) !== null
    )
      throw new Error();
    if (
      Reflect.ownKeys(x).some((k) => typeof k !== 'string' || /[\ud800-\udfff]/u.test(k))
    )
      throw new Error();
    active.add(x);
    if (Array.isArray(x)) {
      if (Object.getPrototypeOf(x) !== Array.prototype) throw new Error();
      const entries = Object.getOwnPropertyDescriptors(x) as unknown as Record<
          string,
          PropertyDescriptor
        >,
        length = entries.length?.value;
      if (
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        Object.keys(entries).length !== length + 1
      )
        throw new Error();
      for (let i = 0; i < length; i++) {
        const item = entries[String(i)];
        if (!item || !('value' in item) || !item.enumerable) throw new Error();
        visit(item.value);
      }
    } else
      for (const d of Object.values(Object.getOwnPropertyDescriptors(x))) {
        if (!('value' in d) || !d.enumerable) throw new Error();
        visit(d.value);
      }
    active.delete(x);
  };
  try {
    visit(value);
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) throw new Error();
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
  const reserved = ['configId', 'configRevision', 'execution', 'concurrency', 'gradeRetries'];
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
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_REQUEST)
    throw new EvaluationError('definition.report_budget_exceeded');
}
