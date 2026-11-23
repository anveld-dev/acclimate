import { AcclimateError } from './errors.js';
import type { BundlePayload } from './types.js';
export type { CompatibilityTarget } from './types.js';
export { compatibilityIssues, assertCompatible } from './compatibility.js';
export type { CompatibilityIssue } from './compatibility.js';

export type DeliveryErrorCode =
  | 'cache_miss'
  | 'collision'
  | 'digest_mismatch'
  | 'invalid_cache'
  | 'invalid_overlay'
  | 'invalid_payload'
  | 'invalid_response'
  | 'stale_resolution'
  | 'unsafe_cache'
  | 'unsafe_destination'
  | 'unsafe_path'
  | 'unsupported_platform'
  | 'unsupported_schema';
/** Delivered content could not be resolved, verified, cached or written safely. */
export class DeliveryError extends AcclimateError<DeliveryErrorCode> {
  constructor(code: DeliveryErrorCode, message: string) {
    super(code, message);
    this.name = 'DeliveryError';
  }
}
const MAX_PAYLOAD = 1024 * 1024,
  MAX_FILES = 128,
  MAX_TEXT = 256 * 1024;

function validPath(path: unknown): path is string {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 240 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    !/^[-A-Za-z0-9._/]+$/.test(path)
  )
    return false;
  const parts = path.split('/');
  if (
    parts.some(
      (x) =>
        !x || x === '.' || x === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(x),
    )
  )
    return false;
  return true;
}
export function validatePayload(value: unknown): asserts value is BundlePayload {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value as object).some((k) => !['schemaVersion', 'files'].includes(k)) ||
    (value as any).schemaVersion !== 1 ||
    !Array.isArray((value as any).files) ||
    (value as any).files.length < 1 ||
    (value as any).files.length > MAX_FILES
  )
    throw new DeliveryError('unsupported_schema', 'Unsupported or malformed bundle payload schema');
  const files = (value as any).files as any[],
    seen = new Set<string>(),
    paths: string[] = [];
  let total = 0;
  for (const file of files) {
    if (
      !file ||
      typeof file !== 'object' ||
      Array.isArray(file) ||
      Object.keys(file).some((k) => !['path', 'kind', 'text'].includes(k)) ||
      !validPath(file.path) ||
      !['instruction', 'skill', 'memory'].includes(file.kind) ||
      typeof file.text !== 'string'
    )
      throw new DeliveryError('invalid_payload', 'Bundle contains an invalid file');
    const key = file.path.toLowerCase();
    if (seen.has(key))
      throw new DeliveryError(
        'invalid_payload',
        'Bundle contains duplicate or case-colliding paths',
      );
    seen.add(key);
    paths.push(file.path);
    const size = new TextEncoder().encode(file.text).byteLength;
    if (size > MAX_TEXT)
      throw new DeliveryError('invalid_payload', 'Bundle file exceeds the text size limit');
    total += size;
  }
  for (const p of paths)
    for (const q of paths)
      if (p.toLowerCase() !== q.toLowerCase() && q.toLowerCase().startsWith(p.toLowerCase() + '/'))
        throw new DeliveryError(
          'invalid_payload',
          'Bundle contains a file/directory path collision',
        );
  if (total > MAX_PAYLOAD)
    throw new DeliveryError('invalid_payload', 'Bundle exceeds the payload size limit');
}
