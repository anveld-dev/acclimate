import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { validateEvaluationDescriptor } from '../evaluation-validation.js';
import type { EvaluationDescriptor } from '../types.js';
import { EvaluationError } from './errors.js';
import { declaredScheduling } from './definition.js';
import type { EvaluationCase, EvaluationDefinition, Json } from './types.js';

const SCHEMA = 'acclimate-evaluation-manifest-v1';
const LIMIT = 16 * 1024 * 1024;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
function fail(): never {
  throw new EvaluationError('config.schema');
}

export type GraderIdentity = { sourceUtf8: string } | { artifactDigest: string };
export interface EvaluationManifestInput<I = Json, E = Json> {
  configId: string;
  execution: 'model-free' | 'live';
  cases: readonly EvaluationCase<I, E>[];
  grader: GraderIdentity;
  runtime: { settings: Record<string, Json>; artifacts: Record<string, string> };
  /** Pairs in flight at once (1–64). Omit for 1. Fingerprinted in the descriptor runtime. */
  concurrency?: number;
  /** Extra grade attempts after a grader throws or times out (0–5). Omit for 0. */
  gradeRetries?: number;
}
export interface PrivateEvaluationManifest<I = Json, E = Json>
  extends EvaluationManifestInput<I, E> {
  schema: 'acclimate-evaluation-manifest-v1';
}
export type ManifestDefinition<I = Json, E = Json> = Omit<
  EvaluationDefinition<I, E, Json>,
  'execute' | 'grade'
>;
export interface EvaluationManifest<I = Json, E = Json> {
  /** Public identities and inventory only. */
  readonly descriptor: EvaluationDescriptor;
  /** Captured inputs for defineEvaluation({...manifest.definition, execute, grade}). */
  readonly definition: ManifestDefinition<I, E>;
  /** Private: includes inputs, expected answers, source/settings. Never submit publicly. */
  readonly privateManifest: PrivateEvaluationManifest<I, E>;
  readonly privateManifestJson: string;
}

const compareUtf8 = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
function validString(value: string): void {
  if (/[\ud800-\udfff]/u.test(value) || Buffer.byteLength(value) > 1024 * 1024) fail();
}
/** Exact finite binary64 decimal, eliminating JS/Python exponent/rounding differences. */
function decimal(value: number): string {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail();
  if (value === 0) return '0';
  if (Number.isInteger(value)) return String(value);
  const data = new DataView(new ArrayBuffer(8));
  data.setFloat64(0, Math.abs(value));
  const bits = data.getBigUint64(0),
    exponent = Number((bits >> 52n) & 2047n);
  let numerator = bits & ((1n << 52n) - 1n);
  let power = exponent === 0 ? -1074 : exponent - 1023 - 52;
  if (exponent !== 0) numerator += 1n << 52n;
  while (power < 0 && numerator % 2n === 0n) {
    numerator /= 2n;
    power++;
  }
  let out: string;
  if (power >= 0) out = String(numerator << BigInt(power));
  else {
    const places = -power,
      digits = String(numerator * 5n ** BigInt(places)).padStart(places + 1, '0');
    out = digits.slice(0, -places) + '.' + digits.slice(-places);
  }
  return (value < 0 ? '-' : '') + out;
}

/** Versioned manifest canonical JSON: UTF-8 keys, exact binary64 decimal, valid Unicode.
 * Rejects accessors, exotic objects, sparse arrays, cycles, unsafe integers and excess size/depth.
 */
