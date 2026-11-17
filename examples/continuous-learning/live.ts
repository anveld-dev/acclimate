/** Opt-in real model qualification of the public recurring learner. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AcclimateClient, ApiError, resolveAndCache, type VerifiedBundle } from '@acclimate/sdk';
import {
  openLearner,
  openLearningStore,
  type AcclimateMutationOptions,
  type WorkContext,
  type LearningOperation,
  sha256Bytes,
  type ExperienceV1,
  type AdmissionResult,
  type LearningAdmissionInput,
  type LearnerDefinition,
  type LearnerView,
  type LearningAdapter,
  type HarnessManifestV1,
  type EffectiveContextV1,
  type FeedbackV1,
  type ReleaseReview,
} from '@acclimate/sdk/learning';
import { cohort, expected, grade, teaching, type Incident } from './domain.js';
import {
  applicationAdapter,
  freezeControls,
  freezeDataset,
  mutationPolicy as installedMutationPolicy,
  selectedContext,
  type ApplicationConfig,
} from './application.js';

import { liveBaseline, liveCampaignIsSettled, liveExecution } from './live-domain.js';
import { liveModels, liveModelMaximumCalls } from './live-model.js';

interface Config {
  schemaVersion: 1;
  live: boolean;
  serviceUrl: string;
  projectId: string;
  learnerToken: string;
  reviewerToken: string;
  output: string;
}
const args = process.argv.slice(2);
const configArgument = args.indexOf('--config');
if (configArgument < 0 || !args[configArgument + 1])
  throw new Error(
    'Use --config /absolute/private/qualification-config.json; no ambient credentials are read.',
  );
const configPath = path.resolve(args[configArgument + 1]!);
const configInfo = await lstat(configPath);
assert(
  configInfo.isFile() && !configInfo.isSymbolicLink() && !(configInfo.mode & 0o077),
  'Private configuration must be a regular owner-only file',
);
const config = JSON.parse(await readFile(configPath, 'utf8')) as Config;
assert.equal(config.schemaVersion, 1);
assert.equal(config.live, true, 'Explicit --live authorization is required');
assert(
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.serviceUrl).hostname),
  'Qualification requires an explicit loopback disposable service',
);
const output = path.resolve(config.output);
const advanceDeadline = () => Date.now() + 850_000;
const client = new AcclimateClient({
  baseUrl: config.serviceUrl,
  token: config.learnerToken,
  scope: 'continuous-learner',
  retries: 0,
});
const reviewer = new AcclimateClient({
  baseUrl: config.serviceUrl,
  token: config.reviewerToken,
  scope: 'disposable-reviewer',
  retries: 0,
});
const setup = await reviewer.createBundleSetup(
  config.projectId,
  {
    name: 'Recurring live fictional payment learner',
    origin: 'example',
    sourceLabel: 'Live recurring qualification',
    channel: 'qualification',
    payload: liveBaseline(),
    reason: 'Explicit disposable fictional baseline.',
  },
  randomUUID(),
);
const bundleId = setup.bundle.id;
const alternateChannel = 'alternate-correction';
await reviewer.promote(
  config.projectId,
  bundleId,
  alternateChannel,
  {
    versionId: setup.version.id,
    expectedRevision: '0',
    unevaluatedReason: 'Start the second campaign from the exact same immutable baseline.',
  },
  randomUUID(),
);

const live = liveExecution(output);
const runnerSource = JSON.stringify({
  models: liveModels,
  files: await Promise.all(
    ['./domain.ts', './application.ts', './live-domain.ts', './live-model.ts', './live.ts'].map(
      async (name) => ({
        name,
        source: await readFile(new URL(name, import.meta.url), 'utf8'),
      }),
    ),
  ),
});

async function campaign(channel: string, primary: boolean) {
  const campaignOutput = primary ? output : path.join(output, 'alternate');
  if (!primary) await mkdir(campaignOutput, { mode: 0o700 });
  const save = async (name: string, value: unknown) =>
    writeFile(path.join(campaignOutput, name), JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  const directory = path.join(campaignOutput, 'campaign');
  const store = await openLearningStore(directory);
  const scope = {
    projectId: config.projectId,
    bundleId,
    taskFamilyId: 'fictional-payment-incident',
    partitionId: 'disposable-qualification',
    policyEpoch: 'fictional-v1',
  };
  const policy = await store.putArtifact({
    schemaVersion: 1 as const,
    kind: 'qualification-learning-policy',
    authority: 'installed-fixture-owner',
    release: 'human-review',
    domain: 'fictional-only',
  });
  const mutationPolicy = await store.putArtifact({
    schemaVersion: 1 as const,
    kind: 'learning-mutation-policy',
    policy: installedMutationPolicy,
  });
  const compatibility = await store.putArtifact({
    schemaVersion: 1,
    kind: 'qualification-compatibility',
    preserve: ['clean', 'response-lost'],
    runtimeTools: 'none',
  });
  const domainSource = await store.putArtifact({
    schemaVersion: 1,
    kind: 'installed-domain-source',
    sourceUtf8: runnerSource,
  });
  const mapping = await store.putArtifact({
    schemaVersion: 1,
    kind: 'mapping',
    implementation: 'verified-bundle-and-incident-prompt-v1',
  });
  const tools = await store.putArtifact({
    schemaVersion: 1,
    kind: 'tools',
    tools: [],
    liveWrites: false,
  });
  const model = await store.putArtifact({
    schemaVersion: 1,
    kind: 'model',
    model: liveModels.harness,
    execution: 'live',
  });
  const contextPolicy = await store.putArtifact({
    schemaVersion: 1,
    kind: 'context-policy',
    selection: 'installed-retry-skill',
    version: 1,
  });
  const audits: Record<string, Incident[]> = primary
    ? {
        'audit-one': cohort('protected-audit-one', 'mobile-receipt'),
        'audit-two': cohort('protected-audit-two', 'batch-import'),
      }
    : {
        'audit-mobile-variant': cohort('protected-audit-renamed-mobile', 'mobile-receipt'),
        'audit-alternate': cohort('protected-audit-alternate', 'operator-console'),
      };
  const auditCohorts = await Promise.all(
    Object.entries(audits).map(async ([id, cases]) => {
      const ref = await freezeDataset(store, cases, 1);
      const dataset = await store.readArtifact(ref);
      return {
        id,
        digest: ref.sha256,
        cases: dataset.cases.map(({ input }, index) => ({
          caseFingerprint: input.sha256,
          familyFingerprint: sha256Bytes(cases[index]!.signal.transport),
        })),
      };
    }),
  );
  const developmentControls = await freezeControls(
    store,
    domainSource,
    'development',
    cohort('development'),
    null,
    true,
  );
  const definition: LearnerDefinition = {
    schemaVersion: 1,
    campaignId: `recurring-fictional-payment-${channel}-v3`,
    scope,
    channel,
    policy,
    mutationPolicy,
    harnessDigest: domainSource.sha256,
    adapterRevision: 'fictional-live-service-adapter-v1',
    trustedDecider: 'installed-fixture-owner',
    auditCohorts,
    limits: {
      maximumRounds: 1,
      maximumDevelopmentAttempts: 2,
      maximumPaidAdmissions: 5,
      budget: { mode: 'admission-count' },
    },
  };
  const evaluatorConfigPath = path.join(
    path.dirname(configPath),
    `private-evaluator-${channel}.json`,
  );
  await writeFile(
    evaluatorConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      serviceUrl: config.serviceUrl,
      projectId: config.projectId,
      evaluatorPrincipalId: 'evaluator',
      evaluatorToken: config.learnerToken,
      journalRoot: path.join(campaignOutput, 'evaluation-journals'),
    }),
    { mode: 0o600, flag: 'wx' },
  );
  const application: ApplicationConfig = {
    serviceUrl: config.serviceUrl,
    projectId: config.projectId,
    bundleId,
    channel,
    audits,
    developmentControls,
    learnerToken: config.learnerToken,
    evaluatorConfigPath,
    domainDigest: domainSource.sha256,
    adapterRevision: definition.adapterRevision,
  };
  const liveApplication = (propose: AcclimateMutationOptions['propose']) =>
    applicationAdapter(application, {
      model: liveModels.harness,
      runnerSource,
      propose,
      execute: (content, input, binding) =>
        live.execute(
          content,
          input,
          `evaluation/${binding.requestId}/${binding.attemptId}/${binding.jobId}`,
        ),
    });
  const base = liveApplication(() => {
    throw new Error('proposal requires retained model response');
  });
  async function work(
    operation: Readonly<LearningOperation>,
    context: WorkContext,
    reconcile: boolean,
  ) {
    const method = reconcile ? 'reconcile' : 'dispatch';
    if (operation.kind !== 'propose') return base[method](operation, context);
    const baseline = await resolveAndCache(
      client,
      { projectId: config.projectId, bundleId, versionId: operation.baseline.version.id },
      { cacheDir: path.join(output, 'consumer-cache') },
    );
    assert.equal(baseline.version.digest, operation.baseline.version.digest);
    context.signal.throwIfAborted();
    const proposed = await live.propose(operation, baseline, reconcile);
    if (!proposed)
      return {
        operationId: operation.id,
        status: 'unknown' as const,
        executionSettled: false,
        costMicroUsd: null,
        reason: 'live-proposal-not-observed',
      };
    const adapter = liveApplication(({ parent, policyDigest, admissionDigest }) => ({
      schemaVersion: 1,
      parent,
      policyDigest,
      admissionDigests: [admissionDigest],
      ...proposed,
    }));
    const receipt = await adapter[method](operation, context);
    return { ...receipt, costMicroUsd: null };
  }
  const adapter: LearningAdapter = {
    ...base,
    dispatch: (operation, context) => work(operation, context, false),
    reconcile: (operation, context) => work(operation, context, true),
  };
  const admittedFeedback = new Set<string>();
  const admit = async ({
    experience,
    experienceRef,
  }: LearningAdmissionInput): Promise<AdmissionResult> => {
    const feedbackRef = experience.feedback[0];
    if (!feedbackRef || !admittedFeedback.has(feedbackRef.sha256))
      return {
        decision: {
          schemaVersion: 1,
          kind: 'learning-admission',
          experience: experienceRef,
          policy,
          decidedBy: definition.trustedDecider,
          decision: 'rejected',
          reasonCode: 'not-an-authorized-correction',
          admitted: null,
        },
        teaching: [],
      };
    const feedback = await store.readArtifact(feedbackRef);
    const teachingView = feedback.claim;
    const claims = (await store.readArtifact(teachingView)) as string[];
    return {
      decision: {
        schemaVersion: 1,
        kind: 'learning-admission',
        experience: experienceRef,
        policy,
        decidedBy: definition.trustedDecider,
        decision: 'admitted',
        reasonCode: 'verified-fictional-domain-correction',
        admitted: {
          targetScope: scope,
          teachingView,
          use: 'authorized_correction',
          mutationPolicy,
          compatibilityObligations: compatibility,
          replaces: [],
        },
      },
      teaching: claims,
    };
  };
  const options = {
    directory,
    auditLineageDirectory: path.join(output, 'audit-lineage'),
    definition,
    adapter,
    admit,
    authorizedFeedback: (experience: ExperienceV1) =>
      experience.feedback.filter((reference) => admittedFeedback.has(reference.sha256)),
  };
  let learner = await openLearner(options);
  const views: LearnerView[] = [];
  const pinnedBaseline = await resolveAndCache(
    client,
    { projectId: config.projectId, bundleId, channel },
    { cacheDir: path.join(output, 'consumer-cache') },
  );

  async function outcome(
    label: string,
    bundle: VerifiedBundle,
    incident: Incident,
    correction: string,
    authorized: boolean,
  ): Promise<ExperienceV1> {
    const task = await store.putArtifact(incident);
    const { output: actual, usage } = await live.execute(
      bundle.payload,
      incident,
      'observation/' + channel,
    );
    const score = grade(actual, incident);
    const result = await store.putArtifact({
      actual,
      correct: score,
      expected: expected(incident),
    });
    const harness = await store.putArtifact<HarnessManifestV1>({
      schemaVersion: 1,
      kind: 'learning-harness',
      scope,
      content: {
        versionId: bundle.version.id,
        digest: bundle.version.digest as `sha256:${string}`,
      },
      runner: domainSource,
      mapping,
      tools,
      model,
      contextPolicy,
    });
    const effectiveContext = await store.putArtifact<EffectiveContextV1>({
      schemaVersion: 1,
      kind: 'learning-effective-context',
      harness,
      task,
      ...selectedContext(bundle.payload),
      hostContext: null,
      readEvidence: null,
    });
    assert.equal(score, 0, 'The live observation must establish the claimed incident failure');
    const claim = await store.putArtifact([correction]);
    const sourceArtifact = await store.putArtifact({
      schemaVersion: 1,
      kind: authorized ? 'approved-fictional-policy-correction' : 'untrusted-task-text',
      rule: correction,
    });
    const feedback = await store.putArtifact<FeedbackV1>({
      schemaVersion: 1,
      kind: 'learning-feedback',
      source: authorized ? 'verified_policy' : 'task_observation',
      sourceArtifact,
      sourcePrincipal: authorized ? 'installed-fixture-owner' : null,
      claim,
    });
    if (authorized) admittedFeedback.add(feedback.sha256);
    const experience: ExperienceV1 = {
      schemaVersion: 1,
      kind: 'learning-experience',
      scope,
      runId: label,
      attemptId: 'attempt-1',
      task,
      harness,
      effectiveContext,
      outcome: { state: 'completed', result },
      trace: result,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: null },
      feedback: [feedback],
    };
    await save(`${label}-outcome.json`, experience);
    return experience;
  }
  async function advanceUntil(
    predicate: (view: LearnerView) => boolean,
    label: string,
  ): Promise<LearnerView> {
    for (let index = 0; index < 40; index++) {
      let view = await learner.advance({ deadline: advanceDeadline() });
      views.push(view);
      if (view.phase === 'needs-reconciliation') {
        learner = await openLearner(options); // same physical state, definition, principal and operation identity
        view = await learner.advance({ deadline: advanceDeadline() });
        views.push(view);
      }
      if (predicate(view)) return view;
      if (liveCampaignIsSettled(view)) return view;
    }
    const final = await learner.inspect();
    throw new Error(`${label} exceeded bounded advances: ${final.phase} / ${final.nextAction}`);
  }
  async function release(view: LearnerView) {
    assert(view.releaseReview, 'Audited candidate must produce a private review package');
    const review = await store.readArtifact<ReleaseReview>(view.releaseReview);
    assert.equal(review.candidate.id, view.candidate!.id);
    await assert.rejects(
      () =>
        client.promote(
          config.projectId,
          bundleId,
          channel,
          {
            versionId: review.candidate.id,
            comparisonId: review.comparison.id,
            expectedRevision: review.baseline.revision,
          },
          randomUUID(),
        ),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
    await assert.rejects(
      () =>
        reviewer.promote(
          config.projectId,
          bundleId,
          channel,
          {
            versionId: review.candidate.id,
            comparisonId: review.comparison.id,
            expectedRevision: '0',
          },
          randomUUID(),
        ),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
    const promotion = await reviewer.promote(
      config.projectId,
      bundleId,
      channel,
      {
        versionId: review.candidate.id,
        comparisonId: review.comparison.id,
        expectedRevision: review.baseline.revision,
      },
      randomUUID(),
    );
    await save(`round-${view.round}-review-and-release.json`, { review, promotion });
    return advanceUntil(
      (next) =>
        next.decisions.some(
          (decision) => decision.stage === 'release' && decision.round === view.round,
        ),
      'observe reviewer release',
    );
  }

  try {
    const incident = cohort('ordinary-observation')[primary ? 1 : 2]!;
    await learner.submit(
      {
        kind: 'observe',
        observation: await outcome(
          'observed-failure',
          pinnedBaseline,
          incident,
          primary ? teaching.stableKey : teaching.reconcile,
          true,
        ),
      },
      'observe-first',
    );
    let view = await advanceUntil((state) => state.phase === 'awaiting-review', 'audit');
    if (!view.releaseReview) return { channel, status: 'held', view };

    learner = await openLearner(options);
    view = await release(view);
    const fresh = await resolveAndCache(
      client,
      { projectId: config.projectId, bundleId, channel },
      { cacheDir: path.join(output, 'consumer-cache') },
    );
    assert.notEqual(fresh.version.id, pinnedBaseline.version.id);
    assert.equal(pinnedBaseline.version.id, setup.version.id);
    const review = await store.readArtifact<ReleaseReview>(
      views.find((state) => state.phase === 'awaiting-review')!.releaseReview!,
    );
    assert.equal(fresh.version.id, review.candidate.id);
    assert.equal(fresh.version.digest, review.candidate.digest);
    const pinned = await resolveAndCache(
      client,
      { projectId: config.projectId, bundleId, versionId: pinnedBaseline.version.id },
      { cacheDir: path.join(output, 'consumer-cache') },
    );
    assert.equal(pinned.version.digest, pinnedBaseline.version.digest);
    const probes = [cohort('new-job', 'batch-import')[primary ? 1 : 2]!];
    const consumer = [];
    for (const [index, probe] of probes.entries()) {
      const parent = await live.execute(
        pinned.payload,
        probe,
        `consumer/${channel}/pinned/${index}`,
      );
      const candidate = await live.execute(
        fresh.payload,
        probe,
        `consumer/${channel}/fresh/${index}`,
      );
      consumer.push({
        input: probe,
        expected: expected(probe),
        pinned: {
          versionId: pinnedBaseline.version.id,
          digest: pinnedBaseline.version.digest,
          ...parent,
          score: grade(parent.output, probe),
        },
        fresh: {
          versionId: fresh.version.id,
          digest: fresh.version.digest,
          ...candidate,
          score: grade(candidate.output, probe),
        },
      });
      await save(`consumer-${index}.json`, consumer.at(-1));
    }
    const pinnedScores = consumer.map((pair) => pair.pinned.score);
    const freshScores = consumer.map((pair) => pair.fresh.score);
    const passed = pinnedScores[0] === 0 && freshScores[0] === 1;
    return {
      channel,
      status: passed ? 'passed' : 'consumer-mismatch',
      view,
      pinnedScores,
      freshScores,
      pinnedBaseline: pinnedBaseline.version,
      fresh: fresh.version,
    };
  } finally {
    await save('campaign-views.json', views);
    await save('audit-roster.json', auditCohorts);
  }
}

const outcomes: unknown[] = [];
for (const [channel, primary] of [
  ['qualification', true],
  [alternateChannel, false],
] as const) {
  try {
    outcomes.push(await campaign(channel, primary));
  } catch (error) {
    outcomes.push({ channel, status: 'error', error: String(error) });
    console.error('Campaign error', channel, error);
  }
}
const evaluations = await client.listEvaluations(config.projectId, bundleId, { limit: 100 });
const comparisons = await client.listComparisons(config.projectId, bundleId, { limit: 100 });
const save = (filename: string, value: unknown) =>
  writeFile(path.join(output, filename), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
await save('service-records.json', {
  evaluations: evaluations.items,
  comparisons: comparisons.items,
});
const completedModelTurns = Object.fromEntries(live.modelAttempts);
const status = outcomes.every((item) => (item as { status: string }).status === 'passed')
  ? 'passed'
  : 'incomplete';
await save('summary.json', {
  status,
  bundleId,
  baseline: setup.version,
  outcomes,
  completedModelTurns,
  models: liveModels,
  maximumModelTurns: liveModelMaximumCalls,
  completedModelTurnCount: live.modelAttempts.size,
  providerDollarCost: null,
  externalPaymentWrites: 0,
});
console.log('Live recurring qualification', status);
