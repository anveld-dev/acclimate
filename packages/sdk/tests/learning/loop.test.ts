import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { AcclimateClient, InfrastructureError } from '../../src/index.js';
import {
  heldOutDigest,
  serveLearningLoop,
  type LearningLoopApp,
} from '../../src/learning/index.js';
import type {
  LearningEvaluation,
  LearningEvaluationReportRequest,
  LearningWorkItem,
} from '../../src/types.js';

const bundleId = '00000000-0000-4000-8000-000000000001';
const evaluationId = '00000000-0000-4000-8000-000000000002';
const unknownEvaluationId = '00000000-0000-4000-8000-000000000003';
const token = 'fixture-evaluator-token';
const base = `/v1/workspaces/w/bundles/${bundleId}`;
const payload = await readFile(
  new URL('../../../../contracts/fixtures/bundle-v1.json', import.meta.url),
);
const version = {
  id: 'version-1',
  bundleId,
  parentVersionId: null,
  digest: 'sha256:' + createHash('sha256').update(payload).digest('hex'),
  createdAt: '2026-11-20T00:00:00Z',
};
const cases = ['a', 'b', 'c', 'd'].map((caseId) => ({ caseId, input: caseId, expected: caseId }));

async function fixture(
  t: TestContext,
  options: { heldOut?: boolean; mismatch?: boolean; retry?: boolean } = {},
) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'learning-'));
  const controller = new AbortController();
  const deadlineAt = new Date(Date.now() + 300_000).toISOString();
  const hold = options.heldOut
    ? { digest: options.mismatch ? version.digest : heldOutDigest(cases), cases: cases.length }
    : null;
  const item: LearningWorkItem = {
    evaluationId,
    roundId: 'round-1',
    roundNumber: 1,
    sample: null,
    role: options.heldOut ? 'retained' : 'incumbent',
    split: options.heldOut ? 'heldOut' : 'evolve',
    versionId: version.id,
    digest: version.digest,
    evolveRevision: options.heldOut ? null : 1,
    heldOut: hold,
    status: 'queued',
    deadlineAt,
  };
  const evaluation: LearningEvaluation = {
    id: evaluationId,
    roundId: item.roundId,
    role: item.role,
    split: item.split,
    cases: cases.length,
    sample: null,
    versionId: version.id,
    digest: version.digest,
    evolveRevision: item.evolveRevision,
    status: 'queued',
    score: null,
    reportedCases: 0,
    createdAt: deadlineAt,
    startedAt: null,
    deadlineAt,
    error: null,
  };
  const reports: LearningEvaluationReportRequest[] = [];
  const reportRequests: { key: string; body: LearningEvaluationReportRequest }[] = [];
  const calls: string[] = [];
  const starts: string[] = [];
  const stored = new Set<string>();
  let state: 'running' | 'stopped' = 'running';
  let onReport: (() => void) | undefined;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = req.url;
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url === base + '/learning/work') {
      calls.push('work');
      return json({
        bundleId,
        status: state,
        items:
          state === 'running' && ['queued', 'running'].includes(evaluation.status) ? [item] : [],
      });
    }
    if (url === base + '/versions/' + version.id) return json(version);
    if (url === base + '/versions/' + version.id + '/payload') {
      res.end(payload);
      return;
    }
    if (url?.includes(`/evaluations/${unknownEvaluationId}/`)) return json({ error: { code: 'not_found' } }, 404);
    if (req.headers.authorization !== 'Bearer ' + token)
      return json({ error: { code: 'denied' } }, 403);
    const key = req.headers['idempotency-key'];
    assert.equal(typeof key, 'string');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (url === base + '/learning/evaluations/' + evaluationId + '/start') {
      calls.push('start');
      assert.equal(key, body.attemptId);
      starts.push(body.attemptId);
      evaluation.status = 'running';
      item.status = 'running';
      return json({
        evaluation,
        cases: options.heldOut ? null : cases,
        heldOut: hold,
        reportedCaseIds: [...stored],
      });
    }
    assert.equal(url, base + '/learning/evaluations/' + evaluationId + '/report');
    calls.push('report');
    reportRequests.push({ key: key as string, body });
    if (options.retry && reportRequests.length === 1)
      return json({ error: { code: 'unavailable' } }, 503);
    reports.push(body);
    if (body.error) evaluation.status = 'failed';
    else {
      for (const result of body.cases) stored.add(result.caseId);
      if (stored.size === cases.length) evaluation.status = 'scored';
    }
    json(evaluation);
    onReport?.();
  }
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
      controller.abort(error);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = 'http://127.0.0.1:' + address.port;
  const configPath = join(root, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      serviceUrl: url,
      workspaceId: 'w',
      evaluatorPrincipalId: 'machine:fixture',
      evaluatorToken: token,
      journalRoot: join(root, 'journal'),
    }),
    { mode: 0o600 },
  );
  return {
    reports,
    reportRequests,
    starts,
    calls,
    controller,
    stop: () => {
      state = 'stopped';
    },
    afterReport: (callback: () => void) => {
      onReport = callback;
    },
    run: (
      app: LearningLoopApp<string, string, string>,
      signal = controller.signal,
      caseConcurrency = 1,
    ) =>
      serveLearningLoop({
        app,
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        bundleId,
        configPath,
        caseConcurrency,
        pollIntervalMs: 10,
      }),
    client: (credential = token) =>
      new AcclimateClient({ baseUrl: url, token: credential, scope: 'fixture' }),
  };
}

