import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openLearner } from '../../src/learning/controller.js';
import { openLearningStore } from '../../src/learning/store.js';
import { operationRuntime } from '../../src/learning/operations.js';
import { hashArtifact, sha256Bytes } from '../../src/learning/identity.js';
import type { EvaluationPolicyV1 } from '../../src/evaluation/policy.js';
import type { AdmissionDecisionV1, ExperienceV1, FeedbackV1, HarnessManifestV1, Ref } from '../../src/learning/evidence-types.js';
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
  const dispatched: LearningOperation[] = [];
  const receipts = new Map<string, WorkReceipt>();
  const adapter: LearningAdapter = {
    revision: definition.adapterRevision, maximumLiabilityMicroUsd: { propose: 1, development: 1, audit: 1 },
    readBaseline: async () => structuredClone(baseline),
    async dispatch(operation) {
      calls++;
      dispatched.push(operation);
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
  return { directory, store, options, outcome, release, adapter, dispatched, calls: () => calls, reconciles: () => reconciles,
    failDispatch: () => { throwDispatch = true; }, invalidVerdict: (value: boolean) => { invalidVerdict = value; },
    hook: (action: (() => Promise<void>) | null) => { dispatchHook = action; }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
const advance = (learner: Awaited<ReturnType<typeof openLearner>>) => learner.advance({ deadline: Date.now() + 120_000 });

const developmentPolicy: EvaluationPolicyV1 = {
  schemaVersion: 1, id: 'development', revision: '1',
  metric: { name: 'quality', unit: 'score', direction: 'higher' },
  aggregation: 'equal-case-means', minimumMeanImprovement: 0.1, maximumCaseRegression: 0,
  requiredCases: [],
};
const auditPolicy = { ...developmentPolicy, id: 'audit', minimumMeanImprovement: 0.2 };

test('campaigns retain canonical selection policies and reject drift before selecting a saved result', async () => {
  const f = await fixture();
  try {
    const selectionPolicies = { development: developmentPolicy, audit: auditPolicy };
    const developmentDigest = hashArtifact(developmentPolicy).sha256;
    const auditDigest = hashArtifact(auditPolicy).sha256;
    let reportedDigest = auditDigest;
    const adapter: LearningAdapter = { ...f.adapter, selectionPolicies,
      decide: (_, stage) => ({ verdict: 'accepted', reason: 'qualified',
        policyDigest: stage === 'development' ? reportedDigest : auditDigest }) };
    const options = { ...f.options, adapter };
    const learner = await openLearner(options);
    await learner.submit({ kind: 'observe', observation: await f.outcome() }, 'observation');
    await advance(learner);
    await assert.rejects(advance(learner), /selection-invalid/);
    assert.equal((await learner.inspect()).operation?.state, 'result-saved');
    for (const stage of ['development', 'audit'] as const) {
      await assert.rejects(openLearner({ ...options, adapter: { ...adapter,
        selectionPolicies: { ...selectionPolicies, [stage]: { ...selectionPolicies[stage], maximumCaseRegression: 0.5 } },
      } }), /definition-conflict/);
    }
    reportedDigest = developmentDigest;
    const reopened = await openLearner(options);
    await advance(reopened);
    const view = await advance(reopened);
    assert.equal(f.calls(), 3);
    for (const [stage, policyDigest] of [['development', developmentDigest], ['audit', auditDigest]] as const) {
      const decision = view.decisions.find(value => value.stage === stage)!;
      assert.equal(decision.policyDigest, policyDigest);
      const record = await f.store.readArtifact(decision.reference!) as {
        policy: Ref<EvaluationPolicyV1>; verdict: { policyDigest: string };
      };
      assert.equal(record.verdict.policyDigest, policyDigest);
      assert.equal(record.policy.sha256, policyDigest);
      assert.deepEqual(await f.store.readArtifact(record.policy), selectionPolicies[stage]);
    }
  } finally { await f.cleanup(); }
});

test('reopen rejects retroactive policy binding for a caller-managed campaign', async () => {
  const f = await fixture();
  try {
    const learner = await openLearner(f.options);
    await assert.rejects(openLearner({ ...f.options, adapter: { ...f.adapter,
      selectionPolicies: { development: developmentPolicy, audit: auditPolicy },
    } }), /definition-conflict/);
    assert.equal((await (await openLearner(f.options)).inspect()).definitionDigest, (await learner.inspect()).definitionDigest);
  } finally { await f.cleanup(); }
});

test('a settled development rejection drives a bounded retry across reopen without teaching from audit', async () => {
  const f = await fixture();
  try {
    f.options.definition.limits.maximumDevelopmentAttempts = 2;
    const controls = sha256Bytes('frozen development controls');
    let developmentDecisions = 0;
    const options = { ...f.options, adapter: { ...f.adapter, developmentControlsDigest: controls,
      decide: (_: Comparison, stage: 'development' | 'audit') => stage === 'development' && ++developmentDecisions > 1
        ? { verdict: 'accepted' as const, reason: 'qualified' }
        : { verdict: 'rejected' as const, reason: 'private diagnostic' },
    } };
    let learner = await openLearner(options);
    const step = () => learner.advance({ deadline: Date.now() + 180_000 });
    await learner.submit({ kind: 'observe', observation: await f.outcome() }, 'observation');
    await step();
    assert.equal((await step()).nextAction, 'retry-development');
    await assert.rejects(openLearner({ ...options, adapter: { ...options.adapter,
      developmentControlsDigest: sha256Bytes('drift') } }), /definition-conflict/);
    learner = await openLearner(options);
    assert.equal((await step()).round, 1);
    assert.deepEqual(f.dispatched[2].proposalHistory, [{ verdict: 'rejected', candidateId: 'candidate-1',
      candidateDigest: sha256Bytes('candidate-1'), totalPairs: 0, scoredPairs: 0, improvedPairs: 0, regressedPairs: 0 }]);
    await step();
    assert.equal((await step()).nextAction, 'audit-failed');
    assert.equal(f.dispatched[4].kind, 'audit');
    assert.equal(f.dispatched[4].proposalHistory, undefined);
    await learner.submit({ kind: 'observe', observation: await f.outcome('next') }, 'next');
    assert.equal((await step()).round, 2);
    assert.deepEqual(f.dispatched[5].proposalHistory, f.dispatched[2].proposalHistory);
    assert.equal(new Set(f.dispatched.map(operation => operation.key)).size, 6);
  } finally { await f.cleanup(); }
});

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

test('declines the exact pending review across reopen and begins the next round on the current baseline', async () => {
  const f = await fixture();
  try {
    const learner = await openLearner(f.options);
    await learner.submit({ kind: 'observe', observation: await f.outcome() }, 'first-observation');
    await advance(learner); await advance(learner);
    const { releaseReview } = await advance(learner);
    assert(releaseReview);
    const stale = await f.store.putArtifact({ ...await f.store.readArtifact(releaseReview), round: 99 });
    await learner.submit({ kind: 'decline-release', review: stale, reason: 'Stale request' }, 'stale-decline');
    assert.deepEqual((await advance(learner)).releaseReview, releaseReview);
    await learner.submit({ kind: 'observe', observation: await f.outcome('task-2') }, 'second-observation');
    await learner.submit({ kind: 'decline-release', review: releaseReview, reason: 'Keep the current release' }, 'decline');

    const reopened = await openLearner(f.options);
    const progress = await advance(reopened);
    assert.equal(progress.round, 2);
    assert.equal(progress.baseline?.version.id, 'baseline');
    assert.equal(progress.releaseReview, null);
    const declines = progress.decisions.filter((entry) => entry.verdict === 'declined');
    assert.equal(declines.length, 1);
    assert.deepEqual(await f.store.readArtifact(declines[0]!.reference!), {
      review: releaseReview, reason: 'Keep the current release', commandId: 'decline',
    });
    assert.deepEqual(f.dispatched[0]!.admission, (await f.store.readArtifact(releaseReview)).admission);
    assert.equal(f.dispatched[0]!.admission?.use, 'authorized_correction');
  } finally { await f.cleanup(); }
});

test('a replacement removes an older queued lesson before any dispatch', async () => {
  const f = await fixture();
  try {
    const admit = f.options.admit;
    let previous: Awaited<ReturnType<typeof f.store.putArtifact<AdmissionDecisionV1>>>;
    f.options.admit = async (input) => {
      const result = await admit(input);
      if (input.experience.runId === 'task-1') previous = await f.store.putArtifact(result.decision);
      else result.decision.admitted!.replaces = [previous];
      return result;
    };
    const learner = await openLearner(f.options);
    await learner.submit({ kind: 'observe', observation: await f.outcome() }, 'first-observation');
    await learner.submit({ kind: 'observe', observation: await f.outcome('task-2') }, 'replacement');
    const progress = await advance(learner);
    assert.equal(f.calls(), 1);
    assert.equal(progress.round, 1);
    assert.equal(progress.decisions.filter((entry) => entry.verdict === 'superseded').length, 1);
    const lesson = f.dispatched[0]!.admission!;
    assert.equal((await f.store.readArtifact(lesson.experience)).runId, 'task-2');
    assert.deepEqual(lesson.replaces, [previous!]);
  } finally { await f.cleanup(); }
});

for (const timing of ['active', 'audit-dispatch', 'awaiting-review'] as const) {
  test(`a replacement takes precedence over a lesson at ${timing}`, async () => {
    const f = await fixture();
    try {
      const learner = await openLearner(f.options);
      await learner.submit({ kind: 'observe', observation: await f.outcome() }, 'first-observation');
      const proposal = await advance(learner);
      const previous = proposal.decisions.find((entry) => entry.verdict === 'admitted')!.reference!;
      const admit = f.options.admit;
      f.options.admit = async (input) => {
        const result = await admit(input);
        result.decision.admitted!.replaces = [previous];
        return result;
      };
      const replacement = await f.outcome('task-2');
      const submitReplacement = async () => { await learner.submit({ kind: 'observe', observation: replacement }, 'replacement'); };
      if (timing !== 'active') await advance(learner);
      if (timing === 'audit-dispatch') {
        f.hook(submitReplacement);
        const audited = await advance(learner);
        f.hook(null);
        assert.equal(audited.operation?.state, 'result-saved');
        assert.equal(audited.releaseReview, null);
      } else {
        if (timing === 'awaiting-review') assert((await advance(learner)).releaseReview);
        await submitReplacement();
      }
      const reopened = await openLearner(f.options);
      const updated = await advance(reopened);
      assert.equal(updated.releaseReview, null);
      assert(updated.decisions.some((entry) => entry.verdict === 'superseded'));
      if (timing === 'audit-dispatch') {
        assert.equal(updated.budget.knownSpentMicroUsd, 3);
        assert.equal(updated.auditExposures.length, 1);
        assert.equal(f.calls(), 3);
        await advance(reopened);
      }
      assert.equal(f.dispatched.at(-1)?.kind, 'propose');
      assert.equal(f.dispatched.at(-1)?.round, 2);
    } finally { await f.cleanup(); }
  });
}

test('shared audit lineage rejects relabeled cases and related task families across campaigns', async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const auditLineageDirectory = path.join(first.directory, 'shared');
    const cohort = (id: string, caseId: string, family: string) => ({
      id, digest: sha256Bytes(id), cases: [{ caseFingerprint: sha256Bytes(caseId), familyFingerprint: sha256Bytes(family) }],
    });
    const initial = await openLearner({ ...first.options, auditLineageDirectory,
      definition: { ...first.options.definition, auditCohorts: [cohort('initial', 'case-1', 'family-1')] } });
    await initial.submit({ kind: 'observe', observation: await first.outcome() }, 'initial');
    await advance(initial); await advance(initial);
    assert.equal((await advance(initial)).phase, 'awaiting-review');

    const options = { ...second.options, auditLineageDirectory,
      definition: { ...second.options.definition, campaignId: 'another-campaign', auditCohorts: [
        cohort('renamed-case', 'case-1', 'different-label'),
        cohort('related-case', 'case-2', 'family-1'),
        cohort('fresh-case', 'case-3', 'family-2'),
      ] } };
    let learner = await openLearner(options);
    await learner.submit({ kind: 'observe', observation: await second.outcome() }, 'second');
    await advance(learner); await advance(learner);
    learner = await openLearner(options);
    const status = await advance(learner);
    assert.equal(status.phase, 'awaiting-review');
    assert.deepEqual(status.auditExposures, [sha256Bytes('fresh-case')]);
    await assert.rejects(openLearner({ ...options, auditLineageDirectory: path.join(second.directory, 'alternate') }), /audit-lineage-conflict/);
  } finally {
    await Promise.all([first.cleanup(), second.cleanup()]);
  }
});

test('explicit audit epoch rollover preserves spend and exposure and fences old handles', async () => {
  const f = await fixture();
  try {
    const auditLineageDirectory = path.join(f.directory, 'shared');
    const cohort = { id: 'audit', digest: sha256Bytes('audit'), cases: [{
      caseFingerprint: sha256Bytes('case'), familyFingerprint: sha256Bytes('family'),
    }] };
    const options = { ...f.options, auditLineageDirectory,
      definition: { ...f.options.definition, auditCohorts: [cohort] } };
    const learner = await openLearner(options);
    await learner.submit({ kind: 'observe', observation: await f.outcome() }, 'first-round');
    await advance(learner); await advance(learner);
    const review = await advance(learner);
    const next = { ...options, definition: { ...options.definition,
      scope: { ...options.definition.scope, policyEpoch: 'v2' },
      auditCohorts: [{ ...cohort, id: 'relabeled', digest: sha256Bytes('relabeled') }],
    }, startEpoch: { previousDefinitionDigest: review.definitionDigest } };
    await assert.rejects(openLearner(next), /epoch-migration-active/);
    await f.release(await f.store.readArtifact(review.releaseReview!));
    const released = await advance(learner);
    const migrated = await openLearner(next);
    const state = await migrated.inspect();
    assert.deepEqual(state.budget, released.budget);
    assert.deepEqual(state.auditExposures, released.auditExposures);
    assert.deepEqual(state.decisions, released.decisions);
    assert.equal((await (await openLearner(next)).inspect()).definitionDigest, state.definitionDigest);
    await assert.rejects(learner.submit({ kind: 'request-stop', reason: 'stale worker' }, 'stale-stop'), /definition-conflict/);
  } finally { await f.cleanup(); }
});
