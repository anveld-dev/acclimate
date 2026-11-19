import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineEvaluation } from '../../src/evaluation/index.js';
import type { EvaluationDefinition } from '../../src/evaluation/types.js';
import {
  loadLocalPayload,
  localPayloadDigest,
  runLocalComparison,
  scoreLocalComparison,
  tryEvaluation,
  LocalRunError,
} from '../../src/evaluation/local.js';
import { localMain } from '../../src/evaluation/local-cli.js';
import { parseEvaluatorArguments } from '../../src/evaluation/cli.js';
import {
  runControlsFromFlags,
  parseDuration,
  parseSelection,
  selectedCaseIds,
} from '../../src/evaluation/controls.js';
import { createEvaluationManifest } from '../../src/evaluation/manifest.js';
import type { BundlePayload, VerifiedVersion } from '../../src/types.js';

const parentPayload: BundlePayload = {
  schemaVersion: 1,
  files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'Be brief.' }],
};
const candidatePayload: BundlePayload = {
  schemaVersion: 1,
  files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'Be polite.' }],
};
const policy = JSON.stringify({
  schemaVersion: 1,
  id: 'no-regression',
  revision: '1',
  metric: { name: 'task reward', unit: 'reward', direction: 'higher' },
  aggregation: 'equal-case-means',
  minimumMeanImprovement: 0,
  maximumCaseRegression: 0,
  requiredCases: [],
  // A four-case fixture: compare point estimates instead of the paired-t default.
  inference: { method: 'none' },
});

type Definition = EvaluationDefinition<number, number, { text: string; n: number }>;
function definition(overrides: Partial<Definition> = {}): Definition {
  return {
    configId: 'local-test',
    configRevision: '1',
    datasetRevision: 'cases-1',
    graderRevision: 'grader-1',
    runtime: { app: 'local-test' },
    execution: 'model-free',
    cases: [
      { caseId: 'a', input: 1, expected: 1 },
      { caseId: 'b', input: 2, expected: 2, repetitions: 2 },
      { caseId: 'c', input: 3, expected: 3 },
      { caseId: 'd', input: 4, expected: 4 },
    ],
    execute: async ({ bundle, input }) => ({
      output: { text: bundle.payload.files[0].text, n: input },
    }),
    grade: async ({ output }) => ({ reward: output.text.includes('polite') ? 1 : 0.5 }),
    ...overrides,
  };
}

async function workspace() {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-local-'));
  return {
    directory,
    run: path.join(directory, 'run'),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function capture(work: () => Promise<number>, tty = false) {
  let out = '',
    err = '';
  const stdout = process.stdout.write,
    stderr = process.stderr.write;
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: tty });
  process.stdout.write = ((value: unknown) => ((out += String(value)), true)) as typeof stdout;
  process.stderr.write = ((value: unknown) => ((err += String(value)), true)) as typeof stderr;
  try {
    const status = await work();
    return { status, out, err, result: out.startsWith('{') ? JSON.parse(out) : undefined };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  }
}

