import type { EvaluationDescriptor, EvaluationHandoff } from './types.js';

const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields = ['datasetRevision', 'graderRevision', 'runtime', 'expectedCases'];

export class EvaluationConfigurationError extends Error {
  constructor(
    readonly code:
      | 'descriptor.mismatch'
      | 'config.schema'
      | 'config.url'
      | 'guided_target_unsupported',
  ) {
    super('Invalid public evaluation configuration. Check its documented fields and limits.');
    this.name = 'EvaluationConfigurationError';
  }
}

function object(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (entry) => !entry.get && !entry.set,
    )
  );
}
function scalarString(value: unknown, limit: number): value is string {
  if (typeof value !== 'string' || !value.trim() || encoder.encode(value).length > limit)
    return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function plainInventory(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 1000
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const property = descriptors[String(index)];
    if (!property || !('value' in property) || !property.enumerable) return false;
  }
  return keys.every(
    (key) =>
      key === 'length' ||
      (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length),
  );
}

/** Closed public authoring shape. Returns fresh data; never echoes rejected input. */
export function validateEvaluationDescriptor(value: unknown): EvaluationDescriptor {
  const invalid = () => new EvaluationConfigurationError('config.schema');
  if (
    !object(value) ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    !scalarString(value.datasetRevision, 1024) ||
    !scalarString(value.graderRevision, 1024) ||
    !object(value.runtime) ||
    !plainInventory(value.expectedCases)
  )
    throw invalid();
  const entries = Object.entries(value.runtime);
  if (
    !entries.length ||
    entries.length > 64 ||
    entries.some(([key, setting]) => !scalarString(key, 128) || !scalarString(setting, 4096)) ||
    !scalarString(value.runtime.configId, 128) ||
    !scalarString(value.runtime.configRevision, 1024)
  )
    throw invalid();
  const seen = new Set<string>();
  const expectedCases = value.expectedCases.map((item) => {
    if (
      !object(item) ||
      Object.keys(item).some((key) => key !== 'caseId' && key !== 'repetition') ||
      !scalarString(item.caseId, 1024) ||
      typeof item.repetition !== 'number' ||
      !Number.isInteger(item.repetition) ||
      item.repetition < 0 ||
      item.repetition > 0xffffffff
    )
      throw invalid();
    const identity = JSON.stringify([item.caseId, item.repetition]);
    if (seen.has(identity)) throw invalid();
    seen.add(identity);
    return { caseId: item.caseId, repetition: item.repetition };
  });
  return {
    datasetRevision: value.datasetRevision,
    graderRevision: value.graderRevision,
    runtime: Object.fromEntries(entries) as Record<string, string>,
    expectedCases,
  };
}

export interface GuidedTarget {
  projectId: string;
  bundleId?: string;
  requestId?: string;
  principalId?: string;
  channel?: string;
}

/** The same subset recognized by retained operation routing; legacy raw clients stay broader. */
export function assertGuidedTarget(scope: GuidedTarget): void {
  if (
    !scope ||
    typeof scope.projectId !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(scope.projectId) ||
    ['.', '..'].includes(scope.projectId) ||
    (scope.bundleId !== undefined &&
      (typeof scope.bundleId !== 'string' || !uuid.test(scope.bundleId))) ||
    (scope.requestId !== undefined &&
      (typeof scope.requestId !== 'string' || !uuid.test(scope.requestId))) ||
    (scope.channel !== undefined &&
      (typeof scope.channel !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(scope.channel))) ||
    (scope.principalId !== undefined &&
      (!scalarString(scope.principalId, 1024) ||
        scope.principalId !== scope.principalId.trim() ||
        /[\u0000-\u001f\u007f]/.test(scope.principalId)))
  )
    throw new EvaluationConfigurationError('guided_target_unsupported');
}

export function validateEvaluationServiceUrl(value: unknown): string {
  if (!scalarString(value, 4096) || value !== value.trim())
    throw new EvaluationConfigurationError('config.url');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EvaluationConfigurationError('config.url');
  }
  const privateHop =
    url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !privateHop) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new EvaluationConfigurationError('config.url');
  return value; // Exact configured spelling is part of durable journal identity.
}

export function validateEvaluationHandoff(value: unknown): EvaluationHandoff {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    Object.keys(value).length !== 6 ||
    Object.keys(value).some(
      (key) =>
        ![
          'schemaVersion',
          'serviceUrl',
          'projectId',
          'bundleId',
          'requestId',
          'configuration',
        ].includes(key),
    )
  )
    throw new EvaluationConfigurationError('config.schema');
  if (
    typeof value.projectId !== 'string' ||
    typeof value.bundleId !== 'string' ||
    typeof value.requestId !== 'string'
  )
    throw new EvaluationConfigurationError('config.schema');
  assertGuidedTarget({
    projectId: value.projectId,
    bundleId: value.bundleId,
    requestId: value.requestId,
  });
  return {
    schemaVersion: 1,
    serviceUrl: validateEvaluationServiceUrl(value.serviceUrl),
    projectId: value.projectId,
    bundleId: value.bundleId,
    requestId: value.requestId,
    configuration: validateEvaluationDescriptor(value.configuration),
  };
}

export type EvaluationMismatchField =
  | 'datasetRevision'
  | 'graderRevision'
  | 'runtime.configId'
  | 'runtime.configRevision'
  | 'runtime'
  | 'expectedCases';

/** Structural agreement also supports historical descriptors without new authoring identity fields. */
export function evaluationDescriptorDifferences(
  actual: EvaluationDescriptor,
  expected: EvaluationDescriptor,
): EvaluationMismatchField[] {
  const differences: EvaluationMismatchField[] = [];
  if (actual.datasetRevision !== expected.datasetRevision) differences.push('datasetRevision');
  if (actual.graderRevision !== expected.graderRevision) differences.push('graderRevision');
  const left = actual.runtime ?? {},
    right = expected.runtime ?? {};
  if (left.configId !== right.configId) differences.push('runtime.configId');
  if (left.configRevision !== right.configRevision) differences.push('runtime.configRevision');
  const otherKeys = new Set(
    [...Object.keys(left), ...Object.keys(right)].filter(
      (key) => !['configId', 'configRevision'].includes(key),
    ),
  );
  if ([...otherKeys].some((key) => left[key] !== right[key])) differences.push('runtime');
  const inventory = (value: EvaluationDescriptor) =>
    (value.expectedCases ?? [])
      .map((item) => JSON.stringify([item.caseId, item.repetition]))
      .sort();
  const a = inventory(actual),
    b = inventory(expected);
  if (
    new Set(a).size !== a.length ||
    new Set(b).size !== b.length ||
    JSON.stringify(a) !== JSON.stringify(b)
  )
    differences.push('expectedCases');
  return differences;
}
