import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalEvaluationJson } from '../evaluation/manifest.js';
import type {
  AdmissionDecisionV1, CollectionSpec, ControlsManifestV1, DatasetSpec,
  EffectiveContextV1, ExperienceV1, ExperimentManifestV1, FeedbackV1,
  HarnessManifestV1, Ref, Scope, Sha256,
} from './evidence-types.js';

export class LearningEvidenceError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'LearningEvidenceError'; }
}
const fail = (code = 'learning.evidence.invalid'): never => { throw new LearningEvidenceError(code); };
const SCOPE_KEYS = ['projectId', 'bundleId', 'taskFamilyId', 'partitionId', 'policyEpoch'] as const;
const MAX_BYTES = 16 * 1024 * 1024;
const surrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** Version-one retained encoding: recursively sorted object keys, compact JSON and one LF. */
export function canonicalJson(value: unknown): string {
  try {
    // Reuse the SDK's versioned UTF-8-key/exact-binary64 encoding, adding the
    // learning artifact convention's terminal LF. This also bounds depth/nodes.
    const bytes = canonicalEvaluationJson(value) + '\n';
    if (Buffer.byteLength(bytes, 'utf8') > MAX_BYTES) fail('learning.evidence.too_large');
    return bytes;
  } catch (error) {
    if (error instanceof LearningEvidenceError) throw error;
    return fail();
  }
}
export const canonicalStringify = canonicalJson;
export function sha256Bytes(value: string | Uint8Array): Sha256 {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
export const artifactDigest = sha256Bytes;
export function hashArtifact(value: unknown): { bytes: string; sha256: Sha256; byteLength: number } {
  const bytes = canonicalJson(value);
  return { bytes, sha256: sha256Bytes(bytes), byteLength: Buffer.byteLength(bytes, 'utf8') };
}
export function assertArtifactBytes(ref: Ref, bytes: string | Uint8Array): void {
  validateRef(ref);
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.byteLength;
  if (size !== ref.bytes || sha256Bytes(bytes) !== ref.sha256) fail('learning.evidence.digest_mismatch');
}
export function parseArtifact<T>(ref: Ref<T>, bytes: string | Uint8Array): T {
  assertArtifactBytes(ref, bytes);
  try {
    const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (canonicalJson(value) !== text) fail();
    return value as T;
  } catch (error) {
    if (error instanceof LearningEvidenceError) throw error;
    return fail();
  }
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) return fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) fail();
  for (const d of Object.values(Object.getOwnPropertyDescriptors(value)))
    if (!('value' in d) || !d.enumerable) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || surrogate.test(value) || /[\x00-\x1f\x7f]/.test(value)) fail();
}
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) fail();
}
function digest(value: unknown): asserts value is Sha256 {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) fail();
}
function list(value: unknown, max = 10000): unknown[] {
  if (!Array.isArray(value) || value.length > max) return fail();
  canonicalJson(value);
  return value;
}
function header(value: unknown, kind: string, keys: readonly string[]): Record<string, unknown> {
  canonicalJson(value);
  const x = object(value, ['schemaVersion', 'kind', ...keys]);
  if (x.schemaVersion !== 1 || x.kind !== kind) fail('learning.evidence.schema');
  return x;
}
export function validateRef(value: unknown): asserts value is Ref {
  const x = object(value, ['id', 'sha256', 'bytes']);
  if (typeof x.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x.id)) fail();
  digest(x.sha256); count(x.bytes, MAX_BYTES);
}
export function sameRef(a: Ref, b: Ref): boolean {
  return a.id === b.id && a.sha256 === b.sha256 && a.bytes === b.bytes;
}
export function validateScope(value: unknown): asserts value is Scope {
  const x = object(value, SCOPE_KEYS);
  for (const key of SCOPE_KEYS) text(x[key]);
}
export function sameScope(a: Scope, b: Scope): boolean {
  return SCOPE_KEYS.every((key) => a[key] === b[key]);
}
function nullableRef(value: unknown): void { if (value !== null) validateRef(value); }
function refs(value: unknown): void { for (const ref of list(value, 1000)) validateRef(ref); }
export function validateFeedback(value: unknown): asserts value is FeedbackV1 {
  const x = header(value, 'learning-feedback', ['source', 'sourceArtifact', 'sourcePrincipal', 'claim']);
  if (!['owner_correction', 'verified_policy', 'task_observation', 'model_inference'].includes(String(x.source))) fail();
  validateRef(x.sourceArtifact); validateRef(x.claim);
  if (x.sourcePrincipal !== null) text(x.sourcePrincipal);
}
export function validateExperience(value: unknown): asserts value is ExperienceV1 {
  const x = header(value, 'learning-experience', ['scope', 'runId', 'attemptId', 'task', 'harness', 'effectiveContext', 'outcome', 'trace', 'usage', 'feedback']);
  validateScope(x.scope); text(x.runId); text(x.attemptId); validateRef(x.task); validateRef(x.harness);
  nullableRef(x.effectiveContext); nullableRef(x.trace); refs(x.feedback);
  const outcome = x.outcome as Record<string, unknown>;
  if (!outcome || typeof outcome !== 'object') fail();
  if (outcome.state === 'completed' || outcome.state === 'task_failed') {
    object(outcome, ['state', 'result']); validateRef(outcome.result);
  } else if (outcome.state === 'infrastructure_failed' || outcome.state === 'outcome_unknown') {
    object(outcome, ['state', 'diagnostic']); validateRef(outcome.diagnostic);
  } else fail();
  const usage = object(x.usage, ['inputTokens', 'outputTokens', 'costUsd']);
  for (const key of ['inputTokens', 'outputTokens']) if (usage[key] !== null) count(usage[key]);
  if (usage.costUsd !== null && (typeof usage.costUsd !== 'number' || !Number.isFinite(usage.costUsd) || usage.costUsd < 0)) fail();
}
export function validateHarness(value: unknown): asserts value is HarnessManifestV1 {
  const x = header(value, 'learning-harness', ['scope', 'content', 'runner', 'mapping', 'tools', 'model', 'contextPolicy']);
  validateScope(x.scope); const content = object(x.content, ['versionId', 'digest']); text(content.versionId); digest(content.digest);
  for (const key of ['runner', 'mapping', 'tools', 'model', 'contextPolicy']) validateRef(x[key]);
}
export function validateEffectiveContext(value: unknown): asserts value is EffectiveContextV1 {
  const x = header(value, 'learning-effective-context', ['harness', 'task', 'selected', 'omitted', 'hostContext', 'readEvidence']);
  validateRef(x.harness); validateRef(x.task); nullableRef(x.hostContext); nullableRef(x.readEvidence);
  const seen = new Set<string>();
  for (const item of list(x.selected)) {
    const entry = object(item, ['resourceId', 'digest', 'role']); text(entry.resourceId); text(entry.role); digest(entry.digest);
    if (seen.has(entry.resourceId)) fail(); seen.add(entry.resourceId);
  }
  for (const item of list(x.omitted)) {
    const entry = object(item, ['resourceId', 'reasonCode']); text(entry.resourceId); text(entry.reasonCode);
    if (seen.has(entry.resourceId)) fail(); seen.add(entry.resourceId);
  }
}
export function validateAdmissionDecision(value: unknown): asserts value is AdmissionDecisionV1 {
  const x = header(value, 'learning-admission', ['experience', 'policy', 'decidedBy', 'decision', 'reasonCode', 'admitted']);
  validateRef(x.experience); validateRef(x.policy); text(x.decidedBy); text(x.reasonCode);
  if (!['admitted', 'rejected', 'needs_review'].includes(String(x.decision))) fail();
  if (x.decision !== 'admitted') { if (x.admitted !== null) fail(); return; }
  const a = object(x.admitted, ['targetScope', 'teachingView', 'use', 'mutationPolicy', 'compatibilityObligations', 'replaces']);
  validateScope(a.targetScope); validateRef(a.teachingView); validateRef(a.mutationPolicy); validateRef(a.compatibilityObligations); refs(a.replaces);
  if (a.use !== 'hypothesis_only' && a.use !== 'authorized_correction') fail();
}
export function validateControls(value: unknown): asserts value is ControlsManifestV1 {
  const x = header(value, 'learning-controls', ['dataset', 'grader', 'collection', 'evidenceUse']);
  for (const key of ['dataset', 'grader', 'collection', 'evidenceUse']) validateRef(x[key]);
}
export function validateExperiment(value: unknown): asserts value is ExperimentManifestV1 {
  const x = header(value, 'learning-experiment', ['scope', 'arms', 'controls']); validateScope(x.scope); validateRef(x.controls);
  const arms = object(x.arms, ['parent', 'candidate']); validateRef(arms.parent); validateRef(arms.candidate);
}
export function validateDataset(value: unknown): asserts value is DatasetSpec {
  const x = header(value, 'learning-dataset', ['domainSchema', 'cases']); validateRef(x.domainSchema);
  const seen = new Set<string>();
  for (const item of list(x.cases)) {
    const c = object(item, ['caseId', 'repetitions', 'input', 'expected']); text(c.caseId); count(c.repetitions, 1000);
    if (c.repetitions === 0 || seen.has(c.caseId)) fail(); seen.add(c.caseId); validateRef(c.input); validateRef(c.expected);
  }
  if (!seen.size) fail();
}
export function validateCollection(value: unknown): asserts value is CollectionSpec {
  const x = header(value, 'learning-collection', ['environmentContract', 'fixtureFactory', 'fixtureScope', 'mode', 'interruptionPolicy']);
  validateRef(x.environmentContract); validateRef(x.fixtureFactory);
  if (x.fixtureScope !== 'fresh_per_arm' || x.interruptionPolicy !== 'retain_and_reconcile') fail();
  const mode = x.mode as Record<string, unknown>;
  if (mode?.kind === 'deterministic') {
    object(mode, ['kind', 'order']); if (mode.order !== 'parent_first') fail();
  } else if (mode?.kind === 'stochastic') {
    object(mode, ['kind', 'order', 'seed']); if (mode.order !== 'seeded_balanced') fail(); text(mode.seed);
  } else fail();
}
export interface PublicExperimentCommitments {
  experiment: string; parentHarness: string; candidateHarness: string; controls: string;
  scheme: 'sha256' | 'opaque';
}
/** Disclosure is explicit: commitments are supplied by the app, never derived from private records implicitly. */
export function projectExperimentRuntime(input: PublicExperimentCommitments): Readonly<Record<string, string>> {
  object(input, ['experiment', 'parentHarness', 'candidateHarness', 'controls', 'scheme']);
  if (input.scheme !== 'sha256' && input.scheme !== 'opaque') fail('learning.evidence.disclosure');
  for (const key of ['experiment', 'parentHarness', 'candidateHarness', 'controls'] as const) {
    if (input.scheme === 'sha256') digest(input[key]);
    else if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/.test(input[key])) fail('learning.evidence.disclosure');
  }
  return Object.freeze({
    'acclimate.learning.schema': '1',
    'acclimate.learning.commitmentScheme': input.scheme,
    'acclimate.learning.experiment': input.experiment,
    'acclimate.learning.parentHarness': input.parentHarness,
    'acclimate.learning.candidateHarness': input.candidateHarness,
    'acclimate.learning.controls': input.controls,
  });
}

