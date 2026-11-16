import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readPrivateJson } from './private-state.js';

export interface EvaluatorConfig {
  schemaVersion: 1;
  serviceUrl: string;
  projectId: string;
  evaluatorPrincipalId: string;
  evaluatorToken: string;
  journalRoot: string;
}

export class EvaluatorConfigError extends Error {
  constructor() {
    super('Evaluator configuration must be an explicit absolute owner-only JSON file with schemaVersion 1, serviceUrl, projectId, evaluatorPrincipalId, evaluatorToken and an absolute journalRoot. Inspect the private file without printing its credentials.');
  }
}

const fields = ['schemaVersion', 'serviceUrl', 'projectId', 'evaluatorPrincipalId', 'evaluatorToken', 'journalRoot'];
const bounded = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value === value.trim() &&
  !/[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(value) <= limit;

/** Reads only the explicitly selected file. No environment, launcher state or token fallback. */
export async function readEvaluatorConfig(filename: string): Promise<EvaluatorConfig> {
  try {
    if (!path.isAbsolute(filename)) throw new Error();
    const parent = path.dirname(filename);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 ||
        (process.getuid && info.uid !== process.getuid()) || await realpath(parent) !== path.resolve(parent)) throw new Error();
    const value = await readPrivateJson(filename);
    if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) || value.schemaVersion !== 1 ||
        !bounded(value.serviceUrl, 4096) || !bounded(value.projectId, 1024) ||
        !bounded(value.evaluatorPrincipalId, 1024) || !bounded(value.evaluatorToken, 4096) ||
        !bounded(value.journalRoot, 4096) || !path.isAbsolute(value.journalRoot)) throw new Error();
    const url = new URL(value.serviceUrl);
    const privateHop = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !privateHop) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return value as unknown as EvaluatorConfig;
  } catch {
    // Filesystem and JSON errors can contain private paths or file contents.
    throw new EvaluatorConfigError();
  }
}
