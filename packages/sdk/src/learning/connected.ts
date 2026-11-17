import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { AcclimateClient, ApiError } from '../client.js';
import { resolveAndCache } from '../cache.js';
import { readEvaluatorConfig } from '../evaluation/config.js';
import { captureDefinition } from '../evaluation/definition.js';
import {
  EvaluationError,
  runEvaluation,
  toSafeDiagnostic,
  type EvaluationApp,
  type SafeDiagnostic,
} from '../evaluation/index.js';
import type {
  DeliveryReceiptRequest,
  LearningFieldAuditRequest,
  LearningFieldAuditReceipt,
  LearningOutcomeRequest,
  LearningOutcomeReceipt,
  LearningWork,
  LearningWorkItem,
  VerifiedBundle,
} from '../types.js';
import { evaluationDescriptorDifferences, validateEvaluationHandoff } from '../validation.js';

interface LearningConnectionScope {
  projectId: string;
  integrationId: string;
}

export interface LearningOutcomeReporterOptions extends LearningConnectionScope {
  /** Use the dedicated outcome principal, separate from delivery and evaluation credentials. */
  client: AcclimateClient;
}

type TerminalOutcome = Omit<
  LearningOutcomeRequest,
  'versionId' | 'digest' | 'deliveryRevision' | 'startedReceiptId'
> & { startedReceipt?: Readonly<DeliveryReceiptRequest> };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[a-f0-9]{64}$/;

function freshResolution(bundle: VerifiedBundle, projectId: string, integrationId: string) {
  const resolution = bundle.resolution;
  if (
    !resolution ||
    bundle.stale ||
    bundle.connection?.integrationId !== integrationId ||
    bundle.connection.projectId !== projectId ||
    resolution.version.id !== bundle.version.id ||
    resolution.version.digest !== bundle.version.digest
  )
    throw new TypeError('Learning outcomes require a fresh bundle resolved for this connection');
  return resolution;
}

function startedBinding(
  bundle: VerifiedBundle,
  projectId: string,
  integrationId: string,
  receipt: Readonly<DeliveryReceiptRequest>,
) {
  const resolution = freshResolution(bundle, projectId, integrationId);
  if (
    !uuid.test(receipt.eventId) ||
    receipt.stage !== 'started' ||
    receipt.stale !== false ||
    (receipt.source !== 'network' && receipt.source !== 'cache') ||
    receipt.projectId !== projectId ||
    receipt.integrationId.toLowerCase() !== integrationId ||
    receipt.bundleId !== bundle.version.bundleId ||
    receipt.versionId !== bundle.version.id ||
    receipt.digest !== bundle.version.digest ||
    receipt.channel !== resolution.channel ||
    receipt.revision !== resolution.revision ||
    receipt.resolvedAt !== new Date(bundle.resolvedAt).toISOString()
  )
    throw new TypeError('Field audit requires the exact fresh started receipt for this job');
  return { startedReceiptId: receipt.eventId, deliveryRevision: resolution.revision };
}

function teachingSummary(text: string, limit: number): string {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text) > limit ||
    /[\x00-\x08\x0b-\x1f\x7f\ud800-\udfff]/u.test(text) ||
    !text.trim()
  ) {
    throw new TypeError('Learning feedback must be a bounded teaching summary');
  }
  return text.trim();
}

/** Call from the application's terminal-outcome hook with a persisted outcome UUID. */
export function createLearningOutcomeReporter(options: LearningOutcomeReporterOptions) {
  const { client, projectId } = options;
  if (!uuid.test(options.integrationId)) throw new TypeError('integrationId must be a UUID');
  const integrationId = options.integrationId.toLowerCase();
  return async (
    bundle: VerifiedBundle,
    outcome: TerminalOutcome,
  ): Promise<LearningOutcomeReceipt> => {
    freshResolution(bundle, projectId, integrationId);
    if (!uuid.test(outcome.outcomeId) || !['completed', 'failed'].includes(outcome.status))
      throw new TypeError('Learning outcomes require a stable UUID and terminal status');

    const body: LearningOutcomeRequest = {
      outcomeId: outcome.outcomeId,
      versionId: bundle.version.id,
      digest: bundle.version.digest,
      status: outcome.status,
    };
    if (outcome.startedReceipt)
      Object.assign(body, startedBinding(bundle, projectId, integrationId, outcome.startedReceipt));
    if (outcome.lesson) {
      body.lesson = {
        path: teachingSummary(outcome.lesson.path, 1024),
        instruction: teachingSummary(outcome.lesson.instruction, 4096),
      };
    }
    if (outcome.feedback) {
      const expected = teachingSummary(outcome.feedback.expected, 2048);
      const observed = teachingSummary(outcome.feedback.observed, 2048);
      if (expected === observed)
        throw new TypeError('Learning feedback requires a graded discrepancy');
      body.feedback = { expected, observed };
    }
    return client.reportLearningOutcome(projectId, integrationId, body);
  };
}

interface FieldAuditSample {
  outcome: LearningOutcomeReceipt;
  startedReceipt: Readonly<DeliveryReceiptRequest>;
}

