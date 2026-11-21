import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AcclimateClient, ApiError, type LearningEvolveCasesPage, type LearningEvolveCasesRequest, type LearningLoop, type LearningLoopRequest } from '../../src/index.js';
import { defineLoop, exact, tests } from '../../src/learning/index.js';
import type { Json } from '../../src/evaluation/types.js';
import { loadLoop } from '../../src/learning/define.js';
import { reconcileLoop, resolveAppPrincipal, syncEvolveCases } from '../../src/learning/setup.js';

const dataset = Array.from({ length: 500 }, (_, index) => ({
  input: { index }, expected: { index },
}));

test('inline grade types follow the cases and agent output; the split is deterministic and disjoint', async () => {
  const config = defineLoop({
    bundle: 'support', channel: 'stable', cases: dataset,
    agent: { model: 'model-a', execute: ({ input }) => ({ output: String(input.index) }) },
    grade: (output, expected) => Number(output.toUpperCase() === expected.index.toFixed()),
  });
  const split = await loadLoop(config, '.');
  const reverse = await loadLoop({ ...config, cases: [...dataset].reverse() }, '.');
  assert.deepEqual(split.commitment, reverse.commitment);
  assert(split.evolve.length >= 200 && split.evolve.length <= 300);
  assert.equal(split.evolve.length + split.app.heldOut.length, dataset.length);
  assert.equal(new Set([...split.evolve, ...split.app.heldOut].map(item => item.caseId)).size, dataset.length);
  assert.deepEqual(split.setting, { domain: 'support', benchmark: 'inline', policyModel: 'model-a' });
  assert.equal(split.live, true);
  const changed = await loadLoop({ ...config, execute: undefined, agent: { ...config.agent!, model: 'model-b' } }, '.');
  assert.equal(changed.setting.policyModel, 'model-b');
  const wire: unknown[] = [];
  await syncEvolveCases({
    async listLearningEvolveCases() { return { items: [], next: null, evolveRevision: 0 }; },
    async addLearningEvolveCases(_workspace, _bundle, body) {
      wire.push(...body.cases!);
      assert(body.cases!.length <= 100);
      return { evolveRevision: 1, added: body.cases!.length, retired: 0, liveCases: wire.length };
    },
  }, 'workspace', 'bundle', split.evolve);
  assert.deepEqual(wire, split.evolve);
});

test('load relative JSONL and JSON files and infer the benchmark basename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acclimate-cases-'));
  try {
    await writeFile(join(directory, 'cases.json'), JSON.stringify(dataset));
    await writeFile(join(directory, 'cases.jsonl'), dataset.map(item => JSON.stringify(item)).join('\n'));
    const config = defineLoop({
      bundle: 'support', channel: 'stable', cases: 'cases.json',
      execute: ({ input }) => ({ output: input }), grade: exact(),
    });
    const first = await loadLoop(config, directory);
    const second = await loadLoop<Json, Json, Json>({ ...config, cases: 'cases.jsonl', setting: { policyModel: 'fixture' } }, directory);
    assert.deepEqual(first.commitment, second.commitment);
    assert.deepEqual(first.setting, { domain: 'support', benchmark: 'cases.json', policyModel: 'model-free' });
    assert.deepEqual(second.setting, { domain: 'support', benchmark: 'cases.jsonl', policyModel: 'fixture' });
    assert.equal(second.app.execution, 'model-free');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sync pages then adds missing and retires removed setup cases without touching outcomes', async () => {
  const old = { caseId: 'obsolete', input: 1, expected: 1 };
  const keep = { caseId: 'keep', input: 2, expected: { a: 1 } };
  const add = { caseId: 'new', input: 3, expected: 4 };
  let live: LearningEvolveCasesPage['items'] = [old, keep, { ...keep, caseId: 'outcome:123' }].map(item => ({ ...item, addedRevision: 1 }));
  const writes: LearningEvolveCasesRequest[] = [];
  const reads: (string | undefined)[] = [];
  const client = {
    async listLearningEvolveCases(_workspace: string, _bundle: string, options?: { after?: string }) {
      reads.push(options?.after);
      return options?.after
        ? { items: live.slice(1), next: null, evolveRevision: 1 }
        : { items: [live[0]], next: live[0].caseId, evolveRevision: 1 };
    },
    async addLearningEvolveCases(_workspace: string, _bundle: string, body: LearningEvolveCasesRequest) {
      writes.push(body);
      live = [...live.filter(item => !body.retire?.includes(item.caseId)), ...(body.cases ?? []).map(item => ({ ...item, addedRevision: 2 }))];
      return { evolveRevision: 2, added: 1, retired: 1, liveCases: live.length };
    },
  };
  await syncEvolveCases(client, 'w', 'b', [keep, add]);
  await syncEvolveCases(client, 'w', 'b', [keep, add]);
  assert.deepEqual(reads, [undefined, 'obsolete', undefined, 'keep']);
  assert.deepEqual(writes, [{ cases: [add], retire: ['obsolete'] }]);
  assert(live.some(item => item.caseId === 'outcome:123'));
});

