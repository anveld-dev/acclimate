import { createHash } from 'node:crypto';
import type { AcclimateClient } from '../../client.js';
import { assertCompatible } from '../../compatibility.js';
import { validatePayload, evaluationDescriptorDifferences } from '../../validation.js';
import { verifyPayloadBytes } from '../../verification.js';
import { runEvaluation, ExecutionUncertainError, EvaluationError } from '../../evaluation/index.js';
import { checkComparison, validateEvaluationPolicy } from '../../evaluation/policy.js';
import type { EvaluationPolicyV1 } from '../../evaluation/policy.js';
import type { EvaluationApp, EvaluationRunResult, RunEvaluationOptions } from '../../evaluation/types.js';
import type {
  BundlePayload, ChannelResolution, Comparison, CompatibilityTarget, Evaluation,
  EvaluationDescriptor, EvaluationRequest, Promotion, Proposal, VersionMetadata, VerifiedBundle,
} from '../../types.js';
import type {
  LearningAdapter, LearningOperation, OperationKind, ReleaseReview,
  SelectionVerdict, WorkContext, WorkReceipt,
} from '../types.js';
import { operationRuntime } from '../operations.js';
import { evaluationMutationFor } from '../../internal/http-bridge.js';
import { captureDefinition } from '../../evaluation/definition.js';
import type { Ref, ExperimentManifestV1 } from '../evidence-types.js';
import { canonicalJson, hashArtifact, validateRef, assertArtifactBytes, validateExperimentGraph, sameScope, projectExperimentRuntime, LearningEvidenceError } from '../identity.js';
import type { PublicExperimentCommitments } from '../identity.js';

export interface AcclimateLearningAppInput {
  operation: Readonly<LearningOperation>;
  /** Must be included when defineEvaluation captures the installed app. */
  runtime: Readonly<Record<string, string>>;
  experiment: Ref<ExperimentManifestV1>;
  artifacts: WorkContext['artifacts'];
}
export interface AcclimateLearningAdapterOptions {
  client: AcclimateClient;
  projectId: string;
  bundleId: string;
  channel: string;
  revision: string;
  evaluatorConfigPath: string;
  app(input: AcclimateLearningAppInput): EvaluationApp<any, any, any> | Promise<EvaluationApp<any, any, any>>;
  /** Must resolve to the frozen full treatment/control graph for this exact operation. */
  prepareExperiment(input: { operation: Readonly<LearningOperation>; artifacts: WorkContext['artifacts'] }): Promise<Ref<ExperimentManifestV1>>;
  /** Explicit opt-in to publishing nonsecret digests, or an application-owned opaque commitment projection. */
  disclosure: 'sha256' | ((refs: { experiment: Ref<ExperimentManifestV1>; parentHarness: Ref; candidateHarness: Ref; controls: Ref }) => PublicExperimentCommitments);
  policies: { development: EvaluationPolicyV1; audit: EvaluationPolicyV1 };
  allowedPaths: readonly string[];
  compatibilityTarget?: CompatibilityTarget;
  /** Pure, deterministic local planning only. External generation uses the service proposer. */
  propose?(operation: Readonly<LearningOperation>, baseline: VerifiedBundle): BundlePayload;
  /** Default service-proposer hypothesis; evidence comes only from admitted teaching views. */
  hypothesis?: string;
  allowLive?: boolean;
  /** All-in bounds must include every underlying SDK/provider retry, not just HTTP admission. */
  maximumLiabilityMicroUsd?: Record<OperationKind, number | null>;
  /** Trusted installed evaluator seam; defaults to the SDK's durable runEvaluation. */
  runner?(options: RunEvaluationOptions<any, any, any>): Promise<EvaluationRunResult>;
}

