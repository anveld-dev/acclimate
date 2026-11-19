import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  defineEvaluation,
  ExecutionUncertainError,
  EvaluationError,
} from '../../src/evaluation/index.js';
import {
  assertEvaluationOutput,
  preflightEvaluation,
  runEvaluation,
} from '../../src/evaluation/index.js';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { captureDefinition } from '../../src/evaluation/definition.js';
import { runCapturedEvaluation } from '../../src/evaluation/runner.js';
import {
  journalDirectory,
  openJournal,
  sha256,
  serializeScope,
} from '../../src/evaluation/journal.js';
import type { AttemptJournal, JournalScope } from '../../src/evaluation/journal.js';
import type { EvaluationDefinition, EvaluatorConfig } from '../../src/evaluation/types.js';
import type { Comparison, EvaluationHandoff, ComparisonRequest } from '../../src/types.js';
import {
  fixture,
  projectId,
  bundleId,
  requestId,
  evaluatorPrincipalId,
  serviceUrl,
} from '../../../../examples/evaluation/fixture.js';
import type { createEvaluationTransport } from '../../src/internal/evaluation-transport.js';

const defaultDefinition = (): EvaluationDefinition<
  { task: string },
  { answer: string },
  { answer: string }
> => ({
  configId: 'custom-review',
  configRevision: '1',
  datasetRevision: 'saved-tasks-1',
  graderRevision: 'exact-1',
  runtime: { app: 'fixture' },
  execution: 'model-free',
  cases: [
    {
      caseId: 'one',
      input: { task: 'execute' },
      expected: { answer: 'private-answer' },
      repetitions: 2,
    },
  ],
  execute: async () => ({ output: { answer: 'private-answer' } }),
  grade: async ({ output, expected }) => ({
    reward: Number(output.answer === expected.answer),
    explanation: { reason: 'exact' },
  }),
});
test('oversize definitions report a usable conservative partition size', () => {
  const definition = defaultDefinition();
  const cases = Array.from({ length: 50 }, (_, i) => ({
    ...definition.cases[0],
    caseId: `case${i}`,
    repetitions: 10,
  }));
  assert.throws(
    () => defineEvaluation({ ...definition, cases }),
    (error: unknown) => {
      assert.ok(error instanceof EvaluationError);
      const budget = error.diagnostic.reportBudget!;
      assert.equal(budget.expectedPairs, 500);
      assert.ok(budget.estimatedBytes > budget.limitBytes);
      assert.ok(budget.maxPairsPerPartition >= 10);
      defineEvaluation({
        ...definition,
        cases: cases.slice(0, Math.floor(budget.maxPairsPerPartition / 10)),
      });
      return true;
    },
  );
});

