import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import {
  AcclimateClient,
  ApiError,
  DeliveryError,
  compare,
  resolveAndCache,
  prepareFiles,
  createReceiptReporter,
} from '@acclimate/sdk';
import { defineEvaluation } from '@acclimate/sdk/evaluation';
import {
  connectedEvaluationDescriptor,
  createLearningFieldAuditor,
  createLearningOutcomeReporter,
} from '@acclimate/sdk/learning';
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const client = new AcclimateClient({
  baseUrl: input.baseUrl,
  token: input.token,
  scope: input.scope,
  retries: 0,
  timeoutMs: 2000,
});
const base = { projectId: input.projectId, bundleId: input.bundleId };
const policy = {
  cacheDir: join(input.directory, 'cache'),
  ...(input.offline ? { offline: { maxAgeMs: 300000 } } : {}),
};
const selection = input.versionId
  ? { ...base, versionId: input.versionId }
  : { ...base, channel: 'stable' };

function reviewDefinition(datasetRevision, reviewCases) {
  return {
    configId: 'review-fixture',
    configRevision: '1',
    datasetRevision,
    graderRevision: 'instruction-coverage-v2',
    runtime: {},
    execution: 'model-free',
    cases: Object.entries(reviewCases).map(([caseId, requiredText]) => ({
      caseId, input: { path: 'AGENTS.md', requiredText }, expected: true, repetitions: 2,
    })),
    execute: async ({ bundle, input: task }) => ({
      output: bundle.payload.files.some((file) => file.path === task.path && file.text.includes(task.requiredText)),
      usage: { costUsd: 0 },
    }),
    grade: async ({ output, expected }) => ({ reward: Number(output === expected) }),
  };
}

function reviewDescriptors() {
  return Object.fromEntries(Object.entries(input.cohorts).map(([phase, cases]) => [
    phase, connectedEvaluationDescriptor(defineEvaluation(reviewDefinition(phase + '-v1', cases))),
  ]));
}

async function evaluate() {
  const reviewCases = input.reviewCases ?? { 'retry-review': 'retries' };
  const parent = await resolveAndCache(
    client,
    { ...base, versionId: input.settings.parentVersionId },
    policy,
  );
  const candidate = await resolveAndCache(
    client,
    { ...base, versionId: input.settings.candidateVersionId },
    policy,
  );
  const bundles = new Map([
    [parent.version.id, parent],
    [candidate.version.id, candidate],
  ]);
  const { datasetRevision, runtime, graderRevision, expectedCases } = input.settings;
  const definition = reviewDefinition(datasetRevision, reviewCases);
  const answers = new Map(definition.cases.map(({ caseId, expected }) => [caseId, expected]));
  if (input.reviewCases) {
    const registered = connectedEvaluationDescriptor(defineEvaluation(definition));
    assert.equal(runtime['acclimate.fixtures.v1.dataset'], registered.datasetDigest);
  }
  const casesById = new Map(definition.cases.map((testCase) => [testCase.caseId, testCase]));
  const repetitionCounts = new Map();
  for (const { caseId } of expectedCases) {
    assert.ok(casesById.has(caseId), `Unexpected review case: ${caseId}`);
    repetitionCounts.set(caseId, (repetitionCounts.get(caseId) ?? 0) + 1);
  }
  assert.equal(repetitionCounts.size, casesById.size);
  const report = await compare({
    parent: { version: parent.version },
    candidate: { version: candidate.version },
    datasetRevision,
    evaluation: input.settings.evaluation,
    runtime,
    graderRevision,
    cases: Array.from(repetitionCounts, ([caseId, repetitions]) => ({
      caseId, repetitions, snapshot: casesById.get(caseId).input, settings: null,
    })),
    execute: ({ version, snapshot }) => definition.execute({ bundle: bundles.get(version.version.id), input: snapshot }),
    grade: ({ output, caseId }) => definition.grade({ output, expected: answers.get(caseId) }),
  });
  assert.deepEqual(report.expectedCases, expectedCases);
  return client.createComparison(base.projectId, base.bundleId, report, crypto.randomUUID());
}

