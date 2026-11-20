import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AcclimateClient,
  compare,
  createReceiptReporter,
  resolveAndCache,
  type EvaluationProgressRequest,
  type VerifiedVersion,
} from '@acclimate/sdk';
import { prepare } from '@acclimate/codex-plugin';
import { callLiveModel } from './live-model.js';

process.umask(0o077);
const [operatorFile, connectionFile, previousSummary, output, teaching, audit1, audit2, probe] =
  process.argv.slice(2);
if (!probe)
  throw new Error(
    'Expected operator JSON, connection JSON, previous summary, new output directory, then four distinct Git merge commits (teaching, audit, audit, probe).',
  );
const dir = path.resolve(output);
async function readJson(file: string, privateFile = false) {
  if (privateFile && (await stat(file)).mode & 0o077)
    throw new Error('Credential file must be owner-only.');
  return JSON.parse(await readFile(file, 'utf8'));
}
const operator = await readJson(operatorFile, true);
const credentials = await readJson(connectionFile, true);
const previous = await readJson(previousSummary);
if (operator.workspaceId !== previous.workspace) throw new Error('Workspace mismatch.');
const workspace = operator.workspaceId;
const bundle = previous.bundle;
const connection = previous.connection;
const api = new AcclimateClient({ ...operator, scope: 'release-feed-evaluator' });
const consumer = new AcclimateClient({
  baseUrl: operator.baseUrl,
  token: credentials['content-read'],
  connectionId: connection,
  scope: 'release-feed-consumer',
});
const reporter = createReceiptReporter({
  client: new AcclimateClient({
    baseUrl: operator.baseUrl,
    token: credentials['receipt-write'],
    scope: 'release-feed-receipts',
  }),
  workspaceId: workspace,
  connectionId: connection,
});
function git(...args: string[]) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}
function snapshot(revision: string) {
  if (!/^[a-f0-9]{7,40}$/i.test(revision)) throw new Error('Pass immutable commit IDs.');
  const [merge, parents, subject] = git('show', '-s', '--format=%H%n%P%n%s', revision).split('\n');
  const [base, head, extra] = parents.split(' ');
  const match = /^Merge pull request #(\d+) /.exec(subject);
  if (!match || !head || extra) throw new Error('Expected a two-parent GitHub PR merge.');
  return {
    merge,
    base,
    head,
    subject,
    title: git('show', '-s', '--format=%s', head),
    pr: Number(match[1]),
  };
}
const rows = [teaching, audit1, audit2, probe].map(snapshot);
if (new Set(rows.map((row) => row.merge)).size !== rows.length)
  throw new Error('Duplicate Git commit.');