test('runs beforeWrite once before the first write, and not at all when nothing changes', async () => {
  const events: string[] = [];
  let live: LearningEvolveCasesPage['items'] = [];
  const client = {
    async listLearningEvolveCases() {
      return { items: live, next: null, evolveRevision: 1 };
    },
    async addLearningEvolveCases(_workspace: string, _bundle: string, body: LearningEvolveCasesRequest) {
      events.push('write');
      live = (body.cases ?? []).map(item => ({ ...item, addedRevision: 2 }));
      return { evolveRevision: 2, added: live.length, retired: 0, liveCases: live.length };
    },
  };
  const cases = [{ caseId: 'a', input: 1, expected: 1 }];
  await syncEvolveCases(client, 'w', 'b', cases, async () => { events.push('pause'); });
  assert.deepEqual(events, ['pause', 'write']);
  await syncEvolveCases(client, 'w', 'b', cases, async () => { events.push('pause'); });
  assert.deepEqual(events, ['pause', 'write']);
});

test('halves the evolve-case page size when a listing response is too large', async () => {
  const limits: (number | undefined)[] = [];
  const client = {
    async listLearningEvolveCases(_workspace: string, _bundle: string, options?: { after?: string; limit?: number }) {
      limits.push(options?.limit);
      if ((options?.limit ?? 100) > 25) throw new ApiError(502, 'response_too_large', 'Response too large', 'req');
      return options?.after
        ? { items: [], next: null, evolveRevision: 1 }
        : { items: [{ caseId: 'keep', input: 1, expected: 1, addedRevision: 1 }], next: 'keep', evolveRevision: 1 };
    },
    async addLearningEvolveCases() {
      throw new Error('nothing to change');
    },
  };
  await syncEvolveCases(client, 'w', 'b', [{ caseId: 'keep', input: 1, expected: 1 }]);
  assert.deepEqual(limits, [100, 50, 25, 25]);
});

test('splits evolve-case additions so each request stays under the 2 MiB body limit', async () => {
  // 18 cases with 60 KiB input and 60 KiB expected each: count-only batching sent one ~2.2 MiB body.
  const big = 'x'.repeat(60 * 1024);
  const cases = Array.from({ length: 18 }, (_, index) => ({ caseId: `big-${index}`, input: big, expected: big }));
  const bodies: number[] = [];
  const sent: string[] = [];
  const client = {
    async listLearningEvolveCases() {
      return { items: [], next: null, evolveRevision: 1 };
    },
    async addLearningEvolveCases(_workspace: string, _bundle: string, body: LearningEvolveCasesRequest) {
      bodies.push(Buffer.byteLength(JSON.stringify(body)));
      sent.push(...(body.cases ?? []).map(item => item.caseId));
      return { evolveRevision: 2, added: body.cases?.length ?? 0, retired: 0, liveCases: sent.length };
    },
  };
  await syncEvolveCases(client, 'w', 'b', cases);
  assert(bodies.length >= 2);
  assert(bodies.every(size => size < 2 * 1024 * 1024));
  assert.deepEqual(sent, cases.map(item => item.caseId));
});

