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
  compatibilityTarget?: CompatibilityTarget;
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
export type PromoteRequest = { versionId: string; expectedRevision: string } & (
  | { comparisonId: string; unevaluatedReason?: never }
  | { unevaluatedReason: string; comparisonId?: never }
);
export interface Promotion {
  id: string;
  channel: string;
  revision: string;
  version: VersionMetadata;
  previousVersionId: string | null;
  comparisonId: string | null;
  unevaluatedReason: string | null;
  reviewer: string;
  createdAt: string;
}
export interface PromotionPage {
  items: Promotion[];
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
export interface EvaluationCapabilities {
  schemaVersion: 1;
  projectId: string;
  principalId: string;
  checkedAt: string;
  readUnpublished: true;
  writeEvaluation: boolean;
  retainedEvaluationOperations: true;
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
export interface VerifiedBundle {
  version: VersionMetadata;
  payload: BundlePayload;
  resolution?: ChannelResolution;
  resolvedAt: number;
  stale: boolean;
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
export interface Project {
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
  promotion: Promotion;
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
  | { comparisonId: string; unevaluatedReason?: never }
  | { unevaluatedReason: string; comparisonId?: never }
);
export interface DraftSnapshot {
  generation: number;
  version: VersionMetadata;
}
export interface EvaluationRequest {
  requireBoundEvidence?: boolean;
  parentVersionId: string;
  parentDigest: string;
  candidateVersionId: string;
  candidateDigest: string;
  datasetRevision: string;
  runtime: Record<string, string>;
  graderRevision: string;
  expectedCases: CaseKey[];
  proposalId?: string | null;
}
export interface Evaluation extends EvaluationRequest {
  id: string;
  proposalId: string | null;
  status: 'requested' | 'running' | 'completed' | 'failed' | 'interrupted';
  evaluatorPrincipal: string | null;
  attemptId: string | null;
  comparisonId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface StartEvaluationRequest {
  attemptId: string;
}
export interface FinishEvaluationRequest {
  attemptId: string;
  comparisonId: string;
}
export interface InterruptEvaluationRequest {
  reason: string;
}
export interface Channel {
  name: string;
  revision: string;
  versionId: string;
}
export interface Integration {
  credentials?: Array<{
    id: string;
    kind: IntegrationCredentialKind;
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
export interface CreateIntegrationRequest {
  bundleId: string;
  channel: string;
  displayName: string;
}
export type IntegrationCredentialKind = 'content-read' | 'receipt-write';
export interface IntegrationCredential {
  id: string;
  kind: IntegrationCredentialKind;
  secret: string;
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
export interface IntegrationObservation {
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
      result: Draft | BundleSetup | Proposal | Evaluation | Promotion | Comparison | VersionMetadata;
    }
  | { status: 'not_observed'; operationId: string }
  | { status: 'closed'; operationId: string; path?: string };