await mkdir(dir, { mode: 0o700 });
const save = (name: string, value: unknown) =>
  writeFile(path.join(dir, name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
await save('frozen-inputs', rows);
const cacheDir = path.join(dir, 'cache');
const resolveStable = () =>
  resolveAndCache(
    consumer,
    { workspaceId: workspace, bundleId: bundle, channel: 'stable' },
    { cacheDir, reporter },
  );
const parent = await resolveStable();
if (parent.version.id !== previous.freshVersion || parent.connection?.connectionId !== connection)
  throw new Error('Live connection has moved since the supplied summary.');
const maxCalls = 12;
type Row = ReturnType<typeof snapshot>;
type Mode = 'standard' | 'change-range';
function grade(text: string, row: Row, mode: Mode) {
  try {
    const expected = {
      pr: row.pr,
      merge: row.merge,
      title: row.title,
      ...(mode === 'change-range' && { range: row.base + '..' + row.merge }),
    };
    const entry = JSON.parse(text);
    return Number(
      Object.keys(entry).length === Object.keys(expected).length &&
        Object.entries(expected).every(([k, v]) => entry[k] === v),
    );
  } catch {
    return 0;
  }
}
async function run(content: VerifiedVersion, row: Row, mode: Mode, id: string, connected = false) {
  const native = await prepare(content);
  try {
    if (connected) reporter.reportPrepared(content);
    const instruction = await readFile(native.instructionPath!, 'utf8');
    const result = await callLiveModel({
      role: 'harness',
      appRoot: native.cwd,
      artifactRoot: dir,
      callId: id,
      maxCalls,
      prompt: [
        'Answer directly from supplied data without tools.',
        instruction,
        'Generate a ' + mode + ' release-feed entry.',
        'Merge SHA: ' + row.merge,
        'Merge subject: ' + row.subject,
        'First parent SHA: ' + row.base,
        'Second parent SHA: ' + row.head,
        'Change title: ' + row.title,
      ].join('\n'),
    });
    if (connected) {
      reporter.reportStarted(content);
      await reporter.flush();
    }
    return result;
  } finally {
    await native.cleanup();
  }
}
const observation = await run(parent, rows[0], 'change-range', 'teaching', true);
await save('teaching', {
  version: parent.version.id,
  score: grade(observation.text, rows[0], 'change-range'),
  output: observation.text,
});
await mkdir(path.join(dir, 'author'));
const oldFile = parent.payload.files.find((file) => file.path === 'instructions/release-feed.md');
if (!oldFile) throw new Error('Expected release feed instructions in the delivered version.');
const authored = await callLiveModel({
  role: 'proposer',
  appRoot: path.join(dir, 'author'),
  artifactRoot: dir,
  callId: 'author',
  maxCalls,
  prompt: [
    'Answer directly without tools. Return only the revised release feed instructions.',
    'Current instruction: ' + oldFile.text,
    'Observed change-range response: ' + observation.text,
    'Application owner correction: The standard feed keeps its exact existing schema. Release engineers also request a change-range entry to inspect everything a merge brought onto the target branch. In this mode add exactly one field called range containing the full first-parent SHA, two dots, and the full merge SHA. Return bare JSON for both modes. Write generic instructions with no case data.',
  ].join('\n'),
});
const candidate = await api.createVersion(
  workspace,
  bundle,
  {
    parentVersionId: parent.version.id,
    payload: {
      ...parent.payload,
      files: parent.payload.files.map((file) =>
        file === oldFile ? { ...file, text: authored.text + '\n' } : file,
      ),
    },
  },
  randomUUID(),
);
const modes: Mode[] = ['standard', 'change-range'];
const cases = rows.slice(1, 3).flatMap((row) =>
  modes.map((mode) => ({
    caseId: 'pr-' + row.pr + '-' + mode,
    snapshot: row,
    settings: { mode },
  })),
);
const datasetDigest = createHash('sha256').update(JSON.stringify(cases)).digest('hex').slice(0, 16);
const descriptor = {
  datasetRevision: 'acclimate-git-' + datasetDigest,
  graderRevision: 'release-feed-with-range-v1',
  runtime: { harness: 'Codex CLI', model: 'gpt-6-luna' },
};
const ev = await api.createEvaluation(
  workspace,
  bundle,
  {
    ...descriptor,
    parentVersionId: parent.version.id,
    parentDigest: parent.version.digest,
    candidateVersionId: candidate.id,
    candidateDigest: candidate.digest,
    expectedCases: cases.map((c) => ({ caseId: c.caseId, repetition: 0 })),
  },
  randomUUID(),
);
const watchPath =
  '/w/' +
  encodeURIComponent(workspace) +
  '/bundles/' +
  bundle +
  '/changes?' +
  new URLSearchParams({
    channel: 'stable',
    history: '1',
    tab: 'evaluations',
    candidate: candidate.id,
    request: ev.id,
  });
console.log('Watch', watchPath);
await save('location', {
  workspace,
  bundle,
  connection,
  candidate: candidate.id,
  evaluation: ev.id,
  watchPath,
});
const attemptId = randomUUID();
await api.startEvaluation(workspace, bundle, ev.id, { attemptId }, randomUUID());
let sequence = 0,
  completed = 0;
async function progress(phase: EvaluationProgressRequest['phase'], caseId?: string) {
  const result = await api.reportEvaluationProgress(workspace, bundle, ev.id, {
    attemptId,
    sequence: ++sequence,
    phase,
    completed,
    total: cases.length * 2,
    ...(caseId && { case: { caseId, repetition: 0 } }),
  });
  await save('progress-' + sequence, result);
}
let finished = false;
try {
  await progress('preparing');
  const report = await compare({
    parent: { version: parent.version },
    candidate: { version: candidate },
    cases,
    ...descriptor,
    evaluation: { requestId: ev.id, attemptId },
    concurrency: 1,
    execute: async ({ version, snapshot, settings, caseId }) => {
      await progress('executing', caseId);
      const verified = await resolveAndCache(
        api,
        { workspaceId: workspace, bundleId: bundle, versionId: version.version.id },
        { cacheDir },
      );
      const role = version.version.id === parent.version.id ? 'parent' : 'candidate';
      const result = await run(verified, snapshot, settings.mode, caseId + '-' + role);
      return {
        output: result.text,
        outputRef: 'codex-thread:' + result.threadId,
        usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
      };
    },
    grade: async ({ output: response, caseId }) => {
      const task = cases.find((c) => c.caseId === caseId)!;
      const reward = grade(response, task.snapshot, task.settings.mode);
      completed++;
      await progress('grading', caseId);
      return { reward };
    },
  });
  await save('comparison', report);
  await progress('submitting');
  const comparison = await api.createComparison(workspace, bundle, report, randomUUID());
  await api.finishEvaluation(
    workspace,
    bundle,
    ev.id,
    { attemptId, comparisonId: comparison.id },
    randomUUID(),
  );
  finished = true;
  const eligible =
    comparison.complete &&
    completed === cases.length * 2 &&
    report.results.every((pair) => pair.candidate.reward === 1 && pair.parent.reward !== null) &&
    report.results.some((pair) => pair.parent.reward === 0);
  if (eligible)
    await api.createRelease(
      workspace,
      bundle,
      'stable',
      {
        versionId: candidate.id,
        expectedRevision: parent.resolution!.revision,
        comparisonId: comparison.id,
      },
      randomUUID(),
    );
  const fresh = await resolveStable();
  const checked = await run(fresh, rows[3], 'change-range', 'fresh-consumer', true);
  const summary = {
    workspace,
    bundle,
    connection,
    evaluation: ev.id,
    comparison: comparison.id,
    watchPath,
    parent: parent.version.id,
    candidate: candidate.id,
    released: eligible,
    freshVersion: fresh.version.id,
    freshScore: grade(checked.text, rows[3], 'change-range'),
    pendingReceipts: reporter.pendingCount,
    scores: report.results.map((pair) => ({
      task: pair.caseId,
      parent: pair.parent.reward,
      candidate: pair.candidate.reward,
    })),
  };
  await save('summary', summary);
  console.log(summary);
} catch (error) {
  if (!finished)
    await api
      .interruptEvaluation(
        workspace,
        bundle,
        ev.id,
        { reason: 'Release feed evaluator stopped; inspect the private run directory.' },
        randomUUID(),
      )
      .catch(() => {});
  throw error;
} finally {
  reporter.close();
}