async function reportPolicy() {
  const { checkComparison, parseEvaluationPolicy } = await import('@acclimate/sdk/evaluation/policy');
  const request = await client.getEvaluation(base.projectId, base.bundleId, input.requestId);
  const comparison = await client.getComparison(base.projectId, base.bundleId, request.comparisonId);
  const { datasetRevision, graderRevision, runtime, expectedCases } = request;
  const descriptor = { datasetRevision, graderRevision, runtime, expectedCases };
  const parsed = parseEvaluationPolicy(JSON.stringify(input.policy), descriptor);
  const { policy, checks, verdict } = checkComparison({
    comparison,
    expectedDescriptor: descriptor,
    expectedBinding: {
      parentVersionId: request.parentVersionId,
      parentDigest: request.parentDigest,
      candidateVersionId: request.candidateVersionId,
      candidateDigest: request.candidateDigest,
      requestId: request.id,
      attemptId: request.attemptId,
      comparisonId: request.comparisonId,
      submitter: request.evaluatorPrincipal,
    },
    policy: parsed.policy,
    policyDigest: parsed.sha256,
  });
  return client.reportComparisonPolicyReceipt(base.projectId, base.bundleId, comparison.id, {
    requestId: request.id, attemptId: request.attemptId, policy, checks, verdict,
  });
}

function fieldJobPasses(instructions, job, defaultChecks = []) {
  const extensions = instructions.includes('Review code.') ? [...defaultChecks, '.ts'] : defaultChecks;
  const reviewed = job.changedPaths.filter((path) => extensions.some((suffix) => path.endsWith(suffix)));
  return reviewed.length === job.expectedPaths.length && job.expectedPaths.every((path) => reviewed.includes(path));
}

async function gradeFieldJob() {
  const target = { projectId: base.projectId, integrationId: input.integrationId };
  const scopedClient = (token, role) =>
    new AcclimateClient({
      baseUrl: input.baseUrl,
      token,
      scope: input.integrationId + ':' + role,
      integrationId: input.integrationId,
      retries: 0,
    });
  const reporter = createReceiptReporter({
    ...target,
    client: scopedClient(input.receiptToken, 'receipt'),
  });
  const reportOutcome = createLearningOutcomeReporter({
    ...target,
    client: scopedClient(input.outcomeToken, 'outcome'),
  });
  const grade = (text) => fieldJobPasses(text, input.fieldJob) ? 'correct' : 'incorrect';
  const audit = createLearningFieldAuditor({
    ...target,
    client,
    cacheDir: policy.cacheDir,
    samplePercent: 100,
    evaluate: async ({ job, predecessor }) => ({
      served: grade(job),
      predecessor: grade(predecessor.payload.files.find((file) => file.path === 'AGENTS.md').text),
    }),
  });
  const job = await scopedClient(input.readerToken, 'delivery').prepare({
    ...base,
    channel: 'stable',
    cacheDir: policy.cacheDir,
    reporter,
  });
  try {
    const startedReceipt = job.reportStarted();
    assert(startedReceipt);
    await reporter.flush();
    assert.equal(reporter.pendingCount, 0);
    const instructions = await readFile(join(job.directory, 'AGENTS.md'), 'utf8');
    const outcome = await reportOutcome(job.bundle, {
      outcomeId: crypto.randomUUID(),
      startedReceipt,
      status: grade(instructions) === 'correct' ? 'completed' : 'failed',
    });
    const verdict = await audit(job.bundle, { job: instructions, outcome, startedReceipt });
    assert(verdict, 'Expected a grade against the served release’s control');
    return verdict;
  } finally {
    await job.cleanup();
  }
}

async function replayFieldJob() {
  const candidate = await resolveAndCache(client, selection, policy);
  assert.equal(candidate.version.digest, input.digest);
  const instructions = candidate.payload.files.find((file) => file.path === 'AGENTS.md').text;
  assert.equal(fieldJobPasses(instructions, input.fieldJob), false, 'Original application must reproduce the loss');
  const attempts = Array.from({ length: 3 }, () =>
    fieldJobPasses(instructions, input.fieldJob, input.defaultChecks) ? 'pass' : 'regression');
  const verdict = attempts.filter((result) => result === 'pass').length >= 2 ? 'pass' : 'regression';
  const receipt = await client.reportLearningFieldReplay(base.projectId, input.integrationId, {
    versionId: candidate.version.id, digest: candidate.version.digest, baselineRevision: input.baselineRevision,
    outcomeId: input.outcomeId, verdict, attempts,
  });
  return { ...receipt, verdict };
}

