import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { type AcclimateClient, ApiError } from '../client.js';
import { assertGuidedTarget } from '../evaluation-validation.js';
import { createEvaluatorClient } from '../internal/evaluation-transport.js';
import { captureDefinition } from './definition.js';
import { readEvaluatorConfig } from './config.js';
import { EvaluationError, toSafeDiagnostic } from './errors.js';
import { acquireFileLock } from './journal.js';
import { privateDirectory } from './private-state.js';
import type { PreflightOptions, PreflightResult } from './types.js';

export function redactDiagnosticText(value: string, secrets: readonly string[] = []): string {
  let text = value.slice(0, 16384);
  for (const secret of secrets)
    if (secret && secret.length >= 8) text = text.split(secret).join('[redacted]');
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, '$1 [redacted]')
    .replace(/\b(sk|pk|rk|ghp|gho|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{8,}/gu, '[redacted]')
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/giu,
      '$1[redacted]',
    );
}

async function assertBundleExists(api: AcclimateClient, workspaceId: string, bundleId: string) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pages = 0; pages < 100; pages++) {
    const page = await api.listBundles(workspaceId, { limit: 100, ...(cursor ? { cursor } : {}) });
    if (
      !page ||
      !Array.isArray(page.items) ||
      page.items.length > 100 ||
      page.items.some((item) => !item || typeof item.id !== 'string') ||
      (page.nextCursor !== null &&
        (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 4096))
    )
      throw new EvaluationError('evidence.malformed', { phase: 'preflight' });
    if (page.items.some((item) => item.id === bundleId)) return;
    if (page.nextCursor === null)
      throw new EvaluationError('bundle.missing', { phase: 'preflight' });
    if (seen.has(page.nextCursor))
      throw new EvaluationError('evidence.malformed', { phase: 'preflight' });
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new EvaluationError('evidence.incomplete', {
    phase: 'preflight',
    nextAction: 'ask_operator',
  });
}
export async function preflightEvaluation<I, E, O>(
  options: PreflightOptions<I, E, O>,
): Promise<PreflightResult> {
  captureDefinition(options.app);
  const config = await readEvaluatorConfig(options.configPath);
  const { bundleId } = options.target;
  try {
    assertGuidedTarget({ workspaceId: config.workspaceId, bundleId, principalId: config.evaluatorPrincipalId });
  } catch {
    throw new EvaluationError('guided_target_unsupported');
  }
  const result: PreflightResult = {
    schemaVersion: 1,
    status: 'ready',
    checkedAt: new Date().toISOString(),
    checks: [],
    nextAction: 'none',
  };
  const pass = (check: PreflightResult['checks'][number]['check']) =>
    result.checks.push({ check, status: 'passed' });
  let probe: string | undefined;
  let currentCheck: PreflightResult['checks'][number]['check'] = 'runtime';
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (process.platform === 'win32' || major < 22 || (major === 22 && minor < 22))
      throw new EvaluationError('runtime.unsupported');
    pass('runtime');
    pass('privateConfig');
    currentCheck = 'journalStorage';
    await privateDirectory(config.journalRoot, true);
    probe = await mkdtemp(path.join(config.journalRoot, '.preflight-'));
    pass('journalStorage');
    currentCheck = 'lock';
    const lock = await acquireFileLock(path.join(probe, 'ownership.lock'));
    await lock.close();
    pass('lock');
    currentCheck = 'targetBundle';
    await assertBundleExists(createEvaluatorClient(config), config.workspaceId, bundleId);
    pass('targetBundle');
    pass('descriptor');
  } catch (error) {
    const diagnostic = toSafeDiagnostic(
      error instanceof ApiError && error.status === 404
        ? new EvaluationError('bundle.missing', { phase: 'preflight', httpStatus: 404 })
        : error,
      'preflight',
    );
    result.status = 'blocked';
    result.nextAction = diagnostic.nextAction;
    result.checks.push({
      check: currentCheck,
      status: 'failed',
      code: diagnostic.code,
      ...(diagnostic.pathIssue && { pathIssue: diagnostic.pathIssue }),
      ...(diagnostic.field && { field: diagnostic.field }),
      ...(diagnostic.hint && { hint: diagnostic.hint }),
      ...(diagnostic.serviceUrl && { serviceUrl: diagnostic.serviceUrl }),
    });
  } finally {
    if (probe) await rm(probe, { recursive: true, force: true });
  }
  return result;
}
