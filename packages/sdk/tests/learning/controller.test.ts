import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openLearner } from '../../src/learning/controller.js';
import { openLearningStore } from '../../src/learning/store.js';
import { operationRuntime } from '../../src/learning/operations.js';
import { sha256Bytes } from '../../src/learning/identity.js';
import type { AdmissionDecisionV1, ExperienceV1, FeedbackV1, HarnessManifestV1 } from '../../src/learning/evidence-types.js';
import type { LearningAdapter, LearnerDefinition, LearningOperation, OpenLearnerOptions, ReleaseReview, WorkReceipt } from '../../src/learning/types.js';
import type { ChannelResolution, Comparison, Promotion } from '../../src/types.js';

async function fixture() {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'learning-controller-'));
  const store = await openLearningStore(directory);
  const scope = { projectId: 'p', bundleId: 'b', taskFamilyId: 'payment', partitionId: 'fictional', policyEpoch: 'v1' };
  const leaf = await store.putArtifact({ installed: true });
  const policy = await store.putArtifact({ schemaVersion: 1 as const, kind: 'admission-policy' });
  const mutationPolicy = await store.putArtifact({ schemaVersion: 1 as const, kind: 'fixed-files' });
  let baseline: ChannelResolution = { channel: 'stable', revision: '1', version: { id: 'baseline', bundleId: 'b', parentVersionId: null, digest: sha256Bytes('baseline'), createdAt: '2026-01-01' } };
  const feedback = await store.putArtifact<FeedbackV1>({ schemaVersion: 1, kind: 'learning-feedback', source: 'owner_correction', sourcePrincipal: 'owner', sourceArtifact: leaf, claim: leaf });
  const teaching = ['Use the original payment key'];
  const teachingView = await store.putArtifact(teaching);
  const definition: LearnerDefinition = { schemaVersion: 1, campaignId: 'campaign', scope, channel: 'stable', policy, mutationPolicy,
    harnessDigest: leaf.sha256, adapterRevision: 'installed-v1', trustedDecider: 'owner',
    auditCohorts: [{ id: 'audit-1', digest: sha256Bytes('audit-1') }, { id: 'audit-2', digest: sha256Bytes('audit-2') }],
    limits: { maximumRounds: 5, maximumPaidAdmissions: 20, budget: { mode: 'hard-usd', maximumMicroUsd: 100 } } };
  let calls = 0, reconciles = 0, promotion: Promotion | null = null;
  let throwDispatch = false;
  let invalidVerdict = false;
  let dispatchHook: (() => Promise<void>) | null = null;
  const receipts = new Map<string, WorkReceipt>();
  const adapter: LearningAdapter = {
    revision: definition.adapterRevision, maximumLiabilityMicroUsd: { propose: 1, development: 1, audit: 1 },
    readBaseline: async () => structuredClone(baseline),
    async dispatch(operation) {
      calls++;
      await dispatchHook?.();
      const receipt: WorkReceipt = operation.kind === 'propose'
        ? { operationId: operation.id, status: 'succeeded', executionSettled: true, costMicroUsd: 1,
          output: { kind: 'proposal', candidate: { id: `candidate-${operation.round}`, parentVersionId: baseline.version.id,
            bundleId: 'b', digest: sha256Bytes(`candidate-${operation.round}`), createdAt: '2026-01-01' } } }
        : { operationId: operation.id, status: 'succeeded', executionSettled: true, costMicroUsd: 1,
          output: { kind: 'evaluation', comparison: comparison(operation) } };
      receipts.set(operation.id, receipt);
      if (throwDispatch) throw new Error('simulated lost acknowledgement');
      return receipt;
    },
    async reconcile(operation) { reconciles++; return receipts.get(operation.id) ?? { operationId: operation.id, status: 'unknown', executionSettled: false, costMicroUsd: null }; },
    decide: () => invalidVerdict ? { verdict: 'broken' as 'accepted', reason: 'broken' } : { verdict: 'accepted', reason: 'qualified' },
    observeRelease: async () => promotion,
  };
  function comparison(operation: LearningOperation): Comparison {
    return { id: `comparison-${operation.kind}-${operation.round}`, parentVersionId: operation.baseline.version.id,
      parentDigest: operation.baseline.version.digest, candidateVersionId: operation.candidate!.id,
      candidateDigest: operation.candidate!.digest, evaluation: { requestId: operation.id, attemptId: operation.attemptId },
      datasetRevision: 'frozen', graderRevision: 'grader-v1', runtime: operationRuntime(operation),
      expectedCases: [], results: [], complete: true, submitter: 'evaluator', createdAt: '2026-01-01' };
  }
  const options: OpenLearnerOptions = { directory, definition, adapter, authorizedFeedback: () => [feedback],
    resolve: async ({ operation }) => receipts.get(operation.id)!,
    async admit({ experienceRef }) {
      const decision: AdmissionDecisionV1 = { schemaVersion: 1, kind: 'learning-admission', experience: experienceRef, policy,
        decidedBy: 'owner', decision: 'admitted', reasonCode: 'reviewed', admitted: { targetScope: scope,
          teachingView, use: 'authorized_correction', mutationPolicy, compatibilityObligations: leaf, replaces: [] } };
      return { decision, teaching };
    } };
  async function outcome(runId = 'task-1'): Promise<ExperienceV1> {
    const harness = await store.putArtifact<HarnessManifestV1>({ schemaVersion: 1, kind: 'learning-harness', scope,
      content: { versionId: baseline.version.id, digest: baseline.version.digest as `sha256:${string}` },
      runner: leaf, mapping: leaf, model: leaf, tools: leaf, contextPolicy: leaf });
    return { schemaVersion: 1, kind: 'learning-experience', scope, runId, attemptId: 'attempt', task: leaf, harness,
      effectiveContext: null, outcome: { state: 'completed', result: leaf }, trace: null,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, feedback: [feedback] };
  }
  async function release(review: ReleaseReview) {
    promotion = { id: `promotion-${review.round}`, channel: 'stable', revision: String(Number(baseline.revision) + 1),
      version: review.candidate, previousVersionId: baseline.version.id, comparisonId: review.comparison.id,
      reviewer: 'human', createdAt: '2026-01-01', unevaluatedReason: null };
    baseline = { channel: 'stable', revision: promotion.revision, version: promotion.version };
  }
  return { directory, store, options, outcome, release, adapter, calls: () => calls, reconciles: () => reconciles,
    failDispatch: () => { throwDispatch = true; }, invalidVerdict: (value: boolean) => { invalidVerdict = value; },
    hook: (action: (() => Promise<void>) | null) => { dispatchHook = action; }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
const advance = (learner: Awaited<ReturnType<typeof openLearner>>) => learner.advance({ deadline: Date.now() + 20_000 });

test('recurring campaigns retain exact decisions, fresh audits, budgets and reviewer releases across reopen', async () => {
  const f = await fixture();
  try {
    let learner = await openLearner(f.options);
    for (let round = 1; round <= 2; round++) {
      await learner.submit({ kind: 'observe', observation: await f.outcome(`task-${round}`) }, `observation-${round}`);
      await advance(learner); await advance(learner); const review = await advance(learner);
      assert.equal(review.phase, 'awaiting-review');
      const artifact = await f.store.readArtifact(review.releaseReview!);
      await f.release(artifact);
      learner = await openLearner(f.options);
      const released = await advance(learner);
      assert(released.decisions.some((d) => d.stage === 'release' && d.round === round));
      assert.equal(released.budget.knownSpentMicroUsd, round * 3);
    }
    assert.equal(f.calls(), 6);
    assert.equal((await learner.inspect()).auditExposures.length, 2);
    await assert.rejects(openLearner({ ...f.options, definition: { ...f.options.definition, channel: 'changed' } }), /definition-conflict/);
  } finally { await f.cleanup(); }
});

test('lost acknowledgement reconciles the same work without dispatch or budget reset', async () => {
  const f = await fixture();
  try {
    const learner = await openLearner(f.options);
    await learner.submit({ kind: 'observe', observation: await f.outcome() }, 'observation');
    f.failDispatch();
    assert.equal((await advance(learner)).phase, 'needs-reconciliation');
    const reopened = await openLearner(f.options);
    assert.equal((await advance(reopened)).nextAction, 'evaluate-development');
    assert.equal(f.calls(), 1); assert.equal(f.reconciles(), 1);
    assert.equal((await reopened.inspect()).budget.admissions, 1);
  } finally { await f.cleanup(); }
});

test('stop during successful work retains result, blocks selection and resumes settled result safely', async () => {
  const f = await fixture();
  try {
    const learner = await openLearner(f.options);
    await learner.submit({ kind: 'observe', observation: await f.outcome() }, 'observation');
    await advance(learner); // candidate
    f.hook(async () => { await learner.submit({ kind: 'request-stop', reason: 'operator stop' }, 'stop'); });
    const stopped = await advance(learner);
    assert.equal(stopped.phase, 'stopped');
    assert.equal(stopped.operation?.state, 'result-saved');
    assert(!stopped.decisions.some((d) => d.stage === 'development'));
    await advance(learner); // apply stop command
    f.hook(null);
    await learner.submit({ kind: 'resume', reason: 'operator resume' }, 'resume');
    const resumed = await advance(learner);
    assert.equal(resumed.nextAction, 'evaluate-audit');
    assert.equal(f.calls(), 2);
  } finally { await f.cleanup(); }
});

test('local policy failure after result retention does not replay work or double-charge budget', async () => {
  const f = await fixture();
  try {
    const learner = await openLearner(f.options);
    await learner.submit({ kind: 'observe', observation: await f.outcome() }, 'observation');
    await advance(learner);
    f.invalidVerdict(true);
    await assert.rejects(advance(learner), /selection-invalid/);
    assert.equal((await learner.inspect()).operation?.state, 'result-saved');
    f.invalidVerdict(false);
    const resumed = await advance(await openLearner(f.options));
    assert.equal(resumed.budget.knownSpentMicroUsd, 2);
    assert.equal(resumed.nextAction, 'evaluate-audit');
    assert.equal(f.calls(), 2);
  } finally { await f.cleanup(); }
});

test('unavailable observation refs are rejected before queue acceptance and stale resolutions do not block stop', async () => {
  const f = await fixture();
  try {
    const learner = await openLearner(f.options);
    const observation = await f.outcome(); observation.task = { ...observation.task, id: 'f'.repeat(64), sha256: `sha256:${'f'.repeat(64)}` };
    await assert.rejects(learner.submit({ kind: 'observe', observation }, 'bad-observation'));
    await learner.submit({ kind: 'resolve-uncertainty', resolution: { operationId: 'absent', expectedRevision: 0, evidence: await f.store.putArtifact({ proof: true }) } }, 'stale-resolution');
    await learner.submit({ kind: 'request-stop', reason: 'stop despite invalid earlier command' }, 'stop');
    const stopped = await advance(learner);
    assert.equal(stopped.phase, 'stopped'); assert.equal(f.calls(), 0);
    assert(stopped.decisions.some((d) => d.reason === 'command-invalid'));
  } finally { await f.cleanup(); }
});

test('hard monetary configuration refuses adapters with unbounded liability', async () => {
  const f = await fixture();
  try {
    f.adapter.maximumLiabilityMicroUsd.audit = null;
    await assert.rejects(openLearner(f.options), /budget-unbounded-adapter/);
  } finally { await f.cleanup(); }
});

test('invalid resolved receipts are rejected without blocking a later stop command', async () => {
  const f = await fixture();
  try {
    f.options.resolve = async ({ operation }) => ({
      operationId: operation.id, status: 'succeeded', executionSettled: true, costMicroUsd: -1,
    });
    const learner = await openLearner(f.options);
    await learner.submit({ kind: 'observe', observation: await f.outcome() }, 'observation');
    f.failDispatch();
    const unknown = await advance(learner);
    assert.equal(unknown.phase, 'needs-reconciliation');
    await learner.submit({ kind: 'resolve-uncertainty', resolution: {
      operationId: unknown.operation!.id, expectedRevision: unknown.revision,
      evidence: await f.store.putArtifact({ invalidReadback: true }),
    } }, 'invalid-resolution');
    await learner.submit({ kind: 'request-stop', reason: 'stop after invalid resolution' }, 'stop');
    const stopped = await advance(learner);
    assert.equal(stopped.phase, 'stopped');
    assert.equal(stopped.operation?.state, 'result-saved');
    assert(stopped.decisions.some((d) => d.reason === 'command-invalid'));
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});


test('typed selection failure during explicit resolution retains known result without partial settlement', async () => {
  const f = await fixture();
  try {
    const learner = await openLearner(f.options);
    await learner.submit({ kind: 'observe', observation: await f.outcome() }, 'observation');
    await advance(learner);
    f.failDispatch();
    const unknown = await advance(learner);
    assert.equal(unknown.phase, 'needs-reconciliation');
    const evidence = await f.store.putArtifact({ serviceReadback: 'bound existing comparison' });
    await learner.submit({ kind: 'resolve-uncertainty', resolution: {
      operationId: unknown.operation!.id, expectedRevision: unknown.revision, evidence,
    } }, 'resolve-existing');
    f.invalidVerdict(true);
    await assert.rejects(advance(learner), /selection-invalid/);
    const retained = await learner.inspect();
    assert.equal(retained.operation?.state, 'result-saved');
    assert.equal(retained.budget.knownSpentMicroUsd, 1);
    f.invalidVerdict(false);
    const settled = await advance(learner);
    assert.equal(settled.budget.knownSpentMicroUsd, 2);
    assert.equal(f.calls(), 2);
  } finally { await f.cleanup(); }
});