async function delivery() {
  const reporter = input.reporting
    ? createReceiptReporter({
        client: new AcclimateClient({
          baseUrl: input.baseUrl,
          token: input.receiptToken,
          scope: 'receipt-fixture',
          retries: 0,
          timeoutMs: 1000,
        }),
        projectId: base.projectId,
        integrationId: input.integrationId,
      })
    : undefined;
  const bundle = await resolveAndCache(client, selection, { ...policy, reporter });
  const destination = join(input.directory, 'prepared-' + crypto.randomUUID());
  const prepared = await prepareFiles(bundle, destination);
  if (input.reporting) {
    reporter.reportPrepared(bundle);
    if (input.started) {
      const { spawn } = await import('node:child_process');
      const app = spawn(process.execPath, ['-e', "console.log('app started')"], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let output = '',
        started = false;
      app.stdout.setEncoding('utf8');
      app.stdout.on('data', (chunk) => {
        output += chunk;
        if (!started && output.includes('app started\n')) {
          started = true;
          try {
            reporter.reportStarted(bundle);
          } catch {}
        }
      });
      await new Promise((resolve, reject) => {
        app.once('error', reject);
        app.once('close', (code) =>
          code === 0 ? resolve() : reject(new Error('Application start failed')),
        );
      });
      assert(started);
    }
    await reporter.flush();
  }
  return {
    version: bundle.version,
    revision: bundle.resolution?.revision,
    stale: bundle.stale,
    instruction: await readFile(join(destination, 'AGENTS.md'), 'utf8'),
    destination,
    pending: reporter?.pendingCount,
  };
}
async function editJob() {
  const result = await delivery();
  await writeFile(join(result.destination, 'AGENTS.md'), 'Job-local edits.');
  return result;
}
async function collision() {
  const bundle = await resolveAndCache(client, selection, policy);
  const destination = join(input.directory, 'existing');
  await mkdir(destination, { mode: 0o700 });
  await writeFile(join(destination, 'AGENTS.md'), 'Application instructions.', { mode: 0o600 });
  let rejected = false;
  try {
    await prepareFiles(bundle, destination);
  } catch (error) {
    if (!(error instanceof DeliveryError) && error.code !== 'EEXIST') throw error;
    rejected = true;
  }
  return { rejected, instruction: await readFile(join(destination, 'AGENTS.md'), 'utf8') };
}
async function cleanup() {
  const bundle = await resolveAndCache(client, selection, policy);
  const destination = join(input.directory, 'cleanup');
  const prepared = await prepareFiles(bundle, destination);
  await writeFile(join(destination, 'application-note.txt'), 'Keep this note.', { mode: 0o600 });
  await prepared.cleanup();
  let instructionExists = true;
  try {
    await access(join(destination, 'AGENTS.md'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    instructionExists = false;
  }
  return {
    instructionExists,
    note: await readFile(join(destination, 'application-note.txt'), 'utf8'),
  };
}
async function native() {
  const bundle = await resolveAndCache(client, selection, policy);
  const plugin = await import('@acclimate/' + input.plugin + '-plugin');
  const prepared = await plugin.prepare(bundle, {
    approvedMemoryPaths: input.approveMemory ? ['memory/team.md'] : [],
  });
  try {
    return {
      instructionName: basename(prepared.instructionPath),
      instruction: await readFile(prepared.instructionPath, 'utf8'),
      skillPaths: prepared.skillPaths.map((path) => basename(path)),
      memoryCount: prepared.memoryFiles.length,
    };
  } finally {
    await prepared.cleanup();
  }
}
async function recoverReporting() {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const unavailable = createServer((request, response) => {
    request.resume();
    response.writeHead(503).end();
  });
  unavailable.listen(0, '127.0.0.1');
  await once(unavailable, 'listening');
  const outageUrl = 'http://127.0.0.1:' + unavailable.address().port;
  const originalEvents = new Map();
  const sentAfter = [];
  let recovered = false;
  let now = Date.now();
  const reportClient = new AcclimateClient({
    baseUrl: input.baseUrl,
    token: input.receiptToken,
    scope: 'receipt-fixture',
    retries: 0,
    fetch: (url, init) => {
      const raw = String(init.body);
      if (recovered) {
        sentAfter.push(raw);
        return fetch(url, init);
      }
      const { eventId } = JSON.parse(raw);
      if (originalEvents.has(eventId)) assert.equal(originalEvents.get(eventId), raw);
      originalEvents.set(eventId, raw);
      return fetch(outageUrl, init);
    },
  });
  const reporter = createReceiptReporter({
    client: reportClient,
    projectId: base.projectId,
    integrationId: input.integrationId,
    now: () => now,
  });
  try {
    const reader = new AcclimateClient({ baseUrl: input.baseUrl, token: input.readerToken, scope: 'delivery-fixture' });
    const bundle = await resolveAndCache(reader, selection, { ...policy, reporter });
    const destination = join(input.directory, 'reporting-outage');
    await prepareFiles(bundle, destination);
    const instruction = await readFile(join(destination, 'AGENTS.md'), 'utf8');
    reporter.reportPrepared(bundle);
    await reporter.flush();
    const pendingBefore = reporter.pendingCount;
    const receivedBefore = (await client.listDeliveryReceipts(base.projectId, input.integrationId)).items;
    const originals = [...originalEvents.values()];
    const preparedEvent = originals.map((raw) => JSON.parse(raw)).find((event) => event.stage === 'prepared');
    now += input.expired ? 24 * 60 * 60 * 1000 + 1 : 1000;
    recovered = true;
    await reporter.flush();
    await reporter.flush();
    return { instruction, pendingBefore, receivedBefore, preparedEvent, originalEvents: originals.sort(),
      sentAfter: sentAfter.sort(), pendingAfter: reporter.pendingCount };
  } finally {
    await new Promise((resolve) => unavailable.close(resolve));
  }
}
async function compareMutation() {
  const parent = {
    version: await client.getVersion(base.projectId, base.bundleId, input.parentVersionId),
  };
  const candidate = {
    version: await client.getVersion(base.projectId, base.bundleId, input.candidateVersionId),
  };
  const original = {
    parentVersionId: parent.version.id,
    candidateVersionId: candidate.version.id,
    parentDigest: parent.version.digest,
    candidateDigest: candidate.version.digest,
    datasetRevision: 'fixed-dataset',
    runtime: { model: 'fixture' },
    graderRevision: 'fixed-grader',
  };
  let executions = 0;
  const observed = [];
  const attempts = new Map();
  const options = {
    parent,
    candidate,
    cases: [{ caseId: 'review', snapshot: null, settings: null }],
    datasetRevision: original.datasetRevision,
    runtime: { ...original.runtime },
    graderRevision: original.graderRevision,
    gradeRetries: 1,
    execute: async ({ version }) => {
      executions++;
      if (input.mutation === 'identities') {
        options.parent.version.id = 'changed-parent';
        options.candidate.version.id = 'changed-candidate';
        options.parent.version.digest = 'sha256:' + 'a'.repeat(64);
        options.runtime.model = 'changed-model';
        options.datasetRevision = 'changed-data';
        options.graderRevision = 'changed-grader';
      }
      return { output: { findings: ['first', 'second'] } };
    },
    grade: async ({ output, version }) => {
      observed.push([...output.findings]);
      const attempt = attempts.get(version.version.id) || 0;
      attempts.set(version.version.id, attempt + 1);
      const reward = output.findings.length;
      if (input.mutation === 'grader') {
        output.findings.pop();
        if (!attempt) throw Error('Fixture grader retry.');
      }
      return { reward };
    },
  };
  const report = await compare(options);
  return { original, report, executions, observed };
}
const actions = {
  reviewDescriptors,
  evaluate,
  reportPolicy,
  gradeFieldJob,
  replayFieldJob,
  delivery,
  editJob,
  collision,
  cleanup,
  native,
  recoverReporting,
  compareMutation,
};
if (!actions[input.action]) throw Error('Unknown SDK fixture action');
try {
  console.log(JSON.stringify(await actions[input.action]()));
} catch (error) {
  if (
    !(
      error instanceof ApiError ||
      error instanceof DeliveryError ||
      (error instanceof TypeError && error.message === 'fetch failed')
    )
  )
    throw error;
  console.log(
    JSON.stringify({ error: { name: error.name, code: error.code, status: error.status } }),
  );
}
