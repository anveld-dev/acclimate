import type { BundleFile, CompatibilityTarget } from '../types.js';
import { types as nodeTypes } from 'node:util';
import { validateEvaluationDescriptor } from '../validation.js';
import { DefinitionError, EvaluationError, OutputValidationError } from './errors.js';
import type {
  EvaluationApp,
  EvaluationCase,
  EvaluationDefinition,
  EvaluationDescriptor,
  EvaluationExecutionResult,
  EvaluationGradeResult,
  ExecuteInput,
  Json,
  JsonOutputCheck,
} from './types.js';
import { COLLECTION_RUNTIME_KEYS, collectionRuntime, collectionSchedule } from './collection.js';
import type { CollectionSchedule } from './collection.js';
export { OutputValidationError } from './errors.js';
const MAX_ARTIFACT = 1024 * 1024;
export interface CapturedDefinition<I = unknown, E = unknown, O = unknown> {
  descriptor: EvaluationDescriptor;
  execution: 'model-free' | 'live';
  cases: readonly EvaluationCase<I, E>[];
  execute: (input: Omit<ExecuteInput<I>, VersionHelper>) => Promise<EvaluationExecutionResult<O>>;
  grade: (input: Parameters<EvaluationDefinition<I, E, O>['grade']>[0]) => Promise<EvaluationGradeResult>;
  collection?: CollectionSchedule;
  /** Native harnesses whose compatibility rules payloads must meet. Never part of the descriptor. */
  compatibilityTargets?: readonly CompatibilityTarget[];
}
const COMPATIBILITY_TARGETS: readonly CompatibilityTarget[] = ['generic', 'codex', 'claude', 'pi', 'cursor'];
/** Normalize a declared compatibility target or list. */
export function compatibilityTargets(value: unknown): readonly CompatibilityTarget[] | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  if (!list.length || list.some((target) => !COMPATIBILITY_TARGETS.includes(target as CompatibilityTarget)))
    throw new DefinitionError(
      'compatibilityTarget',
      'Use generic, codex, claude, pi or cursor, or a list of them.',
    );
  return Object.freeze([...new Set(list as CompatibilityTarget[])]);
}
type VersionHelper = 'instructions' | 'instructionFiles' | 'skillFiles' | 'memoryFiles';
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
const filesOf = (version: ExecuteInput['version'], kind: BundleFile['kind']) =>
  Object.freeze((version?.payload?.files ?? []).filter((file) => file.kind === kind));
/** Add read-only helpers for the version's instructions, skills and memory files. */
export function withVersionHelpers<T extends { version: ExecuteInput["version"] }>(
  input: T,
): T & Pick<ExecuteInput, VersionHelper> {
  const helpers: PropertyDescriptorMap = {
    instructionFiles: { get: () => filesOf(input.version, 'instruction'), enumerable: false },
    skillFiles: { get: () => filesOf(input.version, 'skill'), enumerable: false },
    memoryFiles: { get: () => filesOf(input.version, 'memory'), enumerable: false },
    instructions: {
      get: () =>
        filesOf(input.version, 'instruction')
          .map((file) => file.text)
          .join('\n\n'),
      enumerable: false,
    },
  };
  return Object.defineProperties({ ...input }, helpers) as T & Pick<ExecuteInput, VersionHelper>;
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
      ...declaredScheduling(definition),
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
  const app = Object.freeze({
    descriptor: deepFreeze(structuredClone(descriptor)),
  }) as EvaluationApp<I, E, O>;
  const execute = definition.execute.bind(definition);
  const grade = definition.grade.bind(definition);
  const targets = compatibilityTargets(definition.compatibilityTarget);
  definitions.set(app, {
    ...(targets ? { compatibilityTargets: targets } : {}),
    descriptor: deepFreeze(descriptor),
    execution: definition.execution,
    cases: deepFreeze(cases),
    execute: async (input) => execute(withVersionHelpers(input)),
    grade: async (input) => grade(input),
    ...(collection ? { collection } : {}),
  });
  return app;
}
/** Fingerprint declared scheduling. Defaults keep existing descriptors byte-identical. */
export function declaredScheduling(definition: {
  concurrency?: number;
  gradeRetries?: number;
}): { concurrency: string; gradeRetries: string } {
  const concurrency = definition.concurrency ?? 1,
    gradeRetries = definition.gradeRetries ?? 0;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)
    throw new DefinitionError('concurrency', 'Use an integer from 1 to 64.');
  if (!Number.isInteger(gradeRetries) || gradeRetries < 0 || gradeRetries > 5)
    throw new DefinitionError('gradeRetries', 'Use an integer from 0 to 5.');
  return { concurrency: String(concurrency), gradeRetries: String(gradeRetries) };
}
