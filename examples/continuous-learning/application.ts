/** Installed deterministic app adapter shared by the starter and its crash worker. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AcclimateClient } from '@acclimate/sdk';
import { defineEvaluation } from '@acclimate/sdk/evaluation';
import type { EvaluationPolicyV1 } from '@acclimate/sdk/evaluation/policy';
import {
  createAcclimateLearningAdapter,
  bindLearningJob,
  sha256Bytes,
  type ArtifactAccess,
  type LearningOperation,
  type Ref,
  type MutationPolicyV1,
  type MutationOperation,
  textDigest,
  type EffectiveContextV1,
  type ExperimentManifestV1,
  type HarnessManifestV1,
  type DatasetSpec,
  type CollectionSpec,
  type AcclimateMutationOptions,
  type JobEvidenceBindingV1,
  type ControlsManifestV1,
} from '@acclimate/sdk/learning';
import {
  execute,
  expected,
  reconciliationDocument,
  reconciliationInstruction,
  reconciliationSkill,
  retrySkill,
  teaching,
  type Incident,
} from './domain.js';

export const mutationPolicy: MutationPolicyV1 = {
  schemaVersion: 1,
  mode: 'skill-packages',
  compatibilityTarget: 'generic',
  editablePaths: ['AGENTS.md', retrySkill],
  createSkillNames: ['reconcile-request'],
  retireSkillNames: [],
  maxChangedArtifacts: 2,
  maxChangedFiles: 2,
  maxAddedTextBytes: 1_024,
  maxFinalFiles: 3,
  maxFinalBytes: 2_048,
  requiredPreflightIds: [],
};

export function selectedContext(content: Parameters<typeof execute>[0]) {
  const selected = content.files.filter((file) =>
    ['AGENTS.md', retrySkill, reconciliationSkill].includes(file.path),
  );
  return {
    selected: selected.map((file) => ({
      resourceId: file.path,
      digest: sha256Bytes(file.text),
      role: file.kind === 'instruction' ? 'instruction' : 'skill',
    })),
    omitted: content.files
      .filter((file) => !selected.includes(file))
      .map((file) => ({
        resourceId: file.path,
        reasonCode: 'not-used-by-deterministic-app',
      })),
  };
}

export interface ApplicationConfig {
  serviceUrl: string;
  projectId: string;
  bundleId: string;
  channel: string;
  audits: Record<string, Incident[]>;
  developmentControls: Ref<ControlsManifestV1>;
  learnerToken: string;
  evaluatorConfigPath: string;
  domainDigest: string;
  adapterRevision: string;
}
export async function freezeDataset(
  artifacts: ArtifactAccess,
  selected: Incident[],
  repetitions = 2,
) {
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
        repetitions,
        input: await artifacts.putArtifact(input),
        expected: await artifacts.putArtifact(expected(input)),
      })),
    ),
  });
}

export async function freezeControls(
  artifacts: ArtifactAccess,
  runner: Ref,
  stage: 'development' | 'audit',
  selected: Incident[],
  auditCohort: LearningOperation['auditCohort'],
  live = false,
) {
  const dataset = await freezeDataset(artifacts, selected, live ? 1 : 2);
  const environmentContract = await artifacts.putArtifact({
    schemaVersion: 1,
    kind: 'environment-contract',
    modelCalls: live,
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
    stage,
    auditCohort,
    auditAnswersForTeaching: false,
  });
  return artifacts.putArtifact<ControlsManifestV1>({
    schemaVersion: 1,
    kind: 'learning-controls',
    dataset,
    grader: runner,
    collection,
    evidenceUse,
  });
}

export interface LiveEvaluation {
  model: string;
  runnerSource: string;
  propose: AcclimateMutationOptions['propose'];
  execute(
    content: Parameters<typeof execute>[0],
    input: Incident,
    binding: JobEvidenceBindingV1,
  ): Promise<{
    output: ReturnType<typeof execute>;
    usage: { inputTokens: number; outputTokens: number };
  }>;
}
export function applicationAdapter(config: ApplicationConfig, live?: LiveEvaluation) {
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
  return createAcclimateLearningAdapter({
    client,
    projectId: config.projectId,
    bundleId: config.bundleId,
    channel: config.channel,
    developmentControlsDigest: config.developmentControls.sha256,
    revision: config.adapterRevision,
    evaluatorConfigPath: config.evaluatorConfigPath,
    disclosure: 'sha256',
    prepareExperiment: async ({ operation, artifacts }) => {
      const runner = await artifacts.putArtifact({
        schemaVersion: 1,
        kind: 'installed-domain-source',
        sourceUtf8:
          live?.runnerSource ?? (await readFile(new URL('./domain.ts', import.meta.url), 'utf8')),
      });
      if (runner.sha256 !== config.domainDigest)
        throw new Error('Installed domain source changed after campaign definition');
      const mapping = await artifacts.putArtifact({
        schemaVersion: 1,
        kind: 'mapping',
        implementation: live
          ? 'verified-bundle-and-incident-prompt-v1'
          : 'parse-retry-policy-from-verified-skill-v1',
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
        model: live?.model ?? 'none',
        execution: live ? 'live' : 'deterministic',
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
      const controls =
        operation.kind === 'audit'
          ? await freezeControls(
              artifacts,
              runner,
              'audit',
              config.audits[operation.auditCohort!.id]!,
              operation.auditCohort,
              Boolean(live),
            )
          : config.developmentControls;
      return artifacts.putArtifact<ExperimentManifestV1>({
        schemaVersion: 1,
        kind: 'learning-experiment',
        scope: operation.scope,
        arms: { parent, candidate },
        controls,
      });
    },
    allowedPaths: [],
    compatibilityTarget: 'generic',
    allowLive: Boolean(live),
    maximumLiabilityMicroUsd: live
      ? { propose: null, development: null, audit: null }
      : { propose: 0, development: 0, audit: 0 },
    policies: { development: policy, audit: policy },
    mutation: {
      policy: mutationPolicy,
      propose:
        live?.propose ??
        (({ operation, baseline, parent, policyDigest, admissionDigest }) => {
          assert.equal(operation.auditCohort, null);
          assert.equal(operation.teaching.length, 1);
          const correction = operation.teaching[0];
          let operations: MutationOperation[];
          let rationale: string;
          if (correction === teaching.reconcile) {
            assert(
              !operation.proposalHistory?.length,
              'Prior baseline history must stay out of a later proposal',
            );
            const root = baseline.payload.files.find((file) => file.path === 'AGENTS.md')!;
            operations = [
              {
                op: 'editText',
                file: { path: root.path, kind: root.kind, textDigest: textDigest(root.text) },
                replacements: [
                  { oldText: root.text, newText: root.text + '\n' + reconciliationInstruction },
                ],
              },
              {
                op: 'createSkill',
                name: 'reconcile-request',
                files: [{ relativePath: 'SKILL.md', text: reconciliationDocument }],
              },
            ];
            rationale =
              'Add dedicated reconciliation instructions for confirmed pre-charge failures.';
          } else {
            assert.equal(correction, teaching.stableKey);
            const skill = baseline.payload.files.find((file) => file.path === retrySkill)!;
            const failedBroadRule = operation.proposalHistory?.some(
              (entry) => entry.verdict === 'rejected' && entry.regressedPairs > 0,
            );
            operations = [
              {
                op: 'editText',
                file: { path: skill.path, kind: skill.kind, textDigest: textDigest(skill.text) },
                replacements: [
                  {
                    oldText: 'retry-policy: initial',
                    newText: failedBroadRule
                      ? 'retry-policy: stable-key'
                      : 'retry-policy: regression',
                  },
                ],
              },
            ];
            rationale = failedBroadRule
              ? 'Development found regressions under the broad rule. Apply original-key reuse only to lost responses.'
              : 'Try original-key reuse across all incident situations.';
          }
          return {
            schemaVersion: 1,
            parent,
            policyDigest,
            operations,
            rationale,
            admissionDigests: [admissionDigest],
          };
        }),
      preflights: {
        'learning.reference-review': (plan) =>
          live
            ? plan.payload.files.some(
                (file) => file.path === 'AGENTS.md' && file.text.includes(reconciliationSkill),
              ) && plan.payload.files.some((file) => file.path === reconciliationSkill)
            : plan.payload.files.some(
                (file) =>
                  file.path === 'AGENTS.md' && file.text.includes(reconciliationInstruction),
              ) &&
              plan.payload.files.some(
                (file) => file.path === reconciliationSkill && file.text === reconciliationDocument,
              ),
      },
    },
    app: async ({ operation, runtime, experiment, artifacts }) => {
      const manifest = await artifacts.readArtifact(experiment);
      const controls = await artifacts.readArtifact(manifest.controls);
      const dataset = await artifacts.readArtifact(controls.dataset);
      return defineEvaluation<Incident, ReturnType<typeof expected>, ReturnType<typeof execute>>({
        configId: 'fictional-retry-application',
        configRevision: '1',
        datasetRevision: controls.dataset.sha256,
        graderRevision: config.domainDigest,
        execution: live ? 'live' : 'model-free',
        runtime,
        collection: { protocol: 'seeded-balanced-v1', seed: 'fictional-qualification-order-v1' },
        cases: await Promise.all(
          dataset.cases.map(async (item) => ({
            caseId: item.caseId,
            input: await artifacts.readArtifact<Incident>(item.input as Ref<Incident>),
            expected: await artifacts.readArtifact<ReturnType<typeof expected>>(
              item.expected as Ref<ReturnType<typeof expected>>,
            ),
            repetitions: item.repetitions,
          })),
        ),
        execute: async ({ bundle, input, context, caseId, repetition }) => {
          const task = await artifacts.putArtifact(input);
          const preparedContext = await artifacts.putArtifact<EffectiveContextV1>({
            schemaVersion: 1,
            kind: 'learning-effective-context',
            harness: manifest.arms[context.side],
            task,
            ...selectedContext(bundle.payload),
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
          if (live) return live.execute(bundle.payload, input, binding);
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
