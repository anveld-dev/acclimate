import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runEvaluation } from './runner.js';
import { openJournal, EvaluationBusyError } from './journal.js';
import { paymentAdapter } from './payment.js';
import { localEvaluationDescriptor } from './descriptor.js';
import { fixture, projectId, bundleId, requestId, evaluatorPrincipalId, serviceUrl } from './fixture.js';

async function disposable() {
  const journalRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-evaluator-'));
  const f = fixture(localEvaluationDescriptor);
  const options = { api: f.api, adapter: paymentAdapter, journalRoot, projectId, bundleId, requestId, evaluatorPrincipalId, serviceUrl };
  return { f, options, cleanup: () => rm(journalRoot, { recursive: true, force: true }) };
}

test('behavioral adapter executes pairs, persists private per-case traces, binds and completes a losing or winning report', async () => {
  const { f, options, cleanup } = await disposable();
  try {
    assert.equal((await runEvaluation(options)).status, 'completed');
    assert.deepEqual(f.events.map((e) => e.kind), ['start', 'submit', 'finish']);
    const report = f.events.find((e) => e.kind === 'submit')!.body as import('../../packages/sdk/src/types.js').ComparisonRequest;
    assert.deepEqual(report.evaluation, { requestId, attemptId: f.request.attemptId });
    assert.equal(report.results.length, 6);
    const lost = report.results.filter((r) => r.caseId === 'response-lost');
    assert.ok(lost.every((r) => r.parent.reward === 0 && r.candidate.reward === 1));
    const [directory] = await readdir(options.journalRoot);
    const privateFiles = await readdir(path.join(options.journalRoot, directory));
    assert.equal(privateFiles.filter((f) => f.startsWith('output-')).length, 12);
    for (const filename of privateFiles.filter((f) => f.endsWith('.json'))) {
      assert.equal((await stat(path.join(options.journalRoot, directory, filename))).mode & 0o777, 0o600);
    }
    // A complete candidate loss still completes orchestration.
    const reversed = fixture(localEvaluationDescriptor);
    const execute = paymentAdapter.execute;
    const losing = { ...paymentAdapter, execute: async (input: Parameters<typeof execute>[0]) => {
      const result = await execute(input);
      return { ...result, output: { charges: 2, succeeded: true, events: [] } };
    } };
    await runEvaluation({ ...options, journalRoot: path.join(options.journalRoot, 'losing'), api: reversed.api, adapter: losing });
    assert.equal(reversed.request.status, 'completed');
  } finally { await cleanup(); }
});

test('structural installed settings rejection happens before start or app execution', async () => {
  const { f, options, cleanup } = await disposable();
  try {
    f.request = { ...f.request, runtime: { ...f.request.runtime, model: 'https://untrusted.example/execute' } };
    await assert.rejects(runEvaluation(options), /installed fixture\/application/);
    assert.deepEqual(f.events, []);
  } finally { await cleanup(); }
});

for (const failure of ['execution', 'grading']) test(`partial ${failure} evidence is retained and finishes failed, without a recovery rerun`, async () => {
  const { f, options, cleanup } = await disposable();
  let executions = 0;
  options.adapter = { ...paymentAdapter,
    execute: async (input) => { executions++; if (failure === 'execution') throw new Error('fixture infrastructure failure'); return paymentAdapter.execute(input); },
    grade: async (input) => { if (failure === 'grading') throw new Error('fixture grading failure'); return paymentAdapter.grade(input); },
  };
  try {
    const result = await runEvaluation(options);
    assert.equal(result.status, 'failed');
    assert.ok(result.comparisonId);
    const report = f.events.find((e) => e.kind === 'submit')!.body as import('../../packages/sdk/src/types.js').ComparisonRequest;
    assert.ok(report.results.every((pair) => pair.parent.reward === null && pair.candidate.reward === null));
    await runEvaluation(options);
    assert.equal(executions, 12);
  } finally { await cleanup(); }
});

