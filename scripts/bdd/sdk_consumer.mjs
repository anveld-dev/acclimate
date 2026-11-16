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
async function evaluate() {
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
  const report = await compare({
    parent: { version: parent.version },
    candidate: { version: candidate.version },
    datasetRevision,
    evaluation: input.settings.evaluation,
    runtime,
    graderRevision,
    cases: [{ caseId: 'retry-review', repetitions: 2, snapshot: null, settings: null }],
    execute: async ({ version }) => ({
      output: bundles
        .get(version.version.id)
        .payload.files.map((f) => f.text)
        .join('\n'),
      usage: { costUsd: 0 },
    }),
    grade: async ({ output }) => ({ reward: output.includes('retries') ? 1 : 0 }),
  });
  assert.deepEqual(report.expectedCases, expectedCases);
  return client.createComparison(base.projectId, base.bundleId, report, crypto.randomUUID());
}
async function delivery() {
  const reporter = input.reporting
    ? createReceiptReporter({
        client: new AcclimateClient({
          baseUrl: input.baseUrl,
          token: input.receiptToken || 'fixture-invalid-report-token',
          scope: 'receipt-fixture',
          retries: 0,
          timeoutMs: 1000,
        }),
        projectId: base.projectId,
        integrationId: input.integrationId || crypto.randomUUID(),
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
async function queueExpiry() {
  let now = Date.now();
  const reportClient = new AcclimateClient({
    baseUrl: input.baseUrl,
    token: 'fixture-invalid-report-token',
    scope: 'expired-receipt',
    retries: 0,
  });
  const reporter = createReceiptReporter({
    client: reportClient,
    projectId: base.projectId,
    integrationId: input.integrationId,
    now: () => now,
  });
  const version = (await client.resolveChannel(base.projectId, base.bundleId, 'stable')).resolution
    .version;
  reporter.enqueue({
    eventId: crypto.randomUUID(),
    integrationId: input.integrationId,
    projectId: base.projectId,
    bundleId: base.bundleId,
    versionId: version.id,
    digest: version.digest,
    stage: 'verified',
    source: 'cache',
    occurredAt: new Date(now).toISOString(),
  });
  await reporter.flush();
  const before = reporter.pendingCount;
  now += 24 * 60 * 60 * 1000 + 1;
  await reporter.flush();
  return { before, after: reporter.pendingCount };
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
  evaluate,
  delivery,
  editJob,
  collision,
  cleanup,
  native,
  queueExpiry,
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