async function setup(definition = defaultDefinition()) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-core-')),
    app = defineEvaluation(definition),
    f = fixture(app.descriptor);
  let comparison: Comparison | undefined;
  const api = f.api;
  api.getComparison = async () => structuredClone(comparison!);
  const submitted: { key: string; body: string }[] = [];
  const transport = {
    client: api,
    mutate: async <T>(op: string, _scope: unknown, body: string, key: string): Promise<T> => {
      const value = JSON.parse(body);
      if (op === 'start')
        return (await api.startEvaluation(projectId, bundleId, requestId, value, key)) as T;
      if (op === 'submit') {
        submitted.push({ key, body });
        comparison = await api.createComparison(projectId, bundleId, value, key);
        return comparison as T;
      }
      if (op === 'finish')
        return (await api.finishEvaluation(projectId, bundleId, requestId, value, key)) as T;
      throw new Error('unexpected operation');
    },
  } as ReturnType<typeof createEvaluationTransport>;
  const config: EvaluatorConfig = {
    schemaVersion: 1,
    serviceUrl,
    projectId,
    evaluatorPrincipalId,
    evaluatorToken: 'private-token-canary',
    journalRoot: root,
  };
  const handoff: EvaluationHandoff = {
    schemaVersion: 1,
    serviceUrl,
    projectId,
    bundleId,
    requestId,
    configuration: structuredClone(app.descriptor),
  };
  const options = { captured: captureDefinition(app), config, handoff, transport };
  const scope: JournalScope = { serviceUrl, projectId, bundleId, requestId, evaluatorPrincipalId };
  return {
    app,
    f,
    options,
    scope,
    root,
    submitted,
    directory: journalDirectory(root, scope),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('callback diagnostics retain private frame locations only when enabled', async () => {
  for (const enabled of [false, true]) {
    const definition = defaultDefinition();
    const directories: string[] = [];
    definition.execute = async ({ context, repetition }) => {
      directories.push(context.privateJobDirectory);
      if (repetition === 0) throw new TypeError('private callback canary\n    at /secret/path:1:1');
      return { output: { answer: 'ok' } };
    };
    definition.grade = async () => {
      throw new RangeError('private grader canary');
    };
    const run = await setup(definition);
    try {
      run.options.config.captureCallbackErrors = enabled;
      const result = await runCapturedEvaluation(run.options);
      assert.equal(result.evaluation.status, 'failed');
      assert.doesNotMatch(JSON.stringify(result), /canary|secret\/path|callback-error/);
      for (const [i, dir] of directories.entries()) {
        const filename = path.join(dir, 'callback-error.json');
        if (!enabled) {
          await assert.rejects(readFile(filename), { code: 'ENOENT' });
          continue;
        }
        const body = await readFile(filename, 'utf8');
        const diagnostic = JSON.parse(body);
        assert.equal(diagnostic.phase, i < 2 ? 'execute' : 'grade');
        assert.equal(diagnostic.exceptionType, i < 2 ? 'TypeError' : 'RangeError');
        assert.ok(diagnostic.frames.length > 0 && diagnostic.frames.length <= 8);
        assert.doesNotMatch(body, /canary|secret\/path/);
      }
    } finally {
      await run.cleanup();
    }
  }
});

test('definition captures immutable public descriptor/inventory and keeps expected values private', () => {
  const definition = defaultDefinition(),
    app = defineEvaluation(definition);
  definition.cases[0].input.task = 'changed';
  definition.runtime = { app: 'changed' };
  assert.equal(captureDefinition(app).cases[0].input.task, 'execute');
  assert.equal(app.descriptor.runtime.concurrency, '1');
  assert.equal(app.descriptor.expectedCases.length, 2);
  assert.ok(!JSON.stringify(app).includes('private-answer'));
  assert.throws(() => {
    app.descriptor.runtime.configRevision = 'oops';
  });
  for (const bad of [
    NaN,
    Infinity,
    undefined,
    new Date(),
    new Map(),
    { ['\ud800']: 'invalid property name' },
    { nested: { ['\udfff']: true } },
    {
      get task() {
        throw new Error('getter must not run');
      },
    },
  ]) {
    assert.throws(
      () =>
        defineEvaluation({
          ...defaultDefinition(),
          cases: [{ caseId: 'x', input: bad as never, expected: { answer: 'x' } }],
        }),
      EvaluationError,
    );
  }
  assert.throws(
    () => defineEvaluation({ ...defaultDefinition(), runtime: { configId: 'overridden' } }),
    EvaluationError,
  );
});

test('installed runner isolates verified bundles and uses exact full-side callback order with role-only artifacts', async () => {
  const trace: string[] = [],
    definition = defaultDefinition();
  let original = '';
  definition.execute = async (args) => {
    const side = args.bundle.version.parentVersionId ? 'candidate' : 'parent';
    trace.push(side + '-execute-' + args.repetition);
    assert.equal('expected' in args, false);
    assert.equal(args.bundle.payload.files[0].text, original || args.bundle.payload.files[0].text);
    original = args.bundle.payload.files[0].text;
    assert.equal(
      JSON.parse(
        await readFile(path.join(args.context.privateJobDirectory, 'binding.json'), 'utf8'),
      ).requestId,
      requestId,
    );
    args.bundle.payload.files[0].text = 'mutation';
    args.bundle.version.digest = 'mutated';
    args.input.task = 'mutation';
    return { output: { answer: 'private-answer' } };
  };
  definition.grade = async (args) => {
    trace.push(
      (trace.at(-1)!.startsWith('candidate') ? 'candidate' : 'parent') +
        '-grade-' +
        args.repetition,
    );
    assert.equal(args.expected.answer, 'private-answer');
    return { reward: 1, explanation: { publicReason: 'match' } };
  };
  const s = await setup(definition);
  try {
    const result = await runCapturedEvaluation(s.options);
    assert.equal(result.evaluation.status, 'completed');
    assert.deepEqual(trace, [
      'parent-execute-0',
      'parent-grade-0',
      'candidate-execute-0',
      'candidate-grade-0',
      'parent-execute-1',
      'parent-grade-1',
      'candidate-execute-1',
      'candidate-grade-1',
    ]);
    const j = await openJournal(s.root, s.scope);
    try {
      const saved = (await j.read())!;
      const body = await j.readBody('submit', saved);
      assert.equal(body, s.submitted[0].body);
      const index = (await j.readArtifactIndex())!;
      assert.equal(index.reportSha256, sha256(body));
      assert.equal(index.entries.length, 8);
      assert.equal(index.comparisonId, result.comparison!.id);
      const entry = index.entries.find((e) => e.role === 'output')!;
      assert.equal(
        result.comparison!.results[0].parent.outputRef,
        'acclimate:artifact:' + entry.sha256,
      );
      assert.ok(!body.includes(s.root));
      const envelope = JSON.parse(await readFile(path.join(j.directory, entry.file), 'utf8'));
      assert.deepEqual(envelope.identity, {
        requestId,
        attemptId: saved.attemptId,
        caseId: entry.caseId,
        repetition: entry.repetition,
        side: entry.side,
        versionId: entry.versionId,
        digest: entry.digest,
        role: 'output',
      });
      assert.deepEqual(envelope.value, {
        answer: 'private-answer',
      });
      assert.ok(!JSON.stringify(index).includes('private-token-canary'));
    } finally {
      await j.close();
    }
    await runCapturedEvaluation(s.options);
    assert.equal(trace.length, 8);
  } finally {
    await s.cleanup();
  }
});

test('JSON validation rejects array accessors/prototypes/serializers before invoking application code', () => {
  let getters = 0,
    serializers = 0;
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get() {
      getters++;
      return { task: 'x' };
    },
  });
  const serializer: unknown[] = [1];
  Object.defineProperty(serializer, 'toJSON', {
    value: () => {
      serializers++;
      return [];
    },
    enumerable: false,
  });
  const exotic = [1];
  Object.setPrototypeOf(exotic, {
    toJSON() {
      serializers++;
      return [];
    },
  });
  const nested: Record<string, unknown> = {};
  Object.defineProperty(nested, 'toJSON', {
    value: () => {
      serializers++;
      return null;
    },
    enumerable: false,
  });
  const proxy = new Proxy([1], {
    get() {
      getters++;
      return 1;
    },
  });
  for (const input of [accessor, serializer, exotic, { nested }, proxy])
    assert.throws(
      () =>
        defineEvaluation({
          ...defaultDefinition(),
          cases: [{ caseId: 'x', input: input as never, expected: { answer: 'x' } }],
        }),
      EvaluationError,
    );
  assert.equal(getters, 0);
  assert.equal(serializers, 0);
});

test('non-JSON adapter output identifies the field only in the private job', async () => {
  const providerResult = { observedAt: new Date() };
  assert.throws(() => assertEvaluationOutput(providerResult), /observedAt.*toISOString/);
  if (false) {
    defineEvaluation({
      ...defaultDefinition(),
      // @ts-expect-error Dates require an explicit conversion at the durable adapter boundary.
      execute: async () => ({ output: providerResult }),
      grade: async () => ({ reward: 1 }),
    });
  }
  const jobs: string[] = [];
  const definition = defaultDefinition();
  definition.execute = async ({ context }) => {
    jobs.push(context.privateJobDirectory);
    if (context.side === 'candidate') assertEvaluationOutput(providerResult);
    return { output: providerResult as never }; // Untyped provider SDK at runtime.
  };
  const s = await setup(definition);
  try {
    const result = await runCapturedEvaluation(s.options);
    assert.equal(result.comparison!.results[0].parent.error, 'output_invalid');
    assert.equal(result.comparison!.results[0].candidate.error, 'output_invalid');
    assert.ok(!s.submitted[0].body.includes('observedAt'));
    const diagnostic = JSON.parse(
      await readFile(path.join(jobs[0], 'output-validation.json'), 'utf8'),
    );
    assert.equal(diagnostic.field, 'output["observedAt"]');
    assert.match(diagnostic.reason, /toISOString/);
  } finally {
    await s.cleanup();
  }
});

