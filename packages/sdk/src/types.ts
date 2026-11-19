import type { EvaluationPolicy } from './evaluation/policy.js';
export type CompatibilityTarget = 'generic' | 'codex' | 'claude' | 'pi' | 'cursor';
export type FileKind = 'instruction' | 'skill' | 'memory';
export interface BundleFile {
  path: string;
  kind: FileKind;
  text: string;
}
export interface BundlePayload {
  schemaVersion: 1;
  files: BundleFile[];
}
export interface Bundle {
  compatibilityTarget: CompatibilityTarget;
  id: string;
  name: string;
  projectId: string;
  createdAt: string;
  origin: BundleOrigin;
  sourceLabel: string | null;
}
export interface VersionMetadata {
  id: string;
  bundleId: string;
  parentVersionId: string | null;
  digest: string;
  createdAt: string;
}
export interface ChannelResolution {
  channel: string;
  revision: string;
  version: VersionMetadata;
}
export interface CreateVersionRequest {
  parentVersionId: string | null;
  payload: BundlePayload;
}
export interface PolicyOverride {
  reason: string;
  receipts: Array<{ comparisonId: string; policyDigest: string }>;
}
export type CreateReleaseRequest = { versionId: string; expectedRevision: string } & (
  | { comparisonId: string; unevaluatedReason?: never; policyOverride?: PolicyOverride }
  | { unevaluatedReason: string; comparisonId?: never; policyOverride?: never }
);
export interface Release {
  id: string;
  channel: string;
  revision: string;
  version: VersionMetadata;
  previousVersionId: string | null;
  comparisonId: string | null;
  unevaluatedReason: string | null;
  policyOverride?: PolicyOverride;
  policyApprovalPromotionId?: string;
  reviewer: string;
  createdAt: string;
}
export interface ReleasePage {
  items: Release[];
  nextBeforeRevision: string | null;
}
export interface ProposalRequest {
  parentVersionId: string;
  allowedPaths: string[];
  hypothesis: string;
  evidence: string[];
}
export interface Proposal {
  id: string;
  parentVersionId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  candidate: VersionMetadata | null;
  rationale: string | null;
  screening?: Array<{
    stage: 'initial' | 'repair';
    result: { verdict: 'accept' | 'reject'; objections: string[]; risky?: boolean } | null;
    scannerClean?: boolean;
    structural?: boolean;
    rationale?: string;
    changes: Array<{ path: string; before: string | null; after: string | null }>;
  }>;
  error: string | null;
  createdAt: string;
}
export interface CaseKey {
  caseId: string;
  repetition: number;
}
/** Public evaluator intent. Task contents, expected answers and callbacks stay in the app. */
export interface EvaluationDescriptor {
  datasetRevision: string;
  graderRevision: string;
  runtime: Record<string, string>;
  expectedCases: CaseKey[];
}
export interface EvaluationHandoff {
  schemaVersion: 1;
  serviceUrl: string;
  projectId: string;
  bundleId: string;
  requestId: string;
  configuration: EvaluationDescriptor;
}
/** Point-in-time machine authorization, never an execution reservation or provider probe. */
export interface ComparisonPolicyReport {
  requestId: string;
  attemptId: string;
  policy: { id: string; revision: string; sha256: string };
  verdict: 'pass' | 'fail' | 'indeterminate';
  checks: Array<{ code: string; result: 'pass' | 'fail' | 'unknown' }>;
  /** Statistics behind the mean-difference check (method, n, sd, floor, df, t, bound, threshold). */
  inference?: PolicyReceiptInference;
}

/** The inference block a policy verdict reports; see the evaluation policy module. */
export interface PolicyReceiptInference {
  method: 'paired-t' | 'none';
  estimand: 'sampled-cases' | 'observed-cases';
  status: 'estimated' | 'insufficient_data' | 'incomplete' | 'not_applicable';
  stage: 'general' | 'development' | 'cumulative' | 'audit';
  check: string;
  confidence: number | null;
  threshold: number;
  thresholdSource: 'minimumMeanImprovement' | 'stepMargin' | 'nonInferiorityMargin';
  n: number;
  minCases: number;
  minRepetitions: number;
  repetitions: number;
  meanDifference: number | null;
  sd: number | null;
  sdFloor: number | null;
  sdFloorSource: 'declared' | 'scale' | 'observed-range' | null;
  calibratedSd: number | null;
  sdUsed: number | null;
  standardError: number | null;
  df: number | null;
  criticalValue: number | null;
  lowerBound: number | null;
  imputed: { parent: number; candidate: number };
  maximumMissingPercent: number;
}

