import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { readPrivateJson } from './private-state.js';
import { EvaluationError } from './errors.js';
import type { EvaluatorConfig, ReaderConfig } from './types.js';
export type { EvaluatorConfig, ReaderConfig } from './types.js';
export class EvaluatorConfigError extends EvaluationError {
  constructor(
    code:
      | 'config.schema'
      | 'config.permissions'
      | 'config.url'
      | 'config.missing' = 'config.schema',
  ) {
    super(code);
    this.name = 'EvaluatorConfigError';
  }
}
const bounded = (x: unknown, n: number): x is string =>
  typeof x === 'string' &&
  x.length > 0 &&
  x === x.trim() &&
  !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(x) &&
  Buffer.byteLength(x) <= n;
export function assertServiceUrl(value: unknown): asserts value is string {
  if (!bounded(value, 4096)) throw new EvaluatorConfigError('config.url');
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new EvaluatorConfigError('config.url');
  }
  const loopback =
    u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (
    (u.protocol !== 'https:' && !loopback) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/'
  )
    throw new EvaluatorConfigError('config.url');
}
async function config(filename: string, reader: boolean): Promise<EvaluatorConfig | ReaderConfig> {
  if (!path.isAbsolute(filename)) throw new EvaluatorConfigError('config.permissions');
  try {
    const parent = path.dirname(filename),
      s = await lstat(parent);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      s.mode & 0o077 ||
      (process.getuid && s.uid !== process.getuid()) ||
      (await realpath(parent)) !== path.resolve(parent)
    )
      throw new Error();
  } catch {
    throw new EvaluatorConfigError('config.permissions');
  }
  // Preserve an absent explicit config as a distinct operator action before
  // private-file validation intentionally hides other filesystem details.
  try {
    await lstat(filename);
  } catch (error) {
    throw new EvaluatorConfigError(
      (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'config.missing' : 'config.permissions',
    );
  }
  let value: Record<string, unknown>;
  try {
    value = await readPrivateJson(filename);
  } catch (error) {
    if (error instanceof EvaluationError)
      throw new EvaluatorConfigError(
        error.code === 'config.permissions' ? 'config.permissions' : 'config.schema',
      );
    throw new EvaluatorConfigError('config.missing');
  }
  const fields = reader
    ? ['schemaVersion', 'serviceUrl', 'projectId', 'readToken']
    : [
        'schemaVersion',
        'serviceUrl',
        'projectId',
        'evaluatorPrincipalId',
        'evaluatorToken',
        'journalRoot',
      ];
  if (
    value.schemaVersion !== 1 ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((k) => !fields.includes(k)) ||
    !bounded(value.projectId, 1024)
  )
    throw new EvaluatorConfigError();
  assertServiceUrl(value.serviceUrl);
  if (reader) {
    if (!bounded(value.readToken, 4096)) throw new EvaluatorConfigError();
  } else if (
    !bounded(value.evaluatorPrincipalId, 1024) ||
    !bounded(value.evaluatorToken, 4096) ||
    !bounded(value.journalRoot, 4096) ||
    !path.isAbsolute(value.journalRoot)
  )
    throw new EvaluatorConfigError();
  return value as unknown as EvaluatorConfig | ReaderConfig;
}
export async function readEvaluatorConfig(filename: string): Promise<EvaluatorConfig> {
  return (await config(filename, false)) as EvaluatorConfig;
}
export async function readReaderConfig(filename: string): Promise<ReaderConfig> {
  return (await config(filename, true)) as ReaderConfig;
}