test('output references reject lone surrogates as failed evidence and preserve Unicode scalar strings', async () => {
  for (const reference of ['app:\ud800', 'app:\udfff', 'app:\ud83d\ude80']) {
    const valid = reference === 'app:\ud83d\ude80';
    const definition = defaultDefinition();
    let grades = 0;
    definition.execute = async () => ({
      output: { answer: 'private-answer' },
      outputRef: reference,
    });
    definition.grade = async () => {
      grades++;
      return { reward: 1 };
    };
    const s = await setup(definition);
    try {
      const result = await runCapturedEvaluation(s.options);
      assert.equal(result.evaluation.status, valid ? 'completed' : 'failed');
      assert.equal(grades, valid ? 4 : 0);
      for (const pair of result.comparison!.results)
        for (const side of ['parent', 'candidate'] as const) {
          assert.equal(pair[side].outputRef, valid ? reference : null);
          assert.equal(pair[side].error, valid ? null : 'output_reference_invalid');
        }
    } finally {
      await s.cleanup();
    }
  }
});

test('callback result output/status/ref/usage/reward/explanation are captured before asynchronous persistence', async () => {
  const definition = defaultDefinition();
  definition.cases = [{ ...definition.cases[0], repetitions: 1 }];
  let mutations = 0;
  definition.execute = async () => {
    const result = {
      output: { answer: 'private-answer' },
      executionStatus: 'task_failed' as const,
      outputRef: 'app:original',
      usage: { costUsd: 1, inputTokens: 2 },
    };
    setTimeout(() => {
      result.output.answer = 'mutated';
      result.outputRef = 'app:mutated';
      result.usage.costUsd = 999;
      result.usage.inputTokens = 999;
      (result as { executionStatus: string }).executionStatus = 'completed';
      mutations++;
    }, 0);
    return result;
  };
  definition.grade = async ({ output }) => {
    assert.equal(output.answer, 'private-answer');
    const result = { reward: 1, explanation: { reason: 'original' } };
    setTimeout(() => {
      result.reward = 999;
      result.explanation.reason = 'mutated';
      mutations++;
    }, 0);
    return result;
  };
  const s = await setup(definition);
  try {
    const result = await runCapturedEvaluation(s.options);
    assert.equal(result.evaluation.status, 'completed');
    for (const pair of result.comparison!.results)
      for (const side of ['parent', 'candidate'] as const) {
        assert.equal(pair[side].reward, 1);
        assert.equal(pair[side].executionStatus, 'task_failed');
        assert.equal(pair[side].outputRef, 'app:original');
        assert.deepEqual(pair[side].usage, { inputTokens: 2, costUsd: 1 });
      }
    const index = JSON.parse(await readFile(path.join(s.directory, 'artifact-index.json'), 'utf8'));
    for (const entry of index.entries) {
      const envelope = JSON.parse(await readFile(path.join(s.directory, entry.file), 'utf8'));
      assert.deepEqual(
        envelope.value,
        entry.role === 'output' ? { answer: 'private-answer' } : { reason: 'original' },
      );
    }
    assert.equal(mutations, 4);
  } finally {
    await s.cleanup();
  }
});

for (const cancelAt of ['execute', 'grade'] as const)
  test(`cancellation observed during pre-${cancelAt} lifecycle GET schedules no new callback`, async () => {
    const controller = new AbortController(),
      definition = defaultDefinition();
    let executions = 0,
      grades = 0;
    definition.execute = async () => {
      executions++;
      return { output: { answer: 'x' } };
    };
    definition.grade = async () => {
      grades++;
      return { reward: 1 };
    };
    const s = await setup(definition),
      get = s.f.api.getEvaluation.bind(s.f.api);
    let reads = 0;
    s.f.api.getEvaluation = async (...args) => {
      reads++;
      const result = await get(...args);
      if (cancelAt === 'execute' ? reads === 4 : executions === 1 && grades === 0)
        controller.abort();
      return result;
    };
    try {
      const result = await runCapturedEvaluation({ ...s.options, signal: controller.signal });
      assert.equal(result.evaluation.status, 'failed');
      assert.equal(executions, cancelAt === 'execute' ? 0 : 1);
      assert.equal(grades, 0);
    } finally {
      await s.cleanup();
    }
  });

function lockOwnerPid(directory: string): number {
  const children = execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' })
    .trim()
    .split(/\s+/);
  const processes = execFileSync('ps', ['-ww', '-p', children.join(','), '-o', 'pid=,command='], {
    encoding: 'utf8',
  });
  const lock = path.join(directory, 'ownership.lock');
  const owner = processes.split('\n').find((line) => line.trimEnd().endsWith(lock));
  assert.ok(owner, 'Expected the helper holding the journal lock');
  return Number(owner.trimStart().split(/\s+/, 1)[0]);
}

