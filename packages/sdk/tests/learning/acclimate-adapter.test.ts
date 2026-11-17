import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AcclimateClient } from '../../src/client.js';
import { defineEvaluation, ExecutionUncertainError } from '../../src/evaluation/index.js';
import { createAcclimateLearningAdapter, AcclimateLearningAdapterError } from '../../src/learning/adapters/acclimate.js';
import { hashArtifact, assertArtifactBytes, canonicalJson } from '../../src/learning/identity.js';
import type { Ref, ExperimentManifestV1, DatasetSpec } from '../../src/learning/evidence-types.js';
import { operationRuntime } from '../../src/learning/operations.js';
import type { AcclimateLearningAdapterOptions } from '../../src/learning/adapters/acclimate.js';
import type { LearningOperation, ReleaseReview, WorkContext } from '../../src/learning/types.js';
import type { BundlePayload, Comparison, Evaluation, EvaluationDescriptor, Operation, Promotion, VersionMetadata } from '../../src/types.js';
import type { EvaluationPolicyV1 } from '../../src/evaluation/policy.js';

const sha = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const now = '2026-11-17T00:00:00Z';
const payload = (text: string): BundlePayload => ({ schemaVersion: 1, files: [{ path: 'AGENTS.md', kind: 'instruction', text }] });
const baselinePayload = payload('unsafe');
const candidatePayload = payload('safe');
const parent: VersionMetadata = { id: 'parent', bundleId: 'bundle', parentVersionId: null,
  digest: sha(JSON.stringify(baselinePayload)), createdAt: now };
const candidate: VersionMetadata = { id: 'candidate', bundleId: 'bundle', parentVersionId: parent.id,
  digest: sha(JSON.stringify(candidatePayload)), createdAt: now };
const baseline = { channel: 'stable', revision: '1', version: parent };
const policy: EvaluationPolicyV1 = { schemaVersion: 1, id: 'improvement', revision: '1',
  metric: { name: 'correct', unit: 'reward', direction: 'higher' }, aggregation: 'equal-case-means',
  minimumMeanImprovement: 0.1, maximumCaseRegression: 0, requiredCases: ['case'] };
