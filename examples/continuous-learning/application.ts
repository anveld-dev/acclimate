/** Installed deterministic app adapter shared by the starter and its crash worker. */
import { readFile } from 'node:fs/promises';
import { AcclimateClient } from '@acclimate/sdk';
import { defineEvaluation } from '@acclimate/sdk/evaluation';
import type { EvaluationPolicyV1 } from '@acclimate/sdk/evaluation/policy';
import {
  createAcclimateLearningAdapter,
  bindLearningJob,
  sha256Bytes,
  type ArtifactAccess,
  type EffectiveContextV1,
  type ExperimentManifestV1,
  type HarnessManifestV1,
  type DatasetSpec,
  type CollectionSpec,
  type ControlsManifestV1,
} from '@acclimate/sdk/learning';
import { cohort, execute, expected, payload, type Incident } from './domain.js';

export interface ApplicationConfig {
  serviceUrl: string;
  projectId: string;
  bundleId: string;
  learnerToken: string;
  evaluatorConfigPath: string;
  domainDigest: string;
  adapterRevision: string;
}
export async function freezeDataset(artifacts: ArtifactAccess, selected: Incident[]) {
  const domainSchema = await artifacts.putArtifact({
    schemaVersion: 1,
    kind: 'fictional-incident-schema',
    situations: ['clean', 'response-lost', 'transient-before-charge'],
    requestKey: 'opaque-fictional-key',
  });
  return artifacts.putArtifact<DatasetSpec>({
    schemaVersion: 1,
    kind: 'learning-dataset',
    domainSchema,
    cases: await Promise.all(
      selected.map(async (input) => ({
        caseId: input.situation,
        repetitions: 2,
        input: await artifacts.putArtifact(input),
        expected: await artifacts.putArtifact(expected(input)),
      })),
    ),
  });
}