test('local compare runs the counterbalanced schedule on synthetic verified versions', async () => {
  const w = await workspace();
  try {
    const seen: Array<{ side: string; bundle: VerifiedVersion; first?: string }> = [];
    const app = defineEvaluation(
      definition({
        collection: { protocol: 'seeded-balanced-v1', seed: 'local' },
        execute: async ({ bundle, input, context }) => {
          seen.push({ side: context.side, bundle, first: context.collection?.firstSide });
          return { output: { text: bundle.payload.files[0].text, n: input } };
        },
      }),
    );
    const result = await runLocalComparison({
      app,
      parent: parentPayload,
      candidate: candidatePayload,
      directory: w.run,
    });
    assert.equal(result.authoritative, false);
    assert.equal(result.callbacksStarted, 10);
    assert.equal(result.comparison.complete, true);
    assert.deepEqual(
      result.comparison.results.map((row) => [row.caseId, row.repetition]),
      [['a', 0], ['b', 0], ['b', 1], ['c', 0], ['d', 0]],
    );
    // The same shape the service runner passes: version metadata, payload, resolution time.
    const candidate = seen.find((item) => item.side === 'candidate')!.bundle;
    assert.deepEqual(Object.keys(candidate).sort(), ['payload', 'resolvedAt', 'stale', 'version']);
    assert.equal(candidate.version.digest, localPayloadDigest(candidatePayload));
    assert.equal(candidate.version.parentVersionId, result.versions.parent.id);
    assert.match(candidate.version.id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Arm order follows the seeded schedule, like a service run.
    const firsts = new Set(seen.map((item) => item.first));
    assert.deepEqual([...firsts].sort(), ['candidate', 'parent']);
    for (let index = 0; index < seen.length; index += 2) assert.equal(seen[index].side, seen[index].first);
    const { scores, policy: verdict } = scoreLocalComparison(result, policy);
    assert.equal(scores.summary?.parentMean, 0.5);
    assert.equal(scores.summary?.candidateMean, 1);
    assert.equal(verdict?.verdict, 'pass');
    assert.equal(verdict?.advisory, true);
    assert.deepEqual(result.warnings, []);
  } finally {
    await w.cleanup();
  }
});

test('payload folders map skills, memory and instructions with the service validation rules', async () => {
  const w = await workspace();
  try {
    const folder = path.join(w.directory, 'bundle');
    await mkdir(path.join(folder, 'skills', 'lookup'), { recursive: true });
    await mkdir(path.join(folder, 'memory'), { recursive: true });
    await mkdir(path.join(folder, '.git'), { recursive: true });
    await writeFile(path.join(folder, 'AGENTS.md'), '# Agent');
    await writeFile(path.join(folder, 'skills', 'lookup', 'SKILL.md'), 'skill');
    await writeFile(path.join(folder, 'memory', 'prefs.md'), 'memory');
    await writeFile(path.join(folder, '.git', 'HEAD'), 'ignored');
    await writeFile(path.join(folder, '.DS_Store'), 'ignored');
    const loaded = await loadLocalPayload(folder);
    assert.equal(loaded.form, 'directory');
    assert.deepEqual(
      loaded.payload.files.map((file) => [file.path, file.kind]),
      [
        ['AGENTS.md', 'instruction'],
        ['memory/prefs.md', 'memory'],
        ['skills/lookup/SKILL.md', 'skill'],
      ],
    );
    // A file with the same content yields the same digest as the folder.
    const file = path.join(w.directory, 'payload.json');
    await writeFile(file, JSON.stringify(loaded.payload));
    assert.equal((await loadLocalPayload(file)).digest, loaded.digest);

    await writeFile(path.join(folder, 'bad name.md'), 'x');
    await assert.rejects(loadLocalPayload(folder), (error: Error) => {
      assert.ok(error instanceof LocalRunError);
      assert.match(error.message, /^bad name\.md: not a valid bundle file/);
      return true;
    });
    await rm(path.join(folder, 'bad name.md'));
    await symlink(path.join(folder, 'AGENTS.md'), path.join(folder, 'link.md'));
    await assert.rejects(loadLocalPayload(folder), /link\.md: symbolic links are not read/);
    await rm(path.join(folder, 'link.md'));
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        files: [
          { path: 'A.md', kind: 'instruction', text: '' },
          { path: 'a.md', kind: 'memory', text: '' },
        ],
      }),
    );
    await assert.rejects(loadLocalPayload(file), /differ only by case/);
    await writeFile(file, '{"schemaVersion":1,"files":[{"path":"a.md","kind":"notes","text":""}]}');
    await assert.rejects(loadLocalPayload(file), /files\[0\] needs exactly path, kind/);
    const empty = path.join(w.directory, 'empty');
    await mkdir(empty);
    await assert.rejects(loadLocalPayload(empty), /has no files/);
  } finally {
    await w.cleanup();
  }
});

test('identical outputs on every pair raise the ignored-bundle warning', async () => {
  const w = await workspace();
  try {
    const app = defineEvaluation(
      definition({ execute: async ({ input }) => ({ output: { text: 'same', n: input } }) }),
    );
    const result = await runLocalComparison({
      app,
      parent: parentPayload,
      candidate: candidatePayload,
      directory: w.run,
    });
    assert.deepEqual(result.summary.outputs, { comparedPairs: 5, identicalPairs: 5 });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /identical output on all 5 compared pairs.*uses the bundle argument/);
    const same = await runLocalComparison({
      app,
      parent: parentPayload,
      candidate: parentPayload,
      directory: path.join(w.directory, 'same'),
    });
    assert.match(same.warnings[0], /same payload/);
    assert.equal(same.versions.candidate.parentVersionId, null);
  } finally {
    await w.cleanup();
  }
});

