import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AcclimateClient, ApiError } from '../client.js';
import { resolveAndCache } from '../cache.js';
import { readEvaluatorConfig } from '../evaluation/config.js';
import { bindEvaluationRepetitions, captureDefinition } from '../evaluation/definition.js';
import {
  EvaluationError,
  toSafeDiagnostic,
  type EvaluationApp,
  type SafeDiagnostic,
} from '../evaluation/index.js';
import { runEvaluationRequest } from '../evaluation/runner.js';
import type {
  DeliveryReceiptRequest,
  LearningFieldAuditRequest,
  LearningFieldReplay,
  LearningIncidentReplay,
  LearningFieldAuditReceipt,
  LearningOutcomeRequest,
  LearningOutcomeReceipt,
  LearningRecheck,
  LearningRecheckVerdict,
  LearningWork,
  LearningWorkItem,
  VerifiedVersion,
} from '../types.js';
import { evaluationDescriptorDifferences, validateEvaluationHandoff } from '../validation.js';
import { replayVerdict, type ReplayExecution } from './connected-replay.js';
import { connectedFixtureBindings } from './connected-fixtures.js';

interface LearningConnectionScope {
  workspaceId: string;
  connectionId: string;
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

function freshResolution(version: VerifiedVersion, workspaceId: string, connectionId: string) {
  const resolution = version.resolution;
  if (
    !resolution ||
    version.stale ||
    version.connection?.connectionId !== connectionId ||
    version.connection.workspaceId !== workspaceId ||
    resolution.version.id !== version.version.id ||
    resolution.version.digest !== version.version.digest
  )
    throw new TypeError('Learning outcomes require a fresh version resolved for this connection');
  return resolution;
}

function startedBinding(
  version: VerifiedVersion,
  workspaceId: string,
  connectionId: string,
  receipt: Readonly<DeliveryReceiptRequest>,
) {
  const resolution = freshResolution(version, workspaceId, connectionId);
  if (
    !uuid.test(receipt.eventId) ||
    receipt.stage !== 'started' ||
    receipt.stale !== false ||
    (receipt.source !== 'network' && receipt.source !== 'cache') ||
    receipt.workspaceId !== workspaceId ||
    receipt.connectionId.toLowerCase() !== connectionId ||
    receipt.bundleId !== version.version.bundleId ||
    receipt.versionId !== version.version.id ||
    receipt.digest !== version.version.digest ||
    receipt.channel !== resolution.channel ||
    receipt.revision !== resolution.revision ||
    receipt.resolvedAt !== new Date(version.resolvedAt).toISOString()
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
  const { client, workspaceId } = options;
  if (!uuid.test(options.connectionId)) throw new TypeError('connectionId must be a UUID');
  const connectionId = options.connectionId.toLowerCase();
  return async (
    version: VerifiedVersion,
    outcome: TerminalOutcome,
  ): Promise<LearningOutcomeReceipt> => {
    const resolution = freshResolution(version, workspaceId, connectionId);
    if (!uuid.test(outcome.outcomeId) || !['completed', 'failed'].includes(outcome.status))
      throw new TypeError('Learning outcomes require a stable UUID and terminal status');

    const body: LearningOutcomeRequest = {
      outcomeId: outcome.outcomeId,
      versionId: version.version.id,
      digest: version.version.digest,
      status: outcome.status,
      deliveryRevision: resolution.revision,
    };
    if (outcome.requireIncidentReplay) {
      if (!outcome.feedback && !outcome.lesson)
        throw new TypeError('An incident replay requires a lesson or graded discrepancy');
      body.requireIncidentReplay = true;
    }
    if (outcome.startedReceipt)
      Object.assign(body, startedBinding(version, workspaceId, connectionId, outcome.startedReceipt));
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
    return client.reportLearningOutcome(workspaceId, connectionId, body);
  };
}

interface FieldAuditSample {
  outcome: LearningOutcomeReceipt;
  startedReceipt: Readonly<DeliveryReceiptRequest>;
}

function fieldAuditBinding(
  version: VerifiedVersion,
  workspaceId: string,
  connectionId: string,
  sample: FieldAuditSample,
): Omit<LearningFieldAuditRequest, 'verdict'> | null {
  const { startedReceiptId, deliveryRevision: revision } = startedBinding(
    version,
    workspaceId,
    connectionId,
    sample.startedReceipt,
  );
  const { outcomeId, accepted, fieldAudit } = sample.outcome;
  if (accepted !== true || !uuid.test(outcomeId))
    throw new TypeError('Field audit requires a trusted accepted terminal outcome');
  if (!fieldAudit) return null;
  if (
    !uuid.test(fieldAudit.parentVersionId) ||
    fieldAudit.parentVersionId === version.version.id ||
    !digest.test(fieldAudit.parentDigest)
  )
    throw new TypeError('Field audit predecessor identity is invalid');
  return {
    outcomeId,
    startedReceiptId,
    revision,
    versionId: version.version.id,
    digest: version.version.digest,
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
  const { client, workspaceId } = options;
  if (!uuid.test(options.connectionId)) throw new TypeError('connectionId must be a UUID');
  const connectionId = options.connectionId.toLowerCase();
  return async (
    version: VerifiedVersion,
    sample: FieldAuditSample & { verdict: LearningFieldAuditRequest['verdict'] },
  ): Promise<LearningFieldAuditReceipt> => {
    const binding = fieldAuditBinding(version, workspaceId, connectionId, sample);
    if (!binding || !['pass', 'regression', 'win', 'loss', 'tie'].includes(sample.verdict))
      throw new TypeError('Field audit requires an eligible sample and an independent verdict');
    return client.reportLearningFieldAudit(workspaceId, connectionId, {
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
    served: VerifiedVersion;
    predecessor: VerifiedVersion;
    signal?: AbortSignal;
  }): Promise<{ served: LearningFieldGrade; predecessor: LearningFieldGrade }>;
}

/** Prepare an independently graded field audit for the application's durable outbox. */
export function createLearningFieldAuditor<Job>(options: LearningFieldAuditorOptions<Job>) {
  const { client, workspaceId, cacheDir, evaluate } = options;
  const samplePercent = options.samplePercent ?? 10;
  if (
    !uuid.test(options.connectionId) ||
    !Number.isFinite(samplePercent) ||
    samplePercent < 0 ||
    samplePercent > 100
  )
    throw new TypeError(
      'Field audit sampling requires a connection UUID and percentage from 0 to 100',
    );
  const connectionId = options.connectionId.toLowerCase();
  return async (
    version: VerifiedVersion,
    sample: FieldAuditSample & { job: Job; signal?: AbortSignal },
  ): Promise<LearningFieldAuditRequest | null> => {
    const binding = fieldAuditBinding(version, workspaceId, connectionId, sample);
    if (!binding) return null;
    const bucket =
      createHash('sha256')
        .update(JSON.stringify([workspaceId, connectionId, binding.outcomeId.toLowerCase()]))
        .digest()
        .readUInt32BE(0) /
      2 ** 32;
    if (bucket * 100 >= samplePercent) return null;
    sample.signal?.throwIfAborted();
    const predecessor = await resolveAndCache(
      client,
      {
        workspaceId,
        bundleId: version.version.bundleId,
        versionId: binding.parentVersionId,
      },
      { cacheDir },
    );
    if (predecessor.version.digest !== binding.parentDigest)
      throw new TypeError('Field audit predecessor digest did not match the authorized sample');
    sample.signal?.throwIfAborted();
    const grades = await evaluate({
      job: sample.job,
      served: version,
      predecessor,
      signal: sample.signal,
    });
    sample.signal?.throwIfAborted();
    if (!['correct', 'incorrect'].includes(grades.predecessor)) return null;
    if (!['correct', 'incorrect'].includes(grades.served)) return null;
    return {
      ...binding,
      verdict:
        grades.served === grades.predecessor ? 'tie' : grades.served === 'correct' ? 'win' : 'loss',
    };
  };
}

export interface ConnectedLearningDriverOptions {
  connectionId: string;
  installationId: string;
  /** The existing private evaluator config, including the persistent journal directory. */
  configPath: string;
  apps: {
    development: EvaluationApp<any, any, any>;
    /** Replay private evidence for the original outcome against this exact delivery. */
    recheckExecution?: ReplayExecution;
    recheck?(input: {
      assignment: Readonly<LearningRecheck>;
      baseline: VerifiedVersion;
      signal?: AbortSignal;
    }): Promise<LearningRecheckVerdict>;
    /** Re-run the triggering incident on a verified candidate using the original private evidence. */
    replayIncidentExecution?: ReplayExecution;
    replayIncident?(input: {
      assignment: Readonly<Omit<LearningIncidentReplay, 'verdict'>>;
      candidate: VerifiedVersion;
      signal?: AbortSignal;
    }): Promise<LearningIncidentReplay['verdict']>;
    /** Opaque replay callbacks default to live. Mark deterministic callbacks model-free. */
    requalifyFieldCaseExecution?: ReplayExecution;
    /** Grade the original private field job using the supplied candidate. */
    requalifyFieldCase?(input: {
      assignment: Readonly<Omit<LearningFieldReplay, 'verdict'>>;
      candidate: VerifiedVersion;
      signal?: AbortSignal;
    }): Promise<LearningFieldReplay['verdict']>;
    audit: readonly EvaluationApp<any, any, any>[];
  };
  allowLive?: boolean;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** The original error may contain private data. Keep it out of shared diagnostics. */
  onDiagnostic?: (diagnostic: SafeDiagnostic, error: unknown) => void;
}

function validateInstalledApps(value: ConnectedLearningDriverOptions['apps']) {
  const invalid = (cause?: unknown) =>
    new EvaluationError('learning.apps_invalid_export', {}, { cause });
  if (!value || typeof value !== 'object' || !Array.isArray(value.audit)) throw invalid();
  for (const callback of [value.recheck, value.requalifyFieldCase, value.replayIncident]) {
    if (callback !== undefined && typeof callback !== 'function') throw invalid();
  }
  for (const mode of [
    value.recheckExecution,
    value.requalifyFieldCaseExecution,
    value.replayIncidentExecution,
  ]) {
    if (mode !== undefined && mode !== 'live' && mode !== 'model-free') throw invalid();
  }
  try {
    for (const app of [value.development, ...value.audit]) captureDefinition(app);
  } catch (error) {
    throw invalid(error);
  }
}

/**
 * Serve assigned evaluations with the installed app. Restart with the same
 * evaluator config and persistent journal so the runner can reconcile attempts.
 * Returns when the connection stops or the caller aborts.
 */
/**
 * Serves calibration and learning evaluations. After calibration submission,
 * enrollment can report `evaluated` while the worker computes the plan and power decision.
 */
export async function serveConnectedLearning(
  options: ConnectedLearningDriverOptions,
): Promise<void> {
  const { configPath, installationId, allowLive, signal, onDiagnostic } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  if (
    !uuid.test(options.connectionId) ||
    !installationId.trim() ||
    Buffer.byteLength(installationId) > 128 ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 25 ||
    pollIntervalMs > 120_000
  ) {
    throw new EvaluationError('config.schema');
  }
  const connectionId = options.connectionId.toLowerCase();
  validateInstalledApps(options.apps);
  const apps = { development: [options.apps.development], audit: [...options.apps.audit] };
  const installed = {
    development: connectedFixtureBindings(apps.development),
    audit: connectedFixtureBindings(apps.audit),
  };
  const config = await readEvaluatorConfig(configPath);
  const client = new AcclimateClient({
    baseUrl: config.serviceUrl,
    token: config.evaluatorToken,
    scope: config.evaluatorPrincipalId,
    timeoutMs: Math.max(1000, Math.min(pollIntervalMs, 10_000)),
  });
  const { workspaceId } = config;
  async function work(): Promise<LearningWork> {
    const result = await client.getLearningWork(workspaceId, connectionId);
    if (
      result.installationId !== installationId ||
      !uuid.test(result.bundleId) ||
      typeof result.active !== 'boolean' ||
      !Array.isArray(result.items) ||
      (result.rechecks !== undefined &&
        (!Array.isArray(result.rechecks) || result.rechecks.length > 100)) ||
      (result.incidentReplays !== undefined &&
        (!Array.isArray(result.incidentReplays) || result.incidentReplays.length > 100)) ||
      (result.fieldReplays !== undefined &&
        (!Array.isArray(result.fieldReplays) || result.fieldReplays.length > 50))
    ) {
      throw new EvaluationError('evidence.identity_mismatch');
    }
    return result;
  }
  function report(error: unknown) {
    onDiagnostic?.(toSafeDiagnostic(error), error);
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
  async function whileAssigned(
    bundleId: string,
    contains: (current: LearningWork) => boolean,
    run: (running: AbortSignal, assigned: () => Promise<boolean>) => Promise<void>,
  ): Promise<void> {
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
          if (!current.active || current.bundleId !== bundleId || !contains(current)) {
            assignment.abort();
          }
        } catch (error) {
          if (!running.aborted) report(error);
          if (terminalError(error)) assignment.abort();
        }
      }
    })();
    try {
      await run(running, async () => {
        if (running.aborted) return false;
        const latest = await work();
        return (
          !running.aborted && latest.active && latest.bundleId === bundleId && contains(latest)
        );
      });
    } finally {
      assignment.abort();
      await monitor;
    }
  }
  async function evaluate(bundleId: string, item: LearningWorkItem): Promise<void> {
    const calibration = item.phase === 'calibration';
    const phase = calibration ? 'development' : item.phase;
    const cumulative = !calibration && item.cumulative === true;
    if (!uuid.test(item.evaluationRequestId) || !Object.hasOwn(apps, phase))
      throw new EvaluationError('evidence.identity_mismatch');
    const request = await client.getEvaluation(workspaceId, bundleId, item.evaluationRequestId);
    if (
      request.id !== item.evaluationRequestId ||
      request.requireBoundEvidence !== true ||
      (!cumulative && Boolean(request.proposalId) === calibration) ||
      (request.parentVersionId === request.candidateVersionId) !== calibration
    )
      throw new EvaluationError('evidence.identity_mismatch');
    if (request.status !== 'requested' && request.status !== 'running') return;

    const matches = installed[phase](request)
      .filter(
        (app) =>
          evaluationDescriptorDifferences(
            { ...request, expectedCases: app.descriptor.expectedCases },
            app.descriptor,
          ).length === 0,
      )
      .map((app) => bindEvaluationRepetitions(app, request.expectedCases))
      .filter((app) => evaluationDescriptorDifferences(request, app.descriptor).length === 0);
    if (matches.length !== 1) throw new EvaluationError('descriptor.mismatch');
    const handoff = validateEvaluationHandoff({
      schemaVersion: 1,
      serviceUrl: client.baseUrl,
      workspaceId,
      bundleId,
      requestId: request.id,
      descriptor: {
        datasetRevision: request.datasetRevision,
        graderRevision: request.graderRevision,
        runtime: request.runtime,
        expectedCases: request.expectedCases,
      },
    });

    await whileAssigned(
      bundleId,
      (current) => current.items.some((next) => next.evaluationRequestId === request.id),
      async (running) => {
        const app = matches[0]!;
        const live = captureDefinition(app).execution === 'live';
        if (live && !allowLive) throw new EvaluationError('config.schema');
        await runEvaluationRequest(
          {
            app,
            configPath,
            handoff,
            allowLive: live,
            retryMissingTrial: true,
            cachedParent: item.cachedParent
              ? async () =>
                  (await work()).items.find((next) => next.evaluationRequestId === request.id)
                    ?.cachedParent
              : undefined,
            signal: running,
          },
          cumulative && !request.proposalId,
        );
      },
    );
  }

  type FieldReplay = Omit<LearningFieldReplay, 'verdict' | 'attempts'>;
  type IncidentReplay = Omit<LearningIncidentReplay, 'verdict' | 'attempts'>;
  async function replay(
    bundleId: string,
    assignment: LearningRecheck | FieldReplay | IncidentReplay,
  ): Promise<void> {
    const field = 'baselineRevision' in assignment;
    const incident = 'roundId' in assignment;
    const revision = field ? assignment.baselineRevision : assignment.revision;
    if (
      !uuid.test(assignment.outcomeId) ||
      !uuid.test(assignment.versionId) ||
      !digest.test(assignment.digest) ||
      !/^[1-9][0-9]*$/.test(revision) ||
      (incident && !uuid.test(assignment.roundId)) ||
      (!field && !uuid.test(assignment.correctionId))
    )
      throw new EvaluationError('evidence.identity_mismatch');
    const { versionId, digest: contentDigest, outcomeId } = assignment;
    const scope = [client.baseUrl, workspaceId, connectionId, bundleId, installationId];
    const identity = [
      ...scope,
      ...(incident ? [assignment.roundId] : []),
      ...(!field ? [assignment.correctionId] : []),
      outcomeId,
      versionId,
      contentDigest,
      revision,
    ];
    function contains(current: LearningWork) {
      const same = (item: FieldReplay | LearningRecheck) =>
        item.outcomeId === outcomeId &&
        item.versionId === versionId &&
        item.digest === contentDigest;
      if (incident)
        return (
          current.incidentReplays?.some(
            (item) =>
              same(item) &&
              item.roundId === assignment.roundId &&
              item.baselineRevision === revision,
          ) === true
        );
      return field
        ? current.fieldReplays?.some((item) => same(item) && item.baselineRevision === revision) ===
            true
        : current.rechecks?.some(
            (item) =>
              same(item) &&
              item.correctionId === assignment.correctionId &&
              item.revision === revision,
          ) === true;
    }
    await whileAssigned(bundleId, contains, async (running, assigned) => {
      const version = await resolveAndCache(
        client,
        { workspaceId, bundleId, versionId },
        {
          cacheDir: join(config.journalRoot, field ? 'field-replay-cache' : 'recheck-cache'),
        },
      );
      if (
        version.version.id !== versionId ||
        version.version.digest !== contentDigest ||
        version.version.bundleId !== bundleId
      )
        throw new EvaluationError('evidence.identity_mismatch');
      const common = { root: config.journalRoot, identity, allowLive, signal: running, assigned };
      if (incident && options.apps.replayIncident) {
        const callback = options.apps.replayIncident;
        const attempts: Array<LearningIncidentReplay['verdict']> = [];
        for (let attempt = 0; attempt < 3; attempt++) {
          const verdict = await replayVerdict({
            ...common,
            identity: [...identity, String(attempt)],
            kind: 'learning-incident-replays',
            verdicts: ['pass', 'regression', 'unavailable'] as const,
            execution: options.apps.replayIncidentExecution,
            execute: (signal) =>
              callback({ assignment: Object.freeze({ ...assignment }), candidate: version, signal }),
          });
          if (verdict === undefined) return;
          attempts.push(verdict);
        }
        const verdict =
          attempts.filter((value) => value === 'pass').length >= 2
            ? 'pass'
            : attempts.filter((value) => value === 'unavailable').length >= 2
              ? 'unavailable'
              : 'regression';
        if (await assigned())
          await client.reportLearningIncidentReplay(workspaceId, connectionId, {
            ...assignment,
            verdict,
            attempts,
          });
      } else if (!incident && field && options.apps.requalifyFieldCase) {
        const callback = options.apps.requalifyFieldCase;
        const attempts: Array<LearningFieldReplay['verdict']> = [];
        for (let attempt = 0; attempt < 3; attempt++) {
          const verdict = await replayVerdict({
            ...common,
            identity: [...identity, String(attempt)],
            kind: 'learning-field-replays',
            verdicts: ['pass', 'regression'] as const,
            execution: options.apps.requalifyFieldCaseExecution,
            execute: (signal) =>
              callback({ assignment: Object.freeze({ ...assignment }), candidate: version, signal }),
          });
          if (verdict === undefined) return;
          attempts.push(verdict);
        }
        const verdict =
          attempts.filter((value) => value === 'pass').length >= 2 ? 'pass' : 'regression';
        if (await assigned())
          await client.reportLearningFieldReplay(workspaceId, connectionId, {
            ...assignment,
            verdict,
            attempts,
          });
      } else if (!field && options.apps.recheck) {
        const callback = options.apps.recheck;
        const verdict = await replayVerdict({
          ...common,
          kind: 'learning-rechecks',
          verdicts: ['reproduced', 'resolved', 'unavailable'] as const,
          execution: options.apps.recheckExecution,
          execute: (signal) =>
            callback({ assignment: structuredClone(assignment), baseline: version, signal }),
        });
        if (verdict !== undefined && (await assigned()))
          await client.reportLearningRecheck(workspaceId, connectionId, {
            correctionId: assignment.correctionId,
            versionId,
            digest: contentDigest,
            revision,
            verdict,
          });
      }
    });
  }

  let previouslyMissing = new Set<string>();
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
    const missing = new Set<string>();
    for (const [callback, assignments, code] of [
      [
        options.apps.replayIncident,
        assigned.incidentReplays,
        'learning.incident_replay_callback_missing',
      ],
      [
        options.apps.requalifyFieldCase,
        assigned.fieldReplays,
        'learning.field_replay_callback_missing',
      ],
      [options.apps.recheck, assigned.rechecks, 'learning.recheck_callback_missing'],
    ] as const) {
      if (callback) continue;
      for (const { outcomeId } of assignments ?? []) {
        if (!uuid.test(outcomeId)) throw new EvaluationError('evidence.identity_mismatch');
        const key = code + ':' + outcomeId;
        missing.add(key);
        if (!previouslyMissing.has(key))
          report(new EvaluationError(code, { correlationId: outcomeId }));
      }
    }
    previouslyMissing = missing;
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
    const replays = [
      ...(options.apps.replayIncident ? (assigned.incidentReplays ?? []) : []),
      ...(options.apps.requalifyFieldCase ? (assigned.fieldReplays ?? []) : []),
      ...(options.apps.recheck ? (assigned.rechecks ?? []) : []),
    ];
    for (const assignment of replays) {
      if (signal?.aborted) return;
      try {
        await replay(assigned.bundleId, assignment);
      } catch (error) {
        if (!signal?.aborted) report(error);
      }
    }
    await wait(signal);
  }
}
