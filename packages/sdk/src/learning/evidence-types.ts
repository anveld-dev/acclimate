/** Private app-owned learning records. A digest is identity, never execution attestation. */
export type Sha256 = `sha256:${string}`;
export interface Ref<T = unknown> {
  id: string;
  sha256: Sha256;
  bytes: number;
}
export interface Scope {
  projectId: string;
  bundleId: string;
  taskFamilyId: string;
  partitionId: string;
  policyEpoch: string;
}
export interface ContentRef { versionId: string; digest: Sha256 }
export type PolicyRef = Ref<{ schemaVersion: 1; kind: string }>;
export interface FeedbackV1 {
  schemaVersion: 1;
  kind: 'learning-feedback';
  source: 'owner_correction' | 'verified_policy' | 'task_observation' | 'model_inference';
  sourceArtifact: Ref;
  sourcePrincipal: string | null;
  claim: Ref;
}
export interface HarnessManifestV1 {
  schemaVersion: 1;
  kind: 'learning-harness';
  scope: Scope;
  content: ContentRef;
  runner: Ref;
  mapping: Ref;
  tools: Ref;
  model: Ref;
  contextPolicy: Ref;
}
export interface EffectiveContextV1 {
  schemaVersion: 1;
  kind: 'learning-effective-context';
  harness: Ref<HarnessManifestV1>;
  task: Ref;
  selected: Array<{ resourceId: string; digest: Sha256; role: string }>;
  omitted: Array<{ resourceId: string; reasonCode: string }>;
  hostContext: Ref | null;
  readEvidence: Ref | null;
}
export interface ExperienceV1 {
  schemaVersion: 1;
  kind: 'learning-experience';
  scope: Scope;
  runId: string;
  attemptId: string;
  task: Ref;
  harness: Ref<HarnessManifestV1>;
  effectiveContext: Ref<EffectiveContextV1> | null;
  outcome:
    | { state: 'completed' | 'task_failed'; result: Ref }
    | { state: 'infrastructure_failed' | 'outcome_unknown'; diagnostic: Ref };
  trace: Ref | null;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  feedback: Ref<FeedbackV1>[];
}
export interface AdmissionDecisionV1 {
  schemaVersion: 1;
  kind: 'learning-admission';
  experience: Ref<ExperienceV1>;
  policy: PolicyRef;
  decidedBy: string;
  decision: 'admitted' | 'rejected' | 'needs_review';
  reasonCode: string;
  admitted: null | {
    targetScope: Scope;
    teachingView: Ref;
    use: 'hypothesis_only' | 'authorized_correction';
    mutationPolicy: PolicyRef;
    compatibilityObligations: Ref;
    replaces: Ref<AdmissionDecisionV1>[];
  };
}
export interface ControlsManifestV1 {
  schemaVersion: 1;
  kind: 'learning-controls';
  dataset: Ref<DatasetSpec>;
  grader: Ref;
  collection: Ref<CollectionSpec>;
  evidenceUse: Ref;
}
export interface ExperimentManifestV1 {
  schemaVersion: 1;
  kind: 'learning-experiment';
  scope: Scope;
  arms: { parent: Ref<HarnessManifestV1>; candidate: Ref<HarnessManifestV1> };
  controls: Ref<ControlsManifestV1>;
}
export interface DatasetSpec {
  schemaVersion: 1;
  kind: 'learning-dataset';
  domainSchema: Ref;
  cases: Array<{ caseId: string; repetitions: number; input: Ref; expected: Ref }>;
}
export interface CollectionSpec {
  schemaVersion: 1;
  kind: 'learning-collection';
  environmentContract: Ref;
  fixtureFactory: Ref;
  fixtureScope: 'fresh_per_arm';
  mode: { kind: 'deterministic'; order: 'parent_first' } | {
    kind: 'stochastic'; order: 'seeded_balanced'; seed: string;
  };
  interruptionPolicy: 'retain_and_reconcile';
}
export interface JobEvidenceBindingV1 {
  schemaVersion: 1;
  kind: 'learning-job-binding';
  experiment: Ref<ExperimentManifestV1>;
  requestId: string;
  attemptId: string;
  jobId: string;
  side: 'parent' | 'candidate';
  caseId: string;
  repetition: number;
  harness: Ref<HarnessManifestV1>;
  effectiveContext: Ref<EffectiveContextV1>;
}
/** Configured trusted ingestion decides provenance; source strings in task text confer no authority. */
export interface AdmissionValidationInput {
  decision: AdmissionDecisionV1;
  experienceRef: Ref<ExperienceV1>;
  experience: ExperienceV1;
  targetScope: Scope;
  policy: PolicyRef;
  mutationPolicy: PolicyRef;
  trustedDecider: string;
  resolve: <T>(reference: Ref<T>) => T | Promise<T>;
  /** Host-verified feedback references permitted to establish an authorized correction. */
  authorizedFeedback: readonly Ref<FeedbackV1>[];
}