test('declared concurrency overlaps pairs, keeps arm order and is fingerprinted', async () => {
  const w = await workspace();
  try {
    assert.equal(defineEvaluation(definition()).descriptor.runtime.concurrency, '1');
    assert.equal(defineEvaluation(definition()).descriptor.runtime.gradeRetries, '0');
    assert.throws(() => defineEvaluation(definition({ concurrency: 0 })), { code: 'definition.invalid', field: 'concurrency' });
    assert.throws(() => defineEvaluation(definition({ gradeRetries: 9 })), { code: 'definition.invalid', field: 'gradeRetries' });
    let active = 0,
      peak = 0;
    const order: string[] = [];
    const app = defineEvaluation(
      definition({
        concurrency: 3,
        execute: async ({ bundle, input, caseId, context }) => {
          order.push(`${caseId}:${context.side}`);
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 30));
          active--;
          return { output: { text: bundle.payload.files[0].text, n: input } };
        },
      }),
    );
    assert.equal(app.descriptor.runtime.concurrency, '3');
    const result = await runLocalComparison({
      app,
      parent: parentPayload,
      candidate: candidatePayload,
      directory: w.run,
    });
    assert.equal(peak, 3);
    assert.equal(result.summary.concurrency, 3);
    assert.deepEqual(
      result.comparison.results.map((row) => row.caseId),
      ['a', 'b', 'b', 'c', 'd'],
    );
    // Without a collection schedule each pair runs parent then candidate.
    for (const caseId of ['a', 'c', 'd'])
      assert.ok(order.indexOf(`${caseId}:parent`) < order.indexOf(`${caseId}:candidate`));
    const manifest = createEvaluationManifest({
      configId: 'm',
      execution: 'model-free',
      cases: [{ caseId: 'x', input: 1, expected: 1 }],
      grader: { artifactDigest: 'sha256:' + '0'.repeat(64) },
      runtime: { settings: {}, artifacts: { app: 'sha256:' + '1'.repeat(64) } },
      concurrency: 4,
      gradeRetries: 2,
    });
    assert.equal(manifest.descriptor.runtime.concurrency, '4');
    assert.equal(manifest.descriptor.runtime.gradeRetries, '2');
    assert.equal(manifest.definition.concurrency, 4);
  } finally {
    await w.cleanup();
  }
});

test('grade retries recover a flaky judge without repeating execution', async () => {
  const w = await workspace();
  try {
    let executions = 0;
    const failures = new Map<string, number>();
    const app = defineEvaluation(
      definition({
        gradeRetries: 2,
        execute: async ({ bundle, input }) => {
          executions++;
          return { output: { text: bundle.payload.files[0].text, n: input } };
        },
        grade: async ({ caseId, output }) => {
          const key = caseId + output.text;
          const seen = failures.get(key) ?? 0;
          failures.set(key, seen + 1);
          if (caseId === 'a' && seen < 2) throw new Error('judge overloaded');
          return { reward: 1 };
        },
      }),
    );
    const result = await runLocalComparison({ app, parent: parentPayload, candidate: candidatePayload, directory: w.run });
    assert.equal(executions, 10);
    assert.equal(result.summary.gradeRetriesUsed, 4);
    assert.equal(result.comparison.complete, true);
  } finally {
    await w.cleanup();
  }
});

test('a per-callback timeout aborts the signal and records a timeout gap', async () => {
  const w = await workspace();
  try {
    let aborted = 0;
    const app = defineEvaluation(
      definition({
        execute: async ({ bundle, input, caseId, signal }) => {
          if (caseId === 'c') {
            signal.addEventListener('abort', () => aborted++);
            await new Promise((resolve) => setTimeout(resolve, 2000)); // ignores the signal
          }
          return { output: { text: bundle.payload.files[0].text, n: input } };
        },
      }),
    );
    const started = Date.now();
    const result = await runLocalComparison({
      app,
      parent: parentPayload,
      candidate: candidatePayload,
      directory: w.run,
      controls: { caseTimeoutMs: 50 },
    });
    assert.ok(Date.now() - started < 1500);
    assert.equal(aborted, 2);
    assert.equal(result.summary.timedOutCallbacks, 2);
    const row = result.comparison.results.find((item) => item.caseId === 'c')!;
    assert.equal(row.parent.error, 'timeout');
    assert.equal(row.candidate.executionStatus, 'infrastructure_failed');
    assert.equal(result.summary.stopReason, 'completed');
    const { scores } = scoreLocalComparison(result);
    assert.equal(scores.evidenceGaps?.rows[0].reason, 'timeout');
  } finally {
    await w.cleanup();
  }
});

