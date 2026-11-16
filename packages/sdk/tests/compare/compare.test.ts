import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, InfrastructureError, TaskExecutionError } from '../../src/compare.js';
import type { VersionMetadata } from '../../src/types.js';

const digest = 'sha256:0067f5c5211d303528a731b3b2e4c169935dd62b40e8444c671204605a53557b';
const v = (id: string, parentVersionId: string | null): VersionMetadata => ({
  id,
  bundleId: 'b',
  parentVersionId,
  digest,
  createdAt: 'now',
});
const versions = { parent: { version: v('p', null) }, candidate: { version: v('c', 'p') } };

test('freezes paired inventory and grading retry does not add or rerun samples', async () => {
  let executions = 0,
    grades = 0;
  const report = await compare({
    ...versions,
    cases: [
      { caseId: 'saved-a', snapshot: { n: 1 }, settings: { model: 'fixture' }, repetitions: 2 },
    ],
    datasetRevision: 'data-4',
    runtime: { model: 'fixture' },
    graderRevision: 'grade-2',
    gradeRetries: 1,
    execute: async ({ version, caseId, repetition, snapshot, settings }) => {
      executions++;
      assert.equal(caseId, 'saved-a');
      assert.deepEqual(snapshot, { n: 1 });
      assert.deepEqual(settings, { model: 'fixture' });
      return {
        output: { version: version.version.id, repetition },
        outputRef: `out-${version.version.id}-${repetition}`,
      };
    },
    grade: async ({ output }) => {
      if (++grades === 1) throw new Error('judge timeout');
      return { reward: output.version === 'c' ? 1 : 0 };
    },
  });
  assert.deepEqual(report.expectedCases, [
    { caseId: 'saved-a', repetition: 0 },
    { caseId: 'saved-a', repetition: 1 },
  ]);
  assert.equal(report.results.length, 2);
  assert.equal(executions, 4);
  assert.equal(grades, 5);
  assert.equal(report.results[0].candidate.reward, 1);
  assert.equal(report.results[0].parent.usage, null);
});

test('preserves task, infrastructure, judge failures and unknown usage distinctly', async () => {
  const report = await compare({
    ...versions,
    cases: [
      { caseId: 'a', snapshot: null, settings: null },
      { caseId: 'b', snapshot: null, settings: null },
    ],
    datasetRevision: 'd',
    runtime: { executor: 'fixture' },
    graderRevision: 'g',
    execute: async ({ version }) => {
      if (version.version.id === 'p') throw new TaskExecutionError('app task failed');
      if (version.version.id === 'c') return { output: 'ok', usage: { costUsd: -2 } };
      throw new InfrastructureError('unreachable');
    },
    grade: async () => {
      throw new Error('grader unavailable');
    },
  });
  assert.equal(report.results[0].parent.executionStatus, 'task_failed');
  assert.equal(report.results[0].parent.gradingStatus, 'missing');
  assert.equal(report.results[0].candidate.executionStatus, 'completed');
  assert.equal(report.results[0].candidate.gradingStatus, 'failed');
  assert.equal(report.results[0].candidate.usage, null);
  assert.equal(report.results[0].candidate.reward, null);
});

test('abort preserves every predeclared pair as infrastructure failure', async () => {
  const controller = new AbortController();
  controller.abort();
  const report = await compare({
    ...versions,
    cases: [{ caseId: 'a', snapshot: 1, settings: 1, repetitions: 2 }],
    datasetRevision: 'd',
    runtime: { executor: 'fixture' },
    graderRevision: 'g',
    signal: controller.signal,
    execute: async () => {
      throw new Error('must not execute');
    },
    grade: async () => ({ reward: 1 }),
  });
  assert.equal(report.expectedCases.length, 2);
  assert.ok(
    report.results.every(
      ({ parent, candidate }) =>
        parent.executionStatus === 'infrastructure_failed' &&
        candidate.executionStatus === 'infrastructure_failed',
    ),
  );
});

test('rejects inventory over service cap before executing', async () => {
  let called = false;
  await assert.rejects(
    compare({
      ...versions,
      cases: [{ caseId: 'x', snapshot: null, settings: null, repetitions: 1001 }],
      datasetRevision: 'd',
      runtime: { executor: 'fixture' },
      graderRevision: 'g',
      execute: async () => {
        called = true;
        return { output: null };
      },
      grade: async () => ({ reward: 0 }),
    }),
    /repetitions/,
  );
  assert.equal(called, false);
});