function fieldAuditBinding(
  bundle: VerifiedBundle,
  projectId: string,
  integrationId: string,
  sample: FieldAuditSample,
): Omit<LearningFieldAuditRequest, 'verdict'> | null {
  const { startedReceiptId, deliveryRevision: revision } = startedBinding(
    bundle,
    projectId,
    integrationId,
    sample.startedReceipt,
  );
  const { outcomeId, accepted, fieldAudit } = sample.outcome;
  if (accepted !== true || !uuid.test(outcomeId))
    throw new TypeError('Field audit requires a trusted accepted terminal outcome');
  if (!fieldAudit) return null;
  if (
    !uuid.test(fieldAudit.parentVersionId) ||
    fieldAudit.parentVersionId === bundle.version.id ||
    !digest.test(fieldAudit.parentDigest)
  )
    throw new TypeError('Field audit predecessor identity is invalid');
  return {
    outcomeId,
    startedReceiptId,
    revision,
    versionId: bundle.version.id,
    digest: bundle.version.digest,
    parentVersionId: fieldAudit.parentVersionId,
    parentDigest: fieldAudit.parentDigest,
  };
}

/** Publish a verdict already computed by a trusted independent grader. */
export interface LearningFieldAuditReporterOptions extends LearningConnectionScope {
  /** Use the enrolled evaluator principal, separate from the outcome and delivery credentials. */
  client: AcclimateClient;
}

export function createLearningFieldAuditReporter(options: LearningFieldAuditReporterOptions) {
  const { client, projectId } = options;
  if (!uuid.test(options.integrationId)) throw new TypeError('integrationId must be a UUID');
  const integrationId = options.integrationId.toLowerCase();
  return async (
    bundle: VerifiedBundle,
    sample: FieldAuditSample & { verdict: LearningFieldAuditRequest['verdict'] },
  ): Promise<LearningFieldAuditReceipt> => {
    const binding = fieldAuditBinding(bundle, projectId, integrationId, sample);
    if (!binding || (sample.verdict !== 'pass' && sample.verdict !== 'regression'))
      throw new TypeError('Field audit requires an eligible sample and an independent verdict');
    return client.reportLearningFieldAudit(projectId, integrationId, {
      ...binding,
      verdict: sample.verdict,
    });
  };
}

export type LearningFieldGrade = 'correct' | 'incorrect' | 'indeterminate';
export interface LearningFieldAuditorOptions<Job> extends LearningFieldAuditReporterOptions {
  cacheDir: string;
  /** Percent of eligible jobs selected by stable hash. Defaults to 10. */
  samplePercent?: number;
  /** Grade the recorded job and a read-only predecessor replay against the same objective. */
  evaluate(input: {
    job: Job;
    served: VerifiedBundle;
    predecessor: VerifiedBundle;
    signal?: AbortSignal;
  }): Promise<{ served: LearningFieldGrade; predecessor: LearningFieldGrade }>;
}

/** Prepare an independently graded field audit for the application's durable outbox. */
export function createLearningFieldAuditor<Job>(options: LearningFieldAuditorOptions<Job>) {
  const { client, projectId, cacheDir, evaluate } = options;
  const samplePercent = options.samplePercent ?? 10;
  if (
    !uuid.test(options.integrationId) ||
    !Number.isFinite(samplePercent) ||
    samplePercent < 0 ||
    samplePercent > 100
  )
    throw new TypeError(
      'Field audit sampling requires an integration UUID and percentage from 0 to 100',
    );
  const integrationId = options.integrationId.toLowerCase();
  return async (
    bundle: VerifiedBundle,
    sample: FieldAuditSample & { job: Job; signal?: AbortSignal },
  ): Promise<LearningFieldAuditRequest | null> => {
    const binding = fieldAuditBinding(bundle, projectId, integrationId, sample);
    if (!binding) return null;
    const bucket =
      createHash('sha256')
      .update(JSON.stringify([projectId, integrationId, binding.outcomeId.toLowerCase()]))
        .digest()
        .readUInt32BE(0) /
      2 ** 32;
    if (bucket * 100 >= samplePercent) return null;
    sample.signal?.throwIfAborted();
    const predecessor = await resolveAndCache(
      client,
      {
        projectId,
        bundleId: bundle.version.bundleId,
        versionId: binding.parentVersionId,
      },
      { cacheDir },
    );
    if (predecessor.version.digest !== binding.parentDigest)
      throw new TypeError('Field audit predecessor digest did not match the authorized sample');
    sample.signal?.throwIfAborted();
    const grades = await evaluate({
      job: sample.job,
      served: bundle,
      predecessor,
      signal: sample.signal,
    });
    sample.signal?.throwIfAborted();
    if (!['correct', 'incorrect'].includes(grades.predecessor)) return null;
    if (grades.served === 'correct') return { ...binding, verdict: 'pass' };
    if (grades.served === 'incorrect' && grades.predecessor === 'correct')
      return { ...binding, verdict: 'regression' };
    return null;
  };
}

