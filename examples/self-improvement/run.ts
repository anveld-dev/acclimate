import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, submitComparison } from '@acclimate/sdk';
import { ApiError, resolveAndCache } from '@acclimate/sdk';
import type { VerifiedVersion, ComparisonRequest } from '@acclimate/sdk';
import {
  batches,
  grade,
  proposalEvidence,
  screenCandidate,
  seedPayload,
  type Batch,
} from './domain.js';
import { Luna, model } from './luna.js';
import { startService } from './service.js';

const args = process.argv.slice(2),
  output = path.resolve(args[args.indexOf('--output') + 1] || '');
if (!args.includes('--live') || !args.includes('--output'))
  throw new Error(
    'Use --live --output PRIVATE_DIRECTORY through the isolated qualification wrapper',
  );
const database = process.env.EVALUATION_TEST_DATABASE_URL;
if (!database) throw new Error('Explicit isolated PostgreSQL database required');
const seed = randomUUID();
const training = batches(seed, 'training'),
  selection = batches(seed, 'selection'),
  audit = batches(seed, 'audit'),
  release = batches(seed, 'release');
const dataset = { seed, training, selection, audit, release };
const save = async (name: string, value: unknown) =>
  writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
await save('frozen-dataset.json', dataset);
const frozenDigest = createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
const luna = new Luna(output);
const system = await startService(luna, database, output);
const { project, client } = system;
const sdkVersion = JSON.parse(
  await readFile(new URL('../package.json', import.meta.resolve('@openai/codex-sdk')), 'utf8'),
).version as string;
let failure: unknown;
try {
  const bundle = await client.createBundle(
    project,
    { name: 'Payment triage learning qualification' },
    randomUUID(),
  );
  const parentMeta = await client.createVersion(
    project,
    bundle.id,
    { parentVersionId: null, payload: seedPayload },
    randomUUID(),
  );
  const initial = await client.createRelease(
    project,
    bundle.id,
    'qualification',
    {
      versionId: parentMeta.id,
      expectedRevision: '0',
      unevaluatedReason: 'Seed for an explicitly disposable live learning test',
    },
    randomUUID(),
  );
  const cached = () => ({ cacheDir: path.join(output, 'cache') });
  const parent = await resolveAndCache(
    client,
    { projectId: project, bundleId: bundle.id, channel: 'qualification' },
    cached(),
  );
  await save('parent.json', parent);
  const scoreRuns = async (version: VerifiedVersion, items: Batch[], label: string) => {
    const results = [];
    for (const batch of items) {
      console.log(`${label}: ${batch.id}`);
      const run = await luna.job(version, batch, `${label}-${batch.id}`);
      results.push({ ...run, grade: grade(batch, run.output) });
    }
    const correct = results.reduce((sum, row) => sum + row.grade.correct, 0),
      total = results.reduce((sum, row) => sum + row.grade.total, 0);
    await save(label + '-results.json', { correct, total, results });
    console.log(`${label}: ${correct}/${total} correct`);
    return { correct, total, results };
  };
  const observed = await scoreRuns(parent, training, 'training-baseline');
  assert(
    observed.correct < observed.total,
    'Training baseline has no failures; this experiment cannot demonstrate improvement',
  );
  const observations = observed.results.flatMap((run) =>
    run.grade.outcomes.map((outcome) =>
      JSON.stringify({
        incident: training
          .flatMap((batch) => batch.incidents)
          .find((incident) => incident.id === outcome.id),
        agentDecision: outcome.actual,
        acceptedDecision: outcome.expected,
        correct: outcome.correct,
      }),
    ),
  );
  // Two incidents per entry leave space for later mistakes within the API's 20-entry limit.
  const feedback = [];
  for (let index = 0; index < observations.length; index += 2)
    feedback.push(
      JSON.stringify(observations.slice(index, index + 2).map((row) => JSON.parse(row))),
    );
  let candidate: VerifiedVersion | undefined, proposalId: string | undefined;
  const attempts = [];
  for (let round = 1; round <= 3; round++) {
    const proposal = await client.createProposal(
      project,
      bundle.id,
      {
        parentVersionId: parent.version.id,
        allowedPaths: parent.payload.files.map((file) => file.path),
        hypothesis:
          'Improve later payment-incident decisions from approved training feedback. Capture stable gateway facts in memory, reusable reasoning in the skill and clear resource-loading/trust boundaries in instructions. For boundary-sensitive decisions, prefer an explicit predicate and a local calculation/check against each original input over prose approximations. Never specialize to incident identifiers or grader internals.',
        evidence: proposalEvidence(feedback, attempts.at(-1)),
      },
      randomUUID(),
    );
    const deadline = Date.now() + 70_000;
    let completed = proposal;
    while (['queued', 'running'].includes(completed.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      completed = await client.getProposal(project, bundle.id, proposal.id);
    }
    await save(`proposal-${round}.json`, completed);
    if (completed.status !== 'succeeded' || !completed.candidate) {
      attempts.push({ round, status: completed.status, error: completed.error });
      continue;
    }
    const value = await resolveAndCache(
      client,
      { projectId: project, bundleId: bundle.id, versionId: completed.candidate.id },
      cached(),
    );
    screenCandidate(value.payload, [...training, ...selection, ...audit, ...release]);
    const changed = value.payload.files
      .filter((file, index) => file.text !== parent.payload.files[index]!.text)
      .map((file) => ({ path: file.path, kind: file.kind }));
    assert(changed.length > 0, 'Candidate is a no-op');
    await save(`candidate-${round}.json`, { ...value, changed });
    const selected = await scoreRuns(value, training, `candidate-${round}-training`);
    const previousCorrect = new Set(
      observed.results.flatMap((run) =>
        run.grade.outcomes.filter((row) => row.correct).map((row) => row.id),
      ),
    );
    const unseen =
      selected.correct === selected.total
        ? await scoreRuns(value, selection, `candidate-${round}-selection`)
        : undefined;
    const regressions = selected.results.flatMap((run) =>
      run.grade.outcomes.filter((row) => previousCorrect.has(row.id) && !row.correct),
    );
    attempts.push({
      round,
      correct: selected.correct,
      total: selected.total,
      selectionCorrect: unseen?.correct,
      selectionTotal: unseen?.total,
      failures: [...selected.results, ...(unseen?.results ?? [])].flatMap((run) =>
        run.grade.outcomes
          .filter((row) => !row.correct)
          .map((row) => ({
            incident: [...training, ...selection]
              .flatMap((batch) => batch.incidents)
              .find((incident) => incident.id === row.id),
            actual: row.actual,
            expected: row.expected,
          })),
      ),
      regressions: regressions.map((row) => ({
        id: row.id,
        expected: row.expected,
        actual: row.actual,
      })),
    });
    if (
      selected.correct === selected.total &&
      selected.correct > observed.correct &&
      regressions.length === 0 &&
      unseen?.correct === unseen?.total &&
      unseen !== undefined
    ) {
      candidate = value;
      proposalId = proposal.id;
      break;
    }
  }
  await save('selection.json', attempts);
  assert(candidate && proposalId, 'No candidate passed training and selection within three rounds');
  const candidateDigest = candidate.version.digest;
  // Candidate is frozen after development selection, before the untouched audit.
  const runtime = {
    app: 'payment-triage-learning-v1',
    model,
    codexSdk: sdkVersion,
    isolation: 'read-only native SDK workspace; local synthetic data only',
    cost: 'unknown',
  };
  const expectedCases = audit.flatMap((batch) =>
    [0, 1].map((repetition) => ({ caseId: batch.id, repetition })),
  );
  const evaluation = await client.createEvaluation(
    project,
    bundle.id,
    {
      parentVersionId: parent.version.id,
      parentDigest: parent.version.digest,
      candidateVersionId: candidate.version.id,
      candidateDigest,
      datasetRevision: 'payment-triage-audit-v1-' + frozenDigest,
      graderRevision: 'meridian-contract-v1',
      runtime,
      expectedCases,
      proposalId,
      requireBoundEvidence: true,
    },
    randomUUID(),
  );
  const attemptId = randomUUID();
  await client.startEvaluation(project, bundle.id, evaluation.id, { attemptId }, randomUUID());
  const versions = new Map([
    [parent.version.id, parent],
    [candidate.version.id, candidate],
  ]);
  const auditRuns: unknown[] = [];
  const report = await compare({
    parent: { version: parent.version },
    candidate: { version: candidate.version },
    cases: audit.map((batch) => ({
      caseId: batch.id,
      snapshot: batch,
      settings: {},
      repetitions: 2,
    })),
    datasetRevision: evaluation.datasetRevision,
    graderRevision: evaluation.graderRevision,
    runtime,
    evaluation: { requestId: evaluation.id, attemptId },
    concurrency: 2,
    execute: async ({ version, snapshot, repetition }) => {
      const arm = version.version.id === parent.version.id ? 'baseline' : 'candidate';
      console.log(`Held-out ${arm}: ${snapshot.id}, repetition ${repetition + 1}`);
      const run = await luna.job(
        versions.get(version.version.id)!,
        snapshot,
        `audit-${arm}-${snapshot.id}-${repetition}`,
      );
      auditRuns.push({ ...run, grade: grade(snapshot, run.output) });
      return { output: run.output, usage: run.usage, outputRef: pathToFileURL(run.filename).href };
    },
    grade: async ({ output, caseId }) => ({
      reward: grade(audit.find((batch) => batch.id === caseId)!, output).reward,
    }),
  });
  await save('audit-runs.json', auditRuns);
  await save('comparison-request.json', report);
  const comparison = await submitComparison(client, project, bundle.id, report, randomUUID());
  await save('comparison.json', comparison);
  await client.finishEvaluation(
    project,
    bundle.id,
    evaluation.id,
    { attemptId, comparisonId: comparison.id },
    randomUUID(),
  );
  const score = (arm: 'parent' | 'candidate') =>
    report.results.reduce((sum, pair) => sum + (pair[arm].reward ?? 0), 0) /
    report.expectedCases.length;
  const baselineScore = score('parent'),
    candidateScore = score('candidate');
  assert(comparison.complete, 'Incomplete audit cannot be promoted');
  assert(
    candidateScore === 1 && candidateScore > baselineScore,
    'No measured held-out improvement; retain the failure and do not promote',
  );
  assert.equal(candidate.version.digest, candidateDigest);
  assert.equal(createHash('sha256').update(JSON.stringify(dataset)).digest('hex'), frozenDigest);
  await save('review.json', {
    decision: 'approve disposable qualification release',
    parent: parent.version,
    candidate: candidate.version,
    proposalId,
    comparisonId: comparison.id,
    evaluationId: evaluation.id,
    baselineScore,
    candidateScore,
    expectedRevision: initial.revision,
    limits:
      'Small synthetic gateway-policy experiment. Application feedback and grading are trusted inputs. No broad benchmark or production autonomy claim.',
  });
  const promotion = await client.createRelease(
    project,
    bundle.id,
    'qualification',
    {
      versionId: candidate.version.id,
      comparisonId: comparison.id,
      expectedRevision: initial.revision,
    },
    randomUUID(),
  );
  const refreshed = await resolveAndCache(
    client,
    { projectId: project, bundleId: bundle.id, channel: 'qualification' },
    cached(),
  );
  assert.equal(refreshed.version.id, candidate.version.id);
  assert.equal(refreshed.stale, false);
  const fresh = await scoreRuns(refreshed, [release[0]!], 'post-release');
  assert.equal(fresh.correct, fresh.total, 'Fresh SDK job did not retain the learned behavior');
  const pinned = await scoreRuns(parent, [release[0]!], 'pinned-parent-control');
  assert(
    pinned.correct < fresh.correct,
    'The same future job does not distinguish the pinned old setup',
  );
  await assert.rejects(
    () =>
      client.createRelease(
        project,
        bundle.id,
        'qualification',
        {
          versionId: parent.version.id,
          expectedRevision: initial.revision,
          unevaluatedReason: 'Must reject stale release',
        },
        randomUUID(),
      ),
    (error) => error instanceof ApiError && error.status === 409,
  );
  const summary = {
    passed: true,
    model,
    sdkVersion,
    lunaCalls: luna.calls,
    project,
    bundleId: bundle.id,
    channel: 'qualification',
    training: { baseline: observed.correct, total: observed.total },
    audit: {
      baselineScore,
      candidateScore,
      pairedJobs: report.expectedCases.length,
      distinctIncidents: audit.reduce((sum, batch) => sum + batch.incidents.length, 0),
      repetitions: 2,
    },
    postRelease: {
      correct: fresh.correct,
      total: fresh.total,
      pinnedParentCorrect: pinned.correct,
      resolvedVersion: refreshed.version.id,
      cacheRefreshVerified: true,
    },
    proposalId,
    evaluationId: evaluation.id,
    comparisonId: comparison.id,
    promotion,
    changedFiles: candidate.payload.files
      .filter((file, index) => file.text !== parent.payload.files[index]!.text)
      .map((file) => ({ path: file.path, kind: file.kind })),
    costUsd: null,
    limits: [
      'Synthetic gateway-policy tasks, not real payment operations.',
      'Only the Codex/Luna integration was exercised.',
      'The service proposer uses a local SDK compatibility adapter, not a direct vendor API.',
      'Agent workspaces contain only harness files and task inputs; read-only mode is not a hostile tenant boundary.',
      'No existing workspace, channel or credentials were changed.',
      'Two repeated jobs per batch are not independent evidence of general agent improvement.',
    ],
  };
  await save('summary.json', summary);
  console.log(
    JSON.stringify(
      {
        passed: true,
        training: summary.training,
        audit: summary.audit,
        postRelease: summary.postRelease,
        lunaCalls: luna.calls,
        output,
      },
      null,
      2,
    ),
  );
} catch (error) {
  failure = error;
  await save('failure.json', {
    passed: false,
    error: error instanceof Error ? error.message : String(error),
    lunaCalls: luna.calls,
  });
} finally {
  await system.close();
}
if (failure) throw failure;
