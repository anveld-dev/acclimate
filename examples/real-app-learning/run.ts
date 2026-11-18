import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Codex } from '@openai/codex-sdk';
import { AcclimateClient, resolveAndCache } from '../../packages/sdk/src/index.js';
import { defineEvaluation } from '../../packages/sdk/src/evaluation/index.js';
import {
  connectedEvaluationDescriptor,
  createLearningOutcomeReporter,
  serveConnectedLearning,
} from '../../packages/sdk/src/learning/index.js';
import type { LearningEnrollmentStatus, VerifiedBundle } from '../../packages/sdk/src/types.js';

const home = path.resolve('examples/real-app-learning');
const scratch = await realpath('.real-app-scratch');
const python = path.join(scratch, 'venv/bin/python');
const grader = path.join(home, 'grade.py');
const modelId = 'gpt-6-luna';
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
let child: ChildProcess | undefined;
let logs = '';
let browserSession: string | undefined;

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

async function waitFor<T>(label: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5 * 3600_000;
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

type Case = { caseId: string; input: string; expected: string };
const fixtures = JSON.parse(
  execFileSync(python, [grader, '--cases'], { encoding: 'utf8' }),
) as Record<'development' | 'audit' | 'field', Case[]>;
const codex = new Codex();
const priorAttempts = Number(process.env.LLM_PRIOR_ATTEMPTS ?? '1');
const remainingMs = Number(process.env.LLM_REMAINING_MS ?? 6 * 3600_000 - 120_000);
assert(Number.isInteger(priorAttempts) && priorAttempts >= 1 && priorAttempts < 600);
assert(remainingMs > 0 && remainingMs <= 6 * 3600_000);
const limit = AbortSignal.timeout(remainingMs);
const signal = AbortSignal.any([controller.signal, limit]);
const usage: { label: string; input: number | null; output: number | null }[] = [];
async function turn(
  cwd: string,
  prompt: string,
  label: string,
  outputSchema?: unknown,
  caseSignal?: AbortSignal,
) {
  assert(priorAttempts + usage.length < 600 && !signal.aborted, 'Experiment budget exhausted');
  const row = { label, input: null as number | null, output: null as number | null };
  usage.push(row);
  console.log(JSON.stringify({ attempt: priorAttempts + usage.length, label }));
  const result = await codex
    .startThread({
      model: modelId,
      modelReasoningEffort: 'low',
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      approvalPolicy: 'never',
    })
    .run(prompt, {
      outputSchema,
      signal: AbortSignal.any(
        caseSignal
          ? [signal, caseSignal, AbortSignal.timeout(80_000)]
          : [signal, AbortSignal.timeout(45_000)],
      ),
    });
  row.input = result.usage?.input_tokens ?? null;
  row.output = result.usage?.output_tokens ?? null;
  console.log(JSON.stringify({ usage: row }));
  return result.finalResponse;
}

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['argv'],
  properties: { argv: { type: 'array', items: { type: 'string' } } },
};
async function answer(
  bundle: VerifiedBundle,
  input: string,
  label: string,
  caseSignal?: AbortSignal,
) {
  const guidance = bundle.payload.files
    .map(({ path: name, text }) => name + '\n' + text)
    .join('\n');
  const result = await turn(
    path.join(scratch, 'llm'),
    guidance +
      '\nUse upstream source and docs as reference. Return JSON with argv beginning with llm. Do not run the suggested command. Request: ' +
      input,
    label,
    schema,
    caseSignal,
  );
  return JSON.parse(result).argv as string[];
}
function score(output: string[], expected: string) {
  return Number(
    execFileSync(
      '/usr/bin/sandbox-exec',
      ['-p', '(version 1) (allow default) (deny network*)', python, grader],
      {
        timeout: 20_000,
        input: JSON.stringify({ output, expected }),
        encoding: 'utf8',
      },
    ),
  );
}
function cohort(split: 'development' | 'audit') {
  return defineEvaluation<string, string, string[]>({
    configId: 'llm-cli-support',
    configRevision: '1',
    datasetRevision: split + '-1',
    graderRevision: 'click-argv-v2',
    runtime: { app: 'llm-0.38', model: modelId, effort: 'low' },
    execution: 'live',
    cases: fixtures[split],
    async execute({ bundle, input, caseId, signal: caseSignal }) {
      return { output: await answer(bundle, input, split + ':' + caseId, caseSignal) };
    },
    async grade({ output, expected }) {
      return { reward: score(output, expected) };
    },
  });
}

const authorDir = path.join(dir, 'author');
await mkdir(authorDir);
const adapter = createServer((req, res) => {
  void (async () => {
    if (
      req.url !== '/v1/chat/completions' ||
      req.headers.authorization !== 'Bearer ' + modelToken
    ) {
      res.writeHead(401).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      assert(raw.length < 2_000_000);
    }
    const body = JSON.parse(raw);
    assert.equal(body.model, modelId);
    const messages = body.messages as { role: string; content: string }[];
    const label = messages[0]?.content.startsWith('Screen the proposed') ? 'critic' : 'proposer';
    const content = await turn(
      authorDir,
      messages.map((message) => message.content).join('\n'),
      label,
    );
    JSON.parse(content);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
  })().catch((error: unknown) => {
    console.error('Adapter:', String(error));
    res.writeHead(502).end();
  });
});

