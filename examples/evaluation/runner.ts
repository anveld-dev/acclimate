import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { compare, type ExecutionResult } from '../../packages/sdk/src/compare.js';
import { resolveAndCache } from '../../packages/sdk/src/index.js';
import type { AcclimateClient, ComparisonRequest, Evaluation } from '../../packages/sdk/src/index.js';
import { assertInstalledConfiguration, type InstalledAdapter } from './adapter.js';
import { openJournal, type AttemptJournal, type JournalScope } from './journal.js';

export interface RunEvaluationOptions extends JournalScope {
  api: AcclimateClient;
  journalRoot: string;
  adapter: InstalledAdapter;
}

function snapshot(request: Evaluation): AttemptJournal['request'] {
  return structuredClone({
    parentVersionId: request.parentVersionId, candidateVersionId: request.candidateVersionId,
    parentDigest: request.parentDigest, candidateDigest: request.candidateDigest,
    datasetRevision: request.datasetRevision, graderRevision: request.graderRevision,
    runtime: request.runtime, expectedCases: request.expectedCases,
  });
}

function assertFrozenRequest(request: Evaluation, requestId: string, frozen: AttemptJournal['request']) {
  if (request.id !== requestId) throw new Error('Service returned a different evaluation request');
  assertInstalledConfiguration(request, frozen);
  for (const key of ['parentVersionId', 'candidateVersionId', 'parentDigest', 'candidateDigest'] as const)
    if (frozen[key] !== request[key]) throw new Error('Frozen evaluator journal does not match request');
}

function assertReport(report: ComparisonRequest, request: Evaluation, attemptId: string) {
  assertInstalledConfiguration(report, request);
  for (const key of ['parentVersionId', 'candidateVersionId', 'parentDigest', 'candidateDigest'] as const)
    if (report[key] !== request[key]) throw new Error('Saved report version binding mismatch');
  if (report.evaluation?.requestId !== request.id || report.evaluation.attemptId !== attemptId)
    throw new Error('Saved report request/attempt binding mismatch');
  const expected = new Set(request.expectedCases.map((key) => JSON.stringify([key.caseId, key.repetition])));
  if (report.results.length !== expected.size || expected.size !== request.expectedCases.length)
    throw new Error('Saved report inventory mismatch');
  for (const pair of report.results) {
    if (!expected.delete(JSON.stringify([pair.caseId, pair.repetition]))) throw new Error('Saved report inventory mismatch');
    for (const outcome of [pair.parent, pair.candidate])
      if (!['completed', 'task_failed', 'infrastructure_failed'].includes(outcome.executionStatus) ||
          !['scored', 'missing', 'failed'].includes(outcome.gradingStatus) ||
          (outcome.gradingStatus === 'scored' ? typeof outcome.reward !== 'number' || !Number.isFinite(outcome.reward) : outcome.reward !== null))
        throw new Error('Saved report has malformed outcomes; interrupt this request and create a new request');
  }
}

