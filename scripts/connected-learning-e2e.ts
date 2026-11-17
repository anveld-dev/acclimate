import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AcclimateClient,
  createReceiptReporter,
  resolveAndCache,
} from '../packages/sdk/src/index.js';
import { defineEvaluation } from '../packages/sdk/src/evaluation/index.js';
import {
  createLearningFieldAuditor,
  createLearningOutcomeReporter,
  serveConnectedLearning,
} from '../packages/sdk/src/learning/index.js';
import type {
  BundlePayload,
  LearningOutcomeRequest,
  VerifiedBundle,
  VersionMetadata,
} from '../packages/sdk/src/types.js';

const database = process.env.EVALUATION_TEST_DATABASE_URL;
assert(
  database && /^postgres(?:ql)?:\/\/[^/]+@127\.0\.0\.1:\d+\//.test(database),
  'Use the private PostgreSQL cluster created by scripts/productization/connected_learning.py',
);
const project = `connected-${randomUUID()}`;
const projectPath = `/v1/projects/${project}`;
const roles = ['operator', 'evaluator', 'other'] as const;
type Role = (typeof roles)[number];
const tokens = Object.fromEntries(
  roles.map((role) => [role, randomUUID() + randomUUID()]),
) as Record<Role, string>;
const modelToken = randomUUID() + randomUUID();
const loginToken = randomUUID() + randomUUID();
const consoleToken = randomUUID() + randomUUID();
const issuer = 'https://identity.example.invalid';
const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'acclimate-connected-'));
const controller = new AbortController();
const modelRequests: { instruction: string; allowedPaths: string[] }[] = [];
const executions: { dataset: string; caseId: string; version: string }[] = [];
const evidence: Record<string, unknown> = {};
const drivers: Promise<unknown>[] = [];
let child: ChildProcess | undefined;
let logs = '';
let model: Server | undefined;
let browserSession: string | undefined;

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

