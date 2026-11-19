import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './support.mjs';
import { runInProcessGroup } from '../harness-process.mjs';
import {
  freezeSourceInventory, gradeRepositoryTests, inspectNativeJob, listNativeJobs, nodeTestRunner, processGroupAlive,
  redactSecrets,
} from '../repository-job.mjs';

const adapters = fileURLToPath(new URL('./fake-adapters.mjs', import.meta.url));
const grouped = (exportName, extra = {}) => async (task) => runInProcessGroup({
  module: adapters, exportName, cwd: task.context.cwd, env: { PATH: process.env.PATH },
  timeoutMs: extra.timeoutMs ?? 15_000, graceMs: 150, killWaitMs: 3000, signal: task.signal, acknowledge: task.acknowledge,
  task: { context: task.context, policy: extra },
});

test('a confirmed timeout fails one task, keeps the partial diff and kills the process group', { timeout: 20_000 }, async () => {
  await fixture(async ({ run, base, options, artifacts, cleaned }) => {
    const pidFile = path.join(base, 'grandchild.pid');
    const result = await run({ runHarness: grouped('hangIgnoringAbort', { pidFile, timeoutMs: 5000 }) });
    assert.equal(result.executionStatus, 'task_failed');
    assert.equal(result.output.result, 'partial answer');
    const { repository } = result.output;
    assert.equal(repository.failure.reason, 'timeout');
    assert.equal(repository.failure.code, 'native.turn_timeout');
    assert.deepEqual(repository.changes.map((change) => [change.path, change.status]),
      [['added.txt', 'added'], ['delete.txt', 'unchanged'], ['src/retry.js', 'modified']]);
    const failure = JSON.parse(await readFile(repository.failure.file, 'utf8'));
    assert.equal(failure.reason, 'timeout');
    assert.match(failure.message, /5000 ms turn timeout/);
    assert.equal(path.dirname(repository.failure.file), path.join(artifacts, options.context.jobId));
    const grandchild = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(grandchild, 0), { code: 'ESRCH' });
    const record = await inspectNativeJob(options.context.privateJobDirectory);
    assert.equal(record.facts.confirmedStopped, true);
    assert.equal(record.facts.cleaned, true);
    const group = record.externalHandles.find((handle) => handle.kind === 'process-group');
    assert.equal(processGroupAlive(Number(group.value)), false);
    assert.equal(record.externalHandle.kind, 'fake-session');
    assert.equal(cleaned(), 1);
  });
});

test('an unexpected harness exit with a confirmed stop is a crash, not uncertainty', { timeout: 20_000 }, async () => {
  await fixture(async ({ run }) => {
    const result = await run({ runHarness: grouped('crash') });
    assert.equal(result.executionStatus, 'task_failed');
    assert.equal(result.output.repository.failure.reason, 'crash');
    assert.equal(result.output.repository.failure.code, 'native.harness_crash');
    assert.ok(result.output.repository.changes.some((change) => change.path === 'src/retry.js' && change.status === 'modified'));
  });
});

test('provider errors keep a private redacted failure.json and name it in the error', { timeout: 20_000 }, async () => {
  await fixture(async ({ run, options, cleaned }) => {
    let thrown;
    await assert.rejects(run({ runHarness: grouped('providerFailure') }), (error) => {
      thrown = error;
      return error.code === 'native.harness_failed' && /failure\.json/.test(error.message) && /fake\.provider/.test(error.message);
    });
    const failure = JSON.parse(await readFile(thrown.path, 'utf8'));
    assert.equal(failure.code, 'fake.provider');
    assert.match(failure.message, /upstream 500/);
    assert.doesNotMatch(failure.message, /sk-test-1234567890abcdef|abcdefghijklmnop/);
    assert.equal(((await lstat(thrown.path)).mode & 0o777), 0o600);
    const record = await inspectNativeJob(options.context.privateJobDirectory);
    assert.equal(record.facts.resultsRetained, true);
    assert.equal(cleaned(), 1);
  });
});

test('an adapter that cannot confirm its own stop is contained by the process group', { timeout: 20_000 }, async () => {
  await fixture(async ({ run }) => {
    const result = await run({ runHarness: grouped('unconfirmed') });
    assert.equal(result.executionStatus, 'task_failed');
    assert.equal(result.output.repository.failure.reason, 'crash');
  });
});

