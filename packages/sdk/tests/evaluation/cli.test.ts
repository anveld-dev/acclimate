import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineEvaluation } from '../../src/evaluation/index.js';
import { evaluationMain } from '../../src/evaluation/cli.js';
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
  app: ReturnType<typeof defineEvaluation>,
  args: string[],
  options?: Parameters<typeof evaluationMain>[2],
) {
  let out = '',
    err = '';
  const stdout = process.stdout.write,
    stderr = process.stderr.write;
  process.stdout.write = ((value: unknown) => {
    out += String(value);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((value: unknown) => {
    err += String(value);
    return true;
  }) as typeof process.stderr.write;
  try {
    const status = await evaluationMain(app, args, options);
    return {
      status,
      out,
      err,
      result: out ? JSON.parse(out) : undefined,
      error: err ? JSON.parse(err) : undefined,
    };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

async function fixture() {
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
    receipts: new Map(),
  };
  const server = createServer(async (req, res) => {
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
          projectId: 'project',
          principalId: 'evaluator',
          checkedAt: now,
          readUnpublished: true,
          writeEvaluation: state.writeEvaluation,
          retainedEvaluationOperations: true,
        });
      if (route.includes('/operations/')) {
        const key = route.split('/').at(-1)!;
        return reply(state.receipts.get(key) ?? { status: 'not_observed', operationId: key });
      }
      if (req.method === 'GET') {
        if (route === '/v1/projects/project/bundles')
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
      assert.equal(req.headers['x-acclimate-durable-operation'], 'true');
      const fingerprint =
        'sha256:' +
        createHash('sha256')
          .update('POST\0' + route + '\0' + raw)
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
      projectId: 'project',
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
      projectId: 'project',
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
  };
  await writeFile(policy, JSON.stringify(quality));
  const app = defineEvaluation({
    configId: 'app',
    configRevision: '1',
    datasetRevision: 'cases-1',
    graderRevision: 'grader-1',
    runtime: { model: 'none' },
    execution: 'model-free',
    cases: [{ caseId: 'case', input: { task: 'saved' }, expected: true }],
    execute: async ({ bundle }) => {
      state.executions++;
      return {
        output: { correct: bundle.payload.files[0].text === (state.flip ? 'bad' : 'good') },
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

test('closed CLI describe and usage errors never expose app data or config path', async () => {
  const f = await fixture();
  try {
    const described = await invoke(f.app, ['describe']);
    assert.equal(described.status, 0);
    assert.equal(described.result.runtime.configId, 'app');
    assert.ok(!described.out.includes('"expected":'));
    const invalid = await invoke(f.app, ['run', '--config', f.config, '--config', 'SECRET_CANARY']);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.error.error.code, 'config.schema');
    assert.ok(!invalid.err.includes(f.config));
    assert.equal(f.state.executions, 0);
    assert.throws(() => parseCommandJson('{"role":"output","role":"grader-explanation"}'));
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
    const verified = await invoke(f.app, [
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
    assert.equal(lost.status, 3);
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
      projectId: 'project',
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
    assert.equal(run.status, 2);
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
    assert.equal(run.status, 3);
    assert.equal(interrupted.state.executions, 0);
  } finally {
    await interrupted.cleanup();
  }
});

test('lost candidate creation plus channel drift never silently rebases', async () => {
  const f = await fixture();
  try {
    f.state.loseDrafts = 3;
    assert.equal((await invoke(f.app, f.requestArgs)).status, 3);
    assert.equal(f.state.drafts, 1);
    assert.equal(f.state.requests, 0);
    f.state.revision = '2';
    const retry = await invoke(f.app, f.requestArgs);
    assert.equal(retry.status, 3);
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
    assert.equal((await invoke(f.app, f.requestArgs)).status, 3);
    await rm(f.intent);
    const retry = await invoke(f.app, f.requestArgs);
    assert.equal(retry.status, 3);
    assert.equal(retry.error.error.code, 'journal.missing');
    assert.equal(f.state.drafts, 1);
    assert.equal(f.state.requests, 1);
  } finally {
    await f.cleanup();
  }
});

test('uncertain committed comparison submission exits 3 and retries exact bytes/key without callbacks', async () => {
  const f = await fixture();
  try {
    assert.equal((await invoke(f.app, f.requestArgs)).status, 0);
    // The first response and both transport retries are lost after commit.
    f.state.loseComparisons = 3;
    const command = ['run', '--config', f.config, '--handoff', f.handoff];
    const uncertain = await invoke(f.app, command);
    assert.equal(uncertain.status, 3);
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

test('request denial uses input/access exit 1 while doctor uses failed-check exit 2', async () => {
  const f = await fixture();
  try {
    f.state.writeEvaluation = false;
    assert.equal(
      (await invoke(f.app, ['doctor', '--config', f.config, '--bundle', bundleId])).status,
      2,
    );
    assert.equal((await invoke(f.app, f.requestArgs)).status, 1);
    assert.equal(f.state.drafts, 0);
    assert.equal(f.state.requests, 0);
  } finally {
    await f.cleanup();
  }
});

test('doctor verifies bundle existence and reports missing request with exit 2 before execution', async () => {
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
    assert.equal(missingBundle.status, 2);
    assert.equal(missingBundle.result.checks.at(-1).code, 'bundle.missing');
    assert.equal(missingBundle.result.nextAction, 'fix_config');
    const config = JSON.parse(await readFile(f.config, 'utf8'));
    await writeFile(
      f.handoff,
      JSON.stringify({
        schemaVersion: 1,
        serviceUrl: config.serviceUrl,
        projectId: 'project',
        bundleId,
        requestId,
        configuration: f.app.descriptor,
      }),
    );
    const missingRequest = await invoke(f.app, [
      'doctor',
      '--config',
      f.config,
      '--handoff',
      f.handoff,
    ]);
    assert.equal(missingRequest.status, 2);
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
    handoff.configuration.graderRevision = 'another-grader';
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
    assert.equal((await invoke(f.app, f.requestArgs)).status, 3);
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
    assert.equal(f.state.executions, 0);
  } finally {
    await f.cleanup();
  }
});