test('the deadline stops scheduling, abandons slow work and reports a partial result', async () => {
  const w = await workspace();
  try {
    const app = defineEvaluation(
      definition({
        execute: async ({ bundle, input }) => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return { output: { text: bundle.payload.files[0].text, n: input } };
        },
      }),
    );
    const result = await runLocalComparison({
      app,
      parent: parentPayload,
      candidate: candidatePayload,
      directory: w.run,
      controls: { deadlineMs: 200 },
    });
    assert.equal(result.summary.stopReason, 'deadline');
    assert.equal(result.summary.partial, true);
    assert.equal(result.comparison.complete, false);
    assert.ok(result.comparison.results.some((row) => row.candidate.error === 'deadline_exceeded'));
    assert.match(result.warnings.join('\n'), /Stopped at the 200ms deadline/);
    const { policy: verdict } = scoreLocalComparison(result, policy);
    assert.equal(verdict?.verdict, 'indeterminate');
  } finally {
    await w.cleanup();
  }
});

test('the cost limit stops new pairs once reported cost reaches it', async () => {
  const w = await workspace();
  try {
    let executions = 0;
    const app = defineEvaluation(
      definition({
        execute: async ({ bundle, input }) => {
          executions++;
          return { output: { text: bundle.payload.files[0].text, n: input }, usage: { costUsd: 0.75 } };
        },
      }),
    );
    const result = await runLocalComparison({
      app,
      parent: parentPayload,
      candidate: candidatePayload,
      directory: w.run,
      controls: { maxCostUsd: 2 },
    });
    // Two pairs cost $3.00; the cap was crossed during the second, so no third pair starts.
    assert.equal(executions, 4);
    assert.equal(result.summary.stopReason, 'cost_limit');
    assert.equal(result.summary.costUsd, 3);
    assert.equal(result.summary.pairs.started, 2);
    assert.deepEqual(
      result.comparison.results.slice(2).map((row) => [row.parent.error, row.candidate.error]),
      Array(3).fill(['cost_limit_reached', 'cost_limit_reached']),
    );
    assert.match(result.warnings.join('\n'), /reported cost reached \$3\.0000 \(limit \$2\)/);
  } finally {
    await w.cleanup();
  }
});

test('case subsets and shards are partial and never claim full coverage', async () => {
  const w = await workspace();
  try {
    const app = defineEvaluation(definition());
    assert.deepEqual([...selectedCaseIds({ kind: 'shard', index: 1, count: 2 }, ['a', 'b', 'c', 'd'])], ['a', 'c']);
    assert.deepEqual([...selectedCaseIds({ kind: 'shard', index: 2, count: 2 }, ['a', 'b', 'c', 'd'])], ['b', 'd']);
    assert.throws(() => selectedCaseIds({ kind: 'cases', caseIds: ['zz'] }, ['a']), /Unknown case ID: "zz"/);
    assert.throws(() => selectedCaseIds({ kind: 'shard', index: 1, count: 5 }, ['a']), /needs at least 5 cases/);
    const result = await runLocalComparison({
      app,
      parent: parentPayload,
      candidate: candidatePayload,
      directory: w.run,
      controls: { selection: { kind: 'shard', index: 2, count: 2 } },
    });
    assert.equal(result.callbacksStarted, 6);
    assert.equal(result.summary.partial, true);
    assert.equal(result.summary.stopReason, 'completed');
    assert.deepEqual(result.summary.pairs, { expected: 5, selected: 3, started: 3, notSelected: 2 });
    assert.equal(result.comparison.complete, false);
    assert.equal(result.comparison.expectedCases.length, 5);
    for (const row of result.comparison.results.filter((item) => ['a', 'c'].includes(item.caseId)))
      assert.deepEqual([row.parent.error, row.candidate.error], ['not_selected', 'not_selected']);
    const { scores, policy: verdict } = scoreLocalComparison(result, policy);
    assert.equal(verdict?.verdict, 'indeterminate');
    assert.equal(scores.counts.comparablePairs, 3);
    assert.equal(scores.evidenceGaps?.rows[0].reason, 'not_selected');
    assert.match(result.warnings.join('\n'), /shard 2\/2 · 3 of 5 pairs.*never claims full coverage/);
  } finally {
    await w.cleanup();
  }
});