function operation(kind: LearningOperation['kind'] = 'propose'): LearningOperation {
  return { id: 'op', attemptId: 'attempt', key: 'operation-key', kind, round: 1,
    definitionDigest: sha('definition'), scope: { projectId: 'project', bundleId: 'bundle',
      taskFamilyId: 'task', partitionId: 'partition', policyEpoch: 'epoch' }, channel: 'stable',
    baseline, candidate: kind === 'propose' ? null : candidate, teaching: ['approved correction'],
    auditCohort: kind === 'audit' ? { id: 'audit', digest: fixtureDatasetReference().sha256 } : null,
    state: 'dispatching', maximumLiabilityMicroUsd: null };
}
function reference<T>(value: T): Ref<T> {
  const hash = hashArtifact(value);
  return { id: hash.sha256.slice(7), sha256: hash.sha256, bytes: hash.byteLength };
}
function fixtureDatasetReference(): Ref<DatasetSpec> {
  return reference({ schemaVersion: 1, kind: 'learning-dataset',
    domainSchema: reference({ schemaVersion: 1, kind: 'fixture-spec' }),
    cases: [{ caseId: 'case', repetitions: 1, input: reference(null), expected: reference(null) }] });
}
const artifactValues = new Map<string, unknown>();
const context: WorkContext = { signal: new AbortController().signal, artifacts: {
  async putArtifact<T>(value: T): Promise<Ref<T>> {
    const hash = hashArtifact(value), id = hash.sha256.slice(7);
    artifactValues.set(id, structuredClone(value));
    return { id, sha256: hash.sha256, bytes: hash.byteLength };
  },
  async readArtifact<T>(ref: Ref<T>): Promise<T> {
    const value = structuredClone(artifactValues.get(ref.id));
    assertArtifactBytes(ref, canonicalJson(value)); return value as T;
  },
} };
async function prepareExperiment({ operation: op, artifacts }: Parameters<AcclimateLearningAdapterOptions['prepareExperiment']>[0]): Promise<Ref<ExperimentManifestV1>> {
  const leaf = await artifacts.putArtifact({ schemaVersion: 1, kind: 'fixture-spec' });
  const harness = async (content: VersionMetadata) => artifacts.putArtifact({
    schemaVersion: 1 as const, kind: 'learning-harness' as const, scope: op.scope,
    content: { versionId: content.id, digest: content.digest as `sha256:${string}` },
    runner: leaf, mapping: leaf, tools: leaf, model: leaf, contextPolicy: leaf,
  });
  const input = await artifacts.putArtifact(null), expected = await artifacts.putArtifact(null);
  const dataset = await artifacts.putArtifact<DatasetSpec>({ schemaVersion: 1, kind: 'learning-dataset',
    domainSchema: leaf, cases: [{ caseId: 'case', repetitions: 1, input, expected }] });
  const collection = await artifacts.putArtifact({ schemaVersion: 1, kind: 'learning-collection',
    environmentContract: leaf, fixtureFactory: leaf, fixtureScope: 'fresh_per_arm',
    mode: { kind: 'deterministic', order: 'parent_first' }, interruptionPolicy: 'retain_and_reconcile' });
  const controls = await artifacts.putArtifact({ schemaVersion: 1 as const, kind: 'learning-controls' as const,
    dataset, collection, grader: leaf, evidenceUse: leaf });
  return artifacts.putArtifact({ schemaVersion: 1, kind: 'learning-experiment', scope: op.scope,
    arms: { parent: await harness(op.baseline.version), candidate: await harness(op.candidate!) }, controls });
}
function fixture() {
  const calls: Array<{ method: string; path: string; key: string | null; body: any }> = [];
  const retained = new Map<string, Operation>();
  let proposalState: 'queued' | 'running' | 'succeeded' | 'failed' = 'queued';
  let promotions: Promotion[] = [];
  const proposal = () => ({ id: 'proposal', parentVersionId: parent.id, status: proposalState,
    attempts: 1, candidate: proposalState === 'succeeded' ? candidate : null, rationale: null, error: null, createdAt: now });
  const respond = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const key = new Headers(init?.headers).get('Idempotency-Key');
    const route = url.pathname;
    calls.push({ method, path: route, key, body });
    if (method === 'GET' && route.includes('/operations/'))
      return respond(retained.get(route.split('/').at(-1)!) ?? { status: 'not_observed', operationId: key ?? 'operation-key' });
    if (method === 'GET' && route.endsWith('/channels/stable')) return respond(baseline);
    if (method === 'GET' && route.endsWith('/channels/stable/promotions')) return respond({ items: promotions, nextBeforeRevision: null });
    if (method === 'GET' && route.endsWith('/proposals/proposal')) return respond(proposal());
    if (method === 'GET' && route.endsWith('/versions/parent')) return respond(parent);
    if (method === 'GET' && route.endsWith('/versions/candidate')) return respond(candidate);
    if (method === 'GET' && route.endsWith('/versions/parent/payload')) return respond(baselinePayload);
    if (method === 'GET' && route.endsWith('/versions/candidate/payload')) return respond(candidatePayload);
    let result: any;
    if (method === 'POST' && route.endsWith('/versions')) result = candidate;
    else if (method === 'POST' && route.endsWith('/proposals')) result = proposal();
    else if (method === 'POST' && route.endsWith('/evaluation-requests'))
      result = { ...body, id: 'request', proposalId: null, status: 'requested', evaluatorPrincipal: null,
        attemptId: null, comparisonId: null, error: null, createdAt: now, updatedAt: now };
    else throw new Error('Unexpected adapter request: ' + method + ' ' + route);
    if (key) retained.set(key, { status: 'committed', operationId: key, path: route,
      requestFingerprint: sha('POST\0' + route + '\0' + JSON.stringify(body)), result });
    return respond(result);
  };
  const client = new AcclimateClient({ baseUrl: 'http://localhost:3000', token: 'fixture-token', scope: 'learner', fetch: fetcher, retries: 0 });
  const options: AcclimateLearningAdapterOptions = {
    client, projectId: 'project', bundleId: 'bundle', channel: 'stable', revision: sha('installed'),
    evaluatorConfigPath: '/configured/private/evaluator.json', allowedPaths: ['AGENTS.md'],
    propose: () => candidatePayload, prepareExperiment, disclosure: 'sha256',
    app: ({ runtime }) => defineEvaluation({ configId: 'test', configRevision: '1',
      datasetRevision: 'dataset', graderRevision: 'grader', runtime, execution: 'model-free',
      cases: [{ caseId: 'case', input: null, expected: null }],
      execute: async () => ({ output: 1 }), grade: async () => ({ reward: 1 }) }),
    policies: { development: policy, audit: policy },
  };
  return { options, calls, retained, setProposalState: (state: typeof proposalState) => { proposalState = state; },
    setPromotions: (value: Promotion[]) => { promotions = value; } };
}
function report(op: LearningOperation, descriptor: Readonly<EvaluationDescriptor>): Comparison {
  const arm = (reward: number) => ({ executionStatus: 'completed' as const, gradingStatus: 'scored' as const,
    reward, outputRef: null, error: null, usage: { costUsd: 0 } });
  return { ...structuredClone(descriptor), id: 'comparison', complete: true, submitter: 'evaluator', createdAt: now,
    evaluation: { requestId: 'request', attemptId: 'evaluation-attempt' }, parentVersionId: parent.id,
    candidateVersionId: candidate.id, parentDigest: parent.digest, candidateDigest: candidate.digest,
    results: [{ caseId: 'case', repetition: 0, parent: arm(0), candidate: arm(1) }] };
}
function evaluatedRequest(cmp: Comparison): Evaluation {
  return { ...cmp, id: 'request', proposalId: null, status: 'completed', evaluatorPrincipal: 'evaluator',
    attemptId: 'evaluation-attempt', comparisonId: cmp.id, error: null, createdAt: now, updatedAt: now };
}