/** Holds exclusive ownership through recovery, execution, exact submission and finish. */
export async function runEvaluation(options: RunEvaluationOptions): Promise<Evaluation> {
  const { api, projectId, bundleId, requestId, evaluatorPrincipalId } = options;
  // Capture installed callbacks/cases before any await; wrappers must not re-read a mutable adapter.
  const adapter = options.adapter;
  const executeAdapter = adapter.execute.bind(adapter);
  const gradeAdapter = adapter.grade.bind(adapter);
  const descriptor = structuredClone(adapter.describe());
  const cases = structuredClone(adapter.cases);
  if (!Array.isArray(cases) || !cases.length || cases.length > 1000)
    throw new Error('Installed adapter has an invalid case inventory');
  const expectedCases = cases.flatMap((item) => {
    const repetitions = item.repetitions ?? 1;
    if (typeof item.caseId !== 'string' || !item.caseId.trim() ||
        !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 1000)
      throw new Error('Installed adapter has an invalid case inventory');
    return Array.from({ length: repetitions }, (_, repetition) => ({ caseId: item.caseId, repetition }));
  });
  if (expectedCases.length > 1000 || new Set(expectedCases.map(item => JSON.stringify(item))).size !== expectedCases.length)
    throw new Error('Installed adapter has an invalid case inventory');
  assertInstalledConfiguration({ ...descriptor, expectedCases }, descriptor);

  const scope: JournalScope = { serviceUrl: options.serviceUrl, projectId, bundleId, requestId, evaluatorPrincipalId };
  const journal = await openJournal(options.journalRoot, scope);
  try {
    let request = await api.getEvaluation(projectId, bundleId, requestId);
    if (request.id !== requestId) throw new Error('Service returned a different evaluation request');
    assertInstalledConfiguration(request, descriptor);
    let state = await journal.read();
    if (state) {
      assertFrozenRequest(request, requestId, state.request);
      if ((request.attemptId || ['running', 'completed', 'failed'].includes(request.status)) &&
          (request.attemptId !== state.attemptId || request.evaluatorPrincipal !== evaluatorPrincipalId))
        throw new Error('Request belongs to a different evaluator or attempt');
      if (state.comparisonId && (request.comparisonId || ['completed', 'failed'].includes(request.status)) &&
          state.comparisonId !== request.comparisonId)
        throw new Error('Request belongs to a different comparison');
    }
    if (request.status === 'completed' || request.status === 'failed') return request;
    if (request.status === 'interrupted') throw new Error('Request was interrupted; create a new evaluation request');
    if (!state) {
      if (request.status !== 'requested') throw new Error('Running request has no local journal; interrupt it and create a new request');
      state = {
        schemaVersion: 1, scope, request: snapshot(request), attemptId: randomUUID(),
        keys: { start: randomUUID(), submit: randomUUID(), finish: randomUUID() },
      };
      await journal.save(state);
    }
    if (state.executionStarted && !state.report)
      throw new Error('Execution started without a complete saved report; interrupt this request and create a new request');
    if (state.report) assertReport(state.report, request, state.attemptId);
    if (request.status === 'requested') {
      journal.assertOwned();
      request = await api.startEvaluation(projectId, bundleId, requestId, { attemptId: state.attemptId }, state.keys.start);
    }
    assertFrozenRequest(request, requestId, state.request);
    if (request.status !== 'running' || request.attemptId !== state.attemptId || request.evaluatorPrincipal !== evaluatorPrincipalId)
      throw new Error('Evaluator did not confirm ownership of the running attempt');
    if (!state.report) {
      const cacheDir = `${journal.directory}/cache`;
      const parent = await resolveAndCache(api, { projectId, bundleId, versionId: request.parentVersionId }, { cacheDir });
      const candidate = await resolveAndCache(api, { projectId, bundleId, versionId: request.candidateVersionId }, { cacheDir });
      if (parent.version.digest !== request.parentDigest || candidate.version.digest !== request.candidateDigest ||
          candidate.version.parentVersionId !== parent.version.id)
        throw new Error('Request version identities or parentage mismatch');
      const versions = new Map([[parent.version.id, parent], [candidate.version.id, candidate]]);
      state.executionStarted = true;
      await journal.save(state); // Must reach durable storage before the first app callback.
      const report = await compare({
        parent, candidate,
        evaluation: { requestId, attemptId: state.attemptId },
        datasetRevision: request.datasetRevision, graderRevision: request.graderRevision, runtime: request.runtime,
        cases, concurrency: 1, gradeRetries: 0,
        execute: async ({ version, ...input }): Promise<ExecutionResult<unknown>> => {
          journal.assertOwned();
          const execution = await executeAdapter({ ...input, bundle: versions.get(version.version.id)! });
          const filename = await journal.output({ ...input, versionId: version.version.id, execution });
          return { ...execution, outputRef: pathToFileURL(filename).href };
        },
        grade: async (input) => { journal.assertOwned(); return gradeAdapter(input); },
      });
      state.report = report;
      await journal.save(state); // Preserve exact report and keys even if submission response is lost.
      assertReport(report, request, state.attemptId);
    }
    if (!state.comparisonId) {
      journal.assertOwned();
      const comparison = await api.createComparison(projectId, bundleId, state.report, state.keys.submit);
      if (!comparison.id || typeof comparison.complete !== 'boolean') throw new Error('Service did not confirm the comparison');
      state.comparisonId = comparison.id;
      await journal.save(state);
    }
    journal.assertOwned();
    const result = await api.finishEvaluation(projectId, bundleId, requestId,
      { attemptId: state.attemptId, comparisonId: state.comparisonId }, state.keys.finish);
    assertFrozenRequest(result, requestId, state.request);
    if (!['completed', 'failed'].includes(result.status) || result.attemptId !== state.attemptId ||
        result.evaluatorPrincipal !== evaluatorPrincipalId || result.comparisonId !== state.comparisonId)
      throw new Error('Service did not confirm the exact completed evaluation attempt');
    state.completed = true;
    await journal.save(state);
    return result;
  } finally { await journal.close(); }
}