export type ArtifactResolver = <T>(ref: Ref<T>) => T | Promise<T>;
async function resolveVerified<T>(resolve: ArtifactResolver, ref: Ref<T>): Promise<T> {
  const value = await resolve(ref);
  assertArtifactBytes(ref, canonicalJson(value));
  return value;
}
export interface ExperimentGraphInput {
  manifest: ExperimentManifestV1;
  resolve: ArtifactResolver;
  /** The default fixed-harness learner may vary content only. */
  fixedHarness?: boolean;
}
/** Resolve/verify the complete selected treatment and control graph before requesting work. */
export async function validateExperimentGraph(input: ExperimentGraphInput): Promise<{
  parent: HarnessManifestV1;
  candidate: HarnessManifestV1;
  controls: ControlsManifestV1;
  dataset: DatasetSpec;
  expectedCases: Array<{ caseId: string; repetition: number }>;
}> {
  validateExperiment(input.manifest);
  const { manifest, resolve } = input;
  const parent = await resolveVerified(resolve, manifest.arms.parent);
  const candidate = await resolveVerified(resolve, manifest.arms.candidate);
  validateHarness(parent); validateHarness(candidate);
  for (const harness of [parent, candidate]) {
    if (!sameScope(manifest.scope, harness.scope)) fail('learning.experiment.scope_mismatch');
    for (const key of ['runner', 'mapping', 'tools', 'model', 'contextPolicy'] as const)
      await resolveVerified(resolve, harness[key]);
  }
  if (input.fixedHarness !== false)
    for (const key of ['runner', 'mapping', 'tools', 'model', 'contextPolicy'] as const)
      if (!sameRef(parent[key], candidate[key])) fail('learning.experiment.harness_drift');
  const controls = await resolveVerified(resolve, manifest.controls); validateControls(controls);
  const dataset = await resolveVerified(resolve, controls.dataset); validateDataset(dataset);
  const collection = await resolveVerified(resolve, controls.collection); validateCollection(collection);
  await resolveVerified(resolve, controls.grader); await resolveVerified(resolve, controls.evidenceUse);
  await resolveVerified(resolve, dataset.domainSchema);
  for (const item of dataset.cases) {
    await resolveVerified(resolve, item.input); await resolveVerified(resolve, item.expected);
  }
  await resolveVerified(resolve, collection.environmentContract); await resolveVerified(resolve, collection.fixtureFactory);
  const expectedCases = dataset.cases.flatMap((item) =>
    Array.from({ length: item.repetitions }, (_, repetition) => ({ caseId: item.caseId, repetition })),
  );
  return structuredClone({ parent, candidate, controls, dataset, expectedCases });
}
export interface JobBindingInput {
  experiment: Ref<ExperimentManifestV1>;
  requestId: string;
  attemptId: string;
  jobId: string;
  side: 'parent' | 'candidate';
  caseId: string;
  repetition: number;
  preparedContext: Ref<EffectiveContextV1>;
  actualContent: { versionId: string; digest: Sha256 };
  resolve: ArtifactResolver;
}
/** Bind a job to its actual content and retained context; this does not attest model reads. */
export async function bindLearningJob(input: JobBindingInput): Promise<import('./evidence-types.js').JobEvidenceBindingV1> {
  validateRef(input.experiment); validateRef(input.preparedContext);
  for (const value of [input.requestId, input.attemptId, input.jobId, input.caseId]) text(value);
  count(input.repetition, 999);
  if (input.side !== 'parent' && input.side !== 'candidate') fail();
  const manifest = await resolveVerified(input.resolve, input.experiment);
  const graph = await validateExperimentGraph({ manifest, resolve: input.resolve, fixedHarness: false });
  const harness = graph[input.side];
  if (input.actualContent.versionId !== harness.content.versionId || input.actualContent.digest !== harness.content.digest)
    fail('learning.experiment.content_mismatch');
  if (!graph.expectedCases.some((item) => item.caseId === input.caseId && item.repetition === input.repetition))
    fail('learning.experiment.case_mismatch');
  const expectedJobId = sha256Bytes(JSON.stringify([
    input.requestId, input.attemptId, input.side, harness.content.versionId, input.caseId, input.repetition,
  ])).slice('sha256:'.length);
  if (input.jobId !== expectedJobId) fail('learning.experiment.job_mismatch');
  const context = await resolveVerified(input.resolve, input.preparedContext); validateEffectiveContext(context);
  if (!sameRef(context.harness, manifest.arms[input.side]) ||
      !sameRef(context.task, graph.dataset.cases.find((item) => item.caseId === input.caseId)!.input))
    fail('learning.experiment.context_mismatch');
  await resolveVerified(input.resolve, context.task);
  if (context.hostContext) await resolveVerified(input.resolve, context.hostContext);
  if (context.readEvidence) await resolveVerified(input.resolve, context.readEvidence);
  return {
    schemaVersion: 1, kind: 'learning-job-binding', experiment: structuredClone(input.experiment),
    requestId: input.requestId, attemptId: input.attemptId, jobId: input.jobId,
    side: input.side, caseId: input.caseId, repetition: input.repetition,
    harness: structuredClone(manifest.arms[input.side]), effectiveContext: structuredClone(input.preparedContext),
  };
}