export function canonicalEvaluationJson(value: unknown): string {
  let nodes = 0,
    bytes = 0;
  const active = new Set<object>();
  const charge = (part: string): string => {
    bytes += Buffer.byteLength(part);
    if (bytes > LIMIT) fail();
    return part;
  };
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 100_000 || depth > 64) fail();
    if (item === null || typeof item === 'boolean') return charge(String(item));
    if (typeof item === 'number') return charge(decimal(item));
    if (typeof item === 'string') {
      validString(item);
      return charge(JSON.stringify(item));
    }
    if (!item || typeof item !== 'object' || active.has(item) || nodeTypes.isProxy(item)) fail();
    const array = Array.isArray(item),
      proto = Object.getPrototypeOf(item);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail();
    const properties = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).some((key) => typeof key !== 'string')) fail();
    const keys = Object.keys(properties).filter((key) => !(array && key === 'length'));
    for (const key of keys) {
      validString(key);
      const property = properties[key];
      if (!('value' in property) || !property.enumerable) fail();
    }
    active.add(item);
    let result: string;
    if (array) {
      if (keys.length !== item.length || item.length > 100_000) fail();
      const values: string[] = [];
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(properties, String(i))) fail();
        values.push(visit(properties[String(i)].value, depth + 1));
      }
      charge('[' + ','.repeat(Math.max(0, values.length - 1)) + ']');
      result = '[' + values.join(',') + ']';
    } else {
      const values = keys.sort(compareUtf8).map((key) => {
        charge(JSON.stringify(key) + ':');
        return JSON.stringify(key) + ':' + visit(properties[key].value, depth + 1);
      });
      charge('{' + ','.repeat(Math.max(0, values.length - 1)) + '}');
      result = '{' + values.join(',') + '}';
    }
    active.delete(item);
    return result;
  };
  try {
    return visit(value, 0);
  } catch {
    return fail();
  }
}

function record(
  value: unknown,
  required: string[],
  optional: string[] = [],
): asserts value is Record<string, any> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail();
}
function identity(value: unknown, limit: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$/u.test(
      value,
    ) ||
    Buffer.byteLength(value) > limit ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail();
}
const hash = (domain: string, value: unknown): string =>
  'sha256:' +
  createHash('sha256')
    .update(SCHEMA + '\n' + domain + '\n' + canonicalEvaluationJson(value))
    .digest('hex');