test('try validates every returned shape and shows the output', async () => {
  const w = await workspace();
  try {
    const app = defineEvaluation<number, number, any>({
      ...(definition() as any),
      execute: async ({ caseId }: { caseId: string }) =>
        caseId === 'a'
          ? { output: { when: new Date(0) }, usage: { costUsd: -1, tokens: 3 } }
          : caseId === 'b'
            ? { output: { ok: true }, executionStatus: 'done' }
            : { output: { ok: true }, extra: 1 },
      grade: async ({ output }: { output: { ok?: boolean } }) => ({ reward: output.ok ? 5 : Number.NaN }),
    });
    const result = await tryEvaluation({
      app,
      selection: { kind: 'cases', caseIds: ['a', 'b', 'c'] },
      directory: w.run,
    });
    assert.equal(result.ok, false);
    const [a, b, c] = result.cases;
    assert.deepEqual(
      a.execute.issues.map((issue) => [issue.severity, issue.field]),
      [
        ['error', 'output["when"]'],
        ['error', 'usage.tokens'],
      ],
    );
    assert.match(a.execute.issues[0].message, /toISOString/);
    assert.equal(a.grade.status, 'skipped');
    assert.equal(b.execute.issues[0].field, 'executionStatus');
    assert.equal(c.execute.status, 'ok');
    assert.deepEqual(c.execute.output, { ok: true });
    assert.equal(c.execute.issues[0].field, 'extra');
    assert.equal(c.grade.status, 'ok');
    assert.equal(c.grade.reward, 5);
    assert.match(c.grade.issues[0].message, /outside 0–1/);
    const first = await tryEvaluation({ app: defineEvaluation(definition()), directory: w.run });
    assert.equal(first.ok, true);
    assert.deepEqual(first.cases.map((row) => row.caseId), ['a']);
    assert.equal(first.payload.source, null);
  } finally {
    await w.cleanup();
  }
});