let driver: Promise<void> | undefined;
try {
  const modelPort = await listen(adapter);
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
  async function startService(checkSteps = 1) {
    child = spawn(path.join(scratch, 'target/debug/acclimate-service'), [], {
      env: {
        ...environment,
        ACCLIMATE_MODEL_ENDPOINT: `http://127.0.0.1:${modelPort}/v1/chat/completions`,
        ACCLIMATE_MODEL_TOKEN: modelToken,
        ACCLIMATE_LEARNING_MAX_STEPS_BETWEEN_AUDITS: String(checkSteps),
        ACCLIMATE_MODEL: modelId,
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

  async function api<T = unknown>(
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
  const bundle = await operator.createBundle(project, { name: 'LLM CLI support' }, randomUUID());
  const baseline = await operator.createVersion(
    project,
    bundle.id,
    {
      parentVersionId: null,
      payload: JSON.parse(await readFile(path.join(home, 'baseline.json'), 'utf8')),
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
      unevaluatedReason: 'Preregistered baseline',
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

  const connection = await makeConnection('LLM CLI support experiment');
  const installationId = 'llm-cli-support';
  const development = cohort('development');
  const audit = cohort('audit');
  await api('PUT', learning(connection), {
    installationId,
    automaticRollout: false,
    permittedPaths: ['AGENTS.md', 'context.md'],
    maxProposalAdmissions: 3,
    development: connectedEvaluationDescriptor(development),
    audits: [connectedEvaluationDescriptor(audit)],
    evaluatorPrincipal: 'evaluator',
    outcomePrincipal: 'other',
  });
  driver = serveConnectedLearning({
    integrationId: connection,
    installationId,
    configPath,
    apps: { development, audit: [audit] },
    pollIntervalMs: 1000,
    signal,
    allowLive: true,
    onDiagnostic: (diagnostic) => console.error('Evaluator:', JSON.stringify(diagnostic)),
  });
  void driver.catch((error: unknown) => {
    console.error('Driver:', String(error));
    controller.abort();
  });
  const view = () => api<LearningEnrollmentStatus>('GET', learning(connection));
  const calibration = await waitFor('noise calibration', async () => {
    signal.throwIfAborted();
    const status = (await view()).noiseCalibration;
    return status && ['failed', 'completed', 'interrupted'].includes(status.status)
      ? status
      : undefined;
  });
  console.log(JSON.stringify({ calibration, baseline }));
  if (calibration.requestId) {
    const request = await operator.getEvaluation(project, bundle.id, calibration.requestId);
    if (request.comparisonId)
      console.log(
        JSON.stringify({
          calibrationComparison: await operator.getComparison(
            project,
            bundle.id,
            request.comparisonId,
          ),
        }),
      );
  }
  assert.equal(calibration.status, 'completed');
  const reporter = createLearningOutcomeReporter({
    client: client('other', connection),
    projectId: project,
    integrationId: connection,
  });
  const installed = await resolveAndCache(
    client('operator', connection),
    {
      projectId: project,
      bundleId: bundle.id,
      channel: 'stable',
    },
    { cacheDir: path.join(dir, 'delivery-cache') },
  );
  const outcome = [];
  for (const task of fixtures.field) {
    const argv = await answer(installed, task.input, 'field:' + task.caseId);
    const reward = score(argv, task.expected);
    const outcomeId = randomUUID();
    await reporter(installed, { outcomeId, status: reward ? 'completed' : 'failed' });
    if (!reward) outcome.push({ task, argv, outcomeId });
    console.log(JSON.stringify({ field: task.caseId, reward }));
  }
  for (const { task, argv, outcomeId } of outcome.slice(0, 3)) {
    const correction = await client('other', connection).reportLearningCorrection(
      project,
      connection,
      {
        correctionId: randomUUID(),
        outcomeId,
        feedback: {
          expected: task.input + ' Reference: ' + task.expected,
          observed: JSON.stringify(argv),
        },
      },
    );
    const round = await waitFor('round for ' + correction.correctionId, async () => {
      signal.throwIfAborted();
      return (await view()).rounds.find(
        (item) =>
          item.outcomeId === outcomeId &&
          ['developed', 'awaiting_review', 'rejected', 'promoted'].includes(item.state),
      );
    });
    console.log(JSON.stringify({ round }));
    for (const id of [
      round.developmentComparisonId,
      round.cumulativeDevelopmentComparisonId,
      round.auditComparisonId,
    ]) {
      if (id)
        console.log(
          JSON.stringify({ comparison: await operator.getComparison(project, bundle.id, id) }),
        );
    }
    if (round.proposalId)
      console.log(
        JSON.stringify({
          proposal: await operator.getProposal(project, bundle.id, round.proposalId),
        }),
      );
    if (round.state === 'awaiting_review') {
      const decisionPath = path.join(scratch, 'operator-decision.json');
      console.log(JSON.stringify({ reviewDecisionFile: decisionPath, roundId: round.id }));
      const decision = await waitFor('operator review', async () => {
        signal.throwIfAborted();
        const data = await readFile(decisionPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (!data) return undefined;
        const value = JSON.parse(data);
        assert.equal(value.roundId, round.id);
        assert.equal(typeof value.approve, 'boolean');
        return value as { roundId: string; approve: boolean };
      });
      await api('POST', learning(connection) + '/rounds/' + round.id + '/review', {
        approve: decision.approve,
      });
      console.log(JSON.stringify({ operatorDecision: decision }));
      break;
    }
    if (!(await view()).remainingAudits) break;
  }
  console.log(JSON.stringify({ final: await view() }));
} finally {
  console.log(
    JSON.stringify({
      attempts: priorAttempts + usage.length,
      input: usage.reduce((n, r) => n + (r.input ?? 0), 0),
      output: usage.reduce((n, r) => n + (r.output ?? 0), 0),
    }),
  );
  controller.abort();
  await driver?.catch(() => {});
  adapter.closeAllConnections();
  adapter.close();
  await stopService();
  if (logs) console.error(logs);
  await rm(dir, { recursive: true, force: true });
}