const echo: LearningLoopApp<string, string, string> = {
  execution: 'model-free',
  heldOut: cases,
  execute: ({ input }) => ({ output: input, trace: 'private trace' }),
  grade: ({ output, expected }) => ({
    score: Number(output === expected),
    passed: output === expected,
  }),
};

test(
  'polls, starts, then reports five rollouts per case with bounded traces and stable retry keys',
  { timeout: 25000 },
  async (t) => {
    const h = await fixture(t, { retry: true });
    h.afterReport(() => {
      if (h.reports.length === cases.length) h.controller.abort();
    });
    let retries = 0;
    await h.run({
      ...echo,
      execute: ({ input, instructions, rollout }) => {
        assert.ok(instructions.length > 0);
        if (input === 'a' && rollout === 0 && retries++ === 0)
          throw new InfrastructureError('retry');
        return { output: input, trace: 'α'.repeat(10_000) + token };
      },
      grade: (data) => {
        if (data.caseId === 'a' && data.rollout === 1)
          throw new Error('Bearer ' + token + 'x'.repeat(9000));
        return echo.grade(data);
      },
    });
    assert.deepEqual(h.calls.slice(0, 2), ['work', 'start']);
    assert.ok(h.calls.indexOf('report') > h.calls.indexOf('start'));
    assert.deepEqual(h.reportRequests[0], h.reportRequests[1]);
    assert.equal(h.reportRequests[0].key, h.starts[0] + ':a');
    assert.equal(retries, 2);
    assert.equal(h.reports.length, 4);
    const rollouts = h.reports[0].cases?.[0].rollouts;
    assert.equal(rollouts?.length, 5);
    assert.match(rollouts![0].trace!, /\[… \d+ bytes omitted …\]/);
    assert.ok(Buffer.byteLength(rollouts![0].trace!) <= 16 * 1024);
    assert.ok(!rollouts![0].trace!.includes(token));
    assert.equal(rollouts![1].score, 0);
    assert.equal(rollouts![1].trace, null);
    assert.ok(!rollouts![1].error!.includes(token));
    assert.ok(Buffer.byteLength(rollouts![1].error!) <= 4096);
  },
);

test(
  'held-out reports contain only scores and passed, including callback errors',
  { timeout: 25000 },
  async (t) => {
    const h = await fixture(t, { heldOut: true });
    h.afterReport(() => {
      if (h.reports.length === cases.length) h.controller.abort();
    });
    await h.run({
      ...echo,
      execute: ({ rollout, input }) => {
        if (rollout === 0) throw new Error('private error');
        return { output: input, trace: 'private trace' };
      },
    });
    assert.equal(h.reports.length, cases.length);
    for (const { cases: results } of h.reports)
      assert.deepEqual(results?.[0].rollouts, [
        { score: 0, passed: false },
        ...Array.from({ length: 4 }, () => ({ score: 1, passed: true })),
      ]);
  },
);