test('isolates parent and candidate snapshots and settings', async () => {
  const received: unknown[] = [];
  const report = await compare({
    ...versions,
    cases: [
      { caseId: 'isolated', snapshot: { nested: { value: 1 } }, settings: { flags: ['safe'] } },
    ],
    datasetRevision: 'd',
    runtime: { executor: 'fixture' },
    graderRevision: 'g',
    execute: async ({ version, snapshot, settings }) => {
      received.push({
        version: version.version.id,
        snapshot: structuredClone(snapshot),
        settings: structuredClone(settings),
      });
      if (version.version.id === 'p') {
        snapshot.nested.value = 99;
        settings.flags.push('changed');
      }
      return { output: null };
    },
    grade: async () => ({ reward: 1 }),
  });
  assert.deepEqual(received[1], {
    version: 'c',
    snapshot: { nested: { value: 1 } },
    settings: { flags: ['safe'] },
  });
  assert.equal(report.results[0].parent.reward, 1);
});

test('concurrency bounds active execute and grade callbacks across both arms', async () => {
  let active = 0,
    maximum = 0;
  const callback = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
  };
  await compare({
    ...versions,
    cases: Array.from({ length: 5 }, (_, i) => ({ caseId: `c${i}`, snapshot: i, settings: {} })),
    datasetRevision: 'd',
    runtime: { executor: 'fixture' },
    graderRevision: 'g',
    concurrency: 2,
    execute: async ({ version }) => {
      await callback();
      return { output: version.version.id };
    },
    grade: async () => {
      await callback();
      return { reward: 1 };
    },
  });
  assert.equal(maximum, 2);
});

test('rejects empty inventory and uncloneable inputs before callbacks', async () => {
  let called = false;
  const base = {
    ...versions,
    datasetRevision: 'd',
    runtime: { executor: 'fixture' },
    graderRevision: 'g',
    execute: async () => {
      called = true;
      return { output: null };
    },
    grade: async () => ({ reward: 1 }),
  };
  await assert.rejects(compare({ ...base, cases: [] }), /must not be empty/);
  await assert.rejects(
    compare({ ...base, cases: [{ caseId: 'bad', snapshot: () => {}, settings: {} }] }),
    /cannot be cloned/,
  );
  assert.equal(called, false);
});

test('report identities stay bound to executed versions when callers mutate inputs', async () => {
  const executed: string[] = [];
  const runtime = { model: 'fixture-before' };
  const options = {
    parent: { version: v('p', null) },
    candidate: { version: v('c', 'p') },
    cases: [{ caseId: 'fixed', snapshot: null, settings: null }],
    datasetRevision: 'dataset-before',
    runtime,
    graderRevision: 'grader-before',
    execute: async ({ version }: { version: { version: VersionMetadata } }) => {
      await Promise.resolve();
      executed.push(version.version.id);
      options.parent.version.id = 'different-parent';
      options.candidate.version.id = 'different-candidate';
      options.parent.version.digest = `sha256:${'a'.repeat(64)}`;
      options.candidate.version.digest = `sha256:${'b'.repeat(64)}`;
      options.datasetRevision = 'dataset-after';
      options.graderRevision = 'grader-after';
      runtime.model = 'mutated';
      options.runtime = { model: 'replaced' };
      return { output: version.version.id };
    },
    grade: async () => ({ reward: 1 }),
  };
  const report = await compare(options);
  assert.deepEqual(executed, ['p', 'c']);
  assert.deepEqual(
    {
      parentVersionId: report.parentVersionId,
      candidateVersionId: report.candidateVersionId,
      parentDigest: report.parentDigest,
      candidateDigest: report.candidateDigest,
      datasetRevision: report.datasetRevision,
      graderRevision: report.graderRevision,
      runtime: report.runtime,
    },
    {
      parentVersionId: 'p',
      candidateVersionId: 'c',
      parentDigest: digest,
      candidateDigest: digest,
      datasetRevision: 'dataset-before',
      graderRevision: 'grader-before',
      runtime: { model: 'fixture-before' },
    },
  );
});

