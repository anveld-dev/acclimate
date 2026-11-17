import type { ChannelResolution, Comparison, Promotion, VersionMetadata } from '../types.js';
import type { AdmissionDecisionV1, ExperienceV1, FeedbackV1, Ref, Scope, PolicyRef } from './evidence-types.js';

export type TaskOutcome = ExperienceV1;
export interface ArtifactAccess {
  putArtifact<T>(value: T): Promise<Ref<T>>;
  readArtifact<T>(reference: Ref<T>): Promise<T>;
}
export interface AuditCohort {
  id: string;
  digest: string;
}
export interface LearnerDefinition {
  schemaVersion: 1;
  campaignId: string;
  scope: Scope;
  channel: string;
  policy: PolicyRef;
  mutationPolicy: PolicyRef;
  /** Fixed installed runner artifact digest; content-dependent harness manifests remain separate. */
  harnessDigest: string;
  adapterRevision: string;
  trustedDecider: string;
  auditCohorts: readonly AuditCohort[];
  limits: {
    maximumRounds: number;
    maximumPaidAdmissions: number;
    budget: { mode: 'admission-count' | 'soft-usd' | 'hard-usd'; maximumMicroUsd?: number };
  };
}
export interface AdmissionResult {
  decision: AdmissionDecisionV1;
  /** Bounded sanitized strings rendered from the admitted teaching view. */
  teaching: string[];
}
export interface LearningAdmissionInput {
  experience: ExperienceV1;
  experienceRef: Ref<ExperienceV1>;
  artifacts: ArtifactAccess;
}
export type OperationKind = 'propose' | 'development' | 'audit';
export interface LearningOperation {
  id: string;
  attemptId: string;
  key: string;
  kind: OperationKind;
  round: number;
  definitionDigest: string;
  scope: Scope;
  channel: string;
  baseline: ChannelResolution;
  candidate: VersionMetadata | null;
  teaching: string[];
  auditCohort: AuditCohort | null;
  state: 'prepared' | 'dispatching' | 'pending' | 'unknown' | 'result-saved' | 'settled';
  maximumLiabilityMicroUsd: number | null;
  receipt?: Ref<WorkReceipt>;
}
export type WorkOutput =
  | { kind: 'proposal'; candidate: VersionMetadata }
  | { kind: 'evaluation'; comparison: Comparison };
export interface WorkReceipt {
  operationId: string;
  status: 'pending' | 'unknown' | 'succeeded' | 'failed';
  executionSettled: boolean;
  output?: WorkOutput;
  costMicroUsd: number | null;
  reason?: string;
}
export interface WorkContext { signal: AbortSignal; artifacts: ArtifactAccess }
export interface LearningAdapter {
  /** Frozen installation/configuration fingerprint, not a self-authorizing identity. */
  revision: string;
  /** Maximum all-in liability including hidden retries, or null when unbounded. */
  maximumLiabilityMicroUsd: Record<OperationKind, number | null>;
  readBaseline(): Promise<ChannelResolution>;
  dispatch(operation: Readonly<LearningOperation>, context: WorkContext): Promise<WorkReceipt>;
  /** Same-work lookup/recovery only; must never start replacement native work. */
  reconcile(operation: Readonly<LearningOperation>, context: WorkContext): Promise<WorkReceipt>;
  decide(comparison: Comparison, stage: 'development' | 'audit'): SelectionVerdict;
  observeRelease(review: Readonly<ReleaseReview>): Promise<Promotion | null>;
}
export interface SelectionVerdict {
  verdict: 'accepted' | 'rejected' | 'indeterminate';
  reason: string;
}
export interface ReleaseReview {
  schemaVersion: 1;
  kind: 'learning-release-review';
  campaignId: string;
  round: number;
  definitionDigest: string;
  baseline: ChannelResolution;
  candidate: VersionMetadata;
  comparison: Comparison;
  auditCohort: AuditCohort;
}
export interface WorkResolution {
  operationId: string;
  expectedRevision: number;
  /** A retained artifact that the installed resolver verifies against the original work. */
  evidence: Ref<unknown>;
}
export type LearnerCommand =
  | { kind: 'observe'; observation: TaskOutcome }
  | { kind: 'request-stop'; reason: string }
  | { kind: 'resume'; reason: string }
  | { kind: 'resolve-uncertainty'; resolution: WorkResolution };
export interface LearnerView {
  schemaVersion: 1;
  campaignId: string;
  revision: number;
  definitionDigest: string;
  desiredMode: 'running' | 'stopped';
  phase: 'ready' | 'working' | 'awaiting-review' | 'needs-reconciliation' | 'stopped' | 'finished';
  nextAction: string;
  round: number;
  baseline: ChannelResolution | null;
  candidate: VersionMetadata | null;
  operation: { id: string; kind: OperationKind; state: LearningOperation['state'] } | null;
  releaseReview: Ref<ReleaseReview> | null;
  decisions: readonly LearningDecision[];
  budget: {
    admissions: number;
    knownSpentMicroUsd: number;
    reservedMicroUsd: number;
    unknownCosts: number;
  };
  auditExposures: readonly string[];
  observations: number;
}
export interface LearningDecision {
  round: number;
  stage: 'admission' | 'development' | 'audit' | 'release';
  verdict: string;
  reason: string;
  reference: Ref<unknown> | null;
}
export interface CommandReceipt { commandId: string; sha256: string; sequence: number }
export type Progress = LearnerView;
export interface Learner {
  submit(command: LearnerCommand, commandId: string): Promise<CommandReceipt>;
  advance(options: { signal?: AbortSignal; deadline: number }): Promise<Progress>;
  inspect(): Promise<LearnerView>;
}
export interface OpenLearnerOptions {
  directory: string;
  definition: LearnerDefinition;
  adapter: LearningAdapter;
  admit(input: LearningAdmissionInput): Promise<AdmissionResult> | AdmissionResult;
  /** Host-assigned eligible correction references, not source labels supplied by task text. */
  authorizedFeedback?(experience: ExperienceV1): Promise<readonly Ref<FeedbackV1>[]> | readonly Ref<FeedbackV1>[];
  /** Optional installed proof resolver; caller-supplied booleans never settle work. */
  resolve?(input: { operation: LearningOperation; evidence: unknown; artifacts: ArtifactAccess }): Promise<WorkReceipt>;
}