for (const action of ['start', 'submit', 'finish'] as const) {
  for (const committed of [false, true]) test(`lost ${action} response (${committed ? 'committed' : 'uncommitted'}) resumes exact keys without repeating callbacks`, async () => {
    const { f, options, cleanup } = await disposable();
    let executions = 0;
    options.adapter = { ...paymentAdapter, execute: async (input) => { executions++; return paymentAdapter.execute(input); } };
    const method = { start: 'startEvaluation', submit: 'createComparison', finish: 'finishEvaluation' }[action] as 'startEvaluation';
    const original = f.api[method].bind(f.api);
    let first = true;
    const seen: Array<{ key: string; body: string }> = [];
    (f.api as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      seen.push({ key: String(args.at(-1)), body: JSON.stringify(args.at(-2)) });
      if (first) {
        first = false;
        if (committed) await (original as (...args: unknown[]) => unknown)(...args);
        throw new Error('lost response');
      }
      return (original as (...args: unknown[]) => unknown)(...args);
    };
    try {
      await assert.rejects(runEvaluation(options), /lost response/);
      assert.equal((await runEvaluation(options)).status, 'completed');
      assert.equal(executions, 12);
      if (!committed || action === 'submit') assert.equal(seen.length, 2);
      if (seen.length === 2) assert.deepEqual(seen[0], seen[1]);
    } finally { await cleanup(); }
  });
}

test('concurrent invocations have one owner through app execution', async () => {
  const { options, cleanup } = await disposable();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  let count = 0;
  options.adapter = { ...paymentAdapter, execute: async (input) => {
    count++; entered(); await barrier; return paymentAdapter.execute(input);
  } };
  try {
    const running = runEvaluation(options);
    await began;
    await assert.rejects(runEvaluation(options), EvaluationBusyError);
    release();
    await running;
    assert.equal(count, 12);
  } finally { release(); await cleanup(); }
});