export interface ConnectedLearningDriverOptions {
  integrationId: string;
  installationId: string;
  /** The existing private evaluator config, including the persistent journal directory. */
  configPath: string;
  apps: {
    development: EvaluationApp<any, any, any>;
    audit: readonly EvaluationApp<any, any, any>[];
  };
  allowLive?: boolean;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: SafeDiagnostic) => void;
}

/**
 * Serve assigned evaluations with the installed app. Restart with the same
 * evaluator config and persistent journal so the runner can reconcile attempts.
 * Returns when the connection stops or the caller aborts.
 */
export async function serveConnectedLearning(
  options: ConnectedLearningDriverOptions,
): Promise<void> {
  const { configPath, installationId, allowLive, signal, onDiagnostic } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  if (
    !uuid.test(options.integrationId) ||
    !installationId.trim() ||
    Buffer.byteLength(installationId) > 128 ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 25 ||
    pollIntervalMs > 120_000
  ) {
    throw new EvaluationError('config.schema');
  }
  const integrationId = options.integrationId.toLowerCase();
  const apps = { development: [options.apps.development], audit: [...options.apps.audit] };
  for (const app of [...apps.development, ...apps.audit]) captureDefinition(app);
  const config = await readEvaluatorConfig(configPath);
  const client = new AcclimateClient({
    baseUrl: config.serviceUrl,
    token: config.evaluatorToken,
    scope: config.evaluatorPrincipalId,
    timeoutMs: Math.max(1000, Math.min(pollIntervalMs, 10_000)),
  });
  const { projectId } = config;
  async function work(): Promise<LearningWork> {
    const result = await client.getLearningWork(projectId, integrationId);
    if (
      result.installationId !== installationId ||
      !uuid.test(result.bundleId) ||
      typeof result.active !== 'boolean' ||
      !Array.isArray(result.items)
    ) {
      throw new EvaluationError('evidence.identity_mismatch');
    }
    return result;
  }
  function report(error: unknown) {
    onDiagnostic?.(toSafeDiagnostic(error));
  }
  function terminalError(error: unknown): boolean {
    return (
      (error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429) ||
      (error instanceof EvaluationError && error.code === 'evidence.identity_mismatch')
    );
  }
  async function wait(until?: AbortSignal): Promise<void> {
    try {
      await delay(pollIntervalMs, undefined, { signal: until });
    } catch (error) {
      if (!until?.aborted) throw error;
    }
  }
  async function evaluate(bundleId: string, item: LearningWorkItem): Promise<void> {
    if (!uuid.test(item.evaluationRequestId) || !Object.hasOwn(apps, item.phase))
      throw new EvaluationError('evidence.identity_mismatch');
    const request = await client.getEvaluation(projectId, bundleId, item.evaluationRequestId);
    if (
      request.id !== item.evaluationRequestId ||
      !request.requireBoundEvidence ||
      !request.proposalId
    )
      throw new EvaluationError('evidence.identity_mismatch');
    if (request.status !== 'requested' && request.status !== 'running') return;

    const matches = apps[item.phase].filter(
      (app) => evaluationDescriptorDifferences(request, app.descriptor).length === 0,
    );
    if (matches.length !== 1) throw new EvaluationError('descriptor.mismatch');
    const handoff = validateEvaluationHandoff({
      schemaVersion: 1,
      serviceUrl: client.baseUrl,
      projectId,
      bundleId,
      requestId: request.id,
      configuration: {
        datasetRevision: request.datasetRevision,
        graderRevision: request.graderRevision,
        runtime: request.runtime,
        expectedCases: request.expectedCases,
      },
    });

    const assignment = new AbortController();
    const running = signal ? AbortSignal.any([signal, assignment.signal]) : assignment.signal;
    if (running.aborted) return;
    // A stop/revoke or withdrawn assignment should cancel an in-flight callback,
    // while transient network failures leave the durable runner in control.
    const monitor = (async () => {
      while (!running.aborted) {
        await wait(running);
        if (running.aborted) break;
        try {
          const current = await work();
          if (
            !current.active ||
            current.bundleId !== bundleId ||
            !current.items.some((next) => next.evaluationRequestId === request.id)
          ) {
            assignment.abort();
          }
        } catch (error) {
          if (!running.aborted) report(error);
          if (terminalError(error)) assignment.abort();
        }
      }
    })();
    try {
      const app = matches[0]!;
      const live = captureDefinition(app).execution === 'live';
      if (live && !allowLive) throw new EvaluationError('config.schema');
      await runEvaluation({ app, configPath, handoff, allowLive: live, signal: running });
    } finally {
      assignment.abort();
      await monitor;
    }
  }

  while (!signal?.aborted) {
    let assigned: LearningWork;
    try {
      assigned = await work();
    } catch (error) {
      if (signal?.aborted) return;
      if (terminalError(error)) throw error;
      report(error);
      await wait(signal);
      continue;
    }
    if (!assigned.active) return;
    for (const item of assigned.items) {
      if (signal?.aborted) return;
      try {
        // The durable runner recovers saved reports on the original attempt and
        // refuses to start native work again after uncertain execution.
        await evaluate(assigned.bundleId, item);
      } catch (error) {
        if (!signal?.aborted) report(error);
      }
    }
    await wait(signal);
  }
}
