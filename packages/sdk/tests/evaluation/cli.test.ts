import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineEvaluation } from '../../src/evaluation/index.js';
import { evaluationMain } from '../../src/evaluation/cli.js';
import { applicationMain } from '../../src/evaluation/app-cli.js';
import { parseCommandJson } from '../../src/evaluation/cli-intents.js';
import { openJournal } from '../../src/evaluation/journal.js';

const bundleId = '11111111-1111-4111-8111-111111111111';
const parentId = '22222222-2222-4222-8222-222222222222';
const candidateId = '33333333-3333-4333-8333-333333333333';
const draftId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const comparisonId = '66666666-6666-4666-8666-666666666666';
const now = '2026-11-16T12:00:00Z';

async function invoke(
  app: ReturnType<typeof defineEvaluation> | undefined,
  args: string[],
  options?: Parameters<typeof evaluationMain>[2],
  tty = false,
) {
  let out = '',
    err = '';
  const stdout = process.stdout.write,
    stderr = process.stderr.write;
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const errTtyDescriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: tty });
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: tty });
  process.stdout.write = ((value: unknown) => {
    out += String(value);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((value: unknown) => {
    err += String(value);
    return true;
  }) as typeof process.stderr.write;
  try {
    const status = app
      ? await evaluationMain(app, args, options)
      : await applicationMain(args, path.join(tmpdir(), 'acclimate-reader-without-agent'));
    return {
      status,
      out,
      err,
      result: out && out.startsWith('{') ? JSON.parse(out) : undefined,
      error: err && err.startsWith('{') ? JSON.parse(err) : undefined,
    };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    if (errTtyDescriptor) Object.defineProperty(process.stderr, 'isTTY', errTtyDescriptor);
    else Reflect.deleteProperty(process.stderr, 'isTTY');
  }
}

async function fixture(execution: 'live' | 'model-free' = 'model-free') {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-cli-'));
  const original = {
    schemaVersion: 1,
    files: [{ path: 'instruction.md', kind: 'instruction', text: 'bad' }],
  };
  const payload = {
    schemaVersion: 1,
    files: [{ path: 'instruction.md', kind: 'instruction', text: 'good' }],
  };
  const payloadBytes = (value: unknown) => JSON.stringify(value) + '\n';
  const version = (id: string, value: unknown, parentVersionId: string | null) => ({
    id,
    bundleId,
    parentVersionId,
    digest: 'sha256:' + createHash('sha256').update(payloadBytes(value)).digest('hex'),
    createdAt: now,
  });
  const parent = version(parentId, original, null),
    candidate = version(candidateId, payload, parentId);
  const state: {
    request: any;
    progress?: unknown;
    comparison: any;
    revision: string;
    drafts: number;
    requests: number;
    comparisons: number;
    executions: number;
    loseRequests: number;
    loseDrafts: number;
    loseComparisons: number;
    comparisonSubmissions: Array<{ key: string; body: string }>;
    failGrade: boolean;
    flip: boolean;
    writeEvaluation: boolean;
    runLabels: boolean;
    policyPins: boolean;
    requestBodies: any[];
    receipts: Map<string, any>;
  } = {
    request: null,
    comparison: null,
    revision: '1',
    drafts: 0,
    requests: 0,
    comparisons: 0,
    executions: 0,
    loseRequests: 0,
    loseDrafts: 0,
    loseComparisons: 0,
    comparisonSubmissions: [],
    failGrade: false,
    flip: false,
    writeEvaluation: true,
    runLabels: false,
    policyPins: false,
    requestBodies: [],
    receipts: new Map(),
  };
  const policyReceipts = new Map<string, object>();
  const traffic: Array<[string | undefined, string | undefined]> = [];
  const server = createServer(async (req, res) => {
    traffic.push([req.method, req.url]);
    try {
      const url = new URL(req.url!, 'http://fixture'),
        route = url.pathname;
      const reply = (value: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (route.endsWith('/evaluation-capabilities'))
        return reply({
          schemaVersion: 1,
          workspaceId: 'project',
          principalId: 'evaluator',
          checkedAt: now,
          readUnpublished: true,
          writeEvaluation: state.writeEvaluation,
          retainedEvaluationOperations: true,
          ...(state.runLabels && { runLabels: true }),
          ...(state.policyPins && { policyPins: true }),
        });
      if (route.includes('/operations/')) {
        const key = route.split('/').at(-1)!;
        return reply(state.receipts.get(key) ?? { status: 'not_observed', operationId: key });
      }
      if (req.method === 'GET') {
        if (route.endsWith('/policy-receipts'))
          return reply({ items: [...policyReceipts.values()] });
        if (route === '/v1/workspaces/project/bundles')
          return reply({ items: [{ id: bundleId }], nextCursor: null });
        if (route.endsWith('/channels/stable'))
          return reply({ channel: 'stable', revision: state.revision, version: parent });
        if (
          route.endsWith(`/versions/${parentId}/payload`) ||
          route.endsWith(`/versions/${candidateId}/payload`)
        ) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(payloadBytes(route.includes(parentId) ? original : payload));
        }
        if (route.endsWith(`/versions/${parentId}`)) return reply(parent);
        if (route.endsWith(`/versions/${candidateId}`)) return reply(candidate);
        if (route.endsWith(`/evaluation-requests/${requestId}`) && state.request)
          return reply(state.request);
        if (route.endsWith(`/evaluation-requests/${requestId}/progress`) && state.progress)
          return reply(state.progress);
        if (route.endsWith(`/comparisons/${comparisonId}`) && state.comparison)
          return reply(state.comparison);
        return reply(
          { error: { code: 'not_found', message: 'fixture missing', requestId: 'fixture' } },
          404,
        );
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString(),
        body = JSON.parse(raw),
        key = String(req.headers['idempotency-key']);
      if (route.endsWith('/policy-receipts')) {
        const receipt = { ...body, comparisonId, reportedBy: 'evaluator', receivedAt: now };
        policyReceipts.set(body.policy.sha256, receipt);
        return reply(receipt);
      }
      assert.equal(req.headers['x-acclimate-durable-operation'], 'true');
      const fingerprint =
        'sha256:' +
        createHash('sha256')
          .update('POST\0' + route.replace(/^\/v1\/workspaces\//, '/v1/projects/') + '\0' + raw)
          .digest('hex');
      if (route.endsWith('/comparisons')) state.comparisonSubmissions.push({ key, body: raw });
      let result = state.receipts.get(key)?.result;
      if (result) {
        assert.equal(state.receipts.get(key).requestFingerprint, fingerprint);
      } else if (route.endsWith('/drafts')) {
        state.drafts++;
        result = {
          id: draftId,
          channel: 'stable',
          baseVersionId: parentId,
          baseRevision: '1',
          snapshotVersion: candidate,
          generation: 1,
          status: 'open',
          createdAt: now,
          updatedAt: now,
          promotionId: null,
        };
      } else if (route.endsWith('/evaluation-requests')) {
        state.requests++;
        state.requestBodies.push(body);
        state.request = {
          ...body,
          id: requestId,
          status: 'requested',
          attemptId: null,
          evaluatorPrincipal: null,
          comparisonId: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        };
        result = state.request;
      } else if (route.endsWith('/start')) {
        state.request = {
          ...state.request,
          status: 'running',
          attemptId: body.attemptId,
          evaluatorPrincipal: 'evaluator',
        };
        result = state.request;
      } else if (route.endsWith('/comparisons')) {
        state.comparisons++;
        const complete = body.results.every((pair: any) =>
          [pair.parent, pair.candidate].every(
            (o) => o.executionStatus !== 'infrastructure_failed' && o.gradingStatus === 'scored',
          ),
        );
        state.comparison = {
          ...body,
          id: comparisonId,
          complete,
          submitter: 'evaluator',
          createdAt: now,
        };
        result = state.comparison;
      } else if (route.endsWith('/finish')) {
        state.request = {
          ...state.request,
          status: state.comparison.complete ? 'completed' : 'failed',
          comparisonId: body.comparisonId,
        };
        result = state.request;
      } else if (route.endsWith('/interrupt')) {
        state.request = { ...state.request, status: 'interrupted', error: body.reason };
        result = state.request;
      } else throw new Error('Unexpected fixture mutation');
      state.receipts.set(key, {
        status: 'committed',
        operationId: key,
        path: route,
        requestFingerprint: fingerprint,
        result: structuredClone(result),
      });
      if (
        (route.endsWith('/evaluation-requests') && state.loseRequests > 0) ||
        (route.endsWith('/drafts') && state.loseDrafts > 0) ||
        (route.endsWith('/comparisons') && state.loseComparisons > 0)
      ) {
        if (route.endsWith('/drafts')) state.loseDrafts--;
        else if (route.endsWith('/comparisons')) state.loseComparisons--;
        else state.loseRequests--;
        req.socket.destroy();
        return;
      }
      reply(result);
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'fixture', message: 'private fixture error', requestId: 'fixture' },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serviceUrl = `http://127.0.0.1:${address.port}`;
  const configuration = path.join(directory, 'configuration');
  await mkdir(configuration, { mode: 0o700 });
  const config = path.join(configuration, 'evaluator.json'),
    reader = path.join(configuration, 'reader.json'),
    payloadFile = path.join(directory, 'candidate.json'),
    intent = path.join(directory, 'intent.json'),
    handoff = path.join(directory, 'request.json'),
    policy = path.join(directory, 'policy.json');
  await writeFile(
    config,
    JSON.stringify({
      schemaVersion: 1,
      serviceUrl,
      workspaceId: 'project',
      evaluatorPrincipalId: 'evaluator',
      evaluatorToken: 'PRIVATE_CANARY',
      journalRoot: path.join(directory, 'journals'),
    }),
    { mode: 0o600 },
  );
  await writeFile(
    reader,
    JSON.stringify({
      schemaVersion: 1,
      serviceUrl,
      workspaceId: 'project',
      readToken: 'PRIVATE_READER_CANARY',
    }),
    { mode: 0o600 },
  );
  await writeFile(payloadFile, JSON.stringify(payload));
  const quality = {
    schemaVersion: 1,
    id: 'quality',
    revision: '1',
    metric: { name: 'correct', unit: 'reward', direction: 'higher' },
    aggregation: 'equal-case-means',
    minimumMeanImprovement: 0.5,
    maximumCaseRegression: 0,
    requiredCases: ['case'],
    // One saved case: a point-estimate check. The paired-t default would be indeterminate.
    inference: { method: 'none' },
  };
  await writeFile(policy, JSON.stringify(quality));
  const app = defineEvaluation({
    configId: 'app',
    configRevision: '1',
    datasetRevision: 'cases-1',
    graderRevision: 'grader-1',
    runtime: { model: 'none' },
    execution,
    cases: [{ caseId: 'case', input: { task: 'saved' }, expected: true }],
    execute: async ({ version }) => {
      state.executions++;
      return {
        output: { correct: version.payload.files[0].text === (state.flip ? 'bad' : 'good') },
      };
    },
    grade: async ({ output, expected }) => {
      if (state.failGrade) throw new Error('PRIVATE_GRADER_CANARY');
      return {
        reward: Number(output.correct === expected),
        explanation: { reason: 'fixture rubric' },
      };
    },
  });
  const requestArgs = [
    'request',
    '--config',
    config,
    '--bundle',
    bundleId,
    '--channel',
    'stable',
    '--payload',
    payloadFile,
    '--intent',
    intent,
    '--out',
    handoff,
  ];
  return {
    directory,
    traffic,
    state,
    app,
    config,
    reader,
    payloadFile,
    intent,
    handoff,
    policy,
    quality,
    requestArgs,
    candidate,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('status reports bound activity and preserves lifecycle status without an observation', async () => {
  const f = await fixture();
  try {
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    const status = async () =>
      (await invoke(undefined, ['status', '--read-config', f.reader, '--handoff', f.handoff]))
        .result;
    assert.deepEqual((await status()).progress, { activity: 'unknown', reason: 'unavailable' });
    const view = {
      schemaVersion: 1,
      status: 'requested',
      requestId,
      attemptId: null,
      activity: 'absent',
      checkedAt: now,
      observation: null,
    };
    f.state.progress = view;
    assert.equal((await status()).progress.reason, 'no_report');
    const attemptId = '88888888-8888-4888-8888-888888888888';
    Object.assign(f.state.request, { status: 'running', attemptId });
    f.state.progress = {
      ...view,
      status: 'running',
      attemptId,
      activity: 'fresh',
      observation: {
        attemptId,
        phase: 'grading',
        completed: 1,
        total: 2,
        receivedAt: now,
        case: f.state.request.expectedCases[0],
      },
    };
    assert.deepEqual((await status()).progress, {
      activity: 'fresh',
      checkedAt: now,
      receivedAt: now,
      phase: 'grading',
      completed: 1,
      total: 2,
      case: f.state.request.expectedCases[0],
    });
    f.state.progress = { ...view, status: 'running', attemptId: candidateId };
    assert.equal((await status()).progress.reason, 'unavailable');
  } finally {
    await f.cleanup();
  }
});

test('plan sizes the installed inventory for a policy without running callbacks', async () => {
  const f = await fixture();
  try {
    const planned = await invoke(f.app, ['plan', '--policy', f.policy, '--simulations', '20']);
    assert.equal(planned.status, 0);
    assert.equal(planned.result.method, 'none');
    assert.equal(planned.result.cases, 1);
    assert.match(planned.result.warnings.join(' '), /point estimates/);
    await writeFile(f.policy, JSON.stringify({ ...f.quality, inference: { method: 'paired-t' } }));
    const insufficient = await invoke(f.app, ['plan', '--policy', f.policy, '--simulations', '5']);
    assert.equal(insufficient.status, 3);
    assert.equal(insufficient.result.sufficient, false);
    assert.equal(insufficient.result.simulation.results[0].indeterminateRate, 1);
    const invalid = await invoke(f.app, ['plan', '--policy', f.policy, '--effects', 'x']);
    assert.equal(invalid.status, 1);
    assert.equal(f.state.executions, 0);
  } finally {
    await f.cleanup();
  }
});

test('closed CLI describe and usage errors never expose app data or config path', async () => {
  const f = await fixture();
  try {
    const described = await invoke(f.app, ['describe']);
    assert.equal(described.status, 0);
    assert.equal(described.result.runtime.configId, 'app');
    assert.ok(!described.out.includes('"expected":'));
    const invalid = await invoke(f.app, ['run', '--config', f.config, '--config', 'SECRET_CANARY']);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.error.error.code, 'usage.invalid_flag');
    assert.equal(invalid.error.error.field, '--config');
    assert.ok(!invalid.err.includes(f.config));
    assert.ok(!invalid.err.includes('SECRET_CANARY'));
    assert.equal(f.state.executions, 0);
    assert.throws(() => parseCommandJson('{"role":"output","role":"grader-explanation"}'));
  } finally {
    await f.cleanup();
  }
});

test('a named comparison reports callback reuse and supplies a durable handle to status, policy and export', async () => {
  const f = await fixture('live');
  try {
    const handle = ['--config', f.config, '--name', 'first-run'];
    const compare = [
      'compare',
      ...handle,
      '--bundle',
      bundleId,
      '--channel',
      'stable',
      '--payload',
      f.payloadFile,
      '--live',
    ];
    const first = await invoke(f.app, compare);
    assert.equal(first.status, 0, first.err);
    assert.equal(first.result.runName, 'first-run');
    assert.deepEqual(first.result.invocation, { callbacksStarted: 2, reusedEvidence: false });
    const again = await invoke(f.app, compare);
    assert.deepEqual(again.result.invocation, { callbacksStarted: 0, reusedEvidence: true });
    assert.equal(again.result.requestId, first.result.requestId);
    assert.equal(
      (await invoke(undefined, ['status', ...handle])).result.requestId,
      first.result.requestId,
    );
    assert.equal(
      (await invoke(f.app, ['check', ...handle, '--policy', f.policy])).result.verdict,
      'pass',
    );
    const destination = path.join(f.directory, 'named-export');
    assert.equal((await invoke(f.app, ['export', ...handle, '--out', destination])).status, 0);
    assert.equal(
      (
        await invoke(undefined, [
          'verify-export',
          '--manifest',
          path.join(destination, 'manifest.json'),
        ])
      ).status,
      0,
    );
    assert.equal(f.state.executions, 2);
  } finally {
    await f.cleanup();
  }
});

test('fresh attempt checks predecessor status, candidate payload and pinned base before creating work', async () => {
  const f = await fixture('live');
  try {
    const inputs = [
      'compare',
      '--config',
      f.config,
      '--bundle',
      bundleId,
      '--channel',
      'stable',
      '--payload',
      f.payloadFile,
      '--live',
    ];
    assert.equal((await invoke(f.app, [...inputs, '--name', 'original'])).status, 0);
    const retry = [...inputs, '--retry-after', 'original'];
    for (const status of ['requested', 'running']) {
      Object.assign(f.state.request, { status });
      const blocked = await invoke(f.app, retry);
      assert.equal(blocked.status, 3);
      assert.equal(blocked.error.error.code, 'evidence.not_terminal');
      assert.match(blocked.error.error.hint, /an interrupted or abandoned request/);
    }
    // An interrupted predecessor (for example, one the service expired) is settled.
    f.state.revision = '2';
    Object.assign(f.state.request, { status: 'interrupted' });
    assert.equal((await invoke(f.app, retry)).error.error.code, 'request.base_conflict');
    Object.assign(f.state.request, { status: 'completed' });
    assert.equal((await invoke(f.app, retry)).error.error.code, 'request.base_conflict');
    await writeFile(
      f.payloadFile,
      JSON.stringify({
        schemaVersion: 1,
        files: [{ path: 'instruction.md', kind: 'instruction', text: 'changed' }],
      }),
    );
    assert.equal((await invoke(f.app, retry)).error.error.code, 'request.intent_mismatch');
    assert.equal(f.state.drafts, 1);
    assert.equal(f.state.executions, 2);
  } finally {
    await f.cleanup();
  }
});

test('a fresh attempt may follow a predecessor the service abandoned', async () => {
  const f = await fixture('live');
  try {
    const inputs = [
      'compare',
      '--config',
      f.config,
      '--bundle',
      bundleId,
      '--channel',
      'stable',
      '--payload',
      f.payloadFile,
      '--live',
    ];
    assert.equal((await invoke(f.app, [...inputs, '--name', 'original'])).status, 0);
    // A cancelled CI job: the attempt started but never reported, then was abandoned.
    Object.assign(f.state.request, {
      status: 'abandoned',
      comparisonId: null,
      error: 'No evaluator activity for 7200 seconds',
      abandonedAt: now,
      abandonedBy: 'service:evaluation-expiry',
    });
    const retried = await invoke(f.app, [...inputs, '--retry-after', 'original']);
    // The predecessor gate accepts it and new work is created. (This fixture reuses one
    // request ID, so the successor's run then meets the first run's journal.)
    assert.notEqual(retried.error?.error?.code, 'evidence.not_terminal');
    assert.equal(f.state.drafts, 2);
    assert.equal(f.state.requests, 2);
  } finally {
    await f.cleanup();
  }
});

test('a named retry labels both runs for the console and keeps one successor', async () => {
  const f = await fixture('live');
  try {
    f.state.runLabels = true;
    const inputs = [
      'compare',
      '--config',
      f.config,
      '--bundle',
      bundleId,
      '--channel',
      'stable',
      '--payload',
      f.payloadFile,
      '--live',
    ];
    assert.equal((await invoke(f.app, [...inputs, '--name', 'original'])).status, 0);
    const original = structuredClone(f.state.request);
    assert.equal(f.state.requestBodies[0].runName, 'original');
    assert.equal(f.state.requestBodies[0].retryOf, undefined);
    const same = await invoke(
      f.app,
      [...inputs, '--retry-after', 'original', '--name', 'original'],
      undefined,
      true,
    );
    assert.equal(same.status, 1);
    assert.match(same.err, /new --name/);
    const retry = [...inputs, '--retry-after', 'original', '--name', 'fixed-grader'];
    // This fixture serves one request ID, so only request creation is observed here.
    await invoke(f.app, retry);
    assert.equal(f.state.requests, 2);
    assert.equal(f.state.requestBodies[1].runName, 'fixed-grader');
    assert.equal(f.state.requestBodies[1].retryOf, requestId);
    await invoke(f.app, retry);
    assert.equal(f.state.requests, 2);
    f.state.request = original;
    const other = await invoke(f.app, [...inputs, '--retry-after', 'original', '--name', 'another']);
    assert.equal(other.error.error.code, 'request.intent_mismatch');
    const unnamed = await invoke(f.app, [...inputs, '--retry-after', 'original']);
    assert.equal(unnamed.error.error.code, 'request.intent_mismatch');
    assert.equal(f.state.requests, 2);
  } finally {
    await f.cleanup();
  }
});

test('run labels are omitted for services that do not accept them', async () => {
  const f = await fixture('live');
  try {
    const result = await invoke(f.app, [
      'compare',
      '--config',
      f.config,
      '--bundle',
      bundleId,
      '--channel',
      'stable',
      '--payload',
      f.payloadFile,
      '--name',
      'original',
      '--live',
    ]);
    assert.equal(result.status, 0);
    assert.equal('runName' in f.state.requestBodies[0], false);
  } finally {
    await f.cleanup();
  }
});

test('an incomplete first policy reports only known missing schema fields before any execution', async () => {
  const f = await fixture('live');
  try {
    const { id, requiredCases, ...policy } = f.quality;
    await writeFile(
      f.policy,
      JSON.stringify({ ...policy, metric: { name: 'PRIVATE_CANARY' }, PRIVATE_CANARY: 'x' }),
    );
    const result = await invoke(f.app, [
      'compare',
      '--config',
      f.config,
      '--handoff',
      f.handoff,
      '--policy',
      f.policy,
      '--live',
    ]);
    assert.equal(result.error.error.code, 'policy.invalid');
    assert.deepEqual(result.error.error.missingFields.sort(), [
      'id',
      'metric.direction',
      'metric.unit',
      'requiredCases',
    ]);
    assert.ok(!result.err.includes('PRIVATE_CANARY'));
    assert.equal(f.traffic.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('compare terminal and JSON modes render the same bound run without extra calls', async () => {
  const f = await fixture('live');
  try {
    const args = ['compare', '--config', f.config, '--handoff', f.handoff, '--policy', f.policy];
    const missingLive = await invoke(f.app, args, undefined, true);
    assert.equal(missingLive.status, 1);
    assert.match(missingLive.err, /error\[usage\.missing_flag\].*--live.*Add --live/);
    assert.match(missingLive.err, /--bundle ID --channel CHANNEL/);
    assert.ok(!missingLive.err.includes(f.config));
    const mixed = await invoke(
      f.app,
      [...args, '--live', '--name', 'PRIVATE_CANARY'],
      undefined,
      true,
    );
    assert.match(mixed.err, /--handoff cannot be combined/);
    assert.ok(!mixed.err.includes('PRIVATE_CANARY'));
    assert.equal(f.traffic.length, 0);
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    args.push('--live');
    await writeFile(f.policy, JSON.stringify({ ...f.quality, minimumMeanImprovement: 2 }));
    const first = await invoke(f.app, args, undefined, true);
    assert.equal(first.status, 2);
    assert.match(first.out, new RegExp(requestId));
    assert.match(first.out, /Equal-case means\s+parent 0\s+candidate 1/);
    assert.match(first.out, /Pair coverage\s+1\/1/);
    assert.match(first.out, /"case"\s+parent 0\s+candidate 1/);
    assert.match(first.out, /Policy\s+fail/);
    assert.match(first.out, /fail\s+policy.minimum_mean_improvement/);
    assert.match(first.out, /Inference\s+none: point estimates for these cases, no noise model/);
    const before = f.traffic.length;
    const piped = await invoke(f.app, args);
    const readCalls = f.traffic.slice(before);
    const next = f.traffic.length;
    const explicit = await invoke(f.app, [...args, '--json'], undefined, true);
    assert.equal(explicit.out, piped.out);
    assert.deepEqual(f.traffic.slice(next), readCalls);
    const last = f.traffic.length;
    assert.match(first.out, /Execution callbacks started this time: 2/);
    assert.match((await invoke(f.app, args, undefined, true)).out, /Reused saved evidence/);
    assert.deepEqual(f.traffic.slice(last), readCalls);
    assert.ok(readCalls.every(([method]) => method === 'GET'));
    assert.equal(f.state.executions, 2);
  } finally {
    await f.cleanup();
  }
});

test('compare terminal preserves missing scores and partial coverage', async () => {
  const f = await fixture('live');
  try {
    f.state.failGrade = true;
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    const result = await invoke(
      f.app,
      ['compare', '--config', f.config, '--handoff', f.handoff, '--live', '--policy', f.policy],
      undefined,
      true,
    );
    assert.equal(result.status, 3);
    assert.match(result.out, /candidate · grade · grading_failed/);
    assert.match(result.out, /parent unknown\s+candidate unknown/);
    assert.match(result.out, /0\/1 \(partial\)/);
    assert.match(result.out, /"case" \[0\]\s+parent unknown\s+candidate unknown/);
    assert.match(result.out, /Policy\s+indeterminate/);
    assert.match(result.out, /unknown\s+evidence.incomplete/);
    const json = await invoke(f.app, [
      'compare',
      '--config',
      f.config,
      '--handoff',
      f.handoff,
      '--live',
      '--policy',
      f.policy,
      '--json',
    ]);
    assert.equal(json.status, 3);
    assert.deepEqual(json.result.scores.evidenceGaps.rows, [
      { caseId: 'case', repetition: 0, side: 'parent', stage: 'grade', reason: 'grading_failed' },
      {
        caseId: 'case',
        repetition: 0,
        side: 'candidate',
        stage: 'grade',
        reason: 'grading_failed',
      },
    ]);
  } finally {
    await f.cleanup();
  }
});

test('installed app headless request -> run -> read-only policy check -> export -> verify', async () => {
  const f = await fixture();
  try {
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    assert.equal(
      (
        await invoke(f.app, [
          'check',
          '--read-config',
          f.reader,
          '--handoff',
          f.handoff,
          '--policy',
          f.policy,
        ])
      ).status,
      3,
    );
    assert.equal(
      (await invoke(f.app, ['run', '--config', f.config, '--handoff', f.handoff])).status,
      0,
    );
    assert.equal(f.state.executions, 2);
    const checked = await invoke(f.app, [
      'check',
      '--read-config',
      f.reader,
      '--handoff',
      f.handoff,
      '--policy',
      f.policy,
    ]);
    assert.equal(checked.status, 0);
    assert.equal(checked.result.verdict, 'pass');
    assert.equal(checked.result.policyPin, 'unpinned');
    await writeFile(f.policy, JSON.stringify({ ...f.quality, minimumMeanImprovement: 2 }));
    assert.equal(
      (
        await invoke(f.app, [
          'check',
          '--config',
          f.config,
          '--handoff',
          f.handoff,
          '--policy',
          f.policy,
        ])
      ).status,
      2,
    );
    const out = path.join(f.directory, 'export');
    const exported = await invoke(f.app, [
      'export',
      '--read-config',
      f.reader,
      '--handoff',
      f.handoff,
      '--out',
      out,
    ]);
    assert.equal(exported.status, 0);
    assert.equal(exported.result.localInspection, 'not_requested');
    assert.ok(!exported.out.includes(f.directory));
    const verified = await invoke(undefined, [
      'verify-export',
      '--manifest',
      path.join(out, 'manifest.json'),
      '--read-config',
      f.reader,
      '--handoff',
      f.handoff,
    ]);
    assert.equal(verified.status, 0);
    assert.equal(verified.result.provenance, 'online_scalar_binding');
    assert.equal(
      (await invoke(f.app, ['run', '--config', f.config, '--handoff', f.handoff])).status,
      0,
    );
    assert.equal(f.state.executions, 2);
  } finally {
    await f.cleanup();
  }
});

test('request lost replies recover original committed intent before changed channel and reject changed payload', async () => {
  const f = await fixture();
  try {
    f.state.loseRequests = 3;
    const lost = await invoke(f.app, f.requestArgs);
    assert.equal(lost.status, 5);
    assert.equal(f.state.requests, 1);
    f.state.revision = '2';
    const recovered = await invoke(f.app, f.requestArgs);
    assert.equal(recovered.status, 0);
    assert.equal(recovered.result.requestId, requestId);
    assert.equal(f.state.drafts, 1);
    assert.equal(f.state.requests, 1);
    await writeFile(
      f.payloadFile,
      JSON.stringify({
        schemaVersion: 1,
        files: [{ path: 'instruction.md', kind: 'instruction', text: 'different' }],
      }),
    );
    const changed = await invoke(f.app, f.requestArgs);
    assert.equal(changed.status, 1);
    assert.equal(changed.error.error.code, 'request.intent_mismatch');
    assert.equal(f.state.requests, 1);
  } finally {
    await f.cleanup();
  }
});

test('static review mapper selection exports only the selected role', async () => {
  const f = await fixture();
  try {
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    assert.equal(
      (await invoke(f.app, ['run', '--config', f.config, '--handoff', f.handoff])).status,
      0,
    );
    const selection = path.join(f.directory, 'selection.json');
    await writeFile(
      selection,
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          { caseId: 'case', repetition: 0, side: 'candidate', role: 'output', required: true },
        ],
      }),
    );
    const out = path.join(f.directory, 'selected-export');
    const result = await invoke(
      f.app,
      [
        'export',
        '--config',
        f.config,
        '--handoff',
        f.handoff,
        '--selection',
        selection,
        '--out',
        out,
      ],
      {
        review: {
          toReviewArtifact: async ({ value }) => ({ mediaType: 'application/json', value }),
        },
      },
    );
    assert.equal(result.status, 0);
    assert.equal(result.result.selection.exportedRequired, 1);
    const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(
      manifest.entries
        .flatMap((entry: any) => entry.roles)
        .filter((role: any) => role.availability === 'exported').length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test('headless interrupt remains usable while the evaluator scope lock is held', async () => {
  const f = await fixture();
  let journal: Awaited<ReturnType<typeof openJournal>> | undefined;
  try {
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    const config = JSON.parse(await readFile(f.config, 'utf8'));
    journal = await openJournal(config.journalRoot, {
      serviceUrl: config.serviceUrl,
      workspaceId: 'project',
      bundleId,
      requestId,
      evaluatorPrincipalId: 'evaluator',
    });
    const interrupted = await invoke(f.app, [
      'interrupt',
      '--config',
      f.config,
      '--handoff',
      f.handoff,
      '--reason',
      'reviewed',
    ]);
    assert.equal(interrupted.status, 0);
    assert.equal(interrupted.result.status, 'interrupted');
    journal.assertOwned();
  } finally {
    if (journal) await journal.close();
    await f.cleanup();
  }
});

test('completed candidate loss, failed grading and interruption have different shell categories', async () => {
  const losing = await fixture();
  try {
    losing.state.flip = true;
    assert.equal((await invoke(losing.app, losing.requestArgs)).status, 0);
    assert.equal(
      (await invoke(losing.app, ['run', '--config', losing.config, '--handoff', losing.handoff]))
        .status,
      0,
    );
    assert.equal(
      (
        await invoke(losing.app, [
          'check',
          '--config',
          losing.config,
          '--handoff',
          losing.handoff,
          '--policy',
          losing.policy,
        ])
      ).status,
      2,
    );
    assert.ok(
      losing.state.comparison.results[0].candidate.reward <
        losing.state.comparison.results[0].parent.reward,
    );
  } finally {
    await losing.cleanup();
  }
  const failed = await fixture();
  try {
    failed.state.failGrade = true;
    assert.equal((await invoke(failed.app, failed.requestArgs)).status, 0);
    const run = await invoke(failed.app, [
      'run',
      '--config',
      failed.config,
      '--handoff',
      failed.handoff,
    ]);
    // A failed run is an execution failure (4), distinct from a quality-gate failure (2).
    assert.equal(run.status, 4);
    assert.equal(run.result.status, 'failed');
    assert.ok(!run.out.includes('PRIVATE_GRADER_CANARY'));
    assert.equal(
      (
        await invoke(failed.app, [
          'check',
          '--config',
          failed.config,
          '--handoff',
          failed.handoff,
          '--policy',
          failed.policy,
        ])
      ).status,
      3,
    );
  } finally {
    await failed.cleanup();
  }
  const interrupted = await fixture();
  try {
    assert.equal((await invoke(interrupted.app, interrupted.requestArgs)).status, 0);
    interrupted.state.request.status = 'interrupted';
    const run = await invoke(interrupted.app, [
      'run',
      '--config',
      interrupted.config,
      '--handoff',
      interrupted.handoff,
    ]);
    assert.equal(run.status, 5);
    assert.equal(interrupted.state.executions, 0);
  } finally {
    await interrupted.cleanup();
  }
});

test('lost candidate creation plus channel drift never silently rebases', async () => {
  const f = await fixture();
  try {
    f.state.loseDrafts = 3;
    assert.equal((await invoke(f.app, f.requestArgs)).status, 5);
    assert.equal(f.state.drafts, 1);
    assert.equal(f.state.requests, 0);
    f.state.revision = '2';
    const retry = await invoke(f.app, f.requestArgs);
    assert.equal(retry.status, 5);
    assert.equal(retry.error.error.code, 'request.base_conflict');
    assert.equal(f.state.drafts, 1);
    assert.equal(f.state.requests, 0);
  } finally {
    await f.cleanup();
  }
});

test('lost private creation intent is inspection-required rather than permission for new keys', async () => {
  const f = await fixture();
  try {
    f.state.loseRequests = 3;
    assert.equal((await invoke(f.app, f.requestArgs)).status, 5);
    await rm(f.intent);
    const retry = await invoke(f.app, f.requestArgs);
    assert.equal(retry.status, 5);
    assert.equal(retry.error.error.code, 'journal.missing');
    assert.equal(f.state.drafts, 1);
    assert.equal(f.state.requests, 1);
  } finally {
    await f.cleanup();
  }
});

test('uncertain committed comparison submission exits 5 and retries exact bytes/key without callbacks', async () => {
  const f = await fixture();
  try {
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    // The first response and both transport retries are lost after commit.
    f.state.loseComparisons = 3;
    const command = ['run', '--config', f.config, '--handoff', f.handoff];
    const uncertain = await invoke(f.app, command);
    assert.equal(uncertain.status, 5);
    assert.equal(uncertain.error.error.executionState, 'report_saved');
    assert.equal(uncertain.error.error.phase, 'submit');
    assert.equal(uncertain.error.error.nextAction, 'retry_same_command');
    assert.equal(f.state.request.status, 'running');
    assert.equal(f.state.comparisons, 1);
    assert.equal(f.state.executions, 2);
    const originalComparison = structuredClone(f.state.comparison);
    const originalAttempt = f.state.request.attemptId;
    assert.equal(f.state.comparisonSubmissions.length, 3);
    const firstSubmission = f.state.comparisonSubmissions[0];
    assert.ok(firstSubmission.key);
    assert.equal(JSON.parse(firstSubmission.body).evaluation.attemptId, originalAttempt);

    const recovered = await invoke(f.app, command);
    assert.equal(recovered.status, 0);
    assert.equal(recovered.result.status, 'completed');
    assert.equal(recovered.result.comparisonId, originalComparison.id);
    assert.equal(recovered.result.attemptId, originalAttempt);
    assert.equal(f.state.comparisons, 1);
    assert.equal(f.state.executions, 2);
    assert.deepEqual(f.state.comparison, originalComparison);
    assert.equal(f.state.comparisonSubmissions.length, 4);
    assert.ok(
      f.state.comparisonSubmissions.every(
        (submission) =>
          submission.key === firstSubmission.key && submission.body === firstSubmission.body,
      ),
    );
    assert.equal((await invoke(f.app, command)).status, 0);
    assert.equal(f.state.executions, 2);
    assert.equal(f.state.comparisonSubmissions.length, 4);
  } finally {
    await f.cleanup();
  }
});

for (const status of ['running', 'interrupted'] as const)
  test(`policy check for a ${status} request without terminal evidence is indeterminate exit 3`, async () => {
    const f = await fixture();
    try {
      assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
      f.state.request.status = status;
      if (status === 'running') {
        f.state.request.attemptId = '77777777-7777-4777-8777-777777777777';
        f.state.request.evaluatorPrincipal = 'evaluator';
      }
      const checked = await invoke(f.app, [
        'check',
        '--read-config',
        f.reader,
        '--handoff',
        f.handoff,
        '--policy',
        f.policy,
      ]);
      assert.equal(checked.status, 3);
      assert.equal(checked.result.verdict, 'indeterminate');
      assert.equal(checked.result.code, 'evidence.not_terminal');
      assert.equal(checked.result.requestId, requestId);
      assert.equal(f.state.executions, 0);
      assert.equal(f.state.comparisons, 0);
    } finally {
      await f.cleanup();
    }
  });

test('a request against a channel without a release names the missing baseline', async () => {
  const f = await fixture();
  try {
    const args = [...f.requestArgs];
    args[args.indexOf('--channel') + 1] = 'unpublished';
    const result = await invoke(f.app, args);
    assert.equal(result.status, 1);
    assert.equal(result.error.error.code, 'request.channel_empty');
    assert.equal(result.error.error.nextAction, 'ask_operator');
    assert.match(result.error.error.hint, /Publish a baseline release/);
    assert.equal(f.state.drafts, 0);
  } finally {
    await f.cleanup();
  }
});

test('request denial and a doctor failed check both use the setup exit 1', async () => {
  const f = await fixture();
  try {
    f.state.writeEvaluation = false;
    assert.equal(
      (await invoke(f.app, ['doctor', '--config', f.config, '--bundle', bundleId])).status,
      1,
    );
    assert.equal((await invoke(f.app, f.requestArgs)).status, 1);
    assert.equal(f.state.drafts, 0);
    assert.equal(f.state.requests, 0);
  } finally {
    await f.cleanup();
  }
});

test('doctor verifies bundle existence and reports missing request with exit 1 before execution', async () => {
  const f = await fixture();
  try {
    const ready = await invoke(f.app, ['doctor', '--config', f.config, '--bundle', bundleId]);
    assert.equal(ready.status, 0);
    assert.equal(ready.result.status, 'ready');
    const missingBundle = await invoke(f.app, [
      'doctor',
      '--config',
      f.config,
      '--bundle',
      comparisonId,
    ]);
    assert.equal(missingBundle.status, 1);
    assert.equal(missingBundle.result.checks.at(-1).code, 'bundle.missing');
    assert.equal(missingBundle.result.nextAction, 'fix_config');
    const config = JSON.parse(await readFile(f.config, 'utf8'));
    await writeFile(
      f.handoff,
      JSON.stringify({
        schemaVersion: 1,
        serviceUrl: config.serviceUrl,
        workspaceId: 'project',
        bundleId,
        requestId,
        descriptor: f.app.descriptor,
      }),
    );
    const missingRequest = await invoke(f.app, [
      'doctor',
      '--config',
      f.config,
      '--handoff',
      f.handoff,
    ]);
    assert.equal(missingRequest.status, 1);
    assert.equal(missingRequest.result.checks.at(-1).code, 'request.missing');
    assert.equal(missingRequest.result.nextAction, 'fix_config');
    assert.ok(!missingRequest.out.includes('PRIVATE_CANARY'));
    assert.ok(!missingRequest.out.includes(f.directory));
    assert.equal(f.state.executions, 0);
    assert.equal(f.state.drafts, 0);
    assert.equal(f.state.requests, 0);
    assert.equal(f.state.comparisons, 0);
    assert.equal(f.state.request, null);
  } finally {
    await f.cleanup();
  }
});

test('interrupt rejects a valid handoff whose descriptor differs before mutating the request', async () => {
  const f = await fixture();
  try {
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    const handoff = JSON.parse(await readFile(f.handoff, 'utf8'));
    handoff.descriptor.graderRevision = 'another-grader';
    await writeFile(f.handoff, JSON.stringify(handoff));
    const result = await invoke(f.app, [
      'interrupt',
      '--config',
      f.config,
      '--handoff',
      f.handoff,
      '--reason',
      'reviewed',
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.error.error.code, 'descriptor.mismatch');
    assert.equal(f.state.request.status, 'requested');
  } finally {
    await f.cleanup();
  }
});

test('policy check rejects unbound requests and candidate versions outside direct parentage', async () => {
  const f = await fixture();
  try {
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    assert.equal(
      (await invoke(f.app, ['run', '--config', f.config, '--handoff', f.handoff])).status,
      0,
    );
    const args = ['check', '--read-config', f.reader, '--handoff', f.handoff, '--policy', f.policy];
    f.state.request.requireBoundEvidence = false;
    let checked = await invoke(f.app, args);
    assert.equal(checked.status, 1);
    assert.equal(checked.error.error.code, 'evidence.identity_mismatch');
    f.state.request.requireBoundEvidence = true;
    f.candidate.parentVersionId = null;
    checked = await invoke(f.app, args);
    assert.equal(checked.status, 1);
    assert.equal(checked.error.error.code, 'version.binding_mismatch');
  } finally {
    await f.cleanup();
  }
});

test('creation recovery survives same-principal token rotation and retains credential-free identity', async () => {
  const f = await fixture();
  try {
    f.state.loseRequests = 3;
    assert.equal((await invoke(f.app, f.requestArgs)).status, 5);
    const config = JSON.parse(await readFile(f.config, 'utf8'));
    config.evaluatorToken = 'ROTATED_PRIVATE_CANARY';
    await writeFile(f.config, JSON.stringify(config));
    const recovered = await invoke(f.app, f.requestArgs);
    assert.equal(recovered.status, 0);
    assert.equal(recovered.result.requestId, requestId);
    assert.equal(f.state.requests, 1);
    const intent = await readFile(f.intent, 'utf8');
    assert.ok(!intent.includes('PRIVATE_CANARY'));
    assert.ok(!recovered.out.includes('PRIVATE_CANARY'));
  } finally {
    await f.cleanup();
  }
});

test('request writes a 0.2.0 handoff, recovers 0.1 intent state, and --handoff rejects 0.1 keys', async () => {
  const f = await fixture();
  try {
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    const current = await readFile(f.handoff, 'utf8');
    const handoff = JSON.parse(current);
    assert.deepEqual(Object.keys(handoff), [
      'schemaVersion',
      'serviceUrl',
      'workspaceId',
      'bundleId',
      'requestId',
      'descriptor',
    ]);
    // A run started by 0.1 left its intent and handoff with the old keys.
    const intent = JSON.parse(await readFile(f.intent, 'utf8'));
    const { workspaceId, ...identity } = intent.identity;
    await writeFile(f.intent, JSON.stringify({ ...intent, identity: { ...identity, projectId: workspaceId } }) + '\n');
    const legacy = JSON.stringify({
      schemaVersion: 1,
      serviceUrl: handoff.serviceUrl,
      projectId: handoff.workspaceId,
      bundleId: handoff.bundleId,
      requestId: handoff.requestId,
      configuration: handoff.descriptor,
    });
    await writeFile(f.handoff, legacy + '\n');
    const recovered = await invoke(f.app, f.requestArgs);
    assert.equal(recovered.status, 0, recovered.err);
    assert.equal(recovered.result.requestId, requestId);
    assert.equal(f.state.requests, 1);
    assert.equal(await readFile(f.handoff, 'utf8'), current);
    // A handoff supplied with --handoff is never translated.
    for (const [file, field, renamed] of [
      [legacy, 'projectId', 'workspaceId'],
      [current.replace('"descriptor"', '"configuration"'), 'configuration', 'descriptor'],
    ]) {
      const old = path.join(f.directory, 'old-handoff.json');
      await writeFile(old, file);
      const rejected = await invoke(undefined, ['status', '--read-config', f.reader, '--handoff', old]);
      assert.equal(rejected.status, 1);
      assert.equal(rejected.error.error.code, 'config.schema');
      assert.equal(rejected.error.error.field, field);
      assert.equal(rejected.error.error.reason, `${field} was renamed to ${renamed} in 0.2.0`);
    }
  } finally {
    await f.cleanup();
  }
});

test('doctor distinguishes config aliases, journal aliases and directory permissions', async () => {
  const f = await fixture();
  try {
    const alias = path.join(f.directory, 'private-name-canary');
    await symlink(f.directory, alias);
    const linked = path.join(f.directory, 'file-alias');
    await symlink(f.config, linked);
    const config = JSON.parse(await readFile(f.config, 'utf8'));
    config.journalRoot = path.join(alias, 'missing', 'journals');
    await writeFile(f.config, JSON.stringify(config));
    for (const filename of [
      linked,
      path.join(alias, path.relative(f.directory, f.config)),
      f.config,
    ]) {
      const result = await invoke(f.app, ['doctor', '--config', filename, '--bundle', bundleId]);
      assert.equal(result.status, 1);
      const failure = result.error?.error ?? result.result.checks.at(-1);
      assert.equal(failure.code, 'config.permissions');
      assert.equal(failure.field, filename === f.config ? 'journalRoot' : 'configPath');
      assert.match(failure.hint, /realpath/);
      assert.doesNotMatch(failure.hint, /chmod/);
      assert.ok(!JSON.stringify(failure).includes(f.directory));
    }
    await assert.rejects(readFile(path.join(f.directory, 'missing')), { code: 'ENOENT' });
    assert.equal(f.state.executions, 0);
  } finally {
    await f.cleanup();
  }
});

test('doctor reports missing private configuration as invalid input exit 1', async () => {
  const f = await fixture();
  try {
    const result = await invoke(f.app, [
      'doctor',
      '--config',
      path.join(f.directory, 'missing.json'),
      '--bundle',
      bundleId,
    ]);
    assert.equal(result.status, 1);
    assert.ok(['config.missing', 'config.permissions'].includes(result.error.error.code));
    await mkdir(path.join(f.directory, 'journals'), { mode: 0o755 });
    const unsafeStorage = await invoke(f.app, [
      'doctor',
      '--config',
      f.config,
      '--bundle',
      bundleId,
    ]);
    assert.equal(unsafeStorage.status, 1);
    assert.equal(unsafeStorage.result.checks.at(-1).code, 'config.permissions');
    assert.equal(unsafeStorage.result.checks.at(-1).field, 'journalRoot');
    assert.match(unsafeStorage.result.checks.at(-1).hint, /chmod/);
    assert.equal(f.state.executions, 0);
  } finally {
    await f.cleanup();
  }
});

test('missing handoffs, an unnamed compare and an unreachable service name the flag and service', async () => {
  const f = await fixture();
  try {
    const missing = await invoke(f.app, [
      'status', '--config', f.config, '--handoff', path.join(f.directory, 'absent.json'),
    ]);
    assert.equal(missing.status, 1);
    assert.equal(missing.error.error.code, 'handoff.missing');
    assert.equal(missing.error.error.field, '--handoff');
    assert.ok(!missing.err.includes(f.directory));
    const unnamed = await invoke(f.app, [
      'compare', '--config', f.config, '--bundle', bundleId, '--channel', 'stable', '--payload', f.payloadFile,
    ]);
    assert.equal(unnamed.error.error.code, 'usage.missing_flag');
    assert.equal(unnamed.error.error.field, '--name');
    assert.match(unnamed.error.error.reason, /--name RUN_NAME/);
    const noRun = await invoke(f.app, ['status', '--config', f.config, '--name', 'never-ran']);
    assert.equal(noRun.error.error.code, 'handoff.missing');
    assert.equal(noRun.error.error.field, '--name');
    assert.match(noRun.error.error.reason, /No run named "never-ran"/);

    const config = JSON.parse(await readFile(f.config, 'utf8'));
    await writeFile(f.config, JSON.stringify({ ...config, serviceUrl: 'http://127.0.0.1:9/' }));
    const doctor = await invoke(f.app, ['doctor', '--config', f.config, '--bundle', bundleId]);
    assert.equal(doctor.status, 4);
    const check = doctor.result.checks.at(-1);
    assert.equal(check.code, 'service.unavailable');
    assert.equal(check.serviceUrl, 'http://127.0.0.1:9');
    assert.match(check.hint, /Check that the Acclimate service is running/);
    assert.equal(doctor.result.nextAction, 'check_service');
  } finally {
    await f.cleanup();
  }
});

test('a failed callback is named in the compare summary with its private diagnostic path', async () => {
  const f = await fixture();
  try {
    f.state.failGrade = true;
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    const args = ['compare', '--config', f.config, '--handoff', f.handoff];
    const terminal = await invoke(f.app, args, undefined, true);
    assert.equal(terminal.status, 4);
    assert.match(terminal.out, /First callback failure: "case" \[0\] \w+ · grade · grading_failed/);
    const file = /Details \(private, not uploaded\): (\S+callback-error\.json)/.exec(terminal.out)![1];
    const diagnostic = JSON.parse(await readFile(file, 'utf8'));
    assert.match(diagnostic.message, /PRIVATE_GRADER_CANARY/);
    assert.ok(!JSON.stringify(f.state.comparison).includes('PRIVATE_GRADER_CANARY'));
    // A rerun reuses saved evidence, so no callback ran and none is reported.
    const json = await invoke(f.app, args);
    assert.equal(json.result.invocation.reusedEvidence, true);
    assert.equal(json.result.firstCallbackFailure, undefined);
  } finally {
    await f.cleanup();
  }
});

test('service compare binds run controls from flags, streams progress and flags identical outputs', async () => {
  const f = await fixture();
  try {
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    // Same descriptor as the fixture, but execute ignores the bundle.
    const ignoring = defineEvaluation({
      configId: 'app',
      configRevision: '1',
      datasetRevision: 'cases-1',
      graderRevision: 'grader-1',
      runtime: { model: 'none' },
      execution: 'model-free',
      cases: [{ caseId: 'case', input: { task: 'saved' }, expected: true }],
      execute: async () => ({ output: { correct: true }, usage: { costUsd: 0.25 } }),
      grade: async () => ({ reward: 1 }),
    });
    assert.deepEqual(ignoring.descriptor, f.app.descriptor);
    const rejected = await invoke(ignoring, ['describe', '--deadline', '1m']);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.error.error.code, 'usage.unknown_flag');
    assert.equal(rejected.error.error.field, '"--deadline"');
    const compared = await invoke(ignoring, [
      'compare', '--config', f.config, '--handoff', f.handoff,
      '--deadline', '1h', '--case-timeout', '5m', '--max-cost-usd', '10', '--progress', '--json',
    ]);
    assert.equal(compared.status, 0);
    const progress = compared.err.trim().split('\n');
    assert.equal(progress.length, 2);
    assert.match(progress[0], /^\[1\/2\] "case" #0 parent {4}reward 1 · \$0\.2500 · /);
    assert.equal(compared.result.run.stopReason, 'completed');
    assert.equal(compared.result.run.costUsd, 0.5);
    assert.equal(compared.result.run.deadlineMs, 3_600_000);
    assert.deepEqual(compared.result.run.outputs, { comparedPairs: 1, identicalPairs: 1 });
    assert.match(compared.result.warnings[0], /identical output on all 1 compared pair\. Check that execute uses the version it is given/);
  } finally {
    await f.cleanup();
  }
});

test('service compare reports a shard selection without writing to stderr', async () => {
  const f = await fixture();
  try {
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    const compared = await invoke(f.app, [
      'compare', '--config', f.config, '--handoff', f.handoff, '--policy', f.policy, '--shard', '1/1', '--json',
    ]);
    // A shard of one covers every case, so nothing is skipped, but the selection is still reported.
    assert.equal(compared.result.run.partial, false);
    assert.match(compared.result.warnings.join('\n'), /shard 1\/1 · 1 of 1 pairs/);
    assert.equal(compared.err, '');
  } finally {
    await f.cleanup();
  }
});

test('a declared native harness rejects incompatible skills before any request or callback', async () => {
  const f = await fixture();
  try {
    const native = defineEvaluation({
      configId: 'app',
      configRevision: '1',
      datasetRevision: 'cases-1',
      graderRevision: 'grader-1',
      runtime: { model: 'none' },
      execution: 'model-free',
      compatibilityTarget: 'claude',
      cases: [{ caseId: 'case', input: { task: 'saved' }, expected: true }],
      execute: async () => {
        f.state.executions++;
        return { output: { correct: true } };
      },
      grade: async () => ({ reward: 1 }),
    });
    // The target is not part of the descriptor, so existing requests keep their identity.
    assert.deepEqual(native.descriptor, f.app.descriptor);
    const broken = path.join(f.directory, 'broken.json');
    await writeFile(
      broken,
      JSON.stringify({
        schemaVersion: 1,
        files: [
          { path: 'instruction.md', kind: 'instruction', text: 'good' },
          { path: 'skills/refunds/SKILL.md', kind: 'skill', text: 'No frontmatter.' },
        ],
      }),
    );
    const doctor = await invoke(native, ['doctor', '--config', f.config, '--bundle', bundleId, '--payload', broken]);
    assert.equal(doctor.status, 1);
    assert.deepEqual(doctor.result.compatibility.targets, ['claude']);
    assert.equal(doctor.result.compatibility.issues[0].code, 'skill_metadata');
    const compared = await invoke(native, [
      'compare', '--config', f.config, '--bundle', bundleId, '--channel', 'stable', '--payload', broken,
      '--name', 'native-change',
    ]);
    assert.equal(compared.status, 1);
    assert.equal(compared.error.error.code, 'payload.incompatible');
    assert.equal(compared.error.error.field, '--payload');
    assert.match(compared.error.error.reason, /claude \[skill_metadata\] skills\/refunds\/SKILL\.md/);
    const local = await invoke(native, ['compare', '--local', '--parent', f.payloadFile, '--candidate', broken]);
    assert.equal(local.status, 1);
    assert.equal(local.error.error.field, '--candidate');
    const tried = await invoke(native, ['try', '--payload', broken]);
    assert.equal(tried.error.error.code, 'payload.incompatible');
    assert.equal(f.state.drafts, 0);
    assert.equal(f.state.executions, 0);
    // A compatible payload passes the same checks.
    const fine = await invoke(native, ['doctor', '--config', f.config, '--bundle', bundleId, '--payload', f.payloadFile]);
    assert.equal(fine.status, 0);
    assert.deepEqual(fine.result.compatibility.issues, []);
    assert.throws(
      () =>
        defineEvaluation({
          configId: 'app', configRevision: '1', datasetRevision: 'cases-1', graderRevision: 'grader-1',
          runtime: { model: 'none' }, execution: 'model-free', compatibilityTarget: 'vim' as 'claude',
          cases: [{ caseId: 'case', input: null, expected: null }],
          execute: () => ({ output: null }), grade: () => ({ reward: 1 }),
        }),
      { code: 'definition.invalid', field: 'compatibilityTarget' },
    );
  } finally {
    await f.cleanup();
  }
});

test('compare --policy pins the policy digest on the request it creates, in the intent journal too', async () => {
  const f = await fixture();
  try {
    f.state.policyPins = true;
    const policyBytes = await readFile(f.policy);
    const digest = 'sha256:' + createHash('sha256').update(policyBytes).digest('hex');
    const inputs = [
      'compare', '--config', f.config, '--bundle', bundleId, '--channel', 'stable', '--payload', f.payloadFile,
      '--name', 'pinned',
    ];
    const pinned = await invoke(f.app, [...inputs, '--policy', f.policy]);
    assert.equal(pinned.status, 0, pinned.err);
    assert.equal(f.state.requestBodies[0].policyDigest, digest);
    const intent = JSON.parse(
      await readFile(path.join(f.directory, 'journals', 'comparisons', 'pinned', 'intent.json'), 'utf8'),
    );
    assert.equal(JSON.parse(intent.requestBody).policyDigest, digest);
    // A different policy than the pinned one is a changed intent for the same run.
    const other = path.join(f.directory, 'other-policy.json');
    await writeFile(other, JSON.stringify({ ...f.quality, revision: '2' }));
    const changed = await invoke(f.app, [...inputs, '--policy', other]);
    assert.equal(changed.error?.error?.code, 'request.intent_mismatch');
    // request --policy pins too; a service without policy pins gets no unknown field.
    f.state.policyPins = false;
    const unpinned = await invoke(f.app, [...f.requestArgs, '--policy', f.policy]);
    assert.equal(unpinned.status, 0, unpinned.err);
    assert.equal('policyDigest' in f.state.requestBodies.at(-1), false);
  } finally {
    await f.cleanup();
  }
});
