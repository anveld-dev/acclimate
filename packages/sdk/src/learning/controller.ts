import { randomUUID } from 'node:crypto';
import { openLearningStore, LearningStoreError, type LearningStore } from './store.js';
import { canonicalJson, hashArtifact, sameRef, sameScope, validateExperience, validateAdmissionDecision, LearningEvidenceError, validateHarness, validateFeedback, validateEffectiveContext, validateScope, validateRef } from './identity.js';
import type { AdmissionDecisionV1, ExperienceV1, FeedbackV1, Ref } from './evidence-types.js';
import { teachingText, validateAdmission } from './admission.js';
import { LearningError, validateWorkReceipt } from './operations.js';
import { developmentHistoryScope, recordDevelopment, validDevelopmentHistory, validHistoryCandidateId, type DevelopmentHistory } from './history.js';
import { validateEvaluationPolicy, type EvaluationPolicyV1 } from '../evaluation/policy.js';
import { openAuditLineage, validateAuditRoster } from './audit-lineage.js';
import type {
  OpenLearnerOptions, Learner, LearnerCommand, LearnerDefinition, LearnerView,
  LearningOperation, LearningDecision, WorkReceipt, ReleaseReview, AdmissionResult, TeachingAdmission, SelectionStage,
} from './types.js';
import type { ChannelResolution, VersionMetadata } from '../types.js';