export interface ComparisonPolicyReceipt extends ComparisonPolicyReport {
  /** Whether this policy is the one pinned on the evaluation request before the run. */
  policyPin?: 'matched' | 'mismatched' | 'unpinned';
  comparisonId: string;
  reportedBy: string;
  receivedAt: string;
}

export interface EvaluationCapabilities {
  schemaVersion: 1;
  projectId: string;
  principalId: string;
  checkedAt: string;
  readUnpublished: true;
  /** True when the principal holds `evaluate` (or `write`, which implies it). */
  writeEvaluation: boolean;
  retainedEvaluationOperations: true;
  /** Reported by services that support the narrow `evaluate` right. */
  rights?: { read: boolean; evaluate: boolean; write: boolean; propose: boolean; promote: boolean };
  credential?: { kind: 'static' } | { kind: 'machineToken'; id: string; expiresAt: string };
  abandonment?: { explicit: boolean; inactivitySeconds: number };
  /** Requests accept `runName` and `retryOf`. Absent on older services. */
  runLabels?: true;
  /** Requests accept `policyDigest`, pinning the quality policy before the run. Absent on older services. */
  policyPins?: true;
}
/** Optional reported activity. Never a lease or evidence of external quiescence. */
export interface EvaluationProgressRequest {
  attemptId: string;
  sequence: number;
  phase: 'preparing' | 'executing' | 'grading' | 'submitting';
  completed: number;
  total: number;
  case?: CaseKey;
}
export interface EvaluationProgressObservation extends EvaluationProgressRequest {
  receivedAt: string;
  evaluatorPrincipal: string;
}
export interface EvaluationProgressView {
  schemaVersion: 1;
  requestId: string;
  status: Evaluation['status'];
  attemptId: string | null;
  observation: EvaluationProgressObservation | null;
  activity: 'fresh' | 'stale' | 'absent';
  checkedAt: string;
  staleAfterSeconds: 60;
}
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}
export interface Outcome {
  executionStatus: 'completed' | 'task_failed' | 'infrastructure_failed';
  gradingStatus: 'scored' | 'missing' | 'failed';
  reward: number | null;
  outputRef: string | null;
  error: string | null;
  usage: Usage | null;
  /** Optional named numeric grade components, such as correctness. Present only on scored arms. */
  components?: Record<string, number>;
}
export interface CasePair extends CaseKey {
  parent: Outcome;
  candidate: Outcome;
}
export interface EvaluationBinding {
  requestId: string;
  attemptId: string;
}
export interface ComparisonRequest {
  parentSourceComparisonId?: string;
  evaluation?: EvaluationBinding;
  parentVersionId: string;
  candidateVersionId: string;
  parentDigest: string;
  candidateDigest: string;
  datasetRevision: string;
  runtime: Record<string, string>;
  graderRevision: string;
  expectedCases: CaseKey[];
  results: CasePair[];
}
export interface Comparison extends ComparisonRequest {
  id: string;
  complete: boolean;
  submitter: string;
  createdAt: string;
}
export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
}
export interface VerifiedVersion {
  version: VersionMetadata;
  payload: BundlePayload;
  resolution?: ChannelResolution;
  resolvedAt: number;
  stale: boolean;
  /** Present when the SDK resolved the bundle for an explicitly scoped connection. */
  connection?: Readonly<{ projectId: string; integrationId: string }>;
}

