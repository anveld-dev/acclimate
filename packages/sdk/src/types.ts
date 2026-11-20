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
  workspaceId: string;
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
export interface CreateReleaseRequest {
  versionId: string;
  expectedRevision: string;
  unevaluatedReason: string;
}
export interface Release {
  id: string;
  channel: string;
  revision: string;
  version: VersionMetadata;
  previousVersionId: string | null;
  unevaluatedReason: string | null;
  reviewer: string;
  createdAt: string;
}
export interface ReleasePage {
  items: Release[];
  nextBeforeRevision: string | null;
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
  connection?: Readonly<{ workspaceId: string; connectionId: string }>;
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
  workspaceId: string;
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
export interface DeliveryReceiptRequest {
  eventId: string;
  connectionId: string;
  workspaceId: string;
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
      result: BundleSetup | Release | VersionMetadata;
    }
  | { status: 'not_observed'; operationId: string }
  | { status: 'closed'; operationId: string; path?: string };

export interface LearningSetting {
  domain: string;
  benchmark: string;
  policyModel: string;
}
export interface LearningHeldOut {
  digest: string;
  cases: number;
}
export interface LearningLoopRequest {
  channel: string;
  appPrincipalId: string;
  setting: LearningSetting;
  heldOut: LearningHeldOut;
}
export type LearningLoopStatus = 'running' | 'paused' | 'stopped';
export interface LearningLoop extends LearningLoopRequest {
  workspaceId: string;
  bundleId: string;
  status: LearningLoopStatus;
  pauseReason: 'operator' | 'failed-rounds' | 'optimizer-context-too-large' | null;
  evolveRevision: number;
  liveCases: number;
  memoryRevision: number;
  nextRound: number;
  failedRounds: number;
  enrolledBy: string;
  createdAt: string;
  updatedAt: string;
  activeRound: LearningRoundSummary | null;
  rounds: LearningRoundSummary[];
}
export interface LearningRoundSummary {
  id: string;
  number: number;
  state: 'scoring_incumbent' | 'proposing' | 'screening' | 'evaluating' | 'selecting'
    | 'scoring_held_out' | 'completed' | 'failed' | 'stopped';
  decision: 'adopted' | 'kept' | null;
  reason: 'selector-kept' | 'no-candidates' | 'no-survivors' | 'no-evaluated-candidates'
    | 'channel-moved' | 'incumbent-evaluation-failed' | 'optimizer-unavailable'
    | 'optimizer-context-too-large' | 'selector-unavailable' | 'stopped' | null;
  parentVersionId: string;
  adoptedSample: number | null;
  adoptedVersionId: string | null;
  incumbentScore: number | null;
  heldOutScore: number | null;
  heldOutError: string | null;
  createdAt: string;
  endedAt: string | null;
}
export interface LearningRound extends LearningRoundSummary {
  channel: string;
  channelRevision: string;
  evolveRevision: number;
  memoryRevision: number;
  memoryDigest: string | null;
  historyDigest: string | null;
  setting: LearningSetting;
  heldOut: LearningHeldOut;
  optimizerModel: string | null;
  selection: LearningSelection | null;
  candidates: LearningCandidate[];
  evaluations: LearningEvaluation[];
}
export interface LearningDiagnosis {
  problem: { id: string } | { new: string };
  predicted: string[];
}
export interface LearningSelection {
  decision: 'adopt' | 'keep';
  sample: number | null;
  versionId: string | null;
  digest: string | null;
  reason: string;
  model: string;
  inputDigest: string;
}
export interface LearningCandidate {
  sample: number;
  status: 'generating' | 'generated' | 'dropped' | 'screened_out' | 'evaluating'
    | 'evaluated' | 'evaluation_failed';
  dropReason: 'provider-failed' | 'format-rejected' | 'scanner-rejected' | 'no-change' | null;
  rationale: string | null;
  changes: {
    edits: { path: string; oldText: string; newText: string }[];
    files: ({ op: 'write'; path: string; text: string } | { op: 'delete'; path: string })[];
  } | null;
  diagnosis: LearningDiagnosis | null;
  scan: { clean: boolean; findings: { rule: string; field: 'rationale' | 'rootCause' | 'path' | 'text'; path: string | null }[] } | null;
  screen: { verdict: 'evaluate' | 'skip'; reason: string } | null;
  versionId: string | null;
  evaluationId: string | null;
  evolveScore: number | null;
}
export type LearningEvaluationStatus = 'queued' | 'running' | 'scored' | 'failed' | 'cancelled';
export interface LearningWorkItem {
  evaluationId: string;
  roundId: string;
  roundNumber: number;
  role: 'incumbent' | 'candidate' | 'retained';
  sample: number | null;
  split: 'evolve' | 'heldOut';
  versionId: string;
  digest: string;
  evolveRevision: number | null;
  heldOut: LearningHeldOut | null;
  status: 'queued' | 'running';
  deadlineAt: string;
}
export interface LearningWork {
  bundleId: string;
  status: LearningLoopStatus;
  items: LearningWorkItem[];
}
export interface LearningEvaluation extends Pick<LearningWorkItem,
  'roundId' | 'role' | 'sample' | 'split' | 'versionId' | 'digest' | 'evolveRevision' | 'deadlineAt'> {
  id: string;
  status: LearningEvaluationStatus;
  score: number | null;
  cases: number;
  reportedCases: number;
  createdAt: string;
  startedAt: string | null;
  error: string | null;
  caseSummaries?: { caseId: string; passedRollouts: number; meanScore: number }[];
  report?: LearningEvaluationReport;
}
export interface LearningHeldOutRollout {
  score: number;
  passed: boolean;
}
export interface LearningRollout extends LearningHeldOutRollout {
  trace?: string | null;
  error?: string | null;
}
export interface LearningEvaluationReport {
  cases: { caseId: string; rollouts: LearningRollout[] }[];
}
export type LearningEvaluationReportRequest = { attemptId: string } & (
  | (LearningEvaluationReport & { error?: never })
  | { error: string; cases?: never }
);
export interface LearningEvaluationStart {
  attemptId: string;
}
export interface LearningEvaluationAssignment {
  evaluation: LearningEvaluation;
  cases: LearningEvolveCase[] | null;
  heldOut: LearningHeldOut | null;
  reportedCaseIds: string[];
}
export interface LearningEvolveCase<I = import('./evaluation/types.js').Json, E = import('./evaluation/types.js').Json> {
  caseId: string;
  input: I;
  expected: E;
}
export interface LearningEvolveCasesRequest {
  cases?: LearningEvolveCase[];
  retire?: string[];
}
export interface LearningEvolveCasesReceipt {
  evolveRevision: number;
  added: number;
  retired: number;
  liveCases: number;
}
export interface LearningOutcomeRequest extends Pick<LearningEvolveCase, 'input' | 'expected'> {
  outcomeId: string;
  versionId: string;
  digest: string;
}
export interface LearningOutcomeReceipt {
  outcomeId: string;
  caseId: string;
  evolveRevision: number;
}
export interface LearningMemory {
  currentRevision: number;
  memoryRevision: number;
  memoryDigest: string;
  improvementMemory: {
    schemaVersion: 1;
    memoryRevision: number;
    problems: {
      id: string;
      rootCause: string;
      openedRound: number;
      attempts: {
        round: number;
        sample: number;
        accepted: true;
        backfilled: boolean;
        what: { rationale: string; changes: NonNullable<LearningCandidate['changes']> };
        files: string[];
        predicted: string[];
        fixed: string[];
        missed: string[];
        passed: number;
        total: number;
        domain: string;
        provenance: LearningSetting & { round: number };
      }[];
    }[];
  };
  records: {
    revision: number;
    problemId: string;
    roundId: string;
    round: number;
    versionId: string;
    provenance: LearningSetting & {
      round: number;
      evolveRevision: number;
      heldOutDigest: string;
      optimizerModel: string;
    };
  }[];
}