type QueuedTeaching = { experience: Ref<ExperienceV1>; decision: Ref<AdmissionDecisionV1>; teaching: string[] };
interface Checkpoint {
  schemaVersion: 1;
  revision: number;
  campaignId: string;
  definitionDigest: string;
  auditLineageDirectory?: string;
  policyEpoch?: string;
  epochStartRound?: number;
  priorEpochs?: { policyEpoch: string; definitionDigest: string; lastRound: number }[];
  selectionPolicies?: Record<SelectionStage, Ref<EvaluationPolicyV1>>;
  appliedSequence: number;
  desiredMode: 'running' | 'stopped';
  stage: 'waiting' | 'propose' | 'development' | 'audit' | 'review';
  nextAction: string;
  round: number;
  developmentAttempts?: number;
  developmentHistory?: DevelopmentHistory;
  baseline: ChannelResolution | null;
  candidate: VersionMetadata | null;
  queue: QueuedTeaching[];
  active: QueuedTeaching | null;
  activeSupersededBy?: Ref<AdmissionDecisionV1>;
  supersessionInitialized?: true;
  seen: Record<string, string>;
  decisions: LearningDecision[];
  operation: LearningOperation | null;
  operations: LearningOperation[];
  releaseReview: Ref<ReleaseReview> | null;
  auditExposures: string[];
  budget: LearnerView['budget'];
}
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function validateDefinition(definition: LearnerDefinition, options: OpenLearnerOptions): void {
  if (definition.schemaVersion !== 1 || !definition.campaignId || !definition.channel ||
      !definition.trustedDecider || !digest(definition.harnessDigest) ||
      !definition.adapterRevision || definition.adapterRevision !== options.adapter.revision ||
      Object.values(definition.scope).some((v) => typeof v !== 'string' || !v) ||
      !integer(definition.limits.maximumRounds) || definition.limits.maximumRounds < 1 ||
      !integer(definition.limits.maximumPaidAdmissions) || definition.limits.maximumPaidAdmissions < 1 ||
      !['admission-count', 'soft-usd', 'hard-usd'].includes(definition.limits.budget.mode) ||
      !Array.isArray(definition.auditCohorts)) throw new LearningError('definition-invalid');
  validateScope(definition.scope); validateRef(definition.policy); validateRef(definition.mutationPolicy);
  const { maximumDevelopmentAttempts } = definition.limits;
  const controls = options.adapter.developmentControlsDigest;
  if ((controls !== undefined && !digest(controls)) || (maximumDevelopmentAttempts !== undefined &&
      (!integer(maximumDevelopmentAttempts) || maximumDevelopmentAttempts < 1 || maximumDevelopmentAttempts > 10 ||
       (maximumDevelopmentAttempts > 1 && controls === undefined))))
    throw new LearningError('development-history-config');
  validateAuditRoster(definition.auditCohorts, options.auditLineageDirectory !== undefined);
  const money = definition.limits.budget;
  if (money.mode !== 'admission-count' && !integer(money.maximumMicroUsd)) throw new LearningError('budget-invalid');
  for (const kind of ['propose', 'development', 'audit'] as const) {
    const maximum = options.adapter.maximumLiabilityMicroUsd[kind];
    if (!(maximum === null || integer(maximum))) throw new LearningError('adapter-liability-invalid');
    if (money.mode === 'hard-usd' && maximum === null) throw new LearningError('budget-unbounded-adapter');
  }
}
function validateCheckpoint(value: Checkpoint, definition: LearnerDefinition, definitionDigest: string): void {
  if (value.schemaVersion !== 1 || value.campaignId !== definition.campaignId || value.definitionDigest !== definitionDigest)
    throw new LearningError('definition-conflict');
  if (!integer(value.revision) || !integer(value.appliedSequence) || !integer(value.round) ||
      (value.developmentAttempts !== undefined && (!integer(value.developmentAttempts) ||
        value.developmentAttempts > (definition.limits.maximumDevelopmentAttempts ?? 1))) ||
      (value.developmentHistory !== undefined && !validDevelopmentHistory(value.developmentHistory)) ||
      !Array.isArray(value.queue) || !Array.isArray(value.decisions) || !Array.isArray(value.auditExposures) ||
      !Array.isArray(value.operations) || !value.seen || !value.budget ||
      Object.values(value.budget).some((x) => !integer(x)) ||
      !['waiting', 'propose', 'development', 'audit', 'review'].includes(value.stage) ||
      !['running', 'stopped'].includes(value.desiredMode)) throw new LearningError('checkpoint-invalid');
}
function view(state: Checkpoint, barrier: boolean): LearnerView {
  const active = state.operation && ['dispatching', 'pending', 'unknown'].includes(state.operation.state);
  const stopped = state.desiredMode === 'stopped' || barrier;
  const uncertain = state.operation?.state === 'unknown';
  const terminal = ['round-limit', 'budget-exhausted', 'audit-refresh-required'].includes(state.nextAction);
  return {
    schemaVersion: 1, campaignId: state.campaignId, revision: state.revision,
    definitionDigest: state.definitionDigest, desiredMode: stopped ? 'stopped' : 'running',
    phase: uncertain ? 'needs-reconciliation' : stopped ? (active ? 'working' : 'stopped') :
      terminal ? 'finished' : state.stage === 'review' ? 'awaiting-review' : state.operation ? 'working' : 'ready',
    nextAction: stopped && active ? 'stop-requested' : stopped ? 'resume' : state.nextAction,
    round: state.round, baseline: state.baseline, candidate: state.candidate,
    operation: state.operation ? { id: state.operation.id, kind: state.operation.kind, state: state.operation.state } : null,
    releaseReview: state.releaseReview, decisions: structuredClone(state.decisions),
    budget: { ...state.budget }, auditExposures: [...state.auditExposures], observations: Object.keys(state.seen).length,
  };
}
async function preflightExperience(store: LearningStore, experience: ExperienceV1): Promise<void> {
  const harness = await store.readArtifact(experience.harness);
  validateHarness(harness);
  await Promise.all([experience.task, 'result' in experience.outcome ? experience.outcome.result : experience.outcome.diagnostic,
    harness.runner, harness.mapping, harness.tools, harness.model, harness.contextPolicy,
    ...(experience.trace ? [experience.trace] : [])].map((ref) => store.readArtifact(ref)));
  for (const reference of experience.feedback) {
    const feedback = await store.readArtifact(reference); validateFeedback(feedback);
    await Promise.all([store.readArtifact(feedback.sourceArtifact), store.readArtifact(feedback.claim)]);
  }
  if (experience.effectiveContext) {
    const context = await store.readArtifact(experience.effectiveContext); validateEffectiveContext(context);
    await Promise.all([...(context.hostContext ? [context.hostContext] : []),
      ...(context.readEvidence ? [context.readEvidence] : [])].map((ref) => store.readArtifact(ref)));
  }
}
async function admission(store: LearningStore, options: OpenLearnerOptions, definition: LearnerDefinition,
                         experience: ExperienceV1, experienceRef: Ref<ExperienceV1>): Promise<AdmissionResult> {
  const harness = await store.readArtifact(experience.harness);
  if (harness.runner.sha256 !== definition.harnessDigest) throw new LearningError('runner-drift');
  const result = await options.admit({ experience: structuredClone(experience), experienceRef, artifacts: store });
  await validateAdmission({
    decision: result.decision, experience, experienceRef, targetScope: definition.scope,
    policy: definition.policy, mutationPolicy: definition.mutationPolicy,
    trustedDecider: definition.trustedDecider, resolve: (ref) => store.readArtifact(ref),
    authorizedFeedback: options.authorizedFeedback ? await options.authorizedFeedback(structuredClone(experience)) : [],
  });
  if (result.decision.decision === 'admitted') {
    const teaching = await store.readArtifact(result.decision.admitted!.teachingView);
    if (!equal(result.teaching, teachingText(teaching)) || result.teaching.length === 0 || result.teaching.length > 20 ||
        result.teaching.some((text) => typeof text !== 'string' || !text || Buffer.byteLength(text) > 4096))
      throw new LearningError('teaching-binding');
  } else if (result.teaching.length) throw new LearningError('teaching-unadmitted');
  return result;
}

