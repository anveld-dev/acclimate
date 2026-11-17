import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertArtifactBytes, bindLearningJob, canonicalJson, hashArtifact, parseArtifact,
  projectExperimentRuntime, sha256Bytes, validateExperience, validateExperimentGraph,
  validateHarness,
} from '../../src/learning/identity.js';
import { authorizeTeaching, experienceKey, validateAdmission } from '../../src/learning/admission.js';
import type {
  AdmissionDecisionV1, AdmissionValidationInput, CollectionSpec, ControlsManifestV1,
  DatasetSpec, EffectiveContextV1, ExperienceV1, ExperimentManifestV1, FeedbackV1,
  HarnessManifestV1, Ref, Scope,
} from '../../src/learning/evidence-types.js';

function fixtures() {
  const artifacts = new Map<string, unknown>(); let next = 1;
  function put<T>(value: T): Ref<T> {
    const hash = hashArtifact(value), id = `a-${next++}`;
    artifacts.set(id, structuredClone(value));
    return { id, sha256: hash.sha256, bytes: hash.byteLength };
  }
  async function resolve<T>(ref: Ref<T>): Promise<T> {
    if (!artifacts.has(ref.id)) throw new Error('Artifact absent');
    return structuredClone(artifacts.get(ref.id)) as T;
  }
  const scope: Scope = { projectId: 'p', bundleId: 'b', taskFamilyId: 'payment', partitionId: 'shop', policyEpoch: 'v2' };
  const task = put({ key: 'order-1', scenario: 'response-lost' });
  const runner = put({ implementation: 'runner-v1' }), mapping = put({ implementation: 'mapping-v1' });
  const tools = put({ effects: 'none' }), model = put({ model: 'none' }), contextPolicy = put({ policy: 'all' });
  const harness: HarnessManifestV1 = {
    schemaVersion: 1, kind: 'learning-harness', scope,
    content: { versionId: 'v1', digest: sha256Bytes('parent') },
    runner, mapping, tools, model, contextPolicy,
  };
  const parent = put(harness);
  const candidate = put({ ...harness, content: { versionId: 'v2', digest: sha256Bytes('candidate') } });
  const policy = put({ schemaVersion: 1, kind: 'admission-policy', revision: '1' });
  const mutationPolicy = put({ schemaVersion: 1, kind: 'mutation-policy', allowedPaths: ['AGENTS.md'] });
  const source = put({ ownerCorrection: 'Reuse the original request key.' });
  const feedback: FeedbackV1 = {
    schemaVersion: 1, kind: 'learning-feedback', source: 'owner_correction',
    sourcePrincipal: 'domain-owner', sourceArtifact: source, claim: source,
  };
  const feedbackRef = put(feedback);
  const experience: ExperienceV1 = {
    schemaVersion: 1, kind: 'learning-experience', scope, runId: 'run-1', attemptId: 'attempt-1',
    task, harness: parent, effectiveContext: null,
    outcome: { state: 'completed', result: put({ charged: 2 }) },
    trace: null, usage: { inputTokens: 0, outputTokens: null, costUsd: 0 }, feedback: [feedbackRef],
  };
  const experienceRef = put(experience);
  const decision: AdmissionDecisionV1 = {
    schemaVersion: 1, kind: 'learning-admission', experience: experienceRef, policy,
    decidedBy: 'domain-owner', decision: 'admitted', reasonCode: 'reviewed-correction',
    admitted: {
      targetScope: scope, teachingView: put({ instruction: 'Reuse the original key after a lost response.' }),
      use: 'authorized_correction', mutationPolicy, compatibilityObligations: put({ preserve: ['clean-payment'] }), replaces: [],
    },
  };
  const admission: AdmissionValidationInput = {
    decision, experienceRef, experience, targetScope: scope, policy, mutationPolicy,
    trustedDecider: 'domain-owner', resolve, authorizedFeedback: [feedbackRef],
  };
  const dataset: DatasetSpec = {
    schemaVersion: 1, kind: 'learning-dataset', domainSchema: put({ task: 'payment-v1' }),
    cases: [{ caseId: 'response-lost', repetitions: 2, input: task, expected: put({ charged: 1 }) }],
  };
  const collection: CollectionSpec = {
    schemaVersion: 1, kind: 'learning-collection', environmentContract: put({ network: false }),
    fixtureFactory: put({ factory: 'fresh-simulator' }), fixtureScope: 'fresh_per_arm',
    mode: { kind: 'deterministic', order: 'parent_first' }, interruptionPolicy: 'retain_and_reconcile',
  };
  const controls: ControlsManifestV1 = {
    schemaVersion: 1, kind: 'learning-controls', dataset: put(dataset), collection: put(collection),
    grader: put({ version: 'one-charge-v1' }), evidenceUse: put({ cohort: 'development' }),
  };
  const experiment: ExperimentManifestV1 = {
    schemaVersion: 1, kind: 'learning-experiment', scope, arms: { parent, candidate }, controls: put(controls),
  };
  return { put, resolve, artifacts, scope, task, parent, candidate, harness, experience, experienceRef,
    decision, admission, feedback, feedbackRef, experiment };
}