test('enrolls once, reconciles an active model transition, and explains held-out conflicts', async () => {
  const desired: LearningLoopRequest = {
    channel: 'stable', appPrincipalId: 'machine:test',
    setting: { domain: 'support', benchmark: 'inline', policyModel: 'a' },
    heldOut: { digest: 'sha256:a', cases: 3 },
  };
  let state: LearningLoop | undefined;
  const enrolled: LearningLoopRequest[] = [];
  const client = {
    async getLearningLoop() {
      if (!state) throw new ApiError(404, 'not_found', 'Missing', 'fixture');
      return state;
    },
    async enrollLearningLoop(_workspace: string, _bundle: string, body: LearningLoopRequest) {
      enrolled.push(body);
      state = { ...state, ...body, status: 'running' } as LearningLoop;
      return state;
    },
  };
  await reconcileLoop(client, 'w', 'b', desired);
  await reconcileLoop(client, 'w', 'b', desired);
  assert(state);
  state = { ...state, activeRound: { number: 1 } as LearningLoop['activeRound'] };
  const transition = { ...desired, setting: { ...desired.setting, policyModel: 'b' } };
  await reconcileLoop(client, 'w', 'b', transition);
  await assert.rejects(
    reconcileLoop(client, 'w', 'b', { ...transition, heldOut: { digest: 'sha256:b', cases: 3 } }),
    /Pause the loop and let the round finish/,
  );
  assert.deepEqual(enrolled, [desired, transition]);
});

test('discovers the app principal, checks rights, and encodes evolve paging on the wire', async () => {
  let rights = ['evaluate', 'promote'];
  const page = { items: [{ caseId: 'case:1', input: 1, expected: 2, addedRevision: 5 }], next: null, evolveRevision: 5 };
  const client = new AcclimateClient({
    baseUrl: 'http://localhost', token: 'fake', scope: 'fixture',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init?.method, 'GET');
      if (url.pathname.endsWith('/principal')) {
        assert.equal(url.pathname, '/v1/workspaces/test/principal');
        return Response.json({ principalId: 'machine:test', kind: 'machine', rights });
      }
      assert.equal(url.pathname + url.search, '/v1/workspaces/test/bundles/b/learning/evolve-cases?after=case%3A1&limit=100');
      return Response.json(page);
    },
  });
  assert.equal(await resolveAppPrincipal(client, 'test', { separateEnrollment: false }), 'machine:test');
  rights = ['evaluate'];
  await assert.rejects(resolveAppPrincipal(client, 'test', { separateEnrollment: false }), /promote/);
  assert.equal(await resolveAppPrincipal(client, 'test', { separateEnrollment: true }), 'machine:test');
  rights = [];
  await assert.rejects(resolveAppPrincipal(client, 'test', { separateEnrollment: false }), /evaluate, promote/);
  assert.equal(await resolveAppPrincipal(client, 'test', { explicit: 'configured', separateEnrollment: true }), 'configured');
  assert.deepEqual(await client.listLearningEvolveCases('test', 'b', { after: 'case:1', limit: 100 }), page);
});

test('exact uses deep equality and tests grades a temporary output.json by process exit code', async () => {
  assert.equal(exact()({ a: [1, 2], b: 3 }, { b: 3, a: [1, 2] }), 1);
  assert.equal(exact('a')({ a: [1, 2] }, [1, 2]), 1);
  assert.equal(exact('a')({}, undefined), 0);
  assert.equal(exact('a')({ a: 1 }, '1'), 0);
  const fixture = await mkdtemp(join(tmpdir(), 'acclimate-grader-'));
  try {
    await writeFile(join(fixture, 'check.cjs'), "process.exitCode = Number(require('./output.json').answer !== 12)");
    const grade = tests('node check.cjs', { cwd: fixture });
    const context = { caseId: 'a', rollout: 0, signal: new AbortController().signal };
    assert.equal(await grade({ answer: 12 }, null, context), 1);
    assert.equal(await grade({ answer: 13 }, null, context), 0);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