export class AcclimateLearningAdapterError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AcclimateLearningAdapterError'; }
}
function fail(code: string): never { throw new AcclimateLearningAdapterError(code); }
const digestPattern = /^sha256:[0-9a-f]{64}$/;
function version(value: VersionMetadata, bundleId: string): VersionMetadata {
  if (!value || !value.id || value.bundleId !== bundleId || !digestPattern.test(value.digest) ||
      !(value.parentVersionId === null || typeof value.parentVersionId === 'string'))
    fail('learning.adapter.version_binding');
  return structuredClone(value);
}
function fixedEdits(parent: BundlePayload, candidate: BundlePayload, allowed: readonly string[]): void {
  validatePayload(candidate);
  const original = new Map(parent.files.map(file => [file.path, file]));
  if (candidate.files.length !== original.size) fail('learning.adapter.mutation_policy');
  for (const file of candidate.files) {
    const old = original.get(file.path);
    if (!old || old.kind !== file.kind || (old.text !== file.text && !allowed.includes(file.path)))
      fail('learning.adapter.mutation_policy');
  }
  if (canonicalJson(parent) === canonicalJson(candidate)) fail('learning.adapter.no_change');
}
function fingerprint(path: string, body: unknown): string {
  return 'sha256:' + createHash('sha256').update('POST\0').update(path).update('\0')
    .update(JSON.stringify(body)).digest('hex');
}
function cost(comparison: Comparison): number | null {
  let total = 0;
  for (const pair of comparison.results) for (const side of [pair.parent, pair.candidate]) {
    const amount = side.usage?.costUsd;
    if (amount === undefined || !Number.isFinite(amount) || amount < 0) return null;
    total += amount;
  }
  const microUsd = Math.ceil(total * 1_000_000);
  return Number.isSafeInteger(microUsd) ? microUsd : null;
}
const receipt = (
  operation: LearningOperation, status: WorkReceipt['status'], executionSettled: boolean,
  reason?: string,
): WorkReceipt => ({ operationId: operation.id, status, executionSettled, costMicroUsd: null,
  ...(reason ? { reason } : {}) });