test('installed pure proposer publishes the exact parent-bound bytes; reconciliation reads retained result without reposting', async () => {
  const f = fixture(), adapter = createAcclimateLearningAdapter(f.options), op = operation();
  assert.deepEqual(await adapter.readBaseline(), baseline);
  const first = await adapter.dispatch(op, context);
  assert.equal(first.status, 'succeeded'); assert.equal(first.costMicroUsd, 0);
  assert.deepEqual(first.output, { kind: 'proposal', candidate });
  const recovered = await adapter.reconcile(op, context);
  assert.deepEqual(recovered, first);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.calls.find(c => c.method === 'POST')!.key, op.key);
  assert.ok(!('promote' in adapter));
});

test('unobserved or conflicting retained creation cannot cause a replacement version', async () => {
  const f = fixture(), adapter = createAcclimateLearningAdapter(f.options), op = operation();
  const unknown = await adapter.reconcile(op, context);
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.executionSettled, false);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  await adapter.dispatch(op, context);
  const saved = f.retained.get(op.key)!;
  f.retained.set(op.key, { ...saved, requestFingerprint: sha('different') } as Operation);
  await assert.rejects(adapter.reconcile(op, context), (e: unknown) => e instanceof AcclimateLearningAdapterError && e.code === 'learning.adapter.operation_binding');
});