/** Pure capture. No files, environment, credentials, execution or source introspection. */
export function createEvaluationManifest<I = Json, E = Json>(
  input: EvaluationManifestInput<I, E>,
): EvaluationManifest<I, E> {
  // Validate descriptors before reading fields or cloning, including getters/proxies.
  const captured = JSON.parse(canonicalEvaluationJson(input));
  record(captured, ['configId', 'execution', 'cases', 'grader', 'runtime'], ['concurrency', 'gradeRetries']);
  let declared: { concurrency: string; gradeRetries: string };
  try {
    declared = declaredScheduling(captured);
  } catch {
    fail();
  }
  identity(captured.configId, 128);
  if (
    !['live', 'model-free'].includes(captured.execution) ||
    !Array.isArray(captured.cases) ||
    !captured.cases.length
  )
    fail();
  record(captured.grader, [], ['sourceUtf8', 'artifactDigest']);
  if (Object.keys(captured.grader).length !== 1) fail();
  if ('sourceUtf8' in captured.grader) {
    if (typeof captured.grader.sourceUtf8 !== 'string' || !captured.grader.sourceUtf8.length)
      fail();
  } else if (
    typeof captured.grader.artifactDigest !== 'string' ||
    !digestPattern.test(captured.grader.artifactDigest)
  )
    fail();
  record(captured.runtime, ['settings', 'artifacts']);
  if (
    !captured.runtime.settings ||
    typeof captured.runtime.settings !== 'object' ||
    Array.isArray(captured.runtime.settings)
  )
    fail();
  const artifacts = captured.runtime.artifacts;
  if (
    !artifacts ||
    typeof artifacts !== 'object' ||
    Array.isArray(artifacts) ||
    !Object.keys(artifacts).length ||
    Object.keys(artifacts).length > 32
  )
    fail();
  for (const [name, digest] of Object.entries(artifacts)) {
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(name) ||
      typeof digest !== 'string' ||
      !digestPattern.test(digest)
    )
      fail();
  }
  const seen = new Set<string>();
  let total = 0;
  for (const item of captured.cases) {
    record(item, ['caseId', 'input', 'expected'], ['repetitions']);
    identity(item.caseId, 1024);
    if (seen.has(item.caseId)) fail();
    seen.add(item.caseId);
    if (!Object.hasOwn(item, 'repetitions')) item.repetitions = 1;
    if (
      !Number.isSafeInteger(item.repetitions) ||
      item.repetitions < 1 ||
      item.repetitions > 1000 ||
      (total += item.repetitions) > 1000
    )
      fail();
  }
  captured.cases.sort((a: EvaluationCase, b: EvaluationCase) => compareUtf8(a.caseId, b.caseId));
  const privateManifest = { schema: SCHEMA, ...captured };
  const privateManifestJson = canonicalEvaluationJson(privateManifest);
  const datasetRevision = hash('dataset', captured.cases),
    graderRevision = hash('grader', captured.grader);
  const runtimeRevision = hash('runtime', captured.runtime);
  const configRevision = hash('configuration', {
    configId: captured.configId,
    execution: captured.execution,
    datasetRevision,
    graderRevision,
    runtimeRevision,
  });
  const runtime = { manifestSchema: SCHEMA, runtimeRevision };
  const definition = {
    configId: captured.configId,
    execution: captured.execution,
    cases: captured.cases,
    configRevision,
    datasetRevision,
    graderRevision,
    runtime,
    ...(captured.concurrency !== undefined ? { concurrency: captured.concurrency } : {}),
    ...(captured.gradeRetries !== undefined ? { gradeRetries: captured.gradeRetries } : {}),
  };
  const descriptor = validateEvaluationDescriptor({
    datasetRevision,
    graderRevision,
    runtime: {
      ...runtime,
      configId: captured.configId,
      configRevision,
      execution: captured.execution,
      ...declared!,
    },
    expectedCases: captured.cases.flatMap((item: EvaluationCase) =>
      Array.from({ length: item.repetitions! }, (_, repetition) => ({
        caseId: item.caseId,
        repetition,
      })),
    ),
  });
  return Object.freeze({
    get descriptor() {
      return structuredClone(descriptor);
    },
    get definition() {
      return structuredClone(definition) as ManifestDefinition<I, E>;
    },
    get privateManifest() {
      return JSON.parse(privateManifestJson) as PrivateEvaluationManifest<I, E>;
    },
    privateManifestJson,
  });
}

/** Restore an application-retained private JSON manifest, rejecting duplicate decoded keys. */
export function restoreEvaluationManifest<I = Json, E = Json>(
  text: string,
): EvaluationManifest<I, E> {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > LIMIT) fail();
    validUnicodeText(text);
    const value = JSON.parse(text);
    const stack: ({ keys: Set<string>; expectingKey: boolean } | null)[] = [];
    for (let position = 0; position < text.length; position++) {
      const token = text[position];
      if (token === '{') stack.push({ keys: new Set(), expectingKey: true });
      else if (token === '[') stack.push(null);
      else if (token === '}' || token === ']') stack.pop();
      else if (token === ',') {
        const frame = stack.at(-1);
        if (frame) frame.expectingKey = true;
      } else if (token === '"') {
        const start = position++;
        while (text[position] !== '"') {
          if (text[position] === '\\') position++;
          position++;
        }
        const frame = stack.at(-1);
        if (frame?.expectingKey) {
          const key = JSON.parse(text.slice(start, position + 1));
          if (frame.keys.has(key)) fail();
          frame.keys.add(key);
          frame.expectingKey = false;
        }
      }
      if (stack.length > 65) fail();
    }
    // Canonical validation also rejects parsed lone surrogate escapes/nonfinite numbers.
    canonicalEvaluationJson(value);
    record(value, ['schema', 'configId', 'execution', 'cases', 'grader', 'runtime']);
    if (value.schema !== SCHEMA) fail();
    const { schema: _, ...input } = value;
    return createEvaluationManifest(input as EvaluationManifestInput<I, E>);
  } catch {
    return fail();
  }
}
function validUnicodeText(text: string): void {
  if (/[\ud800-\udfff]/u.test(text)) fail();
}