/** Real service transport + installed app evaluator. It has no promotion operation. */
export function createAcclimateLearningAdapter(options: AcclimateLearningAdapterOptions): LearningAdapter {
  const { client, app: installedApp, propose: installedProposer, prepareExperiment, disclosure } = options;
  const installedRunner = options.runner ?? runEvaluation;
  const evaluatorConfigPath = options.evaluatorConfigPath;
  const allowLive = options.allowLive ?? false;
  const compatibilityTarget = options.compatibilityTarget ?? 'generic';
  const hypothesis = options.hypothesis ?? 'Improve the allowed content using only the admitted teaching evidence.';
  const mutate = async <T>(path: string, body: unknown, key: string): Promise<T> =>
    await evaluationMutationFor(client)(path, JSON.stringify(body), key) as T;
  const scope = { projectId: options.projectId, bundleId: options.bundleId, channel: options.channel };
  if (!options.revision || !scope.projectId || !scope.bundleId || !scope.channel ||
      typeof prepareExperiment !== 'function' || !(disclosure === 'sha256' || typeof disclosure === 'function') ||
      !options.allowedPaths.length || new Set(options.allowedPaths).size !== options.allowedPaths.length)
    fail('learning.adapter.configuration');
  const allowedPaths = Object.freeze([...options.allowedPaths]);
  const policies = structuredClone(options.policies);
  validateEvaluationPolicy(policies.development);
  validateEvaluationPolicy(policies.audit);
  const liability = structuredClone(options.maximumLiabilityMicroUsd ?? {
    propose: installedProposer ? 0 : null, development: null, audit: null,
  });
  for (const amount of Object.values(liability))
    if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0))
      fail('learning.adapter.configuration');
  if (!installedProposer && liability.propose !== null) fail('learning.adapter.opaque_proposer_liability');
  const root = `/v1/projects/${encodeURIComponent(scope.projectId)}/bundles/${encodeURIComponent(scope.bundleId)}`;
  function assertOperation(op: LearningOperation): void {
    if (op.scope.projectId !== scope.projectId || op.scope.bundleId !== scope.bundleId ||
        op.channel !== scope.channel || op.baseline.channel !== scope.channel ||
        !op.id || !op.attemptId || !op.key || !digestPattern.test(op.definitionDigest))
      fail('learning.adapter.operation_binding');
    version(op.baseline.version, scope.bundleId);
    if (op.kind !== 'propose') {
      if (!op.candidate || op.candidate.parentVersionId !== op.baseline.version.id)
        fail('learning.adapter.candidate_binding');
      version(op.candidate, scope.bundleId);
    }
    if (op.kind === 'audit' && (!op.auditCohort || !digestPattern.test(op.auditCohort.digest)))
      fail('learning.adapter.audit_binding');
  }
  async function verified(meta: VersionMetadata): Promise<VerifiedBundle> {
    const observed = version(await client.getVersion(scope.projectId, scope.bundleId, meta.id), scope.bundleId);
    if (observed.id !== meta.id || observed.digest !== meta.digest || observed.parentVersionId !== meta.parentVersionId)
      fail('learning.adapter.version_binding');
    const payload = verifyPayloadBytes(await client.getPayload(scope.projectId, scope.bundleId, meta.id), meta.digest);
    return { version: observed, payload, resolvedAt: Date.now(), stale: false };
  }
  async function committed<T>(op: LearningOperation, path: string, body: unknown): Promise<T | null> {
    const observation = await client.getOperation(scope.projectId, op.key, path);
    if (observation.status !== 'committed') return null;
    if (observation.operationId !== op.key || observation.path !== path ||
        observation.requestFingerprint !== fingerprint(path, body))
      fail('learning.adapter.operation_binding');
    return observation.result as T;
  }
  async function proposed(op: LearningOperation, context: WorkContext, reconcile: boolean): Promise<WorkReceipt> {
    const baseline = await verified(op.baseline.version);
    context.signal.throwIfAborted();
    if (installedProposer) {
      // This seam is deliberately synchronous/pure. A paid app proposer needs its own retained attempt protocol.
      const payload = structuredClone(installedProposer(structuredClone(op), structuredClone(baseline)));
      fixedEdits(baseline.payload, payload, allowedPaths);
      assertCompatible(payload, compatibilityTarget);
      const body = { parentVersionId: baseline.version.id, payload };
      const created = reconcile
        ? await committed<VersionMetadata>(op, root + '/versions', body)
        : await mutate<VersionMetadata>(root + '/versions', body, op.key);
      if (!created) return receipt(op, 'unknown', false, 'learning.adapter.operation_unobserved');
      const candidate = await verified(version(created, scope.bundleId));
      if (candidate.version.parentVersionId !== baseline.version.id ||
          canonicalJson(candidate.payload) !== canonicalJson(payload)) fail('learning.adapter.candidate_binding');
      return { operationId: op.id, status: 'succeeded', executionSettled: true,
        output: { kind: 'proposal', candidate: candidate.version }, costMicroUsd: 0 };
    }
    const body = {
      parentVersionId: baseline.version.id,
      allowedPaths: [...allowedPaths],
      hypothesis,
      evidence: [...op.teaching],
    };
    const created = reconcile
      ? await committed<Proposal>(op, root + '/proposals', body)
      : await mutate<Proposal>(root + '/proposals', body, op.key);
    if (!created) return receipt(op, 'unknown', false, 'learning.adapter.operation_unobserved');
    if (!created.id || created.parentVersionId !== baseline.version.id) fail('learning.adapter.proposal_binding');
    const proposal = await client.getProposal(scope.projectId, scope.bundleId, created.id);
    if (proposal.id !== created.id || proposal.parentVersionId !== baseline.version.id)
      fail('learning.adapter.proposal_binding');
    if (proposal.status === 'queued' || proposal.status === 'running')
      return receipt(op, 'pending', false, 'learning.adapter.proposal_pending');
    if (proposal.status === 'failed') return receipt(op, 'unknown', false, 'learning.adapter.proposal_failed_settlement_unknown');
    if (!proposal.candidate) fail('learning.adapter.candidate_binding');
    const candidate = await verified(proposal.candidate);
    if (candidate.version.parentVersionId !== baseline.version.id) fail('learning.adapter.candidate_binding');
    fixedEdits(baseline.payload, candidate.payload, allowedPaths);
    assertCompatible(candidate.payload, compatibilityTarget);
    return { operationId: op.id, status: 'succeeded', executionSettled: true,
      output: { kind: 'proposal', candidate: candidate.version }, costMicroUsd: null };
  }
  async function evaluated(op: LearningOperation, context: WorkContext, reconcile: boolean): Promise<WorkReceipt> {
    const experiment = await prepareExperiment({ operation: structuredClone(op), artifacts: context.artifacts });
    validateRef(experiment);
    const manifest = await context.artifacts.readArtifact(experiment);
    assertArtifactBytes(experiment, canonicalJson(manifest));
    const graph = await validateExperimentGraph({ manifest, resolve: ref => context.artifacts.readArtifact(ref) });
    if (!sameScope(manifest.scope, op.scope) ||
        graph.parent.content.versionId !== op.baseline.version.id || graph.parent.content.digest !== op.baseline.version.digest ||
        graph.candidate.content.versionId !== op.candidate!.id || graph.candidate.content.digest !== op.candidate!.digest)
      fail('learning.adapter.experiment_binding');
    if (op.kind === 'audit' && graph.controls.dataset.sha256 !== op.auditCohort!.digest)
      fail('learning.adapter.audit_dataset_binding');
    const refs = { experiment, parentHarness: manifest.arms.parent, candidateHarness: manifest.arms.candidate, controls: manifest.controls };
    const commitments = disclosure === 'sha256'
      ? { experiment: experiment.sha256, parentHarness: refs.parentHarness.sha256,
          candidateHarness: refs.candidateHarness.sha256, controls: refs.controls.sha256, scheme: 'sha256' as const }
      : disclosure(refs);
    const runtime = { ...projectExperimentRuntime(commitments), ...operationRuntime(op) };
    const app = await installedApp({ operation: structuredClone(op), runtime: Object.freeze({ ...runtime }),
      experiment, artifacts: context.artifacts });
    const captured = captureDefinition(app);
    if (canonicalJson(captured.descriptor.expectedCases) !== canonicalJson(graph.expectedCases))
      fail('learning.adapter.dataset_binding');
    const collection = await context.artifacts.readArtifact(graph.controls.collection);
    if (collection.mode.kind === 'deterministic' ? captured.collection !== undefined :
        !captured.collection || captured.collection.protocol !== 'seeded-balanced-v1' ||
          captured.collection.seed !== collection.mode.seed)
      fail('learning.adapter.collection_binding');
    for (const item of graph.dataset.cases) {
      const installed = captured.cases.find(value => value.caseId === item.caseId);
      if (!installed || canonicalJson(installed.input) !== canonicalJson(await context.artifacts.readArtifact(item.input)) ||
          canonicalJson(installed.expected) !== canonicalJson(await context.artifacts.readArtifact(item.expected)))
        fail('learning.adapter.dataset_binding');
    }
    for (const [key, value] of Object.entries(runtime))
      if (app.descriptor.runtime[key] !== value) fail('learning.adapter.manifest_binding');
    const descriptor = structuredClone(app.descriptor) as EvaluationDescriptor;
    const body: EvaluationRequest = {
      parentVersionId: op.baseline.version.id, parentDigest: op.baseline.version.digest,
      candidateVersionId: op.candidate!.id, candidateDigest: op.candidate!.digest,
      ...descriptor, requireBoundEvidence: true,
    };
    context.signal.throwIfAborted();
    const request = reconcile
      ? await committed<Evaluation>(op, root + '/evaluation-requests', body)
      : await mutate<Evaluation>(root + '/evaluation-requests', body, op.key);
    if (!request) return receipt(op, 'unknown', false, 'learning.adapter.operation_unobserved');
    if (!request.id || request.parentVersionId !== body.parentVersionId ||
        request.parentDigest !== body.parentDigest || request.candidateVersionId !== body.candidateVersionId ||
        request.candidateDigest !== body.candidateDigest || evaluationDescriptorDifferences(request, descriptor).length)
      fail('learning.adapter.evaluation_binding');
    const result = await installedRunner({
      app, configPath: evaluatorConfigPath,
      handoff: { schemaVersion: 1, serviceUrl: client.baseUrl, projectId: scope.projectId, bundleId: scope.bundleId, requestId: request.id,
        configuration: descriptor },
      allowLive, signal: context.signal,
    });
    if (result.executionState === 'interrupted' || result.evaluation.status === 'interrupted')
      return receipt(op, 'unknown', false, 'learning.adapter.interrupted_not_settled');
    const comparison = result.comparison;
    if (!comparison || result.executionState !== 'finished' || result.evaluation.status !== 'completed' ||
        result.evaluation.id !== request.id || !result.evaluation.attemptId ||
        result.evaluation.parentVersionId !== body.parentVersionId || result.evaluation.parentDigest !== body.parentDigest ||
        result.evaluation.candidateVersionId !== body.candidateVersionId || result.evaluation.candidateDigest !== body.candidateDigest ||
        evaluationDescriptorDifferences(result.evaluation, descriptor).length ||
        comparison.evaluation?.requestId !== request.id ||
        comparison.evaluation.attemptId !== result.evaluation.attemptId ||
        comparison.id !== result.evaluation.comparisonId ||
        comparison.submitter !== result.evaluation.evaluatorPrincipal ||
        comparison.parentVersionId !== body.parentVersionId || comparison.parentDigest !== body.parentDigest ||
        comparison.candidateVersionId !== body.candidateVersionId || comparison.candidateDigest !== body.candidateDigest ||
        evaluationDescriptorDifferences(comparison, descriptor).length)
      fail('learning.adapter.evaluation_binding');
    return { operationId: op.id, status: 'succeeded', executionSettled: true,
      output: { kind: 'evaluation', comparison: structuredClone(comparison) }, costMicroUsd: cost(comparison) };
  }
  async function work(op: Readonly<LearningOperation>, context: WorkContext, reconcile: boolean): Promise<WorkReceipt> {
    assertOperation(op);
    try {
      return op.kind === 'propose' ? await proposed(op, context, reconcile) : await evaluated(op, context, reconcile);
    } catch (error) {
      if (error instanceof AcclimateLearningAdapterError || error instanceof LearningEvidenceError) throw error;
      if (error instanceof EvaluationError && error.code === 'journal.busy')
        return receipt(op, 'pending', false, 'learning.adapter.evaluator_busy');
      if (error instanceof ExecutionUncertainError)
        return receipt(op, 'unknown', false, 'learning.adapter.execution_uncertain');
      // A rejected await is not evidence that a provider/native operation never started.
      return receipt(op, 'unknown', false, 'learning.adapter.external_outcome_unknown');
    }
  }
  return {
    revision: options.revision,
    maximumLiabilityMicroUsd: liability,
    async readBaseline(): Promise<ChannelResolution> {
      const result = await client.resolveChannel(scope.projectId, scope.bundleId, scope.channel);
      const resolution = result.resolution;
      if (!resolution || resolution.channel !== scope.channel || !resolution.revision)
        fail('learning.adapter.baseline_binding');
      version(resolution.version, scope.bundleId);
      return structuredClone(resolution);
    },
    dispatch: (op, context) => work(op, context, false),
    reconcile: (op, context) => work(op, context, true),
    decide(comparison: Comparison, stage: 'development' | 'audit'): SelectionVerdict {
      const binding = comparison.evaluation;
      if (!binding) return { verdict: 'indeterminate', reason: 'learning.adapter.unbound_comparison' };
      const verdict = checkComparison({
        comparison,
        expectedDescriptor: { datasetRevision: comparison.datasetRevision, graderRevision: comparison.graderRevision,
          runtime: comparison.runtime, expectedCases: comparison.expectedCases },
        expectedBinding: { parentVersionId: comparison.parentVersionId, parentDigest: comparison.parentDigest,
          candidateVersionId: comparison.candidateVersionId, candidateDigest: comparison.candidateDigest,
          requestId: binding.requestId, attemptId: binding.attemptId, comparisonId: comparison.id },
        policy: policies[stage], policyDigest: hashArtifact(policies[stage]).sha256,
      });
      return { verdict: verdict.verdict === 'pass' ? 'accepted' : verdict.verdict === 'fail' ? 'rejected' : 'indeterminate',
        reason: verdict.code };
    },
    async observeRelease(review: Readonly<ReleaseReview>): Promise<Promotion | null> {
      if (review.baseline.channel !== scope.channel || review.candidate.bundleId !== scope.bundleId ||
          review.candidate.parentVersionId !== review.baseline.version.id ||
          review.comparison.candidateVersionId !== review.candidate.id ||
          review.comparison.candidateDigest !== review.candidate.digest ||
          review.comparison.parentVersionId !== review.baseline.version.id ||
          review.comparison.parentDigest !== review.baseline.version.digest || !review.comparison.complete)
        fail('learning.adapter.release_binding');
      let beforeRevision: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 1000; page++) {
        const result = await client.listPromotions(scope.projectId, scope.bundleId, scope.channel,
          { limit: 100, ...(beforeRevision ? { beforeRevision } : {}) });
        for (const promotion of result.items) {
          if (promotion.channel === scope.channel && promotion.version.id === review.candidate.id &&
              promotion.version.bundleId === scope.bundleId && promotion.version.digest === review.candidate.digest &&
              promotion.previousVersionId === review.baseline.version.id &&
              promotion.comparisonId === review.comparison.id && promotion.reviewer &&
              /^\d+$/.test(promotion.revision) && /^\d+$/.test(review.baseline.revision) &&
              BigInt(promotion.revision) === BigInt(review.baseline.revision) + 1n)
            return structuredClone(promotion);
        }
        if (result.nextBeforeRevision === null) return null;
        if (!result.nextBeforeRevision || seen.has(result.nextBeforeRevision))
          fail('learning.adapter.pagination_binding');
        seen.add(result.nextBeforeRevision); beforeRevision = result.nextBeforeRevision;
      }
      return fail('learning.adapter.pagination_limit');
    },
  };
}