test('service proposal is polled under its original creation identity and leaves model spend unknown', async () => {
  const f = fixture(); delete f.options.propose;
  const adapter = createAcclimateLearningAdapter(f.options), op = operation();
  assert.equal((await adapter.dispatch(op, context)).status, 'pending');
  f.setProposalState('succeeded');
  const result = await adapter.reconcile(op, context);
  assert.equal(result.status, 'succeeded'); assert.equal(result.costMicroUsd, null);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.deepEqual(f.calls.find(c => c.method === 'POST')!.body.evidence, op.teaching);
  assert.equal(adapter.maximumLiabilityMicroUsd.propose, null);
});

test('fixed-file policy rejects structural or unauthorized changes before publishing', async () => {
  const f = fixture(); f.options.propose = () => ({ schemaVersion: 1, files: [...candidatePayload.files,
    { path: 'memory/new.md', kind: 'memory', text: 'extra' }] });
  const adapter = createAcclimateLearningAdapter(f.options);
  await assert.rejects(adapter.dispatch(operation(), context), (e: unknown) =>
    e instanceof AcclimateLearningAdapterError && e.code === 'learning.adapter.mutation_policy');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});

test('frozen runtime commitments and exact evaluation identities survive report recovery', async () => {
  const f = fixture(), op = operation('audit'); let callbacks = 0;
  f.options.runner = async input => {
    callbacks++;
    assert.equal(input.handoff.requestId, 'request');
    assert.deepEqual(Object.keys(input.handoff).sort(), ['bundleId','configuration','projectId','requestId','schemaVersion','serviceUrl'].sort());
    for (const [key, value] of Object.entries(operationRuntime(op))) assert.equal(input.handoff.configuration.runtime[key], value);
    const comparison = report(op, input.app.descriptor);
    return { schemaVersion: 1, evaluation: evaluatedRequest(comparison), comparison, executionState: 'finished' };
  };
  const adapter = createAcclimateLearningAdapter(f.options);
  const first = await adapter.dispatch(op, context);
  assert.equal(first.status, 'succeeded'); assert.equal(first.costMicroUsd, 0);
  assert.equal(first.output?.kind, 'evaluation');
  if (first.output?.kind !== 'evaluation') throw new Error('missing report');
  assert.equal(adapter.decide(first.output.comparison, 'audit').verdict, 'accepted');
  assert.deepEqual(await adapter.reconcile(op, context), first);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(callbacks, 2); // the installed runner owns same-attempt report replay, not this adapter
});

test('missing runtime commitments fail before evaluation creation and uncertainty stays unsettled', async () => {
  const f = fixture(), op = operation('development');
  f.options.app = () => defineEvaluation({ configId: 'test', configRevision: '1', datasetRevision: 'dataset',
    graderRevision: 'grader', runtime: {}, execution: 'model-free',
    cases: [{ caseId: 'case', input: null, expected: null }], execute: async () => ({ output: null }), grade: async () => ({ reward: 1 }) });
  await assert.rejects(createAcclimateLearningAdapter(f.options).dispatch(op, context), (e: unknown) =>
    e instanceof AcclimateLearningAdapterError && e.code === 'learning.adapter.manifest_binding');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  const g = fixture(); g.options.runner = async () => { throw new ExecutionUncertainError(); };
  const result = await createAcclimateLearningAdapter(g.options).dispatch(op, context);
  assert.equal(result.status, 'unknown'); assert.equal(result.executionSettled, false);
  assert.equal(result.reason, 'learning.adapter.execution_uncertain');
});

test('wrong runner report binding is rejected instead of becoming accepted evidence', async () => {
  const f = fixture(), op = operation('development');
  f.options.runner = async input => { const comparison = report(op, input.app.descriptor); comparison.candidateDigest = sha('foreign');
    return { schemaVersion: 1, comparison, evaluation: evaluatedRequest(comparison), executionState: 'finished' }; };
  await assert.rejects(createAcclimateLearningAdapter(f.options).dispatch(op, context), (e: unknown) =>
    e instanceof AcclimateLearningAdapterError && e.code === 'learning.adapter.evaluation_binding');
});