test('lock helper loss during authoritative GET is checked before app execution', async () => {
  const definition = defaultDefinition();
  let executions = 0;
  definition.execute = async () => {
    executions++;
    return { output: { answer: 'x' } };
  };
  const s = await setup(definition),
    get = s.f.api.getEvaluation.bind(s.f.api);
  let reads = 0;
  s.f.api.getEvaluation = async (...args) => {
    const result = await get(...args);
    reads++;
    if (reads === 4) {
      process.kill(lockOwnerPid(s.directory), 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return result;
  };
  try {
    await assert.rejects(
      runCapturedEvaluation(s.options),
      (error) => error instanceof EvaluationError && error.code === 'journal.ownership_lost',
    );
    assert.equal(executions, 0);
    assert.equal(s.submitted.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('saved mutation body cannot be returned after ownership is lost during its file read', async () => {
  const s = await setup();
  s.options.transport.mutate = async () => {
    throw new TypeError('private-start-outage');
  };
  let journal: Awaited<ReturnType<typeof openJournal>> | undefined;
  let restore: (() => void) | undefined;
  try {
    await assert.rejects(runCapturedEvaluation(s.options));
    journal = await openJournal(s.root, s.scope);
    const state = (await journal.read())!;
    const handle = await open(path.join(s.directory, 'start-body.json'));
    const prototype = Object.getPrototypeOf(handle) as { read: (...args: any[]) => Promise<any> };
    await handle.close();
    const read = prototype.read;
    let killed = false;
    restore = () => {
      prototype.read = read;
    };
    prototype.read = async function (...args: unknown[]) {
      const result = await read.apply(this, args);
      if (!killed) {
        const pid = lockOwnerPid(s.directory);
        const lost = new Promise<void>((resolve) =>
          journal!.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        process.kill(pid, 'SIGKILL');
        killed = true;
        await lost;
      }
      return result;
    };
    await assert.rejects(
      journal.readBody('start', state),
      (error) => error instanceof EvaluationError && error.code === 'journal.ownership_lost',
    );
    assert.equal(killed, true);
    assert.equal(s.submitted.length, 0);
  } finally {
    restore?.();
    await journal?.close();
    await s.cleanup();
  }
});

test('observed interruption returns the validated snapshot without a second failing GET', async () => {
  const s = await setup(),
    get = s.f.api.getEvaluation.bind(s.f.api);
  let reads = 0;
  s.f.api.getEvaluation = async (...args) => {
    reads++;
    if (reads > 4) throw new TypeError('private-outage-canary');
    if (reads === 4) s.f.request = { ...s.f.request, status: 'interrupted' };
    return get(...args);
  };
  try {
    const result = await runCapturedEvaluation(s.options);
    assert.equal(result.executionState, 'interrupted');
    assert.equal(result.evaluation.status, 'interrupted');
    assert.equal(reads, 4);
    assert.equal(s.submitted.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('comparison/index crash window is repaired before finish and on terminal recovery without callbacks', async () => {
  const definition = defaultDefinition();
  let executions = 0;
  definition.execute = async () => {
    executions++;
    return { output: { answer: 'x' } };
  };
  const s = await setup(definition),
    mutate = s.options.transport.mutate;
  let first = true;
  s.options.transport.mutate = async <T>(...args: Parameters<typeof mutate>) => {
    if (args[0] === 'finish' && first) {
      first = false;
      throw new TypeError('lost finish');
    }
    return mutate<T>(...args);
  };
  try {
    await assert.rejects(runCapturedEvaluation(s.options));
    const filename = path.join(s.directory, 'artifact-index.json'),
      index = JSON.parse(await readFile(filename, 'utf8'));
    delete index.comparisonId;
    index.reportSha256 = '';
    await writeFile(filename, JSON.stringify(index), { mode: 0o600 });
    const result = await runCapturedEvaluation(s.options);
    const repaired = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(repaired.comparisonId, result.comparison!.id);
    assert.ok(repaired.reportSha256.startsWith('sha256:'));
    assert.equal(executions, 4);
    assert.equal(s.submitted.length, 1);
    delete repaired.comparisonId;
    await writeFile(filename, JSON.stringify(repaired), { mode: 0o600 });
    await runCapturedEvaluation(s.options);
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).comparisonId, result.comparison!.id);
    assert.equal(executions, 4);
  } finally {
    await s.cleanup();
  }
});

test('uncertainty from one execute fails that arm only, is never retried and leaves a marker', async () => {
  const definition = defaultDefinition();
  let executions = 0;
  definition.execute = async () => {
    executions++;
    if (executions === 1)
      throw new ExecutionUncertainError({ cause: new Error('turn timed out; stop unconfirmed') });
    return { output: { answer: 'private-answer' } };
  };
  const s = await setup(definition);
  try {
    const result = await runCapturedEvaluation({ ...s.options, retryMissingTrial: true });
    assert.equal(executions, 4);
    assert.equal(s.submitted.length, 1);
    const report = JSON.parse(s.submitted[0].body) as ComparisonRequest;
    const first = report.results.find((pair) => pair.repetition === 0)!;
    const uncertainSide = first.parent.error === 'execution_uncertain' ? first.parent : first.candidate;
    assert.equal(uncertainSide.executionStatus, 'infrastructure_failed');
    assert.equal(uncertainSide.error, 'execution_uncertain');
    assert.equal(
      report.results.flatMap((pair) => [pair.parent, pair.candidate]).filter((arm) => arm.reward === 1)
        .length,
      3,
    );
    assert.ok(result.comparison);
    const jobs = path.join(s.directory, 'jobs');
    const markers = [];
    for (const job of await readdir(jobs))
      if (await readFile(path.join(jobs, job, 'uncertain.json'), 'utf8').catch(() => null))
        markers.push(job);
    assert.equal(markers.length, 1);
  } finally {
    await s.cleanup();
  }
});

for (const stage of ['grade'] as const)
  test(`uncertainty from ${stage} stops every later callback and leaves an unreplayable marker`, async () => {
    const definition = defaultDefinition();
    let executions = 0,
      grades = 0;
    definition.execute = async () => {
      executions++;
      return { output: { answer: 'x' } };
    };
    definition.grade = async () => {
      grades++;
      throw new ExecutionUncertainError();
    };
    const s = await setup(definition);
    try {
      await assert.rejects(
        runCapturedEvaluation(s.options),
        (error) =>
          error instanceof EvaluationError &&
          error.code === 'execution.uncertain' &&
          error.diagnostic.executionState === 'may_have_started',
      );
      const saved = JSON.parse(await readFile(path.join(s.directory, 'attempt.json'), 'utf8'));
      assert.equal(saved.executionStarted, true);
      assert.equal(saved.report, undefined);
      assert.equal(s.submitted.length, 0);
      await assert.rejects(
        runCapturedEvaluation(s.options),
        (error) =>
          error instanceof EvaluationError &&
          error.code === 'execution.uncertain' &&
          error.diagnostic.executionState === 'may_have_started',
      );
      assert.equal(executions, 1);
      assert.equal(grades, 1);
    } finally {
      await s.cleanup();
    }
  });

test('recovery diagnostics preserve durable certainty when the initial lifecycle read fails', async () => {
  for (const sealed of [false, true]) {
    const definition = defaultDefinition();
    let executions = 0;
    definition.execute = async () => {
      executions++;
      return { output: { answer: 'private-answer' } };
    };
    // An uncertain grade leaves started work without a sealed report.
    if (!sealed)
      definition.grade = async () => {
        throw new ExecutionUncertainError();
      };
    const s = await setup(definition);
    const mutate = s.options.transport.mutate;
    s.options.transport.mutate = async <T>(...args: Parameters<typeof mutate>) => {
      if (args[0] === 'submit') throw new TypeError('private-submit-outage');
      return mutate<T>(...args);
    };
    try {
      await assert.rejects(runCapturedEvaluation(s.options));
      const before = executions;
      s.f.api.getEvaluation = async () => {
        throw new TypeError('private-read-outage');
      };
      await assert.rejects(
        runCapturedEvaluation(s.options),
        (error) =>
          error instanceof EvaluationError &&
          error.code === (sealed ? 'submission.unconfirmed' : 'execution.uncertain') &&
          error.diagnostic.executionState === (sealed ? 'report_saved' : 'may_have_started'),
      );
      assert.equal(executions, before);
    } finally {
      await s.cleanup();
    }
  }
});

test('retained start snapshot is reconciled with an interruption before callbacks', async () => {
  const definition = defaultDefinition();
  let executions = 0;
  definition.execute = async () => {
    executions++;
    return { output: { answer: 'x' } };
  };
  const s = await setup(definition);
  const mutate = s.options.transport.mutate;
  s.options.transport.mutate = async <T>(...args: Parameters<typeof mutate>) => {
    const result = await mutate<T>(...args);
    if (args[0] === 'start') s.f.request = { ...s.f.request, status: 'interrupted' };
    return result;
  };
  try {
    const result = await runCapturedEvaluation(s.options);
    assert.equal(result.executionState, 'interrupted');
    assert.equal(executions, 0);
    assert.equal(s.submitted.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('saved exact submission and original key recover without execution after response loss', async () => {
  const definition = defaultDefinition();
  let executions = 0;
  definition.execute = async () => {
    executions++;
    return { output: { answer: 'x' } };
  };
  const s = await setup(definition),
    mutate = s.options.transport.mutate;
  let first = true;
  s.options.transport.mutate = async <T>(...args: Parameters<typeof mutate>) => {
    const result = await mutate<T>(...args);
    if (args[0] === 'submit' && first) {
      first = false;
      throw new TypeError('private transport canary');
    }
    return result;
  };
  try {
    await assert.rejects(
      runCapturedEvaluation(s.options),
      (error) =>
        error instanceof EvaluationError &&
        error.code === 'submission.unconfirmed' &&
        !String(error).includes('private transport canary'),
    );
    assert.equal((await runCapturedEvaluation(s.options)).evaluation.status, 'completed');
    assert.equal(executions, 4);
    assert.equal(s.submitted.length, 2);
    assert.deepEqual(s.submitted[0], s.submitted[1]);
  } finally {
    await s.cleanup();
  }
});

for (const kind of ['start', 'finish'] as const)
  test(`recovery rejects a hash-consistent ${kind} body with a different attempt before mutation`, async () => {
    const s = await setup();
    const mutate = s.options.transport.mutate;
    s.options.transport.mutate = async <T>(...args: Parameters<typeof mutate>) => {
      if (args[0] === kind) throw new TypeError('private-mutation-outage');
      return mutate<T>(...args);
    };
    try {
      await assert.rejects(runCapturedEvaluation(s.options));
      const filename = path.join(s.directory, 'attempt.json');
      const state = JSON.parse(await readFile(filename, 'utf8')) as AttemptJournal;
      const body = JSON.stringify({
        attemptId: '90000000-0000-4000-8000-000000000009',
        ...(kind === 'finish' ? { comparisonId: state.comparisonId } : {}),
      });
      state.wireBodies![kind] = {
        file: `${kind}-body.json`,
        sha256: sha256(body),
        bytes: Buffer.byteLength(body),
      };
      await writeFile(path.join(s.directory, `${kind}-body.json`), body, { mode: 0o600 });
      await writeFile(filename, JSON.stringify(state), { mode: 0o600 });
      const sent: string[] = [];
      s.options.transport.mutate = async <T>(...args: Parameters<typeof mutate>) => {
        sent.push(args[0]);
        return mutate<T>(...args);
      };
      await assert.rejects(
        runCapturedEvaluation(s.options),
        (error) => error instanceof EvaluationError && error.code === 'journal.invalid',
      );
      assert.deepEqual(sent, []);
    } finally {
      await s.cleanup();
    }
  });

test('duplicate decoded journal identity refuses recovery before callbacks or mutation', async () => {
  for (const key of ['attemptId', String.raw`\u0061ttemptId`]) {
    const definition = defaultDefinition();
    let executions = 0;
    definition.execute = async () => {
      executions++;
      return { output: { answer: 'private-answer' } };
    };
    const s = await setup(definition);
    const mutate = s.options.transport.mutate;
    s.options.transport.mutate = async () => {
      throw new TypeError('private-start-outage');
    };
    try {
      await assert.rejects(runCapturedEvaluation(s.options));
      const filename = path.join(s.directory, 'attempt.json');
      const text = await readFile(filename, 'utf8');
      await writeFile(filename, `{"${key}":"private-duplicate-canary",${text.slice(1)}`, {
        mode: 0o600,
      });
      const sent: string[] = [];
      s.options.transport.mutate = async <T>(...args: Parameters<typeof mutate>) => {
        sent.push(args[0]);
        return mutate<T>(...args);
      };
      await assert.rejects(
        runCapturedEvaluation(s.options),
        (error) =>
          error instanceof EvaluationError &&
          error.code === 'config.schema' &&
          !JSON.stringify(error).includes('private-duplicate-canary'),
      );
      assert.deepEqual(sent, []);
      assert.equal(executions, 0);
    } finally {
      await s.cleanup();
    }
  }
});

test('cooperative abort retains a full inventory with missing grades and does not schedule later work', async () => {
  const controller = new AbortController(),
    definition = defaultDefinition();
  let executions = 0,
    grades = 0;
  definition.execute = async () => {
    executions++;
    controller.abort();
    return { output: { answer: 'x' } };
  };
  definition.grade = async () => {
    grades++;
    return { reward: 1 };
  };
  const s = await setup(definition);
  try {
    const result = await runCapturedEvaluation({ ...s.options, signal: controller.signal });
    assert.equal(result.evaluation.status, 'failed');
    assert.equal(result.comparison!.results.length, 2);
    assert.equal(executions, 1);
    assert.equal(grades, 0);
    assert.ok(
      result.comparison!.results.every(
        (p) => p.parent.reward === null && p.candidate.reward === null,
      ),
    );
  } finally {
    await s.cleanup();
  }
});

test('terminal recovery refuses a different local assertion with the same request/attempt/version binding', async () => {
  const s = await setup();
  try {
    await runCapturedEvaluation(s.options);
    const filename = path.join(s.directory, 'attempt.json');
    const state = JSON.parse(await readFile(filename, 'utf8')) as AttemptJournal;
    state.report!.results[0].parent.reward = 123;
    await writeFile(filename, JSON.stringify(state), { mode: 0o600 });
    await assert.rejects(
      runCapturedEvaluation(s.options),
      (error) => error instanceof EvaluationError && error.code === 'evidence.identity_mismatch',
    );
    assert.equal(s.submitted.length, 1);
  } finally {
    await s.cleanup();
  }
});

test('a saved report without the original submission body cannot be replayed', async () => {
  const s = await setup();
  const mutate = s.options.transport.mutate;
  s.options.transport.mutate = async <T>(...args: Parameters<typeof mutate>) => {
    if (args[0] === 'submit') throw new TypeError('lost response');
    return mutate<T>(...args);
  };
  try {
    await assert.rejects(runCapturedEvaluation(s.options));
    const filename = path.join(s.directory, 'attempt.json');
    const state = JSON.parse(await readFile(filename, 'utf8')) as AttemptJournal;
    delete state.wireBodies.submit;
    await writeFile(filename, JSON.stringify(state), { mode: 0o600 });
    s.options.transport.mutate = mutate;
    await assert.rejects(
      runCapturedEvaluation(s.options),
      (error) => error instanceof EvaluationError && error.code === 'journal.invalid',
    );
    assert.equal(s.submitted.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('foreign Python journal refuses ownership and scope serialization is explicit', async () => {
  const s = await setup();
  try {
    const journal = await openJournal(s.root, s.scope);
    await journal.close();
    await writeFile(path.join(s.directory, 'attempt.python.json'), '{}', { mode: 0o600 });
    await assert.rejects(
      runCapturedEvaluation(s.options),
      (error) => error instanceof EvaluationError && error.code === 'journal.foreign',
    );
    assert.equal(
      serializeScope(s.scope),
      JSON.stringify({ serviceUrl, projectId, bundleId, requestId, evaluatorPrincipalId }),
    );
    assert.equal(s.f.events.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('public config/handoff preflight and run work through bounded authenticated HTTP with retained headers', async () => {
  let callbacks = 0;
  const definition = defaultDefinition();
  definition.execute = async () => {
    callbacks++;
    return { output: { answer: 'private-answer' } };
  };
  definition.grade = async () => {
    callbacks++;
    return { reward: 1 };
  };
  const app = defineEvaluation(definition),
    f = fixture(app.descriptor);
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-public-runner-'));
  let comparison: Comparison | undefined,
    capabilityAvailable = true,
    missingResource = '',
    inventoryMode = '',
    denyAccess = false,
    reads = 0;
  const headers: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      reads++;
      if (req.headers.authorization !== 'Bearer private-public-test-token') {
        res.writeHead(401);
        res.end(
          JSON.stringify({
            error: { code: 'unauthenticated', message: 'private token must not print' },
          }),
        );
        return;
      }
      const pathname = new URL(req.url!, 'http://localhost').pathname;
      if (
        denyAccess ||
        (missingResource === 'request' && pathname.includes('/evaluation-requests/')) ||
        (missingResource === 'version' && pathname.includes('/versions/'))
      ) {
        res.writeHead(denyAccess ? 403 : 404);
        res.end(JSON.stringify({ error: { code: 'not_found', message: 'PRIVATE_HTTP_CANARY' } }));
        return;
      }
      let value: unknown;
      if (pathname.endsWith('/evaluation-capabilities')) {
        if (!capabilityAvailable) {
          res.writeHead(404);
          res.end('{}');
          return;
        }
        value = {
          schemaVersion: 1,
          projectId,
          principalId: evaluatorPrincipalId,
          checkedAt: new Date().toISOString(),
          readUnpublished: true,
          writeEvaluation: true,
          retainedEvaluationOperations: true,
        };
      } else if (req.method === 'GET' && pathname === `/v1/workspaces/${projectId}/bundles`) {
        const cursor = new URL(req.url!, 'http://localhost').searchParams.get('cursor');
        value =
          inventoryMode === 'loop'
            ? { items: [], nextCursor: 'same' }
            : inventoryMode === 'limit'
              ? { items: [], nextCursor: String(Number(cursor ?? 0) + 1) }
              : inventoryMode === 'malformed'
                ? { items: null, nextCursor: null }
                : inventoryMode === 'secondPage' && !cursor
                  ? { items: [], nextCursor: 'page-two' }
                  : {
                      items: missingResource === 'bundle' ? [] : [{ id: bundleId }],
                      nextCursor: null,
                    };
      } else if (req.method === 'GET' && pathname.endsWith('/evaluation-requests/' + requestId))
        value = f.request;
      else if (req.method === 'GET' && pathname.includes('/comparisons/')) value = comparison;
      else if (req.method === 'GET' && pathname.endsWith('/payload')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(f.bytes.get(pathname.split('/').at(-2)!));
        return;
      } else if (req.method === 'GET' && pathname.includes('/versions/'))
        value = f.version(pathname.split('/').at(-1)!);
      else if (req.method === 'POST') {
        headers.push(String(req.headers['x-acclimate-durable-operation']));
        let text = '';
        for await (const chunk of req) text += chunk;
        const body = JSON.parse(text),
          key = String(req.headers['idempotency-key']);
        if (pathname.endsWith('/start'))
          value = await f.api.startEvaluation(projectId, bundleId, requestId, body, key);
        else if (pathname.endsWith('/finish'))
          value = await f.api.finishEvaluation(projectId, bundleId, requestId, body, key);
        else if (pathname.endsWith('/comparisons'))
          value = comparison = await f.api.createComparison(projectId, bundleId, body, key);
        else throw new Error('Unexpected mutation');
      } else throw new Error('Unexpected path');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    } catch {
      res.writeHead(500);
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port;
  const configPath = path.join(root, 'config.json'),
    journalRoot = path.join(root, 'journals');
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      serviceUrl: origin,
      projectId,
      evaluatorPrincipalId,
      evaluatorToken: 'private-public-test-token',
      journalRoot,
    }),
    { mode: 0o600 },
  );
  const handoff: EvaluationHandoff = {
    schemaVersion: 1,
    serviceUrl: origin,
    projectId,
    bundleId,
    requestId,
    configuration: structuredClone(app.descriptor),
  };
  try {
    const before = reads;
    await assert.rejects(
      runEvaluation({
        app,
        configPath,
        handoff: { ...handoff, serviceUrl: 'https://untrusted.example' },
      }),
      EvaluationError,
    );
    assert.equal(reads, before);
    const check = await preflightEvaluation({ app, configPath, target: { handoff } });
    assert.equal(check.status, 'ready');
    assert.equal(check.authorization, 'verified');
    assert.equal(f.events.length, 0);
    capabilityAvailable = false;
    const unsupported = await preflightEvaluation({ app, configPath, target: { handoff } });
    assert.equal(unsupported.status, 'blocked');
    assert.equal(unsupported.authorization, 'unverified');
    assert.equal(unsupported.nextAction, 'upgrade_service');
    assert.equal(f.events.length, 0);
    capabilityAvailable = true;
    for (const [resource, checkName] of [
      ['bundle', 'targetBundle'],
      ['request', 'targetRequest'],
      ['version', 'versions'],
    ]) {
      missingResource = resource;
      const blocked = await preflightEvaluation({ app, configPath, target: { handoff } });
      assert.equal(blocked.status, 'blocked');
      assert.equal(blocked.authorization, 'verified');
      assert.equal(blocked.nextAction, 'fix_config');
      assert.deepEqual(blocked.checks.at(-1), {
        check: checkName,
        status: 'failed',
        code: `${resource}.missing`,
      });
      assert.ok(!JSON.stringify(blocked).includes('PRIVATE_HTTP_CANARY'));
      assert.ok(!JSON.stringify(blocked).includes(root));
    }
    missingResource = 'bundle';
    assert.equal(
      (await preflightEvaluation({ app, configPath, target: { bundleId } })).status,
      'blocked',
    );
    missingResource = '';
    inventoryMode = 'secondPage';
    assert.equal(
      (await preflightEvaluation({ app, configPath, target: { bundleId } })).status,
      'ready',
    );
    for (const mode of ['loop', 'malformed', 'limit']) {
      inventoryMode = mode;
      const blocked = await preflightEvaluation({ app, configPath, target: { bundleId } });
      assert.equal(blocked.status, 'blocked');
      assert.equal(
        blocked.checks.at(-1)?.code,
        mode === 'limit' ? 'evidence.incomplete' : 'evidence.malformed',
      );
    }
    inventoryMode = '';
    denyAccess = true;
    const denied = await preflightEvaluation({ app, configPath, target: { handoff } });
    assert.equal(denied.authorization, 'denied');
    assert.equal(denied.checks.at(-1)?.code, 'auth.denied');
    assert.equal(denied.nextAction, 'ask_operator');
    assert.equal(headers.length, 0);
    assert.equal(f.events.length, 0);
    assert.equal(callbacks, 0);
    assert.equal(f.request.status, 'requested');
    denyAccess = false;
    const result = await runEvaluation({ app, configPath, handoff });
    assert.equal(result.evaluation.status, 'completed');
    assert.deepEqual(headers, ['true', 'true', 'true']);
    assert.equal(
      (await runEvaluation({ app, configPath, handoff })).comparison!.id,
      result.comparison!.id,
    );
    assert.equal(headers.length, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('missing python3 blocks public preflight and run before claim or callbacks in an isolated process', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-no-python-'));
  const requests: Array<{ method: string; path: string }> = [];
  const token = 'missing-python-test-token';
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', path: req.url ?? '' });
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    if (req.method === 'GET' && req.url === `/v1/workspaces/${projectId}/evaluation-capabilities`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          projectId,
          principalId: evaluatorPrincipalId,
          checkedAt: new Date().toISOString(),
          readUnpublished: true,
          writeEvaluation: true,
          retainedEvaluationOperations: true,
        }),
      );
      return;
    }
    res.writeHead(500);
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serviceUrl =
    'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port;
  const configPath = path.join(directory, 'evaluator.json'),
    journalRoot = path.join(directory, 'journals');
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      serviceUrl,
      projectId,
      evaluatorPrincipalId,
      evaluatorToken: token,
      journalRoot,
    }),
    { mode: 0o600 },
  );
  const moduleUrl = pathToFileURL(path.resolve('packages/sdk/src/evaluation/index.ts')).href;
  const source = `import assert from 'node:assert/strict';
import {defineEvaluation,preflightEvaluation,runEvaluation} from ${JSON.stringify(moduleUrl)};
let callbacks=0;
const app=defineEvaluation({configId:'no-python',configRevision:'1',datasetRevision:'fixture1',graderRevision:'fixture1',runtime:{app:'fixture'},execution:'model-free',cases:[{caseId:'one',input:null,expected:null}],execute:async()=>{callbacks++;return{output:null};},grade:async()=>{callbacks++;return{reward:1};}});
const configPath=${JSON.stringify(configPath)};
const handoff={schemaVersion:1,serviceUrl:${JSON.stringify(serviceUrl)},projectId:${JSON.stringify(projectId)},bundleId:${JSON.stringify(bundleId)},requestId:${JSON.stringify(requestId)},configuration:app.descriptor};
const preflight=await preflightEvaluation({app,configPath,target:{handoff}});
assert.equal(preflight.status,'blocked');
assert.ok(preflight.checks.some(check=>check.code==='runtime.unsupported'));
let runCode;
try{await runEvaluation({app,configPath,handoff});}catch(error){runCode=error.code;}
assert.equal(runCode,'runtime.unsupported');assert.equal(callbacks,0);
console.log(JSON.stringify({preflight:'blocked',runCode,callbacks}));`;
  try {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source],
      { env: { PATH: '', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += String(data);
    });
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), {
      preflight: 'blocked',
      runCode: 'runtime.unsupported',
      callbacks: 0,
    });
    assert.ok(
      requests.every(
        (request) => request.method === 'GET' && request.path.endsWith('/evaluation-capabilities'),
      ),
    );
    assert.ok(
      !(await readdir(journalRoot, { recursive: true })).some((file) =>
        file.endsWith('attempt.json'),
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('committed submit with oversized decoded HTTP response recovers exact report/key and original comparison without callbacks', async () => {
  const definition = defaultDefinition();
  let executions = 0,
    grades = 0;
  definition.execute = async () => {
    executions++;
    return { output: { answer: 'private-answer' } };
  };
  definition.grade = async ({ output, expected }) => {
    grades++;
    return { reward: Number(output.answer === expected.answer) };
  };
  const app = defineEvaluation(definition),
    f = fixture(app.descriptor);
  const directory = await mkdtemp(
    path.join(await realpath(tmpdir()), 'acclimate-response-budget-'),
  );
  const token = 'response-budget-fixture-token',
    base = `/v1/workspaces/${projectId}/bundles/${bundleId}`;
  const submitted: Array<{ key: string; body: string }> = [],
    retained = new Map<string, { body: string; comparison: Comparison }>();
  const handlerErrors: unknown[] = [];
  let originalComparison: Comparison | undefined,
    oversizedDecodedBytes = 0,
    compressedBytes = 0;
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    try {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      const route = new URL(req.url!, 'http://localhost').pathname;
      if (req.method === 'GET' && route === `/v1/workspaces/${projectId}/evaluation-capabilities`)
        return send(200, await f.api.getEvaluationCapabilities(projectId));
      assert.ok(route.startsWith(base + '/'));
      if (req.method === 'GET' && route === `${base}/evaluation-requests/${requestId}`)
        return send(200, await f.api.getEvaluation(projectId, bundleId, requestId));
      if (
        req.method === 'GET' &&
        originalComparison &&
        route === `${base}/comparisons/${originalComparison.id}`
      )
        return send(200, originalComparison);
      const version = /\/versions\/([^/]+)(\/payload)?$/.exec(route);
      if (req.method === 'GET' && version) {
        if (version[2]) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(f.bytes.get(version[1]));
          return;
        }
        return send(200, f.version(version[1]));
      }
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['x-acclimate-durable-operation'], 'true');
      const key = String(req.headers['idempotency-key'] ?? '');
      assert.match(key, /^[\x20-\x7e]{1,128}$/);
      let body = '';
      for await (const chunk of req) body += chunk;
      const value = JSON.parse(body);
      if (route === `${base}/evaluation-requests/${requestId}/start`)
        return send(200, await f.api.startEvaluation(projectId, bundleId, requestId, value, key));
      if (route === `${base}/evaluation-requests/${requestId}/finish`)
        return send(200, await f.api.finishEvaluation(projectId, bundleId, requestId, value, key));
      assert.equal(route, `${base}/comparisons`);
      submitted.push({ key, body });
      const saved = retained.get(key);
      if (saved) {
        assert.equal(body, saved.body);
        return send(201, saved.comparison);
      }
      originalComparison = await f.api.createComparison(projectId, bundleId, value, key);
      retained.set(key, { body, comparison: structuredClone(originalComparison) });
      // The write has committed. A tiny compressed response expands beyond the
      // decoded 4 MiB client budget, so Content-Length is not a sufficient guard.
      const oversized = JSON.stringify({
          ...originalComparison,
          padding: 'x'.repeat(4 * 1024 * 1024),
        }),
        compressed = gzipSync(oversized);
      oversizedDecodedBytes = Buffer.byteLength(oversized);
      compressedBytes = compressed.byteLength;
      res.writeHead(201, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': compressed.byteLength,
      });
      res.end(compressed);
    } catch (error) {
      handlerErrors.push(error);
      if (!res.headersSent) send(500, {});
      else res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port;
  const configPath = path.join(directory, 'evaluator.json'),
    journalRoot = path.join(directory, 'journals');
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      serviceUrl: origin,
      projectId,
      evaluatorPrincipalId,
      evaluatorToken: token,
      journalRoot,
    }),
    { mode: 0o600 },
  );
  const handoff: EvaluationHandoff = {
    schemaVersion: 1,
    serviceUrl: origin,
    projectId,
    bundleId,
    requestId,
    configuration: structuredClone(app.descriptor),
  };
  const scope: JournalScope = {
    serviceUrl: origin,
    projectId,
    bundleId,
    requestId,
    evaluatorPrincipalId,
  };
  try {
    await assert.rejects(
      runEvaluation({ app, configPath, handoff }),
      (error) =>
        error instanceof EvaluationError &&
        error.code === 'transport.response_too_large' &&
        error.diagnostic.executionState === 'report_saved',
    );
    assert.ok(oversizedDecodedBytes > 4 * 1024 * 1024);
    assert.ok(compressedBytes < 4 * 1024 * 1024);
    assert.equal(f.request.status, 'running');
    assert.equal(f.request.comparisonId, null);
    assert.equal(executions, 4);
    assert.equal(grades, 4);
    assert.equal(retained.size, 1);
    const journal = await openJournal(journalRoot, scope);
    try {
      const state = (await journal.read())!;
      assert.ok(state.report);
      assert.equal(state.comparisonId, undefined);
      assert.equal(state.keys.submit, submitted[0].key);
      const exactBody = await journal.readBody('submit', state);
      assert.equal(exactBody, submitted[0].body);
      assert.deepEqual(JSON.parse(exactBody), state.report);
      assert.equal(state.wireBodies!.submit!.sha256, sha256(exactBody));
    } finally {
      await journal.close();
    }
    const beforeRetry = { executions, grades };
    const recovered = await runEvaluation({ app, configPath, handoff });
    assert.equal(recovered.evaluation.status, 'completed');
    assert.equal(recovered.comparison!.id, originalComparison!.id);
    assert.deepEqual({ executions, grades }, beforeRetry);
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted[0], submitted[1]);
    assert.deepEqual(
      f.events.map((event) => event.kind),
      ['start', 'submit', 'finish'],
    );
    assert.deepEqual(handlerErrors, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