export async function openLearner(options: OpenLearnerOptions): Promise<Learner> {
  const definition = JSON.parse(canonicalJson(options.definition)) as LearnerDefinition;
  validateDefinition(definition, options);
  const liabilities = structuredClone(options.adapter.maximumLiabilityMicroUsd);
  const policies = structuredClone(options.adapter.selectionPolicies);
  if (policies !== undefined) {
    validateEvaluationPolicy(policies?.development);
    validateEvaluationPolicy(policies?.audit);
  }
  const policyDigests = policies && {
    development: hashArtifact(policies.development).sha256,
    audit: hashArtifact(policies.audit).sha256,
  };
  const developmentControlsDigest = options.adapter.developmentControlsDigest;
  const definitionDigest = hashArtifact({ definition, liabilities,
    ...(policyDigests ? { selectionPolicies: policyDigests } : {}),
    ...(developmentControlsDigest === undefined ? {} : { developmentControlsDigest }),
  }).sha256;
  const store = await openLearningStore(options.directory);
  const auditLineage = options.auditLineageDirectory !== undefined || definition.auditCohorts.some(cohort => cohort.cases)
    ? await openAuditLineage(options.auditLineageDirectory ?? options.directory, definition.scope)
    : undefined;
  const auditLineageDirectory = options.auditLineageDirectory === undefined ? undefined : auditLineage?.directory;
  const startEpoch = options.startEpoch && structuredClone(options.startEpoch);
  if (startEpoch && (!auditLineageDirectory || !digest(startEpoch.previousDefinitionDigest)))
    throw new LearningError('epoch-migration-binding');
  const validateLineage = (state: Checkpoint) => {
    if (state.auditLineageDirectory !== auditLineageDirectory)
      throw new LearningError('audit-lineage-conflict');
  };
  const validateCampaign = (state: Checkpoint) => {
    validateCheckpoint(state, definition, definitionDigest);
    validateLineage(state);
    if (auditLineageDirectory && (state.policyEpoch !== definition.scope.policyEpoch ||
        (state.epochStartRound !== undefined && (!integer(state.epochStartRound) || state.epochStartRound > state.round))))
      throw new LearningError('epoch-migration-binding');
    if (state.selectionPolicies?.development?.sha256 !== policyDigests?.development ||
        state.selectionPolicies?.audit?.sha256 !== policyDigests?.audit)
      throw new LearningError('selection-policy-binding');
  };
  await Promise.all([store.readArtifact(definition.policy), store.readArtifact(definition.mutationPolicy)]);
  await store.withWorkerLock(async () => {
    const existing = await store.readCheckpoint<Checkpoint>();
    if (existing?.definitionDigest === definitionDigest) {
      validateCampaign(existing);
      if (startEpoch && existing.priorEpochs?.at(-1)?.definitionDigest !== startEpoch.previousDefinitionDigest)
        throw new LearningError('epoch-migration-binding');
      if (existing.selectionPolicies)
        await Promise.all([store.readArtifact(existing.selectionPolicies.development), store.readArtifact(existing.selectionPolicies.audit)]);
      return;
    }
    if (existing && !startEpoch) throw new LearningError('definition-conflict');
    if (!existing && startEpoch) throw new LearningError('epoch-migration-binding');
    const selectionPolicies = policies && {
      development: await store.putArtifact(policies.development),
      audit: await store.putArtifact(policies.audit),
    };
    if (existing && startEpoch) {
      validateLineage(existing);
      const previousEpoch = existing.policyEpoch;
      const history = existing.priorEpochs ?? [];
      if (existing.campaignId !== definition.campaignId || existing.definitionDigest !== startEpoch.previousDefinitionDigest ||
          !previousEpoch || previousEpoch === definition.scope.policyEpoch ||
          history.some(epoch => epoch.policyEpoch === definition.scope.policyEpoch) || history.length >= 256)
        throw new LearningError('epoch-migration-binding');
      await store.withInboxLock(async lock => {
        if (existing.operation || existing.releaseReview ||
            (existing.stage !== 'waiting' && existing.nextAction !== 'audit-refresh-required') ||
            (await store.readInbox(existing.appliedSequence)).length)
          throw new LearningError('epoch-migration-active');
        const next: Checkpoint = {
          ...existing, revision: existing.revision + 1, definitionDigest, policyEpoch: definition.scope.policyEpoch,
          priorEpochs: [...history, { policyEpoch: previousEpoch, definitionDigest: existing.definitionDigest,
            lastRound: existing.round }],
          epochStartRound: existing.round, stage: 'waiting', nextAction: 'waiting-for-outcomes',
          baseline: null, candidate: null, active: null, queue: [],
        };
        delete next.activeSupersededBy;
        delete next.developmentAttempts;
        delete next.developmentHistory;
        if (selectionPolicies) next.selectionPolicies = selectionPolicies;
        else delete next.selectionPolicies;
        lock.assertOwned();
        await store.writeCheckpoint(existing.revision, next);
      });
      return;
    }
    const state: Checkpoint = {
      schemaVersion: 1, revision: 0, campaignId: definition.campaignId, definitionDigest,
      ...(selectionPolicies ? { selectionPolicies } : {}),
      ...(auditLineageDirectory ? { auditLineageDirectory, policyEpoch: definition.scope.policyEpoch } : {}),
      appliedSequence: 0, desiredMode: 'running', stage: 'waiting', nextAction: 'waiting-for-outcomes',
      round: 0, baseline: null, candidate: null, queue: [], active: null, seen: {}, decisions: [], supersessionInitialized: true,
      operation: null, operations: [], releaseReview: null, auditExposures: [],
      budget: { admissions: 0, knownSpentMicroUsd: 0, reservedMicroUsd: 0, unknownCosts: 0 },
    };
    await store.writeCheckpoint(null, state);
  });
  const read = async () => {
    const state = await store.readCheckpoint<Checkpoint>();
    if (!state) throw new LearningError('checkpoint-missing');
    validateCampaign(state);
    return state;
  };
  const save = async (state: Checkpoint) => {
    const revision = state.revision;
    state.revision++;
    await store.writeCheckpoint(revision, state);
  };
  const closeRound = (state: Checkpoint, nextAction = 'waiting-for-outcomes') => {
    state.stage = 'waiting'; state.candidate = null; state.active = null; state.baseline = null;
    state.releaseReview = null; state.nextAction = nextAction;
    delete state.activeSupersededBy;
    delete state.developmentAttempts;
  };
  const historyScope = (baseline: ChannelResolution, teaching: readonly string[]) => developmentControlsDigest &&
    developmentHistoryScope(definitionDigest, baseline, developmentControlsDigest, teaching);
  const validateReceipt = (receipt: WorkReceipt, operation: LearningOperation) => {
    validateWorkReceipt(receipt, operation);
    if (developmentControlsDigest && receipt.output?.kind === 'proposal' && !validHistoryCandidateId(receipt.output.candidate.id))
      throw new LearningError('development-history-candidate-binding');
  };
  const decision = async (state: Checkpoint, stage: LearningDecision['stage'], verdict: string,
                          reason: string, value: unknown, policyDigest?: string) => {
    const reference = await store.putArtifact(value);
    state.decisions.push({ round: state.round, stage, verdict, reason, reference,
      ...(policyDigest === undefined ? {} : { policyDigest }) });
  };
  const teachingAdmission = async (lesson: QueuedTeaching): Promise<TeachingAdmission> => {
    const record = await store.readArtifact(lesson.decision);
    validateAdmissionDecision(record);
    if (!record.admitted || !sameRef(record.experience, lesson.experience) ||
        !sameRef(record.policy, definition.policy) || record.decidedBy !== definition.trustedDecider ||
        !sameScope(record.admitted.targetScope, definition.scope) ||
        !sameRef(record.admitted.mutationPolicy, definition.mutationPolicy))
      throw new LearningError('teaching-binding');
    const { teachingView, use, mutationPolicy, compatibilityObligations, replaces } = record.admitted;
    if (!equal(lesson.teaching, teachingText(await store.readArtifact(teachingView))))
      throw new LearningError('teaching-binding');
    return { experience: lesson.experience, decision: lesson.decision, teachingView, use,
      mutationPolicy, compatibilityObligations, replaces };
  };
  const supersede = async (state: Checkpoint, replacement: Ref<AdmissionDecisionV1>, lesson: NonNullable<AdmissionDecisionV1['admitted']>) => {
    if (lesson.replaces.length) {
      delete state.developmentHistory;
      if (state.operation?.state === 'prepared') delete state.operation.proposalHistory;
    }
    const matches = (queued: QueuedTeaching) => lesson.replaces.some((ref) => sameRef(ref, queued.decision));
    const removed = state.queue.filter(matches);
    const active = state.active && !state.activeSupersededBy && matches(state.active) ? state.active : null;
    if (!removed.length && !active) return;
    await decision(state, 'admission', 'superseded', 'lesson-replaced', {
      replacement, queued: removed.map((entry) => entry.decision),
      active: active?.decision ?? null, releaseReview: active ? state.releaseReview : null,
    });
    state.queue = state.queue.filter((entry) => !matches(entry));
    if (!active) return;
    if (state.operation && state.operation.state !== 'prepared') {
      state.activeSupersededBy = replacement;
      return;
    }
    if (state.operation) {
      state.budget.admissions--;
      state.budget.reservedMicroUsd -= state.operation.maximumLiabilityMicroUsd ?? 0;
      state.operation = null;
    }
    closeRound(state, 'lesson-superseded');
  };
  const pendingObservation = async (state: Checkpoint) =>
    (await store.readInbox<LearnerCommand>(state.appliedSequence)).some((entry) => entry.command.kind === 'observe');
  const settle = async (state: Checkpoint, receipt: WorkReceipt): Promise<void> => {
    const operation = state.operation!;
    validateReceipt(receipt, operation);
    operation.receipt = await store.putArtifact(receipt);
    operation.state = receipt.status === 'pending' ? 'pending' : receipt.status === 'unknown' || !receipt.executionSettled
      ? 'unknown' : 'result-saved';
    state.nextAction = operation.state === 'unknown' ? 'reconcile-existing-work' : 'await-existing-work';
    await save(state); // Result artifact/checkpoint precedes settlement and decision.
    if (operation.state !== 'result-saved') return;
    await store.withInboxLock(async () => {
    // Local selection/storage failures must leave the durable result receipt
    // recoverable, without partially applying budget or stage transitions.
    const originalState = state;
    state = structuredClone(state);
    const operation = state.operation!;
    if (state.desiredMode === 'stopped' || await store.admissionBarrier()) {
      state.nextAction = 'stopped-result-retained';
      await save(state);
      Object.assign(originalState, state);
      return;
    }
    // A command accepted during the audit may replace this lesson. Keep the
    // receipt recoverable until that command is applied before exposing review.
    if (operation.kind === 'audit' && !state.activeSupersededBy && await pendingObservation(state))
      return;
    if (receipt.costMicroUsd === null) state.budget.unknownCosts++;
    else {
      if (!Number.isSafeInteger(state.budget.knownSpentMicroUsd + receipt.costMicroUsd)) throw new LearningError('budget-overflow');
      state.budget.knownSpentMicroUsd += receipt.costMicroUsd;
      state.budget.reservedMicroUsd -= operation.maximumLiabilityMicroUsd ?? 0;
      if (operation.maximumLiabilityMicroUsd !== null && receipt.costMicroUsd > operation.maximumLiabilityMicroUsd) {
        state.desiredMode = 'stopped'; state.nextAction = 'adapter-liability-breached';
      }
    }
    operation.state = 'settled'; state.operations.push(structuredClone(operation)); state.operation = null;
    if (state.activeSupersededBy) {
      closeRound(state, 'lesson-superseded');
    } else if (receipt.status !== 'succeeded') {
      await decision(state, operation.kind === 'audit' ? 'audit' : 'development', 'failed', receipt.reason ?? 'work-failed', receipt);
      const scope = operation.kind === 'development' && historyScope(operation.baseline, operation.teaching);
      if (scope) state.developmentHistory = recordDevelopment(state.developmentHistory, scope, 'failed', operation.candidate!);
      closeRound(state, operation.kind === 'audit' ? 'audit-failed' : 'waiting-for-outcomes');
    } else if (operation.kind === 'propose') {
      state.candidate = (receipt.output as { kind: 'proposal'; candidate: VersionMetadata }).candidate;
      state.stage = 'development'; state.nextAction = 'evaluate-development';
    } else {
      const comparison = (receipt.output as { kind: 'evaluation'; comparison: import('../types.js').Comparison }).comparison;
      const policyDigest = policyDigests?.[operation.kind];
      const verdict = comparison.complete ? options.adapter.decide(comparison, operation.kind) :
        { verdict: 'indeterminate' as const, reason: 'incomplete-evidence', ...(policyDigest ? { policyDigest } : {}) };
      if (!['accepted', 'rejected', 'indeterminate'].includes(verdict.verdict) || typeof verdict.reason !== 'string' ||
          (policyDigest !== undefined && verdict.policyDigest !== policyDigest))
        throw new LearningError('selection-invalid');
      const policy = state.selectionPolicies?.[operation.kind];
      await decision(state, operation.kind, verdict.verdict, verdict.reason, {
        operation, comparison, verdict, ...(policy ? { policy } : {}),
      }, policyDigest);
      if (verdict.verdict !== 'accepted') {
        const scope = operation.kind === 'development' && historyScope(operation.baseline, operation.teaching);
        if (scope) state.developmentHistory = recordDevelopment(state.developmentHistory, scope, verdict.verdict,
          operation.candidate!, comparison, policies?.development.metric.direction);
        if (scope && verdict.verdict === 'rejected' && state.desiredMode === 'running' &&
            (state.developmentAttempts ?? 1) < (definition.limits.maximumDevelopmentAttempts ?? 1)) {
          state.candidate = null; state.stage = 'propose'; state.nextAction = 'retry-development';
        } else closeRound(state, operation.kind === 'audit' ? 'audit-failed' : 'waiting-for-outcomes');
      }
      else if (operation.kind === 'development') { state.stage = 'audit'; state.nextAction = 'evaluate-audit'; }
      else {
        const review: ReleaseReview = { schemaVersion: 1, kind: 'learning-release-review', campaignId: definition.campaignId,
          round: state.round, definitionDigest, baseline: operation.baseline, candidate: operation.candidate!,
          comparison, auditCohort: operation.auditCohort!,
          admission: await teachingAdmission(state.active!) };
        state.releaseReview = await store.putArtifact(review); state.stage = 'review'; state.nextAction = 'review-release';
      }
    }
    await save(state);
    Object.assign(originalState, state);
    });
  };
  const commandValid = (command: LearnerCommand) => {
    if (!command || !['observe', 'request-stop', 'resume', 'resolve-uncertainty', 'decline-release'].includes(command.kind))
      throw new LearningError('command-invalid');
    if (command.kind === 'observe') {
      validateExperience(command.observation);
      if (!sameScope(command.observation.scope, definition.scope)) throw new LearningError('observation-scope');
    } else if (command.kind === 'request-stop' || command.kind === 'resume' || command.kind === 'decline-release') {
      if (typeof command.reason !== 'string' || !command.reason.trim() || command.reason.length > 4096)
        throw new LearningError('reason-invalid');
      if (command.kind === 'decline-release') validateRef(command.review);
    } else if (!command.resolution || !integer(command.resolution.expectedRevision) || !command.resolution.operationId)
      throw new LearningError('resolution-invalid');
    canonicalJson(command);
  };
  return {
    async submit(command, commandId) {
      commandValid(command);
      if (command.kind === 'observe') {
        // Reject unavailable references before queue acceptance. Admission is
        // invoked exactly once, while consuming the durable command.
        await preflightExperience(store, command.observation);
      }
      return store.submit(commandId, command, auditLineageDirectory ? async () => { await read(); } : undefined);
    },
    async inspect() { return view(await read(), await store.admissionBarrier()); },
    async advance({ signal, deadline }) {
      if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new LearningError('deadline-invalid');
      return store.withWorkerLock(async (lock) => {
        const combined = AbortSignal.any([lock.signal, signal ?? new AbortController().signal,
          AbortSignal.timeout(Math.max(0, Math.min(deadline - Date.now(), 2_147_483_647)))]);
        const state = await read();
        const migrateSupersession = !state.supersessionInitialized;
        const initialRevision = state.revision;
        if (migrateSupersession) {
          // Older checkpoints retained replacement decisions without applying
          // them to lessons still queued or active.
          for (const entry of state.decisions.slice()) {
            if (entry.stage !== 'admission' || entry.verdict !== 'admitted' || !entry.reference) continue;
            const ref = entry.reference as Ref<AdmissionDecisionV1>;
            const record = await store.readArtifact(ref);
            validateAdmissionDecision(record);
            if (record.admitted) await supersede(state, ref, record.admitted);
          }
          state.supersessionInitialized = true;
        }
        for (const entry of await store.readInbox<LearnerCommand>(state.appliedSequence)) {
          const command = entry.command;
          let settlingResolution = false;
          try {
          commandValid(command);
          if (command.kind === 'observe') {
            const key = hashArtifact([command.observation.runId, command.observation.attemptId]).sha256;
            const observationRef = await store.putArtifact(command.observation);
            if (state.seen[key] && state.seen[key] !== observationRef.sha256) throw new LearningError('observation-conflict');
            if (!state.seen[key]) {
              const result = await admission(store, options, definition, command.observation, observationRef);
              const admissionRef = await store.putArtifact(result.decision);
              if (result.decision.admitted) await supersede(state, admissionRef, result.decision.admitted);
              state.seen[key] = observationRef.sha256;
              state.decisions.push({ round: state.round, stage: 'admission', verdict: result.decision.decision,
                reason: result.decision.reasonCode, reference: admissionRef });
              if (result.decision.decision === 'admitted')
                state.queue.push({ experience: observationRef, decision: admissionRef, teaching: result.teaching });
            }
          } else if (command.kind === 'request-stop') state.desiredMode = 'stopped';
          else if (command.kind === 'resume') {
            if (!state.operation || ['prepared', 'result-saved'].includes(state.operation.state)) {
              state.desiredMode = 'running';
              await store.setAdmissionBarrier(false, entry.sequence);
            }
          } else if (command.kind === 'decline-release') {
            if (state.stage !== 'review' || !state.releaseReview || !sameRef(state.releaseReview, command.review))
              throw new LearningError('review-binding');
            await decision(state, 'release', 'declined', command.reason, {
              review: command.review, reason: command.reason, commandId: entry.commandId,
            });
            closeRound(state);
          } else {
            const resolution = command.resolution;
            if (!state.operation || state.operation.id !== resolution.operationId || resolution.expectedRevision !== state.revision || !options.resolve)
              throw new LearningError('resolution-binding');
            const evidence = await store.readArtifact(resolution.evidence);
            const receipt = await options.resolve({ operation: structuredClone(state.operation), evidence, artifacts: store });
            // Invalid resolver evidence is a rejected command. Once a valid
            // result enters settlement, local failures must remain recoverable.
            validateReceipt(receipt, state.operation);
            settlingResolution = true;
            await settle(state, receipt);
          }
          } catch (error) {
            if (settlingResolution || (!(error instanceof LearningError) && !(error instanceof LearningEvidenceError))) throw error;
            await decision(state, command.kind === 'decline-release' ? 'release' : 'admission', 'rejected', 'command-invalid', {
              commandId: entry.commandId, commandDigest: entry.sha256, code: error.code,
            });
          }
          state.appliedSequence = entry.sequence;
          await save(state);
        }
        if (migrateSupersession && state.revision === initialRevision) await save(state);
        lock.assertOwned();
        if (state.operation) {
          if (state.operation.state === 'result-saved' && state.operation.receipt) {
            await settle(state, await store.readArtifact(state.operation.receipt));
            return view(state, await store.admissionBarrier());
          }
          if (state.operation.state !== 'prepared') {
            let receipt: WorkReceipt;
            try { receipt = await options.adapter.reconcile(structuredClone(state.operation), { signal: combined, artifacts: store }); }
            catch { state.operation.state = 'unknown'; state.nextAction = 'reconcile-existing-work'; await save(state); return view(state, await store.admissionBarrier()); }
            await settle(state, receipt);
            return view(state, await store.admissionBarrier());
          }
        }
        if (state.desiredMode === 'stopped' || await store.admissionBarrier() || combined.aborted || Date.now() >= deadline)
          return view(state, await store.admissionBarrier());
        if (state.stage === 'review') {
          const review = await store.readArtifact(state.releaseReview!);
          const admission = await teachingAdmission(state.active!);
          if (review.admission && !equal(review.admission, admission)) throw new LearningError('review-binding');
          let promotion = await options.adapter.observeRelease(review);
          const current = promotion ? null : await options.adapter.readBaseline();
          const baselineChanged = current &&
            (current.version.id !== review.baseline.version.id || current.revision !== review.baseline.revision);
          if (baselineChanged) promotion = await options.adapter.observeRelease(review);
          await store.withInboxLock(async () => {
            if (await store.admissionBarrier() || (await store.readInbox(state.appliedSequence)).length) return;
            if (promotion) {
              if (promotion.version.id !== review.candidate.id || promotion.version.digest !== review.candidate.digest ||
                  promotion.previousVersionId !== review.baseline.version.id || promotion.comparisonId !== review.comparison.id ||
                  promotion.channel !== definition.channel || promotion.revision === review.baseline.revision)
                throw new LearningError('release-binding');
              await decision(state, 'release', 'released', 'reviewer-promotion-observed', promotion);
              closeRound(state); await save(state);
            } else if (baselineChanged) {
              await decision(state, 'release', 'conflict', 'published-baseline-changed', current);
              closeRound(state); await save(state);
            }
          });
          return view(state, await store.admissionBarrier());
        }
        if (state.stage === 'waiting') {
          if (!state.queue.length) { state.nextAction = 'waiting-for-outcomes'; return view(state, false); }
          if (state.round - (state.epochStartRound ?? 0) >= definition.limits.maximumRounds) { state.nextAction = 'round-limit'; await save(state); return view(state, false); }
          state.baseline = await options.adapter.readBaseline();
          if (state.baseline.version.bundleId !== definition.scope.bundleId || !digest(state.baseline.version.digest))
            throw new LearningError('baseline-binding');
          state.round++; state.active = state.queue.shift()!; state.stage = 'propose'; state.nextAction = 'propose';
          await save(state);
        }
        if (!state.operation) {
          const kind = state.stage === 'propose' ? 'propose' : state.stage === 'development' ? 'development' : 'audit';
          const cohorts = kind === 'audit' ? definition.auditCohorts.filter(c => !state.auditExposures.includes(c.digest)) : [];
          const cohort = auditLineage ? await auditLineage.select(cohorts) : cohorts[0];
          if (kind === 'audit' && !cohort) { state.nextAction = 'audit-refresh-required'; await save(state); return view(state, false); }
          if (options.adapter.revision !== definition.adapterRevision) throw new LearningError('adapter-drift');
          if (options.adapter.developmentControlsDigest !== developmentControlsDigest) throw new LearningError('adapter-drift');
          const maximum = liabilities[kind];
          const budget = definition.limits.budget;
          if (state.budget.admissions >= definition.limits.maximumPaidAdmissions ||
              (budget.mode !== 'admission-count' && (state.budget.unknownCosts > 0 ||
               state.budget.knownSpentMicroUsd + state.budget.reservedMicroUsd + (maximum ?? 0) > budget.maximumMicroUsd!))) {
            state.nextAction = 'budget-exhausted'; await save(state); return view(state, false);
          }
          const scope = kind === 'propose' && historyScope(state.baseline!, state.active!.teaching);
          const history = scope && state.developmentHistory?.scopeDigest === scope ? state.developmentHistory.entries : undefined;
          state.operation = { id: randomUUID(), attemptId: randomUUID(), key: randomUUID(), kind, round: state.round,
            definitionDigest, scope: definition.scope, channel: definition.channel, baseline: state.baseline!,
            candidate: state.candidate, teaching: state.active!.teaching,
            ...(history?.length ? { proposalHistory: structuredClone(history) } : {}),
            admission: await teachingAdmission(state.active!), auditCohort: cohort ?? null,
            state: 'prepared', maximumLiabilityMicroUsd: maximum };
          if (kind === 'development') state.developmentAttempts = (state.developmentAttempts ?? 0) + 1;
          state.budget.admissions++; state.budget.reservedMicroUsd += maximum ?? 0;
          await save(state);
        }
        if (state.operation.state === 'prepared' && !state.operation.admission) {
          state.operation.admission = await teachingAdmission(state.active!);
          await save(state);
        }
        try {
          await store.withAdmission(async (admissionLock) => {
            if (combined.aborted || Date.now() >= deadline) return;
            if (await pendingObservation(state)) return;
            if (combined.aborted || Date.now() >= deadline) return;
            lock.assertOwned(); admissionLock.assertOwned();
            const operation = state.operation!;
            if (operation.auditCohort) {
              if (auditLineage && !await auditLineage.claim(operation.auditCohort, operation.id)) {
                state.budget.admissions--;
                state.budget.reservedMicroUsd -= operation.maximumLiabilityMicroUsd ?? 0;
                state.operation = null;
                await save(state);
                return;
              }
              state.auditExposures.push(operation.auditCohort.digest);
            }
            lock.assertOwned(); admissionLock.assertOwned();
            operation.state = 'dispatching';
            await save(state);
          });
        } catch (error) {
          if (!(error instanceof LearningStoreError) || error.code !== 'admission-closed') throw error;
          return view(state, true);
        }
        if (state.operation?.state === 'dispatching') {
          let receipt: WorkReceipt;
          try { receipt = await options.adapter.dispatch(structuredClone(state.operation), { signal: combined, artifacts: store }); }
          catch { state.operation!.state = 'unknown'; state.nextAction = 'reconcile-existing-work'; await save(state); return view(state, await store.admissionBarrier()); }
          await settle(state, receipt);
        }
        return view(state, await store.admissionBarrier());
      });
    },
  };
}
