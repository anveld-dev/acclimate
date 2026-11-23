import type { Json } from './json.js';
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
export interface LearningLoopRequest {
  channel: string;
  setting: Pick<LearningSetting, 'domain' | 'benchmark'>;
  taskModel: string;
  judgeModel: string;
  maxRoundsPerDay?: number;
}
export type LearningLoopStatus = 'running' | 'paused' | 'stopped';
export interface LearningLoop extends Omit<LearningLoopRequest, 'taskModel' | 'judgeModel'> {
  taskModel: string | null;
  judgeModel: string | null;
  maxRoundsPerDay: number;
  admittedEvolve: number;
  admittedHeldOut: number;
  alert: { kind: 'regression-check-incomplete'; roundId: string; versionId: string } | { kind?: undefined; reverted?: boolean; roundId: string; score: number; previousScore: number; passRate?: number; previousPassRate?: number; flippedTasks: number } | null;
  setting: LearningSetting;
  waiting: string | null;
  /** False when the service has no optimizer model; Start is refused until an operator configures one. */
  optimizerConfigured?: boolean;
  taskRevision: number;
  workspaceId: string;
  bundleId: string;
  status: LearningLoopStatus;
  pauseReason: 'operator' | 'failed-rounds' | 'optimizer-context-too-large' | 'tasks-required' | null;
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
  diff: LearningCandidate['changes'];
  diagnosis: LearningDiagnosis | null;
  evolveScore: number | null;
  trigger: string;
  incumbentReused: boolean;
  taskModel: string | null;
  judgeModel: string | null;
  taskRevision: number;
  id: string;
  number: number;
  state: 'scoring_incumbent' | 'proposing' | 'screening' | 'evaluating' | 'selecting'
    | 'scoring_held_out' | 'completed' | 'failed' | 'stopped';
  decision: 'adopted' | 'kept' | null;
  reason: 'selector-kept' | 'no-candidates' | 'no-survivors' | 'no-evaluated-candidates'
    | 'no-matching-executor' | 'channel-moved' | 'incumbent-evaluation-failed' | 'optimizer-unavailable'
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
  progress?: {scored:number; total:number};
  reverted?: boolean;
  confirmedParentScore?: number|null;
  confirmedAdoptionScore?: number|null;
  channelRevision: string;
  evolveRevision: number;
  memoryRevision: number;
  memoryDigest: string | null;
  historyDigest: string | null;
  setting: LearningSetting;
  optimizerReasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | null;
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
  dropReason: 'provider-failed' | 'format-rejected' | 'scanner-rejected' | 'no-change' | 'blocked-version' | null;
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
export interface LearningEvaluation {
  roundId: string;
  role: string;
  sample: number | null;
  split: 'evolve' | 'heldOut';
  versionId: string;
  digest: string;
  evolveRevision: number | null;
  passedCases?: number;
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
  gatewayLog?: Json[];
  reasons?: string[];
  trace?: string | null;
  error?: string | null;
}
export interface LearningEvaluationReport {
  cases: { caseId: string; rollouts: LearningRollout[] }[];
}
export type LearningGrading = 'exact' | 'criteria';
export interface LearningOutcomeRequest {
  input: Json;
  expected: Json;
  output?: Json;
  /** How the expected answer is graded. By default a short single-line string or any non-string
   * JSON value is compared exactly, and a longer answer is judged against drafted criteria. */
  grading?: LearningGrading;
  outcomeId: string;
  versionId: string;
  digest: string;
}
export interface LearningOutcomeReceipt {
  outcomeId: string;
  taskId?: string;
  heldOutCount?: number;
  taskRevision: number;
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
      optimizerModel: string;
    };
  }[];
}

export interface LearningTaskRequest {
  input: Json;
  grader: Json;
}

export interface LearningTaskEdit {
  input?: Json;
  grader?: Json;
  confirm?: boolean;
}

export interface LearningTask {
  taskId: string;
  input: Json;
  grader: {type:'exact';expected:Json} | {type:'criteria';criteria:string[];reference?:Json};
  source: string;
  sourceFile?: string|null;
  sourceRow?: number|null;
  admissionReason?:string|null;
  flagReason?:string|null;
  confirmedBy?:string|null;
  split: string;
  admission: string;
  addedRevision: number;
}

export interface LearningTaskPage {
  items: LearningTask[];
  next: string|null;
  heldOutCount: number;
}

export interface LearningTaskReceipt {
  taskId?: string;
  split?: string;
  addedRevision?: number;
  heldOutCount?: number;
}

export interface LearningTaskRevision {
  taskId: string;
  revision: number;
}

export interface LearningTrialReceipt {
  trialId: string;
}

export interface LearningTrial {
  trialId: string;
  kind: string;
  status: string;
  output?: Json;
  gatewayLog?: Json;
  verdict?: {passed:boolean; score?:number; votes?:boolean[]|null; reasons?:string[]|null};
  /** Present when status is `failed`. `code` is the failed rollout's error code, or `cancelled`. */
  error?: {code: string|null};
}

export interface LearningTaskConfirmation {
  /** The task revision the confirmed tasks were written at, or null when none needed confirming. */
  revision: number|null;
  results: {taskId: string; result: 'confirmed'|'already-confirmed'|'not-held-out'|'not-found'}[];
}

export interface LearningTaskRecheck {
  taskId: string;
  admission: 'pending';
}

export interface LearningImportSummary extends LearningImport {
  createdAt: string;
  source: string;
}

export interface LearningImport {
  importId: string;
  rows: number;
  pending: number;
  converted: number;
  cards?: LearningTask[];
  status?: string;
  message?: string | null;
  setAsideCount?: number;
  setAside?: { row: number; source: string; reason: string }[];
}

export interface BlockedLearningVersion {
  digest: string;
  removedBy: string;
  note: string | null;
  createdAt: string;
}

export interface LearningUsageDay {
  day: string;
  rounds: number;
  rollouts: number;
  optimizerTokens: number;
  taskTokens: number;
  judgeTokens: number;
}

export interface LearningUsage {
  items: LearningUsageDay[];
}

export interface LearningRollback {
  roundId: string;
  note?: string;
}

export interface ModelProvider {
  verification?: {
    status: 'pending' | 'verified' | 'failed';
    checkedAt: string | null;
    models: { model: string; ok: boolean; usage: boolean; message: string | null }[];
  };
  baseUrl: string|null;
  allowedModels: string[];
  hasKey: boolean;
}

export interface ModelProviderRequest {
  baseUrl: string;
  allowedModels: string[];
  apiKey?: string;
}