test('retained encoding reuses strict manifest canonicalization with one newline and exact bytes', () => {
  assert.equal(canonicalJson({ z: 1, a: ['x', true] }), '{"a":["x",true],"z":1}\n');
  const hash = hashArtifact({ value: 0.1 });
  const ref = { id: 'opaque-1', sha256: hash.sha256, bytes: hash.byteLength };
  assert.equal(parseArtifact<{ value: number }>(ref, hash.bytes).value, 0.1);
  assert.throws(() => assertArtifactBytes(ref, hash.bytes + ' '), /digest_mismatch/);
  const duplicated = '{"value":1,"value":2}\n';
  assert.throws(() => parseArtifact({ id: 'dup', sha256: sha256Bytes(duplicated), bytes: duplicated.length }, duplicated));
  const reordered = '{"z":1,"a":2}\n';
  assert.throws(() => parseArtifact({ id: 'order', sha256: sha256Bytes(reordered), bytes: reordered.length }, reordered));
  for (const value of [NaN, Infinity, undefined, new Date(), [undefined], { bad: undefined }])
    assert.throws(() => canonicalJson(value));
  let getterCalled = false;
  assert.throws(() => canonicalJson({ get value() { getterCalled = true; return 1; } }));
  assert.equal(getterCalled, false);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic));
  const sparse = new Array(2); sparse[1] = 1;
  assert.throws(() => canonicalJson(sparse));
});

test('strict experience shape preserves known zero and rejects unknown fields, forged reads and unbounded usage', () => {
  const f = fixtures();
  validateExperience(f.experience);
  assert.equal(f.experience.usage.costUsd, 0);
  assert.equal(f.experience.usage.outputTokens, null);
  assert.throws(() => validateExperience({ ...f.experience, status: 'started' }));
  assert.throws(() => validateExperience({ ...f.experience, usage: { ...f.experience.usage, inputTokens: -1 } }));
  assert.throws(() => validateExperience({ ...f.experience, schemaVersion: 2 }));
  let invoked = false;
  assert.throws(() => validateExperience({ ...f.experience, outcome: { get state() { invoked = true; return 'completed'; } } }));
  assert.equal(invoked, false);
  assert.notEqual(experienceKey(f.experience), experienceKey({ ...f.experience, attemptId: 'attempt-2' }));
});

test('authorized teaching requires verified identity, exact scope, and host-authorized correction provenance', async () => {
  const f = fixtures();
  const decision = await validateAdmission(f.admission);
  assert.deepEqual(authorizeTeaching(decision, f.scope), decision.admitted!.teachingView);
  await assert.rejects(validateAdmission({ ...f.admission, trustedDecider: 'another-owner' }), /unauthorized/);
  await assert.rejects(validateAdmission({ ...f.admission, targetScope: { ...f.scope, partitionId: 'other-shop' } }), /scope_mismatch/);
  await assert.rejects(validateAdmission({ ...f.admission, targetScope: { ...f.scope, policyEpoch: 'v3' } }), /scope_mismatch/);
  await assert.rejects(validateAdmission({ ...f.admission, authorizedFeedback: [] }), /correction_unauthorized/);
  const planted = f.put({ ...f.feedback, source: 'task_observation', sourcePrincipal: null });
  const experience = { ...f.experience, feedback: [planted] };
  const experienceRef = f.put(experience);
  await assert.rejects(validateAdmission({ ...f.admission, experience, experienceRef,
    decision: { ...f.decision, experience: experienceRef }, authorizedFeedback: [planted] }), /correction_unauthorized/);
  const altered = { ...f.decision, admitted: { ...f.decision.admitted!, teachingView: { ...f.decision.admitted!.teachingView, sha256: sha256Bytes('tampered') } } };
  await assert.rejects(validateAdmission({ ...f.admission, decision: altered }), /digest_mismatch/);
});