test('evaluator cancellation stops the group, retains results and reports CallbackCancelled', { timeout: 20_000 }, async () => {
  await fixture(async ({ run, base, options }) => {
    const controller = new AbortController();
    const harness = grouped('hangIgnoringAbort', { pidFile: path.join(base, 'cancel.pid'), timeoutMs: 20_000 });
    await assert.rejects(
      run({
        signal: controller.signal,
        runHarness: (task) => harness({
          ...task,
          // Cancel once the agent is running, like an operator interrupting the comparison.
          acknowledge: async (handle) => {
            await task.acknowledge(handle);
            if (handle.kind === 'fake-session') setTimeout(() => controller.abort(), 50);
          },
        }),
      }),
      { name: 'CallbackCancelled' },
    );
    const record = await inspectNativeJob(options.context.privateJobDirectory);
    assert.equal(record.facts.resultsRetained, true);
    assert.equal(record.facts.cleaned, true);
  });
});

test('a rejected harness promise is uncertain and carries its cause', async () => {
  await fixture(async ({ run, options }) => {
    await assert.rejects(run({ runHarness: async () => { throw new Error('socket hang up'); } }), (error) =>
      error.name === 'ExecutionUncertainError' && error.cause?.message === 'socket hang up');
    const record = await inspectNativeJob(options.context.privateJobDirectory);
    assert.equal(record.facts.confirmedStopped, false);
  });
});

test('files outside resultFiles are reported, and resultFiles globs retain them', async () => {
  await fixture(async ({ run }) => {
    const write = async ({ context }) => {
      await mkdir(path.join(context.cwd, 'src/lib'), { recursive: true });
      await writeFile(path.join(context.cwd, 'src/lib/id.js'), 'export const id = 1;\n');
      await writeFile(path.join(context.cwd, 'src/retry.js'), 'export { id as key } from "./lib/id.js";\n');
      await mkdir(path.join(context.cwd, 'node_modules/x'), { recursive: true });
      await writeFile(path.join(context.cwd, 'node_modules/x/index.js'), '');
      return { stopped: true, output: null };
    };
    const literal = await run({ resultFiles: ['src/retry.js'], runHarness: write });
    assert.deepEqual(literal.output.repository.undeclaredChanges, {
      count: 1, paths: ['src/lib/id.js'], truncated: false, unsupportedEntries: [], complete: true,
    });
    assert.deepEqual(literal.output.repository.changes.map((change) => change.path), ['src/retry.js']);
  });
  await fixture(async ({ run, options, artifacts }) => {
    const result = await run({
      resultFiles: ['src/**'],
      runHarness: async ({ context }) => {
        await mkdir(path.join(context.cwd, 'src/lib'), { recursive: true });
        await writeFile(path.join(context.cwd, 'src/lib/id.js'), 'export const id = 1;\n');
        return { stopped: true, output: null };
      },
    });
    assert.deepEqual(result.output.repository.changes.map((change) => [change.path, change.status]),
      [['src/lib/id.js', 'added'], ['src/retry.js', 'unchanged']]);
    assert.equal(result.output.repository.undeclaredChanges.count, 0);
    const grade = await gradeRepositoryTests({
      source: options.source, artifactRoot: artifacts, resultFiles: ['src/**'], repository: result.output.repository,
      runTests: async ({ cwd }) => (await readFile(path.join(cwd, 'src/lib/id.js'), 'utf8')).includes('id = 1'),
    });
    assert.equal(grade.reward, 1);
    await assert.rejects(gradeRepositoryTests({
      source: options.source, artifactRoot: artifacts, resultFiles: ['src/retry.js'], repository: result.output.repository,
      runTests: async () => true,
    }), { code: 'native.grading_binding' });
  });
});