test(
  'held-out commitment mismatch fails the evaluation before executing',
  { timeout: 25000 },
  async (t) => {
    const h = await fixture(t, { heldOut: true, mismatch: true });
    h.afterReport(() => h.controller.abort());
    await h.run({ ...echo, heldOut: [], execute: () => assert.fail('must not execute') });
    assert.deepEqual(h.reports, [{ attemptId: h.starts[0], error: 'learning.held_out_mismatch' }]);
  },
);

test(
  'four cases can run at once and reports follow completion order',
  { timeout: 25000 },
  async (t) => {
    const h = await fixture(t);
    let finishFirst!: () => void;
    const otherCasesReported = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    h.afterReport(() => {
      if (h.reports.length === cases.length - 1) finishFirst();
      if (h.reports.length === cases.length) h.controller.abort();
    });
    const firstRollouts: string[] = [];
    let allStarted!: () => void;
    const barrier = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    await h.run(
      {
        ...echo,
        execute: async ({ caseId, input, rollout, signal }) => {
          if (!rollout) {
            firstRollouts.push(caseId);
            if (firstRollouts.length === 4) allStarted();
            await Promise.race([barrier, delay(20_000, undefined, { signal, ref: false })]);
            if (caseId === 'a')
              await Promise.race([
                otherCasesReported,
                delay(20_000, undefined, { signal, ref: false }),
              ]);
          }
          return { output: input };
        },
      },
      h.controller.signal,
      4,
    );
    assert.equal(firstRollouts.length, 4);
    assert.equal(h.reports.length, 4);
    assert.equal(h.reports.at(-1)?.cases?.[0].caseId, 'a');
  },
);

test(
  'restart reuses attempt, skips reported cases, and never repeats an uncertain rollout',
  { timeout: 25000 },
  async (t) => {
    const h = await fixture(t);
    const interruption = new AbortController();
    const executed: string[] = [];
    await h.run(
      {
        ...echo,
        execute: ({ input, rollout }) => {
          executed.push(input + rollout);
          if (input === 'b' && rollout === 1) interruption.abort();
          return { output: input };
        },
      },
      interruption.signal,
    );
    assert.equal(h.reports.length, 1);
    h.afterReport(() => {
      if (h.reports.length === cases.length) h.controller.abort();
    });
    await h.run({
      ...echo,
      execute: ({ input, rollout }) => {
        executed.push(input + rollout);
        return { output: input };
      },
    });
    assert.equal(h.starts.length, 2);
    assert.equal(h.starts[0], h.starts[1]);
    assert.equal(executed.length, 20);
    assert.equal(new Set(executed).size, 20);
    assert.deepEqual(h.reports[1].cases?.[0].rollouts[1], {
      score: 0,
      passed: false,
      trace: null,
      error: 'execution.uncertain',
    });
  },
);

test('removing an assigned item aborts the executing callback', { timeout: 25000 }, async (t) => {
  const h = await fixture(t);
  let cancelled = false;
  await h.run({
    ...echo,
    execute: async ({ signal }) => {
      h.stop();
      try {
        await delay(20_000, undefined, { signal });
      } catch {
        cancelled = true;
        h.controller.abort();
      }
      return { output: '' };
    },
  });
  assert.equal(cancelled, true);
  assert.deepEqual(h.reports, []);
});

test('unknown and forbidden starts and reports fail closed', async (t) => {
  const h = await fixture(t);
  for (const [client, id, status, code] of [
    [h.client(), unknownEvaluationId, 404, 'not_found'],
    [h.client('foreign'), evaluationId, 403, 'denied'],
  ] as const) {
    await assert.rejects(
      client.startLearningEvaluation('w', bundleId, id, { attemptId: 'attempt' }),
      { status, code },
    );
    await assert.rejects(
      client.reportLearningEvaluation(
        'w',
        bundleId,
        id,
        { attemptId: 'attempt', error: 'example' },
        'attempt:error',
      ),
      { status, code },
    );
  }
  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.reports, []);
});

test('a live app requires opt-in', async (t) => {
  const h = await fixture(t);
  await assert.rejects(h.run({ ...echo, execution: 'live' }), { code: 'usage.conflicting_flags' });
  assert.deepEqual(h.calls, []);
});