test('infrastructure failure remains observable without becoming a behavioral teaching demonstration', async () => {
  const f = fixtures();
  const experience: ExperienceV1 = { ...f.experience, outcome: { state: 'outcome_unknown', diagnostic: f.put({ reason: 'lost process' }) } };
  const experienceRef = f.put(experience);
  await assert.rejects(validateAdmission({ ...f.admission, experience, experienceRef,
    decision: { ...f.decision, experience: experienceRef } }), /outcome_ineligible/);
  const excluded: AdmissionDecisionV1 = { ...f.decision, experience: experienceRef, decision: 'needs_review', admitted: null };
  const result = await validateAdmission({ ...f.admission, experience, experienceRef, decision: excluded });
  assert.equal(authorizeTeaching(result, f.scope), null);
});

test('experiment graph detects content-independent harness drift and binds case, content and effective context to a job', async () => {
  const f = fixtures();
  const graph = await validateExperimentGraph({ manifest: f.experiment, resolve: f.resolve });
  assert.deepEqual(graph.expectedCases, [{ caseId: 'response-lost', repetition: 0 }, { caseId: 'response-lost', repetition: 1 }]);
  const changed = f.put({ ...graph.candidate, tools: f.put({ effects: 'network-write' }) });
  const drift = { ...f.experiment, arms: { ...f.experiment.arms, candidate: changed } };
  await assert.rejects(validateExperimentGraph({ manifest: drift, resolve: f.resolve }), /harness_drift/);
  await validateExperimentGraph({ manifest: drift, resolve: f.resolve, fixedHarness: false });
  const context: EffectiveContextV1 = { schemaVersion: 1, kind: 'learning-effective-context',
    harness: f.candidate, task: f.task, selected: [], omitted: [], hostContext: null, readEvidence: null };
  const experiment = f.put(f.experiment), preparedContext = f.put(context);
  const jobId = sha256Bytes(JSON.stringify(['request', 'attempt', 'candidate', 'v2', 'response-lost', 0])).slice(7);
  const input = { experiment, preparedContext, jobId, requestId: 'request', attemptId: 'attempt',
    side: 'candidate' as const, caseId: 'response-lost', repetition: 0,
    actualContent: graph.candidate.content, resolve: f.resolve };
  const binding = await bindLearningJob(input);
  assert.equal(binding.harness.sha256, f.candidate.sha256);
  await assert.rejects(bindLearningJob({ ...input, actualContent: graph.parent.content }), /content_mismatch/);
  await assert.rejects(bindLearningJob({ ...input, caseId: 'hidden-case' }), /case_mismatch/);
  await assert.rejects(bindLearningJob({ ...input, jobId: 'forged-job' }), /job_mismatch/);
  await assert.rejects(bindLearningJob({ ...input, preparedContext: f.put({ ...context, task: f.put({ task: 'different' }) }) }), /context_mismatch/);
  assert.throws(() => validateHarness({ ...f.harness, secretToken: 'never-allowed-manifest-field' }));
});

test('public projection is explicit and contains commitments only, with a declared disclosure scheme', () => {
  const commitment = sha256Bytes('explicitly-public-fictional-data');
  const runtime = projectExperimentRuntime({ scheme: 'sha256', experiment: commitment,
    parentHarness: commitment, candidateHarness: commitment, controls: commitment });
  assert.equal(runtime['acclimate.learning.schema'], '1');
  assert.equal(runtime['acclimate.learning.commitmentScheme'], 'sha256');
  assert.equal(Object.isFrozen(runtime), true);
  assert.throws(() => projectExperimentRuntime({ scheme: 'sha256', experiment: 'private-path',
    parentHarness: commitment, candidateHarness: commitment, controls: commitment }));
  assert.throws(() => projectExperimentRuntime({ scheme: 'opaque', experiment: '/private/task.json',
    parentHarness: 'registry:p', candidateHarness: 'registry:c', controls: 'registry:controls' }), /disclosure/);
  assert.equal(projectExperimentRuntime({ scheme: 'opaque', experiment: 'registry:exp', parentHarness: 'registry:p',
    candidateHarness: 'registry:c', controls: 'registry:controls' })['acclimate.learning.experiment'], 'registry:exp');
});