/** Bounded service listing. Cursors are opaque and must be sent back unchanged. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface ListOptions {
  limit?: number;
  cursor?: string;
}
export interface Workspace {
  id: string;
  name: string;
  role: string;
}
export type BundleOrigin = 'created' | 'example' | 'imported' | 'unknown';
export interface BundleSetupRequest {
  compatibilityTarget?: CompatibilityTarget;
  name: string;
  origin: Exclude<BundleOrigin, 'unknown'>;
  sourceLabel?: string;
  channel: string;
  payload: BundlePayload;
  reason: string;
}
export interface BundleSetup {
  bundle: Bundle;
  version: VersionMetadata;
  resolution: ChannelResolution;
  promotion: Release;
}
export interface Draft {
  id: string;
  channel: string;
  baseVersionId: string;
  baseRevision: string;
  snapshotVersion: VersionMetadata;
  generation: number;
  status: 'open' | 'discarded' | 'published';
  createdAt: string;
  updatedAt: string;
  promotionId: string | null;
}
export interface CreateDraftRequest {
  baseVersionId: string;
  baseRevision: string;
  payload: BundlePayload;
}
export interface SaveDraftRequest {
  expectedGeneration: number;
  payload: BundlePayload;
}
export interface DiscardDraftRequest {
  expectedGeneration: number;
}
export type PublishDraftRequest = { expectedGeneration: number; expectedRevision: string } & (
  | { comparisonId: string; unevaluatedReason?: never; policyOverride?: PolicyOverride }
  | { unevaluatedReason: string; comparisonId?: never; policyOverride?: never }
);
export interface DraftSnapshot {
  generation: number;
  version: VersionMetadata;
}
export interface EvaluationRequest {
  requireBoundEvidence?: true;
  parentVersionId: string;
  parentDigest: string;
  candidateVersionId: string;
  candidateDigest: string;
  datasetRevision: string;
  runtime: Record<string, string>;
  graderRevision: string;
  expectedCases: CaseKey[];
  proposalId?: string | null;
  /** The evaluator's label for this run, such as the CLI `--name`. Display only. */
  runName?: string;
  /** An earlier request on the same parent and candidate content that this run supersedes. */
  retryOf?: string;
  /** sha256 digest of the quality policy chosen before the run. Receipts record whether they match. */
  policyDigest?: string;
}
export interface Evaluation extends EvaluationRequest {
  requireBoundEvidence: true;
  id: string;
  proposalId: string | null;
  /** `abandoned` is a server-side terminal state: the attempt's outcome is unknown,
   * its later reports are refused and its evidence never counts. */
  status: 'requested' | 'running' | 'completed' | 'failed' | 'interrupted' | 'abandoned';
  evaluatorPrincipal: string | null;
  attemptId: string | null;
  comparisonId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** Last start, progress report or bound report from the current attempt. */
  lastActivityAt?: string;
  abandonedAt?: string;
  /** The principal that abandoned it, or `service:evaluation-expiry` after inactivity. */
  abandonedBy?: string;
}
export interface StartEvaluationRequest {
  attemptId: string;
}
export interface FinishEvaluationRequest {
  attemptId: string;
  comparisonId: string;
}
/** Abandon a requested or running attempt whose outcome is unknown, such as a cancelled CI job. */
export interface AbandonEvaluationRequest {
  reason: string;
}
export interface InterruptEvaluationRequest {
  reason: string;
}
export interface Channel {
  name: string;
  revision: string;
  versionId: string;
}
export interface Connection {
  credentials?: Array<{
    id: string;
    kind: ConnectionCredentialKind;
    createdAt: string;
    revokedAt: string | null;
  }>;
  id: string;
  projectId: string;
  bundleId: string;
  channel: string;
  displayName: string;
  enabled: boolean;
  createdAt: string;
}
export interface CreateConnectionRequest {
  bundleId: string;
  channel: string;
  displayName: string;
}
export type ConnectionCredentialKind = 'content-read' | 'receipt-write';
export interface ConnectionCredential {
  id: string;
  kind: ConnectionCredentialKind;
  secret: string;
}
export interface LearningEvaluationDescriptor extends EvaluationDescriptor {
  fixtureProtocol?: 'installed-v1';
  datasetDigest?: string;
  caseFingerprints?: string[];
  familyFingerprints?: string[];
}
export type LearningSelectionPolicy = EvaluationPolicy;
export interface LearningSelectionPolicies {
  development: LearningSelectionPolicy;
  audit: LearningSelectionPolicy;
}
export interface LearningEnrollmentRequest {
  selectionPolicies?: LearningSelectionPolicies;
  installationId: string;
  permittedPaths: string[];
  /** Names authorized for whole-package operations on discrepancy-driven proposals. */
  skillPackages?: { createSkillNames: string[]; retireSkillNames: string[] };
  maxProposalAdmissions: number;
  maxCorrectionsPerRound?: number;
  development: LearningEvaluationDescriptor;
  audits: LearningEvaluationDescriptor[];
  automaticRollout: boolean;
  /** Require the stored rollout mode to match before applying an enrollment update. */
  expectedAutomaticRollout?: boolean;
  /** Defaults to enabled on enrollment. Omitting it on an update preserves the stored setting. */
  automaticRollback?: boolean;
  outcomePrincipal: string;
  evaluatorPrincipal: string;
}
export interface LearningEnrollment
  extends Omit<LearningEnrollmentRequest, 'audits' | 'expectedAutomaticRollout'> {
  automaticRollback: boolean;
  audits?: LearningEvaluationDescriptor[];
  auditCount: number;
  projectId: string;
  integrationId: string;
  bundleId: string;
  channel: string;
  authorizedBy: string;
  proposalAdmissions: number;
  renewalRevision: number;
  policyEpoch?: number;
  stoppedAt: string | null;
  enabled: boolean;
}
export interface LearningRound {
  batchSize?: number;
  includedCorrections?: { correctionId: string; outcomeId: string; attempt: number }[];
  parentSourceComparisonId?: string | null;
  incidentReplay?: LearningIncidentReplayStatus | null;
  correctionId?: string;
  attempt?: number;
  policyEpoch?: number;
  id: string;
  outcomeId: string;
  state:
    | 'proposing'
    | 'development'
    | 'developed'
    | 'audit'
    | 'awaiting_review'
    | 'promoted'
    | 'rejected';
  decision?: string | null;
  reason: string | null;
  parentVersionId: string;
  candidateVersionId: string | null;
  proposalId: string | null;
  developmentRequestId: string | null;
  developmentComparisonId: string | null;
  developmentParentVersionId?: string;
  developmentCandidateVersionId?: string | null;
  cumulativeDevelopmentRequestId?: string | null;
  cumulativeDevelopmentComparisonId?: string | null;
  cumulativeDevelopmentEstimate?: number | null;
  cumulativeDevelopmentLowerBound?: number | null;
  auditRequestId: string | null;
  auditComparisonId: string | null;
  promotionId: string | null;
  fieldAudits?: {
    windowSize: number;
    regressions: number;
    rollbackPromotionId?: string | null;
  };
}
export interface LearningDevelopmentIncumbent {
  versionId: string;
  chainLength: number;
  cumulativeEstimate: number | null;
  cumulativeLowerBound: number | null;
  nextAuditTrigger: {
    state:
      | 'awaitingSteps'
      | 'checkingCumulative'
      | 'auditPending'
      | 'awaitingReview'
      | 'unavailable';
    acceptedStepsRemaining: number;
  };
}
export interface LearningEnrollmentStatus extends LearningEnrollment {
  developmentIncumbent?: LearningDevelopmentIncumbent;
  policyHistory?: Array<{
    policyEpoch: number;
    development: LearningEvaluationDescriptor;
    selectionPolicies: LearningSelectionPolicies | null;
  }>;
  rounds: LearningRound[];
  remainingAudits: number;
  noiseCalibration?: {
    requestId: string | null;
    /** Evaluated evidence awaits the worker's decision. Completed includes the plan and projections. */
    status:
      | 'queued'
      | 'requested'
      | 'running'
      | 'evaluated'
      | 'completed'
      | 'failed'
      | 'interrupted'
      | 'stopped';
    failedAttempts?: number;
    stoppedReason?: string | null;
    caseCount?: number;
    flipRate?: number;
    pairedStandardDeviation?: number;
    effectiveRepetitions?: number;
    standardError?: number;
    minimumDetectableEffect?: number;
    powerGuardObservations?: number;
    caseVariability?: Record<string, number>;
    plan?: {
      /** Assigned repetitions per development case, shared with cumulative comparisons. */
      developmentRepetitions: Record<string, number>;
      /** Uniform count per audit cohort. Earlier plans recorded a repetition floor. */
      auditRepetitions: number[];
      /** Development cases with observed A/A disagreement. */
      flakyCaseCount: number;
      pairBudget: number;
      trialBudget: number;
      maxRepetitions: number;
    };
    developmentProjection?: LearningPowerProjection;
    cumulativeProjection?: LearningPowerProjection;
    auditProjections?: LearningPowerProjection[];
    warning?: string | null;
  };
  deliveredVersionId: string;
  deliveredRevision: string;
  restoreTargets?: LearningRestoreTarget[];
}
export interface LearningPowerProjection {
  caseCount: number;
  effectiveRepetitions: number;
  projectedMde: number | null;
  lowerMde?: number | null;
  upperMde?: number | null;
  decision?: 'stop' | 'warn' | 'admit';
  reason?: string;
  powerAtEffect: number | null;
  effect: number;
  casesNeededAtTarget: number | null;
  pairedTrials: number;
}
export interface LearningRestoreTarget {
  kind: 'delivery' | 'source';
  revision: string;
  versionId: string;
}
export interface LearningRestoreRequest {
  restoreId: string;
  expectedRevision: string;
  target: LearningRestoreTarget;
  reason: string;
}
export interface LearningReviewReceipt {
  roundId: string;
  state: 'promoted' | 'rejected';
  promotionId?: string;
}
export interface LearningRenewalRequest {
  /** Rotate only between rounds; each historical decision retains its original epoch. */
  development?: LearningEvaluationDescriptor;
  selectionPolicies?: LearningSelectionPolicies;
  renewalId: string;
  expectedRevision: number;
  proposalAdmissions: number;
  audits: LearningEvaluationDescriptor[];
}
export interface LearningRenewalReceipt extends LearningEnrollment {
  appliedRenewalRevision: number;
}
export interface LearningLesson {
  path: string;
  /** Application-approved teaching instruction. Keep transcripts, task data and secrets private. */
  instruction: string;
}
export type LearningIncidentReplayStatus = 'pending' | 'pass' | 'regression' | 'unavailable';
export interface LearningIncidentReplay {
  roundId: string;
  outcomeId: string;
  versionId: string;
  digest: string;
  baselineRevision: string;
  verdict: Exclude<LearningIncidentReplayStatus, 'pending'>;
  attempts?: Array<Exclude<LearningIncidentReplayStatus, 'pending'>>;
}
export interface LearningReleaseEvidence {
  promotionId: string;
  versionId: string;
  revision: string;
  withdrawn: boolean;
  rollback: { promotionId: string; versionId: string; revision: string } | null;
  developmentRequestId: string | null;
  auditRequestId: string | null;
}
export interface LearningOutcomeStatus {
  /** Release lineage is available on services that support field verdict lookup. */
  bundleId?: string;
  channel?: string;
  currentDelivery?: { versionId: string; revision: string };
  servedRelease?: LearningReleaseEvidence | null;
  fieldAudit?: {
    verdict: LearningFieldAuditRequest['verdict'];
    controlVersionId: string;
    triggeredRollback: boolean;
  } | null;
  outcomeId: string;
  status: 'completed' | 'failed';
  versionId: string;
  deliveryRevision: string | null;
  receivedAt: string;
  corrections: {
    correctionId: string;
    state: string;
    roundId: string | null;
    decision?: string | null;
    reason: string | null;
    incidentReplay: LearningIncidentReplayStatus | null;
    release?: LearningReleaseEvidence | null;
    candidateVersionId?: string | null;
    developmentRequestId?: string | null;
    auditRequestId?: string | null;
  }[];
}
export interface LearningOutcomeRequest {
  /** Require this correction's private incident to pass on each proposed candidate. */
  requireIncidentReplay?: boolean;
  outcomeId: string;
  versionId: string;
  digest: string;
  status: 'completed' | 'failed';
  /** Optional evidence for field auditing. New reporters send the delivery revision even without a receipt. */
  startedReceiptId?: string;
  deliveryRevision?: string;
  lesson?: LearningLesson;
  /** Bounded application-grade summaries suitable for sharing with the proposer. */
  feedback?: { expected: string; observed: string };
}
export interface LearningCorrectionRequest {
  requireIncidentReplay?: boolean;
  correctionId: string;
  outcomeId: string;
  lesson?: LearningLesson;
  feedback?: LearningOutcomeRequest['feedback'];
}
export interface LearningRecheck extends LearningCorrectionRequest {
  versionId: string;
  digest: string;
  revision: string;
}
export type LearningRecheckVerdict = 'reproduced' | 'resolved' | 'unavailable';
export interface LearningRecheckRequest {
  correctionId: string;
  versionId: string;
  digest: string;
  revision: string;
  verdict: LearningRecheckVerdict;
}
export interface LearningOutcomeReceipt {
  outcomeId: string;
  accepted: true;
  eligible: boolean;
  fieldAudit?: { parentVersionId: string; parentDigest: string };
}
export interface LearningFieldAuditRequest {
  outcomeId: string;
  startedReceiptId: string;
  versionId: string;
  digest: string;
  revision: string;
  parentVersionId: string;
  parentDigest: string;
  verdict: 'pass' | 'regression' | 'win' | 'loss' | 'tie';
}
export interface LearningFieldRequalification {
  versionId: string;
  digest: string;
  baselineRevision: string;
  pendingOutcomeIds: string[];
  failedOutcomeIds: string[];
}
export interface LearningFieldReplay {
  versionId: string;
  digest: string;
  baselineRevision: string;
  outcomeId: string;
  verdict: 'pass' | 'regression';
  attempts?: Array<'pass' | 'regression'>;
}
export interface LearningFieldAuditReceipt {
  outcomeId: string;
  accepted: true;
  regressions: number;
  windowSize: number;
  wins?: number;
  rollbackPromotionId?: string;
}
export interface CachedLearningParent {
  comparisonId: string;
  results: (CaseKey & { parent: Outcome })[];
}