test('actual process death after execution marker never reruns callbacks and releases OS ownership', async () => {
  const { f, options, cleanup } = await disposable();
  const fixtureUrl = pathToFileURL(path.resolve('examples/evaluation/fixture.ts')).href;
  const runnerUrl = pathToFileURL(path.resolve('examples/evaluation/runner.ts')).href;
  const paymentUrl = pathToFileURL(path.resolve('examples/evaluation/payment.ts')).href;
  const descriptorUrl = pathToFileURL(path.resolve('examples/evaluation/descriptor.ts')).href;
  const code = `import { fixture } from ${JSON.stringify(fixtureUrl)};
import {runEvaluation} from ${JSON.stringify(runnerUrl)};
import {paymentAdapter} from ${JSON.stringify(paymentUrl)};
import {localEvaluationDescriptor} from ${JSON.stringify(descriptorUrl)};
const f=fixture(localEvaluationDescriptor);
await runEvaluation({...${JSON.stringify({ ...options, api: undefined, adapter: undefined })},api:f.api,
adapter:{...paymentAdapter,execute:async()=>{process.stdout.write('callback\\n'); await new Promise(()=>{});}}});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += String(data); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (data) => { if (String(data).includes('callback')) resolve(); });
      child.on('exit', (code) => reject(new Error(`Crash worker exited early: ${code}: ${stderr}`)));
    });
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    const [directory] = await readdir(options.journalRoot);
    const saved = JSON.parse(await readFile(path.join(options.journalRoot, directory, 'attempt.json'), 'utf8'));
    assert.equal(saved.executionStarted, true);
    assert.equal(saved.report, undefined);
    f.request = { ...f.request, status: 'running', attemptId: saved.attemptId, evaluatorPrincipal: evaluatorPrincipalId };
    await assert.rejects(runEvaluation(options), /without a complete saved report/);
    assert.equal(f.events.length, 0);
  } finally { child.kill('SIGKILL'); await cleanup(); }
});

test('journal is scoped to service, project, bundle, request and evaluator', async () => {
  const { options, cleanup } = await disposable();
  const scope = { serviceUrl, projectId, bundleId, requestId, evaluatorPrincipalId };
  try {
    const first = await openJournal(options.journalRoot, scope);
    for (const key of Object.keys(scope) as Array<keyof typeof scope>) {
      const other = await openJournal(options.journalRoot, { ...scope, [key]: scope[key] + '-other' });
      assert.notEqual(first.directory, other.directory);
      await other.close();
    }
    await first.close();
  } finally { await cleanup(); }
});


test('runner captures installed execution and grading callbacks before any app callback', async () => {
  const { f, options, cleanup } = await disposable();
  let executions = 0, originalGrades = 0, replacementGrades = 0;
  const adapter = {
    ...paymentAdapter,
    execute: async (input: Parameters<typeof paymentAdapter.execute>[0]) => {
      executions++;
      adapter.grade = async () => { replacementGrades++; return { reward: 99 }; };
      adapter.execute = async () => { throw Error('replacement execution must not run'); };
      return paymentAdapter.execute(input);
    },
    grade: async (input: Parameters<typeof paymentAdapter.grade>[0]) => {
      originalGrades++;
      return paymentAdapter.grade(input);
    },
  };
  try {
    await runEvaluation({ ...options, adapter });
    assert.equal(executions, 12);
    assert.equal(originalGrades, 12);
    assert.equal(replacementGrades, 0);
    assert.equal(f.request.status, 'completed');
  } finally { await cleanup(); }
});

test('installed case inventory mismatch fails before starting or executing and creates no journal', async () => {
  const { f, options, cleanup } = await disposable();
  let executions = 0;
  try {
    const adapter = { ...paymentAdapter, cases: paymentAdapter.cases.slice(0, 1),
      execute: async (input: Parameters<typeof paymentAdapter.execute>[0]) => { executions++; return paymentAdapter.execute(input); } };
    await assert.rejects(runEvaluation({ ...options, adapter }), /installed fixture\/application|inventory/);
    assert.equal(executions, 0);
    assert.deepEqual(f.events, []);
    assert.deepEqual(await readdir(options.journalRoot), []);
  } finally { await cleanup(); }
});

for (const changed of ['serviceUrl', 'evaluatorPrincipalId', 'journalRoot'] as const)
  test(`unfinished request cannot resume under a changed ${changed}`, async () => {
    const { f, options, cleanup } = await disposable();
    const start = f.api.startEvaluation.bind(f.api);
    f.api.startEvaluation = async (...args) => { await start(...args); throw new Error('lost start response'); };
    try {
      await assert.rejects(runEvaluation(options), /lost start response/);
      const attempted = { ...options, [changed]: options[changed] + '-other' };
      let executions = 0;
      attempted.adapter = { ...paymentAdapter, execute: async (input) => { executions++; return paymentAdapter.execute(input); } };
      await assert.rejects(runEvaluation(attempted), /Running request has no local journal|different evaluator/);
      assert.equal(executions, 0);
      assert.deepEqual(f.events.map(event => event.kind), ['start']);
    } finally {
      await cleanup();
      if (changed === 'journalRoot') await rm(options.journalRoot + '-other', { recursive: true, force: true });
    }
  });

test('copying an unfinished journal to a different root refuses recovery and callback execution', async () => {
  const { cp } = await import('node:fs/promises');
  const { f, options, cleanup } = await disposable();
  const destination = options.journalRoot + '-copy';
  const submit = f.api.createComparison.bind(f.api);
  f.api.createComparison = async (...args) => { await submit(...args); throw new Error('lost submit response'); };
  try {
    await assert.rejects(runEvaluation(options), /lost submit response/);
    await cp(options.journalRoot, destination, { recursive: true, preserveTimestamps: true });
    let executions = 0;
    const adapter = { ...paymentAdapter, execute: async (input: Parameters<typeof paymentAdapter.execute>[0]) => {
      executions++; return paymentAdapter.execute(input);
    } };
    await assert.rejects(runEvaluation({ ...options, journalRoot: destination, adapter }), /journal root changed/);
    assert.equal(executions, 0);
  } finally { await cleanup(); await rm(destination, { recursive: true, force: true }); }
});

for (const changed of ['id', 'runtime', 'candidateVersionId', 'candidateDigest', 'attemptId', 'evaluatorPrincipal'] as const)
  test(`start response cannot change frozen ${changed} before app execution`, async () => {
    const { f, options, cleanup } = await disposable();
    const start = f.api.startEvaluation.bind(f.api);
    let executions = 0;
    options.adapter = { ...paymentAdapter, execute: async (input) => { executions++; return paymentAdapter.execute(input); } };
    f.api.startEvaluation = async (...args) => {
      const result = await start(...args);
      return { ...result, [changed]: changed === 'runtime' ? { ...result.runtime, configRevision: 'changed' } : 'changed' };
    };
    try {
      await assert.rejects(runEvaluation(options));
      assert.equal(executions, 0);
      assert.deepEqual(f.events.map(event => event.kind), ['start']);
    } finally { await cleanup(); }
  });

test('finish response must confirm the exact request, attempt and submitted comparison', async () => {
  const { f, options, cleanup } = await disposable();
  const finish = f.api.finishEvaluation.bind(f.api);
  f.api.finishEvaluation = async (...args) => ({ ...await finish(...args), comparisonId: 'wrong-comparison' });
  try {
    await assert.rejects(runEvaluation(options), /exact completed evaluation attempt/);
    const [directory] = await readdir(options.journalRoot);
    const saved = JSON.parse(await readFile(path.join(options.journalRoot, directory, 'attempt.json'), 'utf8'));
    assert.equal(saved.completed, undefined);
    assert.ok(saved.report);
  } finally { await cleanup(); }
});