test('local commands need no config, write an advisory report and use policy exit codes', async () => {
  const w = await workspace();
  try {
    const parent = path.join(w.directory, 'parent.json'),
      candidate = path.join(w.directory, 'candidate.json'),
      policyFile = path.join(w.directory, 'policy.json');
    await writeFile(parent, JSON.stringify(parentPayload));
    await writeFile(candidate, JSON.stringify(candidatePayload));
    await writeFile(policyFile, policy);
    const app = defineEvaluation(definition({ execution: 'live' }));
    const missingLive = await capture(() =>
      localMain(app, ['compare', '--local', '--parent', parent, '--candidate', candidate, '--json'], w.directory),
    );
    assert.equal(missingLive.status, 1);
    assert.match(JSON.parse(missingLive.err).error.message, /Add --live/);

    const args = ['compare', '--local', '--parent', parent, '--candidate', candidate, '--live', '--policy', policyFile];
    const json = await capture(() => localMain(app, [...args, '--json', '--out', 'first'], w.directory));
    assert.equal(json.status, 0);
    assert.equal(json.err, '');
    assert.equal(json.result.authoritative, false);
    assert.equal(json.result.policy.verdict, 'pass');
    assert.equal(json.result.policy.advisory, true);
    const report = JSON.parse(await readFile(json.result.report, 'utf8'));
    assert.equal(report.kind, 'acclimate.local-comparison');
    assert.equal(report.releaseReceipt, false);
    assert.match(report.notice, /not a release receipt/);
    assert.equal(report.comparison.results.length, 5);
    assert.match(report.replay.command, /--payload .*candidate\.payload\.json/);
    assert.equal(((await stat(path.dirname(json.result.report))).mode & 0o777).toString(8), '700');
    assert.deepEqual(
      JSON.parse(await readFile(report.replay.candidatePayload, 'utf8')),
      candidatePayload,
    );

    // Reverse the arms: the policy fails and the exit code says so.
    const failing = await capture(() =>
      localMain(app, ['compare', '--local', '--parent', candidate, '--candidate', parent, '--live', '--policy', policyFile, '--out', 'second'], w.directory),
    );
    assert.equal(failing.status, 2);

    const text = await capture(
      () => localMain(app, [...args, '--out', 'third', '--shard', '1/2'], w.directory),
      true,
    );
    assert.equal(text.status, 3);
    assert.match(text.out, /^Local comparison · not a release receipt\n/);
    assert.match(text.out, /Pair coverage {7}2\/5 \(partial\)/);
    assert.match(text.out, /Policy \(advisory\) {3}indeterminate/);
    assert.match(text.out, /Selection {11}shard 1\/2 · 2 of 5 pairs/);
    assert.match(text.out, /To gate a release, replay the candidate against the service:\n {2}acclimate-eval compare --config CONFIG/);

    const reused = await capture(() => localMain(app, [...args, '--json', '--out', 'first'], w.directory));
    assert.equal(reused.status, 1);
    assert.match(JSON.parse(reused.err).error.message, /is not empty/);
    const badFlag = await capture(() => localMain(app, ['compare', '--local', '--config', 'x', '--json'], w.directory));
    assert.equal(badFlag.status, 1);
    assert.equal(JSON.parse(badFlag.err).error.code, 'usage.conflicting_flags');
    assert.match(JSON.parse(badFlag.err).error.message, /--config belongs to the service compare/);
    const unknownFlag = await capture(() => localMain(app, ['try', '--parent', parent, '--json'], w.directory));
    assert.equal(unknownFlag.status, 1);
    assert.equal(JSON.parse(unknownFlag.err).error.code, 'usage.unknown_flag');
    const badControl = await capture(() => localMain(app, [...args, '--json', '--deadline', 'soon'], w.directory));
    assert.equal(badControl.status, 1);
    assert.equal(JSON.parse(badControl.err).error.code, 'usage.invalid_flag');
    assert.equal(JSON.parse(badControl.err).error.field, '--deadline');
    const tryJson = await capture(() => localMain(app, ['try', '--live', '--case', 'b', '--payload', candidate, '--json'], w.directory));
    assert.equal(tryJson.status, 0);
    assert.equal(tryJson.result.cases[0].caseId, 'b');
  } finally {
    await w.cleanup();
  }
});

test('run-control flags parse strictly and stay off other commands', () => {
  assert.equal(parseDuration('90', '--deadline'), 90_000);
  assert.equal(parseDuration('1.5m', '--deadline'), 90_000);
  assert.equal(parseDuration('250ms', '--case-timeout'), 250);
  assert.throws(() => parseDuration('soon', '--deadline'), /positive duration/);
  assert.deepEqual(parseSelection(undefined, '2/4'), { kind: 'shard', index: 2, count: 4 });
  assert.throws(() => parseSelection(undefined, '5/4'), /1 <= INDEX <= COUNT/);
  assert.throws(() => parseSelection('a,a'), /distinct/);
  // The shared evaluator parser owns run-control flags for compare and run.
  const parsed = parseEvaluatorArguments(
    ['compare', '--config', 'c', '--deadline', '30m', '--handoff', 'h', '--max-cost-usd', '2.5', '--cases', 'a,b', '--progress'],
    '/work',
  );
  assert.equal(parsed.flags.handoff, '/work/h');
  assert.equal(parsed.flags.progress, true);
  assert.deepEqual(runControlsFromFlags(parsed.flags), {
    deadlineMs: 1_800_000,
    maxCostUsd: 2.5,
    selection: { kind: 'cases', caseIds: ['a', 'b'] },
  });
  assert.throws(() => parseEvaluatorArguments(['describe', '--deadline', '1m']), {
    code: 'usage.unknown_flag',
  });
  assert.throws(() => parseEvaluatorArguments(['status', '--quiet']), { code: 'usage.unknown_flag' });
  assert.throws(
    () => runControlsFromFlags(parseEvaluatorArguments(['run', '--shard', '1/2', '--cases', 'a']).flags),
    /not both/,
  );
});