test('a comparison cannot conceal a foreign returned evaluation or evaluator', async () => {
  for (const changed of ['request', 'submitter'] as const) {
    const f = fixture(), op = operation('development');
    f.options.runner = async input => {
      const comparison = report(op, input.app.descriptor);
      const evaluation = evaluatedRequest(comparison);
      if (changed === 'request') evaluation.id = 'unrelated-request';
      else evaluation.evaluatorPrincipal = 'unrelated-evaluator';
      return { schemaVersion: 1, comparison, evaluation, executionState: 'finished' };
    };
    await assert.rejects(createAcclimateLearningAdapter(f.options).dispatch(op, context), (e: unknown) =>
      e instanceof AcclimateLearningAdapterError && e.code === 'learning.adapter.evaluation_binding');
  }
});

test('release observation requires the exact audited promotion and never writes a channel', async () => {
  const f = fixture(), op = operation('audit');
  const experiment = await prepareExperiment({operation: op, artifacts: context.artifacts});
  const app = await f.options.app({ operation: op, runtime: operationRuntime(op), experiment, artifacts: context.artifacts });
  const comparison = report(op, app.descriptor);
  const review: ReleaseReview = { schemaVersion: 1, kind: 'learning-release-review', campaignId: 'campaign', round: 1,
    definitionDigest: op.definitionDigest, baseline, candidate, comparison, auditCohort: op.auditCohort! };
  const promotion: Promotion = { id: 'promotion', channel: 'stable', revision: '2', version: candidate,
    previousVersionId: parent.id, comparisonId: comparison.id, unevaluatedReason: null, reviewer: 'human', createdAt: now };
  f.setPromotions([{ ...promotion, comparisonId: 'unrelated' }]);
  const adapter = createAcclimateLearningAdapter(f.options);
  assert.equal(await adapter.observeRelease(review), null);
  f.setPromotions([promotion]); assert.deepEqual(await adapter.observeRelease(review), promotion);
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
});


test('mismatched resolved experiment controls or hidden dataset changes cannot launch work', async () => {
  const f = fixture(), op = operation('development');
  f.options.prepareExperiment = async input => {
    const experiment = await prepareExperiment(input);
    const manifest = await input.artifacts.readArtifact(experiment);
    const controls = await input.artifacts.readArtifact(manifest.controls);
    const dataset = await input.artifacts.readArtifact(controls.dataset);
    dataset.cases[0].expected = await input.artifacts.putArtifact('changed private answer');
    controls.dataset = await input.artifacts.putArtifact(dataset);
    manifest.controls = await input.artifacts.putArtifact(controls);
    return input.artifacts.putArtifact(manifest);
  };
  let launched = false; f.options.runner = async () => { launched = true; throw new Error('must not launch'); };
  await assert.rejects(createAcclimateLearningAdapter(f.options).dispatch(op, context), (e: unknown) =>
    e instanceof AcclimateLearningAdapterError && e.code === 'learning.adapter.dataset_binding');
  assert.equal(launched, false); assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});

test('audit roster commitment must identify the actual resolved private dataset', async () => {
  const f = fixture(), op = operation('audit'); op.auditCohort!.digest = sha('different cohort');
  await assert.rejects(createAcclimateLearningAdapter(f.options).dispatch(op, context), (e: unknown) =>
    e instanceof AcclimateLearningAdapterError && e.code === 'learning.adapter.audit_dataset_binding');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});

test('opaque server proposer may not advertise an invented hard monetary liability', () => {
  const f = fixture(); delete f.options.propose;
  f.options.maximumLiabilityMicroUsd = { propose: 0, development: 0, audit: 0 };
  assert.throws(() => createAcclimateLearningAdapter(f.options), (e: unknown) =>
    e instanceof AcclimateLearningAdapterError && e.code === 'learning.adapter.opaque_proposer_liability');
});
