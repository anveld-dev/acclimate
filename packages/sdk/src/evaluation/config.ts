import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { assertUnaliasedPath, readPrivateJson, readPrivateText } from './private-state.js';
import { EvaluationError, type PathIssue } from './errors.js';
import type { EvaluatorConfig, ReaderConfig } from './types.js';
export type { EvaluatorConfig, ReaderConfig } from './types.js';
export class EvaluatorConfigError extends EvaluationError {
  constructor(
    code:
      | 'config.schema'
      | 'config.permissions'
      | 'config.url'
      | 'config.missing' = 'config.schema',
    pathIssue?: PathIssue,
    detail: { field?: string; reason?: string; hint?: string } = {},
  ) {
    super(code, { pathIssue, ...detail });
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
/** Environment variable that supplies the evaluator token when the config names none. */
export const EVALUATOR_TOKEN_ENV = 'ACCLIMATE_EVALUATOR_TOKEN';
/** A private config or token file: absolute, unaliased, owner-only, in an owner-only directory. */
async function assertPrivateFile(filename: string, field = 'configPath'): Promise<void> {
  if (!path.isAbsolute(filename)) throw new EvaluatorConfigError('config.permissions', 'configAlias');
  // Report an absent file before judging its directory, so a typo in the path
  // is not mistaken for a permissions problem.
  try {
    await lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new EvaluatorConfigError('config.missing', undefined, {
        field,
        hint: `Check the ${field === 'configPath' ? 'config' : 'token file'} path. Relative CLI paths resolve against the current directory.`,
      });
  }
  try {
    await assertUnaliasedPath(filename, 'configAlias');
    const parent = path.dirname(filename),
      s = await lstat(parent);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      (await realpath(parent)) !== path.resolve(parent)
    )
      throw new Error();
    if (s.mode & 0o077 || (process.getuid && s.uid !== process.getuid()))
      throw new EvaluatorConfigError('config.permissions', 'configMode');
  } catch (error) {
    if (error instanceof EvaluationError) throw new EvaluatorConfigError('config.permissions', error.diagnostic.pathIssue);
    throw new EvaluatorConfigError('config.permissions');
  }
  // Preserve an absent explicit config as a distinct operator action before
  // private-file validation intentionally hides other filesystem details.
  try {
    const file = await lstat(filename);
    if (file.isFile() && ((file.mode & 0o077) || !(file.mode & 0o400) || (process.getuid && file.uid !== process.getuid())))
      throw new EvaluatorConfigError('config.permissions', 'configMode');
  } catch (error) {
    if (error instanceof EvaluatorConfigError) throw error;
    throw new EvaluatorConfigError(
      (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'config.missing' : 'config.permissions',
    );
  }
}
/** Read a token file with the config file's privacy checks. One trailing newline is allowed. */
async function readTokenFile(filename: string): Promise<string> {
  await assertPrivateFile(filename, 'evaluatorTokenFile');
  let text: string;
  try {
    text = await readPrivateText(filename, 8192);
  } catch (error) {
    if (error instanceof EvaluationError && error.code === 'config.permissions')
      throw new EvaluatorConfigError('config.permissions');
    throw new EvaluatorConfigError();
  }
  const token = text.replace(/\r?\n$/, '');
  if (!bounded(token, 4096)) throw new EvaluatorConfigError();
  return token;
}
async function config(filename: string, reader: boolean): Promise<EvaluatorConfig | ReaderConfig> {
  await assertPrivateFile(filename);
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
  if (Object.hasOwn(value, 'projectId'))
    throw new EvaluatorConfigError('config.schema', undefined, {
      field: 'projectId',
      reason: 'projectId was renamed to workspaceId in 0.2.0',
    });
  const fields = reader
    ? ['schemaVersion', 'serviceUrl', 'workspaceId', 'readToken']
    : ['schemaVersion', 'serviceUrl', 'workspaceId', 'evaluatorPrincipalId', 'journalRoot'];
  if (!reader && Object.hasOwn(value, 'captureCallbackErrors')) {
    if (typeof value.captureCallbackErrors !== 'boolean') throw new EvaluatorConfigError();
    fields.push('captureCallbackErrors');
  }
  // The token is inline, in a private file, or in ACCLIMATE_EVALUATOR_TOKEN.
  // Naming both an inline token and a token file is ambiguous and rejected.
  if (!reader) {
    if (Object.hasOwn(value, 'evaluatorToken') && Object.hasOwn(value, 'evaluatorTokenFile'))
      throw new EvaluatorConfigError();
    for (const field of ['evaluatorToken', 'evaluatorTokenFile'])
      if (Object.hasOwn(value, field)) fields.push(field);
  }
  if (
    value.schemaVersion !== 1 ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((k) => !fields.includes(k)) ||
    !bounded(value.workspaceId, 1024)
  )
    throw new EvaluatorConfigError();
  assertServiceUrl(value.serviceUrl);
  if (reader) {
    if (!bounded(value.readToken, 4096)) throw new EvaluatorConfigError();
  } else {
    if (
      !bounded(value.evaluatorPrincipalId, 1024) ||
      !bounded(value.journalRoot, 4096) ||
      !path.isAbsolute(value.journalRoot)
    )
      throw new EvaluatorConfigError();
    if (Object.hasOwn(value, 'evaluatorTokenFile')) {
      if (!bounded(value.evaluatorTokenFile, 4096) || !path.isAbsolute(value.evaluatorTokenFile))
        throw new EvaluatorConfigError();
      const { evaluatorTokenFile, ...rest } = value;
      value = { ...rest, evaluatorToken: await readTokenFile(evaluatorTokenFile) };
    } else if (!Object.hasOwn(value, 'evaluatorToken')) {
      value = { ...value, evaluatorToken: process.env[EVALUATOR_TOKEN_ENV] };
    }
    if (!bounded(value.evaluatorToken, 4096)) throw new EvaluatorConfigError();
  }
  return value as unknown as EvaluatorConfig | ReaderConfig;
}
export async function readEvaluatorConfig(filename: string): Promise<EvaluatorConfig> {
  return (await config(filename, false)) as EvaluatorConfig;
}
export async function readReaderConfig(filename: string): Promise<ReaderConfig> {
  return (await config(filename, true)) as ReaderConfig;
}
