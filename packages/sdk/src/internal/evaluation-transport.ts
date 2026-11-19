import { AcclimateUsageError } from '../errors.js';
import { AcclimateClient } from '../client.js';
import { assertGuidedTarget, validateEvaluationServiceUrl } from '../evaluation-validation.js';
import { evaluationMutationFor } from './http-bridge.js';
import { postFingerprint } from './operation-fingerprint.js';

export type EvaluationMutationOperation =
  | 'start'
  | 'submit'
  | 'finish'
  | 'interrupt'
  | 'createRequest'
  | 'createDraft';
export interface EvaluationMutationScope {
  projectId: string;
  bundleId: string;
  requestId?: string;
  channel?: string;
}
export interface EvaluationTransportConfig {
  serviceUrl: string;
  projectId: string;
  evaluatorToken: string;
  evaluatorPrincipalId: string;
  fetch?: typeof fetch;
}

/** Closed typed routes only; no service data can introduce an HTTP target or executable. */
export function evaluationOperationPath(
  operation: EvaluationMutationOperation,
  scope: EvaluationMutationScope,
): string {
  assertGuidedTarget(scope);
  if (typeof scope.bundleId !== 'string' || !scope.bundleId)
    throw new AcclimateUsageError('Evaluation bundle is required', 'bundleId');
  const base = `/v1/workspaces/${scope.projectId}/bundles/${scope.bundleId}`;
  if (operation === 'submit') return `${base}/comparisons`;
  if (operation === 'createRequest') return `${base}/evaluation-requests`;
  if (operation === 'createDraft') {
    if (!scope.channel || !/^[A-Za-z0-9_-]{1,64}$/.test(scope.channel))
      throw new AcclimateUsageError('Invalid evaluation channel', 'channel');
    return `${base}/channels/${scope.channel}/drafts`;
  }
  if (!['start', 'finish', 'interrupt'].includes(operation) || !scope.requestId)
    throw new AcclimateUsageError('Unsupported evaluation operation', 'operation');
  return `${base}/evaluation-requests/${scope.requestId}/${operation}`;
}

export function evaluationFingerprint(
  operation: EvaluationMutationOperation,
  scope: EvaluationMutationScope,
  body: string,
): string {
  return postFingerprint(evaluationOperationPath(operation, scope), body);
}

export function createEvaluationTransport(config: EvaluationTransportConfig) {
  validateEvaluationServiceUrl(config.serviceUrl);
  assertGuidedTarget({ projectId: config.projectId, principalId: config.evaluatorPrincipalId });
  const client = new AcclimateClient({
    baseUrl: config.serviceUrl,
    token: config.evaluatorToken,
    scope: config.evaluatorPrincipalId,
    maxJsonResponseBytes: 4 * 1024 * 1024,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  return evaluationTransportForClient(client, config.projectId);
}

export function evaluationTransportForClient(client: AcclimateClient, projectId: string) {
  return {
    client,
    mutate<T>(
      operation: EvaluationMutationOperation,
      scope: EvaluationMutationScope,
      body: string,
      key: string,
    ): Promise<T> {
      if (scope.projectId !== projectId) throw new AcclimateUsageError('Evaluation target mismatch', 'projectId');
      if (typeof body !== 'string' || new TextEncoder().encode(body).length > 2 * 1024 * 1024)
        throw new AcclimateUsageError('Evaluation request exceeds its byte budget', 'body');
      return evaluationMutationFor(client)(
        evaluationOperationPath(operation, scope),
        body,
        key,
      ) as Promise<T>;
    },
  };
}