test('a mutating failed grader cannot change captured outputs or later grade attempts', async () => {
  const outputs: Array<{ findings: string[] }> = [];
  const attempts = new Map<string, number>();
  const observed: string[][] = [];
  let executions = 0;
  const report = await compare({
    ...versions,
    cases: [{ caseId: 'retry', snapshot: null, settings: null }],
    datasetRevision: 'd',
    runtime: { model: 'fixture' },
    graderRevision: 'g',
    gradeRetries: 1,
    execute: async () => {
      executions++;
      const output = { findings: ['first', 'second'] };
      outputs.push(output);
      return { output };
    },
    grade: async ({ output, version }) => {
      observed.push([...output.findings]);
      const attempt = attempts.get(version.version.id) ?? 0;
      attempts.set(version.version.id, attempt + 1);
      const reward = output.findings.length;
      output.findings.pop();
      if (attempt === 0) throw new Error('judge timeout after modifying its input');
      return { reward };
    },
  });
  assert.equal(executions, 2);
  assert.deepEqual([...attempts.values()], [2, 2]);
  assert.deepEqual(
    observed,
    Array.from({ length: 4 }, () => ['first', 'second']),
  );
  assert.ok(outputs.every((output) => output.findings.length === 2));
  assert.equal(report.results[0].parent.reward, 2);
  assert.equal(report.results[0].candidate.reward, 2);
});

test('uncloneable outputs fail grading without rerunning execution or calling the grader', async () => {
  let executions = 0,
    grades = 0;
  const report = await compare({
    ...versions,
    cases: [{ caseId: 'uncloneable', snapshot: null, settings: null }],
    datasetRevision: 'd',
    runtime: { model: 'fixture' },
    graderRevision: 'g',
    gradeRetries: 1,
    execute: async ({ version }) => {
      executions++;
      return { output: () => {}, outputRef: `output-${version.version.id}` };
    },
    grade: async () => {
      grades++;
      return { reward: 1 };
    },
  });
  assert.equal(executions, 2);
  assert.equal(grades, 0);
  for (const id of ['parent', 'candidate'] as const) {
    const result = report.results[0][id];
    assert.equal(result.executionStatus, 'completed');
    assert.equal(result.gradingStatus, 'failed');
    assert.equal(result.reward, null);
    assert.match(result.error ?? '', /execution output cannot be cloned/);
    assert.equal(result.outputRef, `output-${id === 'parent' ? 'p' : 'c'}`);
  }
});

test('freezes binding and callback identities before any application callback runs', async () => {
  const binding = { requestId: 'request-1', attemptId: 'attempt-1' };
  let initialExecutions = 0,
    initialGrades = 0,
    replacementCalls = 0;
  const options = {
    ...versions,
    evaluation: binding,
    cases: [{ caseId: 'a', snapshot: null, settings: null, repetitions: 2 }],
    datasetRevision: 'dataset',
    runtime: { configRevision: 'opaque-v1' },
    graderRevision: 'grader',
    execute: async () => {
      initialExecutions++;
      binding.requestId = 'wrong-request';
      binding.attemptId = 'wrong-attempt';
      options.execute = async () => {
        replacementCalls++;
        return { output: 0 };
      };
      options.grade = async () => {
        replacementCalls++;
        return { reward: 0 };
      };
      return { output: 1 };
    },
    grade: async () => {
      initialGrades++;
      return { reward: 1 };
    },
  };
  const report = await compare(options);
  assert.deepEqual(report.evaluation, { requestId: 'request-1', attemptId: 'attempt-1' });
  assert.equal(initialExecutions, 4);
  assert.equal(initialGrades, 4);
  assert.equal(replacementCalls, 0);
});

test('partial evaluation binding is rejected before execution', async () => {
  let calls = 0;
  await assert.rejects(
    compare({
      ...versions,
      evaluation: { requestId: 'request', attemptId: '' },
      cases: [{ caseId: 'a', snapshot: null, settings: null }],
      datasetRevision: 'd',
      runtime: { app: 'a' },
      graderRevision: 'g',
      execute: async () => {
        calls++;
        return { output: null };
      },
      grade: async () => ({ reward: 1 }),
    }),
    /requestId and attemptId/,
  );
  assert.equal(calls, 0);
});