export type LearningWorkItem = {
  cachedParent?: CachedLearningParent | null;
  evaluationRequestId: string;
  status: 'requested' | 'running';
} & (
  | { phase: 'development' | 'audit'; roundId: string; cumulative?: boolean }
  | { phase: 'calibration'; roundId: null }
);
export interface LearningWork {
  incidentReplays?: Omit<LearningIncidentReplay, 'verdict' | 'attempts'>[];
  fieldReplays?: Omit<LearningFieldReplay, 'verdict' | 'attempts'>[];
  installationId: string;
  bundleId: string;
  active: boolean;
  items: LearningWorkItem[];
  rechecks?: LearningRecheck[];
}
export interface DeliveryReceiptRequest {
  eventId: string;
  integrationId: string;
  projectId: string;
  bundleId: string;
  channel?: string | null;
  revision?: string | null;
  versionId: string;
  digest: string;
  stage: 'resolved' | 'downloaded' | 'verified' | 'prepared' | 'started';
  occurredAt: string;
  source: 'network' | 'cache' | 'offline';
  resolvedAt?: string | null;
  stale?: boolean | null;
}
export interface DeliveryReceipt extends DeliveryReceiptRequest {
  receivedAt: string;
  delayed: boolean;
}
/** Safe project-readable discovery; all latest fields describe one received observation. */
export interface ConnectionObservation {
  id: string;
  displayName: string;
  bundleId: string;
  channel: string;
  enabled: boolean;
  latestObservation: {
    eventId: string;
    stage: DeliveryReceiptRequest['stage'];
    versionId: string;
    digest: string;
    occurredAt: string;
    receivedAt: string;
  } | null;
}
export type Operation =
  | {
      status: 'committed';
      operationId: string;
      path: string;
      requestFingerprint?: string;
      result: Draft | BundleSetup | Proposal | Evaluation | Release | Comparison | VersionMetadata;
    }
  | { status: 'not_observed'; operationId: string }
  | { status: 'closed'; operationId: string; path?: string };

/** @deprecated Use Workspace. */
export type Project = Workspace;
/** @deprecated Use Release. */
export type Promotion = Release;
/** @deprecated Use ReleasePage. */
export type PromotionPage = ReleasePage;
/** @deprecated Use CreateReleaseRequest. */
export type PromoteRequest = CreateReleaseRequest;
/** @deprecated Use Connection. */
export type Integration = Connection;
/** @deprecated Use CreateConnectionRequest. */
export type CreateIntegrationRequest = CreateConnectionRequest;
/** @deprecated Use ConnectionCredential. */
export type IntegrationCredential = ConnectionCredential;
/** @deprecated Use ConnectionCredentialKind. */
export type IntegrationCredentialKind = ConnectionCredentialKind;
/** @deprecated Use ConnectionObservation. */
export type IntegrationObservation = ConnectionObservation;

/** @deprecated Use VerifiedVersion. */
export type VerifiedBundle = VerifiedVersion;