test('the default grader reports test counts, a distinct test_timeout and a fractional reward', { timeout: 30_000 }, async () => {
  await fixture(async ({ run, source: sourceRoot, artifacts }) => {
    await mkdir(path.join(sourceRoot, 'tests'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'tests/key.test.mjs'), [
      "import test from 'node:test'; import assert from 'node:assert/strict';",
      "import { key } from '../src/retry.js';",
      "test('one', () => assert.equal(key, 'request'));",
      "test('two', () => assert.equal(typeof key, 'string'));",
      "test('hang', { skip: key !== 'hang' }, () => new Promise(() => setInterval(() => {}, 1000)));",
    ].join('\n'));
    const snapshot = await freezeSourceInventory({ sourceRoot, paths: ['src/retry.js', 'tests/key.test.mjs'], revision: 'grading' });
    const answer = async (value) => (await run({
      source: snapshot, resultFiles: ['src/retry.js'],
      runHarness: async ({ context }) => {
        await writeFile(path.join(context.cwd, 'src/retry.js'), `export const key = ${JSON.stringify(value)};\n`);
        return { stopped: true, output: null };
      },
    })).output.repository;
    const grade = (repository, options = {}) => gradeRepositoryTests({
      source: snapshot, artifactRoot: artifacts, resultFiles: ['src/retry.js'], repository,
      runTests: nodeTestRunner({ testFiles: ['tests/key.test.mjs'], timeoutMs: options.timeoutMs ?? 10_000 }),
      ...options.grade,
    });
    const partial = await answer('attempt');
    const binary = await grade(partial);
    assert.equal(binary.reward, 0);
    assert.equal(binary.explanation.outcome, 'failed');
    assert.deepEqual(binary.explanation.tests, { total: 3, passed: 1, failed: 1, cancelled: 0, skipped: 1, todo: 0 });
    const fraction = await grade(partial, { grade: { reward: 'fraction' } });
    assert.equal(fraction.reward, 1 / 3);
    const log = path.join(artifacts, partial.jobId, fraction.explanation.log.path);
    assert.match(await readFile(log, 'utf8'), /not ok \d+ - one/);
    assert.equal(fraction.explanation.log.truncated, false);
    assert.ok((await readdir(path.join(artifacts, partial.jobId, 'grading'))).length >= 2);
  });
  await fixture(async ({ run, source: sourceRoot, artifacts }) => {
    await mkdir(path.join(sourceRoot, 'tests'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'tests/hang.test.mjs'),
      "import test from 'node:test'; test('hangs', () => new Promise(() => setInterval(() => {}, 1000)));\n");
    const snapshot = await freezeSourceInventory({ sourceRoot, paths: ['src/retry.js', 'tests/hang.test.mjs'], revision: 'hang' });
    const result = await run({ source: snapshot, resultFiles: ['src/retry.js'], runHarness: async () => ({ stopped: true, output: null }) });
    const graded = await gradeRepositoryTests({
      source: snapshot, artifactRoot: artifacts, resultFiles: ['src/retry.js'], repository: result.output.repository,
      runTests: nodeTestRunner({ testFiles: ['tests/hang.test.mjs'], timeoutMs: 700 }),
    });
    assert.equal(graded.reward, 0);
    assert.equal(graded.explanation.outcome, 'test_timeout');
    const aborted = new AbortController();
    aborted.abort(new Error('grading cancelled'));
    await assert.rejects(gradeRepositoryTests({
      source: snapshot, artifactRoot: artifacts, resultFiles: ['src/retry.js'], repository: result.output.repository,
      runTests: nodeTestRunner({ testFiles: ['tests/hang.test.mjs'], timeoutMs: 10_000 }), signal: aborted.signal,
    }), /grading cancelled/);
  });
});

test('jobs can be listed from the artifact root through their private locator', async () => {
  await fixture(async ({ run, artifacts, options }) => {
    await assert.rejects(run({ runHarness: async () => ({ stopped: false }) }), { name: 'ExecutionUncertainError' });
    const [job] = await listNativeJobs(artifacts);
    assert.equal(job.jobId, options.context.jobId);
    assert.equal(job.state, 'quarantined');
    assert.equal(job.privateJobDirectory, options.context.privateJobDirectory);
    assert.equal(job.caseId, 'task');
  });
});

test('secret redaction removes credential shapes and known values', () => {
  const text = redactSecrets('key=abcd1234efgh sk-live-abcdefghijk Bearer zzzzzzzzzz value-XYZ-secret-1', ['value-XYZ-secret-1']);
  assert.doesNotMatch(text, /abcd1234efgh|sk-live-abcdefghijk|zzzzzzzzzz|value-XYZ-secret-1/);
});