export function applicationAdapter(config: ApplicationConfig) {
  const client = new AcclimateClient({
    baseUrl: config.serviceUrl,
    token: config.learnerToken,
    scope: 'continuous-learner',
    retries: 0,
  });
  const policy: EvaluationPolicyV1 = {
    schemaVersion: 1,
    id: 'fictional-exact-actions',
    revision: '1',
    metric: { name: 'correct-action', unit: 'fraction', direction: 'higher' },
    aggregation: 'equal-case-means',
    minimumMeanImprovement: 0.1,
    maximumCaseRegression: 0,
    maximumCandidateTaskFailures: 0,
    requiredCases: ['clean', 'response-lost', 'transient-before-charge'],
  };
  const audits = [cohort('protected-audit-one'), cohort('protected-audit-two')];
  return createAcclimateLearningAdapter({
    client,
    projectId: config.projectId,
    bundleId: config.bundleId,
    channel: 'qualification',
    revision: config.adapterRevision,
    evaluatorConfigPath: config.evaluatorConfigPath,
    disclosure: 'sha256',
    prepareExperiment: async ({ operation, artifacts }) => {
      const runner = await artifacts.putArtifact({
        schemaVersion: 1,
        kind: 'installed-domain-source',
        sourceUtf8: await readFile(new URL('./domain.ts', import.meta.url), 'utf8'),
      });
      if (runner.sha256 !== config.domainDigest)
        throw new Error('Installed domain source changed after campaign definition');
      const mapping = await artifacts.putArtifact({
        schemaVersion: 1,
        kind: 'mapping',
        implementation: 'parse-retry-policy-from-verified-skill-v1',
      });
      const tools = await artifacts.putArtifact({
        schemaVersion: 1,
        kind: 'tools',
        tools: [],
        liveWrites: false,
      });
      const model = await artifacts.putArtifact({
        schemaVersion: 1,
        kind: 'model',
        model: 'none',
        execution: 'deterministic',
      });
      const contextPolicy = await artifacts.putArtifact({
        schemaVersion: 1,
        kind: 'context-policy',
        selection: 'installed-retry-skill',
        version: 1,
      });
      const arm = async (version: { id: string; digest: string }) =>
        artifacts.putArtifact<HarnessManifestV1>({
          schemaVersion: 1,
          kind: 'learning-harness',
          scope: operation.scope,
          content: { versionId: version.id, digest: version.digest as `sha256:${string}` },
          runner,
          mapping,
          tools,
          model,
          contextPolicy,
        });
      const parent = await arm(operation.baseline.version);
      const candidate = await arm(operation.candidate!);
      const selected =
        operation.kind === 'audit'
          ? audits[Number(operation.auditCohort!.id.split('-')[1]) - 1]!
          : cohort('development');
      const dataset = await freezeDataset(artifacts, selected);
      const environmentContract = await artifacts.putArtifact({
        schemaVersion: 1,
        kind: 'environment-contract',
        modelCalls: false,
        externalWrites: false,
        sharedMutableState: false,
      });
      const fixtureFactory = await artifacts.putArtifact({
        schemaVersion: 1,
        kind: 'fixture-factory',
        runnerDigest: runner.sha256,
        freshInputPerArm: true,
      });
      const collection = await artifacts.putArtifact<CollectionSpec>({
        schemaVersion: 1,
        kind: 'learning-collection',
        environmentContract,
        fixtureFactory,
        fixtureScope: 'fresh_per_arm',
        mode: {
          kind: 'stochastic',
          order: 'seeded_balanced',
          seed: 'fictional-qualification-order-v1',
        },
        interruptionPolicy: 'retain_and_reconcile',
      });
      const evidenceUse = await artifacts.putArtifact({
        schemaVersion: 1,
        kind: 'evidence-use',
        stage: operation.kind,
        auditCohort: operation.auditCohort,
        auditAnswersForTeaching: false,
      });
      const controls = await artifacts.putArtifact<ControlsManifestV1>({
        schemaVersion: 1,
        kind: 'learning-controls',
        dataset,
        grader: runner,
        collection,
        evidenceUse,
      });
      return artifacts.putArtifact<ExperimentManifestV1>({
        schemaVersion: 1,
        kind: 'learning-experiment',
        scope: operation.scope,
        arms: { parent, candidate },
        controls,
      });
    },
    allowedPaths: ['skills/retry-review/SKILL.md'],
    compatibilityTarget: 'generic',
    maximumLiabilityMicroUsd: { propose: 0, development: 0, audit: 0 },
    policies: { development: policy, audit: policy },
    propose: (operation) =>
      payload(
        operation.round === 1 ? 'regression' : operation.round === 2 ? 'stable-key' : 'reconcile',
      ),
    app: async ({ operation, runtime, experiment, artifacts }) => {
      const selected =
        operation.kind === 'audit'
          ? audits[Number(operation.auditCohort!.id.split('-')[1]) - 1]!
          : cohort('development');
      return defineEvaluation<Incident, ReturnType<typeof expected>, ReturnType<typeof execute>>({
        configId: 'fictional-retry-application',
        configRevision: '1',
        datasetRevision:
          operation.kind === 'audit' ? operation.auditCohort!.digest : 'fictional-development-v1',
        graderRevision: config.domainDigest,
        execution: 'model-free',
        runtime,
        collection: { protocol: 'seeded-balanced-v1', seed: 'fictional-qualification-order-v1' },
        cases: selected.map((input) => ({
          caseId: input.situation,
          input,
          expected: expected(input),
          repetitions: 2,
        })),
        execute: async ({ bundle, input, context, caseId, repetition }) => {
          const manifest = await artifacts.readArtifact(experiment);
          const task = await artifacts.putArtifact(input);
          const skill = bundle.payload.files.find(
            (file) => file.path === 'skills/retry-review/SKILL.md',
          );
          if (!skill) throw new Error('Delivered context lacks installed skill');
          const preparedContext = await artifacts.putArtifact<EffectiveContextV1>({
            schemaVersion: 1,
            kind: 'learning-effective-context',
            harness: manifest.arms[context.side],
            task,
            selected: [{ resourceId: skill.path, digest: sha256Bytes(skill.text), role: 'skill' }],
            omitted: bundle.payload.files
              .filter((file) => file.path !== skill.path)
              .map((file) => ({
                resourceId: file.path,
                reasonCode: 'not-used-by-deterministic-app',
              })),
            hostContext: null,
            readEvidence: null,
          });
          const binding = await bindLearningJob({
            experiment,
            requestId: context.requestId,
            attemptId: context.attemptId,
            jobId: context.jobId,
            side: context.side,
            caseId,
            repetition,
            preparedContext,
            actualContent: {
              versionId: bundle.version.id,
              digest: bundle.version.digest as `sha256:${string}`,
            },
            resolve: artifacts.readArtifact,
          });
          await artifacts.putArtifact(binding);
          return {
            output: execute(bundle.payload, input),
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          };
        },
        grade: async ({ output: actual, expected: target }) => ({
          reward: Number(actual.action === target.action && actual.key === target.key),
        }),
      });
    },
  });
}