async function waitFor<T>(label: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  do {
    const found = await probe();
    if (found !== undefined) return found;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function stopService() {
  if (!child || child.exitCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  const watchdog = setTimeout(() => child?.kill('SIGKILL'), 15_000);
  try {
    await exit;
  } finally {
    clearTimeout(watchdog);
  }
}

// An installed refund-response harness interprets small instruction rules for actual app behavior.
type Task = { kind: 'refund' | 'refund-status' | 'refund-escalation' };
const expectedResponse: Record<Task['kind'], string> = {
  refund: 'Quote the refund window.',
  'refund-status': 'Ask for the receipt number.',
  'refund-escalation': 'Send the case to support.',
};
function runRefundTask(payload: BundlePayload, task: Task): string {
  const rules = payload.files.find((file) => file.path === 'AGENTS.md')?.text.split('\n') ?? [];
  const rule = rules.reverse().find((line) => line.startsWith(`${task.kind} = `));
  return rule?.split(' = ')[1] ?? 'Send the case to support.';
}

function cohort(dataset: string, tasks: Task[]) {
  return defineEvaluation<Task, string, string>({
    configId: 'refund-harness-fixture',
    configRevision: '1',
    datasetRevision: dataset,
    graderRevision: 'refund-expected-responses-v1',
    runtime: { app: 'refund', provider: 'local-fixture' },
    execution: 'model-free',
    cases: tasks.map((input, index) => ({
      caseId: `${dataset}-${index}`,
      input,
      expected: expectedResponse[input.kind],
    })),
    async execute({ bundle, input, caseId }) {
      executions.push({ dataset, caseId, version: bundle.version.id });
      return { output: runRefundTask(bundle.payload, input) };
    },
    async grade({ output, expected }) {
      return { reward: output === expected ? 1 : 0 };
    },
  });
}

interface Round {
  id: string;
  outcomeId: string;
  state: string;
  reason: string | null;
  parentVersionId: string;
  candidateVersionId: string | null;
  developmentRequestId: string | null;
  developmentComparisonId: string | null;
  auditRequestId: string | null;
  auditComparisonId: string | null;
  promotionId: string | null;
}

try {
  const modelPort = await listen(
    (model = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/v1/chat/completions');
        assert.equal(req.headers.authorization, `Bearer ${modelToken}`);
        const request = JSON.parse(JSON.parse(body).messages[0].content) as {
          parent: BundlePayload;
          request: { hypothesis: string; allowedPaths: string[]; evidence: string[] };
        };
        assert.deepEqual(request.request.allowedPaths, ['AGENTS.md']);
        const file = request.parent.files.find((item) => item.path === 'AGENTS.md');
        assert(file);
        const expectedOutcome = request.request.evidence.find((item) =>
          item.startsWith('Expected outcome: '),
        );
        const instruction =
          expectedOutcome?.slice('Expected outcome: '.length) ?? request.request.hypothesis;
        modelRequests.push({
          instruction,
          allowedPaths: request.request.allowedPaths,
        });
        const content = JSON.stringify({
          schemaVersion: 1,
          edits: [
            {
              path: file.path,
              oldText: file.text,
              newText: `${file.text.trimEnd()}\n${instruction}`,
            },
          ],
          rationale: 'Apply the proposed refund response rules to the permitted instruction file.',
        });
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content } }],
          }),
        );
      } catch (error) {
        logs += `Fixture model rejected request: ${String(error)}\n`;
        res.writeHead(400).end();
      }
    })),
  );
  const vacant = createServer();
  const port = await listen(vacant);
  vacant.close();
  await once(vacant, 'close');
  const serviceUrl = `http://127.0.0.1:${port}`;
  const environment = JSON.parse(
    execFileSync('python3', ['-m', 'scripts.testing.production'], {
      input: JSON.stringify({
        database_url: database,
        bind: `127.0.0.1:${port}`,
        project,
        tokens,
        login_token: loginToken,
        console_token: consoleToken,
        issuer,
      }),
      encoding: 'utf8',
    }),
  );
  async function startService() {
    child = spawn('target/debug/acclimate-service', [], {
      env: {
        ...environment,
        ACCLIMATE_MODEL_ENDPOINT: `http://127.0.0.1:${modelPort}/v1/chat/completions`,
        ACCLIMATE_MODEL_TOKEN: modelToken,
        ACCLIMATE_MODEL: 'gpt-6.2-sol',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (data) => {
      logs = (logs + data).slice(-18_000);
    });
    child.stderr?.on('data', (data) => {
      logs = (logs + data).slice(-18_000);
    });
    await waitFor('production service readiness', async () => {
      assert.equal(child?.exitCode, null, logs);
      const ready = await fetch(`${serviceUrl}/ready`, {
        signal: AbortSignal.timeout(1_000),
      }).catch(() => undefined);
      return ready?.ok ? true : undefined;
    });
  }

  async function api<T = any>(
    method: string,
    route: string,
    body?: unknown,
    role: Role | 'admin' = 'admin',
    expected?: number,
  ): Promise<T> {
    const response = await fetch(`${serviceUrl}${projectPath}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${role === 'admin' ? consoleToken : tokens[role]}`,
        ...(role === 'admin' && browserSession ? { 'x-acclimate-session': browserSession } : {}),
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert(
      expected === undefined ? response.ok : response.status === expected,
      `${method} ${route} returned ${response.status}: ${JSON.stringify(value)}`,
    );
    return value as T;
  }

  const client = (role: Role, integrationId?: string) =>
    new AcclimateClient({
      baseUrl: serviceUrl,
      token: tokens[role],
      scope: `${project}:${role}:${integrationId ?? 'global'}`,
      integrationId,
      retries: 0,
      timeoutMs: 3_000,
    });
  const learning = (connection: string) => `/integrations/${connection}/learning`;
  const configPath = path.join(dir, 'evaluator.json');
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      serviceUrl,
      projectId: project,
      evaluatorPrincipalId: 'evaluator',
      evaluatorToken: tokens.evaluator,
      journalRoot: path.join(dir, 'journal'),
    }),
    { mode: 0o600 },
  );

  function enableDriver(
    integrationId: string,
    installationId: string,
    apps: ReturnType<typeof evaluationApps>,
  ) {
    const installed = new AbortController();
    const signal = AbortSignal.any([controller.signal, installed.signal]);
    const actual = serveConnectedLearning({
      integrationId,
      installationId,
      configPath,
      apps: { development: apps.development, audit: apps.audits },
      pollIntervalMs: 100,
      signal,
      onDiagnostic: (diagnostic) => {
        logs += `SDK driver ${installationId}: ${JSON.stringify(diagnostic)}\n`;
      },
    });
    drivers.push(
      actual.catch((error) => {
        if (!signal.aborted) throw error;
      }),
    );
    void drivers.at(-1)?.catch(() => {});
    return async () => {
      installed.abort();
      await actual;
    };
  }

  function evaluationApps(installation: string) {
    const tasks: Task[] = [{ kind: 'refund' }, { kind: 'refund-status' }];
    return {
      development: cohort(`${installation}-development`, tasks),
      audits: Array.from({ length: 4 }, (_, index) =>
        cohort(`${installation}-audit-${index + 1}`, [...tasks, { kind: 'refund-escalation' }]),
      ),
    };
  }

  function rollbackApps(installation: string) {
    const tasks: Task[] = [{ kind: 'refund' }, { kind: 'refund-status' }];
    return {
      development: cohort(`${installation}-development`, tasks),
      audits: [1, 2, 3].map((index) => cohort(`${installation}-audit-${index}`, tasks)),
    };
  }

  function descriptor(app: ReturnType<typeof cohort>) {
    const fingerprint = (identity: string) => createHash('sha256').update(identity).digest('hex');
    return {
      ...app.descriptor,
      datasetDigest: fingerprint(app.descriptor.datasetRevision),
      caseFingerprints: app.descriptor.expectedCases.map(({ caseId }) => fingerprint(caseId)),
    };
  }

  async function enroll(connection: string, installationId: string, automaticRollout: boolean) {
    const apps = evaluationApps(installationId);
    const body = {
      installationId,
      automaticRollout,
      permittedPaths: ['AGENTS.md'],
      maxProposalAdmissions: automaticRollout ? 4 : 1,
      development: descriptor(apps.development),
      audits: apps.audits.slice(0, automaticRollout ? 4 : 1).map(descriptor),
      evaluatorPrincipal: 'evaluator',
      outcomePrincipal: 'other',
    };
    await api('PUT', learning(connection), body, 'other', 403);
    await api('PUT', learning(connection), body);
    await api('PUT', learning(connection), body);
    return apps;
  }

  await startService();
  const login = await fetch(`${serviceUrl}/v1/auth/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${loginToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ issuer, subject: 'operator' }),
  });
  assert(login.ok, `Fixture browser login returned ${login.status}`);
  browserSession = (await login.json()).secret;
  assert(browserSession);
  const adoption = await fetch(`${serviceUrl}/v1/auth/workspace-adoptions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${consoleToken}`,
      'content-type': 'application/json',
      'x-acclimate-session': browserSession,
    },
    body: JSON.stringify({
      projectId: project,
      reason: 'Own the disposable qualification workspace.',
    }),
  });
  assert(adoption.ok, `Fixture browser workspace adoption returned ${adoption.status}`);
  const operator = client('operator');
  const bundle = await operator.createBundle(
    project,
    { name: 'Connected refund harness' },
    randomUUID(),
  );
  const baseline = await operator.createVersion(
    project,
    bundle.id,
    {
      parentVersionId: null,
      payload: {
        schemaVersion: 1,
        files: [
          {
            path: 'AGENTS.md',
            kind: 'instruction',
            text: 'Follow the specified refund response rules.\n',
          },
          { path: 'context.md', kind: 'memory', text: 'Preserve this unrelated context.\n' },
        ],
      },
    },
    randomUUID(),
  );
  await operator.promote(
    project,
    bundle.id,
    'stable',
    {
      versionId: baseline.id,
      expectedRevision: '0',
      unevaluatedReason: 'Initial fixture seed',
    },
    randomUUID(),
  );

  const makeConnection = async (displayName: string) =>
    (
      await api<{ id: string }>('POST', '/integrations', {
        displayName,
        bundleId: bundle.id,
        channel: 'stable',
      })
    ).id;
  const [automatic, manual, sibling] = await Promise.all([
    makeConnection('Automatic refund harness'),
    makeConnection('Review-required refund harness'),
    makeConnection('Unenrolled sibling harness'),
  ]);
  const autoApps = await enroll(automatic, 'auto-refund-fixture', true);
  const manualApps = await enroll(manual, 'manual-refund-fixture', false);
  const fresh = async (connection?: string) => {
    const result = await client('operator', connection).resolveChannel(
      project,
      bundle.id,
      'stable',
    );
    assert(result.resolution);
    return result.resolution.version;
  };
  const installedBundle = (connection: string) =>
    resolveAndCache(
      client('operator', connection),
      {
        projectId: project,
        bundleId: bundle.id,
        channel: 'stable',
      },
      { cacheDir: path.join(dir, 'delivery-cache') },
    );
  assert.equal((await fresh(automatic)).id, baseline.id);
  assert.equal((await fresh(manual)).id, baseline.id);

  async function submit(connection: string, version: VersionMetadata, instruction: string) {
    const body = {
      outcomeId: randomUUID(),
      versionId: version.id,
      digest: version.digest,
      status: 'completed' as const,
      lesson: { path: 'AGENTS.md', instruction },
    };
    await api('POST', `${learning(connection)}/outcomes`, body, 'evaluator', 403);
    const reporter = client('other', connection);
    const accepted = await reporter.reportLearningOutcome(project, connection, body, randomUUID());
    assert.deepEqual(accepted, { outcomeId: body.outcomeId, accepted: true, eligible: true });
    assert.deepEqual(
      await reporter.reportLearningOutcome(project, connection, body, randomUUID()),
      accepted,
    );
    return body.outcomeId;
  }
  async function observe(connection: string, outcomeId: string, state: string) {
    return waitFor(`${state} round for ${outcomeId}`, async () => {
      const view = await api<{ rounds: Round[] }>('GET', learning(connection));
      const round = view.rounds.find((item) => item.outcomeId === outcomeId);
      if (round?.state === state) return round;
      if (round && ['promoted', 'rejected'].includes(round.state))
        assert.fail(`Unexpected terminal round: ${JSON.stringify(round)}`);
      return undefined;
    });
  }

  const alpha = 'refund = Quote the refund window.';
  const beta = 'refund-status = Ask for the receipt number.';
  function gradedOutcome(task: Task, installed: VerifiedBundle) {
    const observed = runRefundTask(installed.payload, task);
    assert.notEqual(observed, expectedResponse[task.kind]);
    return {
      outcomeId: randomUUID(),
      status: 'failed' as const,
      feedback: {
        expected: `${task.kind} = ${expectedResponse[task.kind]}`,
        observed: `${task.kind} = ${observed}`,
      },
    };
  }
  const initialTaskBundle = await installedBundle(automatic);
  const terminalOutcome = gradedOutcome({ kind: 'refund' }, initialTaskBundle);
  const first = terminalOutcome.outcomeId;
  const reporter = createLearningOutcomeReporter({
    client: client('other', automatic),
    projectId: project,
    integrationId: automatic,
  });
  const siblingTaskBundle = await installedBundle(sibling);
  await assert.rejects(() => reporter(siblingTaskBundle, terminalOutcome), TypeError);
  const accepted = await reporter(initialTaskBundle, terminalOutcome);
  assert.deepEqual(accepted, { outcomeId: first, accepted: true, eligible: true });
  assert.deepEqual(await reporter(initialTaskBundle, terminalOutcome), accepted);
  const pending = await observe(automatic, first, 'development');
  assert(pending.developmentRequestId);
  await api('GET', `${learning(automatic)}/work`, undefined, 'other', 403);
  await api(
    'POST',
    `/bundles/${bundle.id}/evaluation-requests/${pending.developmentRequestId}/start`,
    { attemptId: randomUUID() },
    'other',
    403,
  );
  await stopService();
  await startService();
  enableDriver(automatic, 'auto-refund-fixture', autoApps);
  enableDriver(manual, 'manual-refund-fixture', manualApps);

  const promoted = await observe(automatic, first, 'promoted');
  assert.equal(promoted.id, pending.id);
  assert.equal(promoted.developmentRequestId, pending.developmentRequestId);
  assert(promoted.auditComparisonId && promoted.developmentComparisonId && promoted.promotionId);
  assert.notEqual(promoted.auditRequestId, promoted.developmentRequestId);
  const firstVersion = await fresh(automatic);
  assert.equal(firstVersion.id, promoted.candidateVersionId);
  const pinned = await client('operator', automatic).getPayload(project, bundle.id, baseline.id);
  assert.equal(
    JSON.parse(Buffer.from(pinned).toString()).files[0].text,
    'Follow the specified refund response rules.\n',
  );
  assert.equal((await fresh(sibling)).id, baseline.id);
  assert.equal((await fresh()).id, baseline.id);
  await assert.rejects(
    () => client('operator', sibling).getPayload(project, bundle.id, firstVersion.id),
    { status: 403 },
  );
  const stale = await submit(automatic, baseline, beta);
  const staleRound = await observe(automatic, stale, 'rejected');
  assert.equal(staleRound.candidateVersionId, null);
  assert.equal(staleRound.developmentRequestId, null);
  assert.equal((await fresh(automatic)).id, firstVersion.id);

  const negative = await submit(automatic, firstVersion, `${beta}\nrefund-escalation = Give up.`);
  const rejected = await observe(automatic, negative, 'rejected');
  assert(rejected.developmentComparisonId && rejected.auditComparisonId);
  assert.equal(rejected.promotionId, null);
  assert.equal((await fresh(automatic)).id, firstVersion.id);

  const nextTaskBundle = await installedBundle(automatic);
  assert.equal(nextTaskBundle.version.id, firstVersion.id);
  const nextOutcome = gradedOutcome({ kind: 'refund-status' }, nextTaskBundle);
  const positive = (await reporter(nextTaskBundle, nextOutcome)).outcomeId;
  const second = await observe(automatic, positive, 'promoted');
  assert.equal(second.parentVersionId, firstVersion.id);
  assert(second.auditComparisonId && second.developmentComparisonId && second.promotionId);
  assert.notEqual(second.auditRequestId, rejected.auditRequestId);
  assert.equal((await fresh(automatic)).id, second.candidateVersionId);
  assert.equal((await fresh(sibling)).id, baseline.id);
  assert.equal((await fresh()).id, baseline.id);

  const manualOutcome = await submit(manual, baseline, alpha);
  const review = await observe(manual, manualOutcome, 'awaiting_review');
  assert(review.auditComparisonId && review.developmentComparisonId);
  assert.equal(review.promotionId, null);
  assert.equal((await fresh(manual)).id, baseline.id);
  const reviewPath = `${learning(manual)}/rounds/${review.id}/review`;
  await api('POST', reviewPath, { approve: true }, 'evaluator', 403);
  await api('POST', reviewPath, { approve: true });
  const reviewed = await observe(manual, manualOutcome, 'promoted');
  assert.equal((await fresh(manual)).id, reviewed.candidateVersionId);
  assert.equal((await fresh(automatic)).id, second.candidateVersionId);
  assert.equal((await fresh(sibling)).id, baseline.id);

  async function scores(id: string | null, request: string | null) {
    assert(id && request);
    const comparison = await operator.getComparison(project, bundle.id, id);
    assert.equal(comparison.complete, true);
    assert.equal(comparison.evaluation?.requestId, request);
    assert.equal(comparison.submitter, 'evaluator');
    return comparison.results.map(({ parent, candidate }) => {
      assert.equal(parent.executionStatus, 'completed');
      assert.equal(candidate.executionStatus, 'completed');
      return candidate.reward! - parent.reward!;
    });
  }
  assert.deepEqual(
    await scores(rejected.developmentComparisonId, rejected.developmentRequestId),
    [0, 1],
  );
  assert.deepEqual(await scores(rejected.auditComparisonId, rejected.auditRequestId), [0, 1, -1]);
  assert.deepEqual(await scores(second.auditComparisonId, second.auditRequestId), [0, 1, 0]);

  await api('POST', `${learning(automatic)}/stop`);
  const stoppedWork = await api('GET', `${learning(automatic)}/work`, undefined, 'evaluator');
  assert.equal(stoppedWork.active, false);
  assert.deepEqual(stoppedWork.items, []);
  assert.equal((await fresh(automatic)).id, second.candidateVersionId);
  const last = await fresh(automatic);
  const newOutcome: LearningOutcomeRequest = {
    outcomeId: randomUUID(),
    versionId: last.id,
    digest: last.digest,
    status: 'failed',
    lesson: { path: 'AGENTS.md', instruction: 'New stopped work.' },
  };
  await api('POST', `${learning(automatic)}/outcomes`, newOutcome, 'other', 409);

  const reviewedVersion = await fresh(manual);
  const exhaustedOutcome = await submit(manual, reviewedVersion, beta);
  const exhausted = await api('GET', learning(manual));
  assert.equal(exhausted.proposalAdmissions, exhausted.maxProposalAdmissions);
  assert.equal(exhausted.remainingAudits, 0);
  assert(!exhausted.rounds.some((round: Round) => round.outcomeId === exhaustedOutcome));
  const renewPath = `${learning(manual)}/renew`;
  const oldAudit = descriptor(manualApps.audits[0]!);
  const renewal = {
    renewalId: randomUUID(),
    expectedRevision: 0,
    proposalAdmissions: 1,
    audits: [descriptor(manualApps.audits[1]!)],
  };
  await api('POST', renewPath, renewal, 'evaluator', 403);
  await api(
    'POST',
    renewPath,
    {
      ...renewal,
      audits: [
        {
          ...oldAudit,
          datasetRevision: 'audit-label-alias',
          expectedCases: oldAudit.expectedCases.map(({ caseId, repetition }) => ({
            caseId: `alias-${caseId}`,
            repetition,
          })),
        },
      ],
    },
    'admin',
    409,
  );
  const renewed = await api('POST', renewPath, renewal);
  assert.equal(renewed.appliedRenewalRevision, 1);
  assert.equal(renewed.maxProposalAdmissions, 2);
  assert.deepEqual(await api('POST', renewPath, renewal), renewed);
  await api('POST', renewPath, { ...renewal, renewalId: randomUUID() }, 'admin', 409);
  const pendingRevocation = exhaustedOutcome;
  const beforeRevoke = await observe(manual, pendingRevocation, 'awaiting_review');
  assert.equal(beforeRevoke.promotionId, null);
  await api('POST', `/integrations/${manual}/revoke`, {});
  await api(
    'POST',
    `${learning(manual)}/rounds/${beforeRevoke.id}/review`,
    { approve: true },
    'admin',
    409,
  );
  const afterRevoke = await observe(manual, pendingRevocation, 'rejected');
  assert.equal(afterRevoke.promotionId, null);
  await api(
    'POST',
    `${learning(manual)}/outcomes`,
    {
      ...newOutcome,
      versionId: reviewedVersion.id,
      digest: reviewedVersion.digest,
    },
    'other',
    409,
  );
  await assert.rejects(() => fresh(manual), { status: 403 });
  assert.equal((await fresh(sibling)).id, baseline.id);

  const autoExecutions = executions.filter(({ dataset }) =>
    dataset.startsWith('auto-refund-fixture-'),
  );
  const auditDatasets = new Set(
    autoExecutions
      .filter(({ dataset }) => dataset.includes('-audit-'))
      .map(({ dataset }) => dataset),
  );
  assert.equal(auditDatasets.size, 3);
  for (const dataset of auditDatasets) {
    const cases = autoExecutions.filter((execution) => execution.dataset === dataset);
    assert.equal(cases.length, 6);
    assert.equal(new Set(cases.map(({ caseId }) => caseId)).size, 3);
    assert.equal(new Set(cases.map(({ version }) => version)).size, 2);
  }
  assert.equal(modelRequests.length, 5, 'each admission calls the local proposer once');
  const rollbackConnection = await makeConnection('Refund harness with rollback audits');
  const rollbackInstallation = 'rollback-refund-fixture';
  const rollbackEvaluation = rollbackApps(rollbackInstallation);
  const rollbackEnrollment = {
    installationId: rollbackInstallation,
    automaticRollout: true,
    automaticRollback: false,
    permittedPaths: ['AGENTS.md'],
    maxProposalAdmissions: 3,
    development: descriptor(rollbackEvaluation.development),
    audits: rollbackEvaluation.audits.map(descriptor),
    evaluatorPrincipal: 'evaluator',
    outcomePrincipal: 'other',
  };
  await api('PUT', learning(rollbackConnection), rollbackEnrollment);
  const pauseRollbackDriver = enableDriver(
    rollbackConnection,
    rollbackInstallation,
    rollbackEvaluation,
  );
  const credentialPath = `/integrations/${rollbackConnection}/credentials`;
  const receiptCredential = await api<{ secret: string }>('POST', credentialPath, {
    kind: 'receipt-write',
  });
  const deliveryCredential = await api<{ secret: string }>('POST', credentialPath, {
    kind: 'content-read',
  });
  const scopedClient = (token: string, scope: string) =>
    new AcclimateClient({
      baseUrl: serviceUrl,
      token,
      scope: `${project}:${rollbackConnection}:${scope}`,
      integrationId: rollbackConnection,
      retries: 0,
    });
  const receiptReporter = createReceiptReporter({
    client: scopedClient(receiptCredential.secret, 'receipt'),
    projectId: project,
    integrationId: rollbackConnection,
  });
  const servedClient = scopedClient(deliveryCredential.secret, 'delivery');
  const reportServedOutcome = createLearningOutcomeReporter({
    client: client('other', rollbackConnection),
    projectId: project,
    integrationId: rollbackConnection,
  });
  const auditClient = client('evaluator', rollbackConnection);
  const auditPath = `${learning(rollbackConnection)}/field-audits`;
  const prepareServedAudit = createLearningFieldAuditor<{ task: Task; output: string }>({
    client: auditClient,
    projectId: project,
    integrationId: rollbackConnection,
    cacheDir: path.join(dir, 'field-audit-cache'),
    samplePercent: 100,
    async evaluate({ job, predecessor }) {
      const expected = expectedResponse[job.task.kind];
      return {
        served: job.output === expected ? 'correct' : 'incorrect',
        predecessor:
          runRefundTask(predecessor.payload, job.task) === expected ? 'correct' : 'incorrect',
      };
    },
  });
  async function runServedTask(task: Task, externalFailure = false) {
    const installed = await resolveAndCache(
      servedClient,
      {
        projectId: project,
        bundleId: bundle.id,
        channel: 'stable',
      },
      { cacheDir: path.join(dir, 'rollback-delivery-cache'), reporter: receiptReporter },
    );
    const started = receiptReporter.reportStartedReceipt(installed);
    assert(started && started.revision);
    await receiptReporter.flush();
    assert.equal(receiptReporter.pendingCount, 0);
    const output = runRefundTask(installed.payload, task);
    const outcomeId = randomUUID();
    const receipt = await reportServedOutcome(installed, {
      outcomeId,
      status: externalFailure || output !== expectedResponse[task.kind] ? 'failed' : 'completed',
      startedReceipt: started,
    });
    assert.equal(receipt.eligible, false);
    assert(receipt.fieldAudit);
    const prepared = await prepareServedAudit(installed, {
      job: { task, output },
      outcome: receipt,
      startedReceipt: started,
    });
    assert(prepared);
    return prepared;
  }
  const auditServedTask = (body: Awaited<ReturnType<typeof runServedTask>>) =>
    auditClient.reportLearningFieldAudit(project, rollbackConnection, body);

  const healthyOutcome = await submit(rollbackConnection, baseline, alpha);
  const healthyRound = await observe(rollbackConnection, healthyOutcome, 'promoted');
  const healthy = await installedBundle(rollbackConnection);
  assert.equal(healthy.version.id, healthyRound.candidateVersionId);
  const unrelated = await runServedTask({ kind: 'refund-escalation' }, true);
  assert.equal(unrelated.verdict, 'pass');
  await api('POST', auditPath, unrelated, 'other', 403);
  const inconclusive = await auditServedTask(unrelated);
  assert.equal(inconclusive.regressions, 0);
  assert.equal(inconclusive.windowSize, 1);
  assert(!inconclusive.rollbackPromotionId);
  assert.equal((await fresh(rollbackConnection)).id, healthy.version.id);
  const late = await runServedTask({ kind: 'refund-escalation' });

  const badOutcome = await submit(
    rollbackConnection,
    healthy.version,
    `${beta}\nrefund-escalation = Give up.`,
  );
  const badRound = await observe(rollbackConnection, badOutcome, 'promoted');
  const bad = await installedBundle(rollbackConnection);
  assert.equal(bad.version.id, badRound.candidateVersionId);
  assert.equal(
    runRefundTask(healthy.payload, { kind: 'refund-escalation' }),
    'Send the case to support.',
  );
  assert.equal(runRefundTask(bad.payload, { kind: 'refund-escalation' }), 'Give up.');
  await api('POST', auditPath, late, 'evaluator', 409);
  const firstRegression = await runServedTask({ kind: 'refund-escalation' });
  assert.equal(firstRegression.verdict, 'regression');
  await api('POST', auditPath, { ...firstRegression, outcomeId: randomUUID() }, 'evaluator', 409);
  await api(
    'POST',
    auditPath,
    { ...firstRegression, parentVersionId: baseline.id, parentDigest: baseline.digest },
    'evaluator',
    409,
  );
  const firstFieldAudit = await auditServedTask(firstRegression);
  assert.equal(firstFieldAudit.regressions, 1);
  assert.equal(firstFieldAudit.windowSize, 1);
  assert(!firstFieldAudit.rollbackPromotionId);
  assert.deepEqual(await auditServedTask(firstRegression), firstFieldAudit);
  const sideTask = await runServedTask({ kind: 'refund-status' });
  assert.equal(sideTask.verdict, 'pass');
  await api(
    'POST',
    auditPath,
    { ...sideTask, startedReceiptId: firstRegression.startedReceiptId },
    'evaluator',
    409,
  );
  const sideAudit = await auditServedTask(sideTask);
  assert.equal(sideAudit.regressions, 1);
  assert.equal(sideAudit.windowSize, 2);
  const secondRegression = await runServedTask({ kind: 'refund-escalation' });
  assert.equal((await auditServedTask(secondRegression)).regressions, 2);
  assert.equal((await fresh(rollbackConnection)).id, bad.version.id);
  const thirdRegression = await runServedTask({ kind: 'refund-escalation' });
  const disabled = await auditServedTask(thirdRegression);
  assert.equal(disabled.regressions, 3);
  assert.equal(disabled.windowSize, 4);
  assert(!disabled.rollbackPromotionId);
  assert.equal((await fresh(rollbackConnection)).id, bad.version.id);
  await pauseRollbackDriver();
  const staleTeaching = await submit(
    rollbackConnection,
    bad.version,
    'refund-escalation = Send the case to support.',
  );
  const staleEvaluation = await observe(rollbackConnection, staleTeaching, 'development');
  assert(staleEvaluation.developmentRequestId);
  await api('PUT', learning(rollbackConnection), {
    ...rollbackEnrollment,
    automaticRollback: true,
  });
  assert.equal(
    (await fresh(rollbackConnection)).id,
    bad.version.id,
    'policy change waits for a fresh verdict',
  );
  const fourthRegression = await runServedTask({ kind: 'refund-escalation' });
  const tooLate = await runServedTask({ kind: 'refund-escalation' });
  const proposalCountBeforeRollback = modelRequests.length;
  const rollback = await auditServedTask(fourthRegression);
  assert.equal(rollback.regressions, 4);
  assert.equal(rollback.windowSize, 5);
  assert(rollback.rollbackPromotionId);
  assert.deepEqual(await auditServedTask(fourthRegression), rollback);
  assert.deepEqual(await auditServedTask(thirdRegression), disabled);
  const staleRejected = await observe(rollbackConnection, staleTeaching, 'rejected');
  assert.match(staleRejected.reason ?? '', /withdrawn by automatic rollback/);
  const staleEvaluationId = staleEvaluation.developmentRequestId;
  const interrupted = await auditClient.getEvaluation(project, bundle.id, staleEvaluationId);
  assert.equal(interrupted.status, 'interrupted');
  await api(
    'POST',
    `/bundles/${bundle.id}/evaluation-requests/${staleEvaluationId}/start`,
    { attemptId: randomUUID() },
    'evaluator',
    409,
  );
  const rolledBack = await installedBundle(rollbackConnection);
  assert.equal(rolledBack.version.id, healthy.version.id);
  assert.equal(BigInt(rolledBack.resolution!.revision), BigInt(bad.resolution!.revision) + 1n);
  assert.equal((await fresh(automatic)).id, second.candidateVersionId);
  assert.equal((await fresh(sibling)).id, baseline.id);
  assert.equal((await fresh()).id, baseline.id);
  assert.equal(
    runRefundTask(bad.payload, { kind: 'refund-escalation' }),
    'Give up.',
    'running pin stays immutable',
  );
  const explicitOldPin = await resolveAndCache(
    servedClient,
    {
      projectId: project,
      bundleId: bundle.id,
      versionId: bad.version.id,
    },
    { cacheDir: path.join(dir, 'rollback-delivery-cache') },
  );
  assert.equal(explicitOldPin.version.id, bad.version.id);
  await api('POST', auditPath, tooLate, 'evaluator', 409);
  await api('POST', auditPath, late, 'evaluator', 409);
  const afterFieldAudit = await api('GET', learning(rollbackConnection));
  const rolledBackRound = afterFieldAudit.rounds.find((round: Round) => round.id === badRound.id);
  assert(rolledBackRound);
  assert.equal(rolledBackRound.state, 'promoted');
  assert.equal(rolledBackRound.fieldAudits.rollbackPromotionId, rollback.rollbackPromotionId);
  assert.equal((await fresh(rollbackConnection)).id, healthy.version.id);
  assert.equal(proposalCountBeforeRollback, 8, 'each teaching admission calls the proposer once');
  assert.equal(
    modelRequests.length,
    proposalCountBeforeRollback,
    'field audit never invokes the proposer',
  );
  evidence.project = project;
  evidence.rounds = [promoted, staleRound, rejected, second, reviewed, afterRevoke];
  evidence.datasetRuns = Object.fromEntries(
    [...new Set(executions.map(({ dataset }) => dataset))].map((dataset) => [
      dataset,
      executions.filter((execution) => execution.dataset === dataset).length,
    ]),
  );
  evidence.delivery = {
    pinned: baseline.id,
    sibling: baseline.id,
    source: baseline.id,
    automatic: second.candidateVersionId,
    manual: reviewed.candidateVersionId,
  };
  evidence.restartPreservedDevelopmentRequest = pending.developmentRequestId;
  evidence.stopAndRevokeVerified = true;
  evidence.renewal = {
    revision: renewed.appliedRenewalRevision,
    aliasRejected: true,
    staleRevisionRejected: true,
    queuedOutcomeResumed: exhaustedOutcome,
  };
  evidence.fieldRollback = {
    healthyRelease: healthyRound,
    rolledBackRelease: rolledBackRound,
    passAfterUnrelatedTaskFailure: inconclusive,
    policyDisabledAtThreshold: disabled,
    staleEvaluationInterrupted: interrupted.id,
    rollback,
    staleAuditsRejected: true,
    priorRevision: bad.resolution?.revision,
    rollbackRevision: rolledBack.resolution?.revision,
    pinnedVersion: explicitOldPin.version.id,
  };
  evidence.localModelRequests = modelRequests.length;
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  controller.abort();
  await Promise.allSettled(drivers);
  await stopService();
  if (model) {
    model.closeAllConnections();
    model.close();
    await once(model, 'close');
  }
  await rm(dir, { recursive: true, force: true });
}
