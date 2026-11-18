/** Disposable model-free service fixture used by evaluator regressions only. */
import { createHash } from 'node:crypto';
import { registerEvaluationMutation } from '../../packages/sdk/src/internal/http-bridge.js';
import type {
  AcclimateClient,
  BundlePayload,
  ComparisonRequest,
  Evaluation,
  VersionMetadata,
} from '../../packages/sdk/src/index.js';
import type { EvaluationDescriptor } from './descriptor.js';

export const projectId = '10000000-0000-4000-8000-000000000001';
export const bundleId = '20000000-0000-4000-8000-000000000002';
export const requestId = '30000000-0000-4000-8000-000000000003';
export const evaluatorPrincipalId = '40000000-0000-4000-8000-000000000004';
export const parentId = '50000000-0000-4000-8000-000000000005';
export const candidateId = '60000000-0000-4000-8000-000000000006';
export const comparisonId = '70000000-0000-4000-8000-000000000007';
export const serviceUrl = 'http://127.0.0.1:15999';
export function fixture(
  descriptor: EvaluationDescriptor,
  bundles?: [BundlePayload, BundlePayload],
) {
  const content = (safe: boolean): BundlePayload => ({
    schemaVersion: 1,
    files: [
      { path: 'AGENTS.md', kind: 'instruction', text: 'Use installed policies and review skill.' },
      {
        path: 'skills/retry-review/SKILL.md',
        kind: 'skill',
        text: '---\nname: retry-review\ndescription: Review unsafe retries.\n---\nReview side effects.',
      },
      {
        path: 'payment-policy.json',
        kind: 'memory',
        text: JSON.stringify({ maxAttempts: 2, idempotency: safe ? 'request' : 'none' }),
      },
    ],
  });
  const bytes = new Map(
    (bundles ?? [content(false), content(true)]).map((payload, i) => [
      i ? candidateId : parentId,
      new TextEncoder().encode(JSON.stringify(payload)),
    ]),
  );
  const version = (id: string): VersionMetadata => ({
    id,
    bundleId,
    parentVersionId: id === candidateId ? parentId : null,
    digest: `sha256:${createHash('sha256').update(bytes.get(id)!).digest('hex')}`,
    createdAt: '2026-11-14T00:00:00Z',
  });
  let request: Evaluation = {
    ...structuredClone(descriptor),
    id: requestId,
    proposalId: null,
    parentVersionId: parentId,
    candidateVersionId: candidateId,
    parentDigest: version(parentId).digest,
    candidateDigest: version(candidateId).digest,
    requireBoundEvidence: true,
    status: 'requested',
    evaluatorPrincipal: null,
    attemptId: null,
    comparisonId: null,
    error: null,
    createdAt: '',
    updatedAt: '',
  };
  const events: Array<{ kind: string; key: string; body: unknown }> = [];
  const reports = new Map<string, string>();
  let complete = true;
  let savedComparison: import('../../packages/sdk/src/types.js').Comparison | undefined;
  const api = {
    baseUrl: serviceUrl,
    scope: evaluatorPrincipalId,
    getEvaluationCapabilities: async () => ({
      schemaVersion: 1,
      projectId,
      principalId: evaluatorPrincipalId,
      checkedAt: new Date().toISOString(),
      readUnpublished: true,
      writeEvaluation: true,
      retainedEvaluationOperations: true,
    }),
    getComparison: async () => structuredClone(savedComparison),
    getEvaluation: async () => structuredClone(request),
    getVersion: async (_p: string, _b: string, id: string) => version(id),
    getPayload: async (_p: string, _b: string, id: string) => bytes.get(id)!,
    startEvaluation: async (
      _p: string,
      _b: string,
      _id: string,
      body: { attemptId: string },
      key: string,
    ) => {
      events.push({ kind: 'start', key, body });
      request = {
        ...request,
        status: 'running',
        attemptId: body.attemptId,
        evaluatorPrincipal: evaluatorPrincipalId,
      };
      return structuredClone(request);
    },
    createComparison: async (_p: string, _b: string, body: ComparisonRequest, key: string) => {
      events.push({ kind: 'submit', key, body });
      const previous = reports.get(key);
      if (previous && previous !== JSON.stringify(body))
        throw new Error('idempotency body changed');
      reports.set(key, JSON.stringify(body));
      complete = body.results.every((pair) =>
        [pair.parent, pair.candidate].every(
          (outcome) =>
            outcome.executionStatus !== 'infrastructure_failed' &&
            outcome.gradingStatus === 'scored' &&
            outcome.reward !== null,
        ),
      );
      return (savedComparison = {
        ...body,
        id: comparisonId,
        complete,
        submitter: evaluatorPrincipalId,
        createdAt: '',
      });
    },
    finishEvaluation: async (
      _p: string,
      _b: string,
      _id: string,
      body: { attemptId: string; comparisonId: string },
      key: string,
    ) => {
      events.push({ kind: 'finish', key, body });
      request = {
        ...request,
        status: complete ? 'completed' : 'failed',
        comparisonId: body.comparisonId,
      };
      return structuredClone(request);
    },
  } as unknown as AcclimateClient;
  registerEvaluationMutation(api, async (operationPath, body, key) => {
    const value = JSON.parse(body);
    if (operationPath.endsWith('/comparisons'))
      return api.createComparison(projectId, bundleId, value, key);
    if (operationPath.endsWith('/start'))
      return api.startEvaluation(projectId, bundleId, requestId, value, key);
    if (operationPath.endsWith('/finish'))
      return api.finishEvaluation(projectId, bundleId, requestId, value, key);
    throw new Error('Unexpected fixture mutation');
  });
  return {
    api,
    events,
    version,
    bytes,
    get request() {
      return request;
    },
    set request(value: Evaluation) {
      request = value;
    },
  };
}
