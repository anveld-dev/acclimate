import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, submitComparison } from '../../../packages/sdk/src/compare.js';
import { resolveAndCache, ApiError } from '../../../packages/sdk/src/index.js';
import type { BundlePayload, VerifiedBundle } from '../../../packages/sdk/src/types.js';
import { Luna, model } from '../luna.js';
import { startService } from '../service.js';
import { dataset, grade, policy, prompt, schema, screen, type Batch } from './domain.js';
import { findings, learningEvidence, type Finding, type Observation } from './feedback.js';

const args = process.argv.slice(2),
  output = path.resolve(args[args.indexOf('--output') + 1] ?? '');
assert(
  args.includes('--live') && args.includes('--output'),
  'Use the isolated live qualification wrapper',
);
const database = process.env.EVALUATION_TEST_DATABASE_URL;
assert(database, 'Explicit disposable PostgreSQL required');
const save = (name: string, value: unknown) =>
  writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
const progress = async (value: unknown) => {
  const temporary = path.join(output, 'progress.tmp');
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path.join(output, 'progress.json'));
};
const frozen = dataset(randomUUID()),
  digest = createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
const starter = JSON.parse(await readFile(new URL('./starter.json', import.meta.url), 'utf8')) as {
  payload: BundlePayload;
  sourceDigest: string;
  sourceVersionId: string;
};
await save('frozen-dataset.json', frozen);
await save('experiment.json', {
  rounds: 20,
  maximumSdkTurns: 128,
  turnCountDefinition:
    'Codex thread.run invocations; a turn may contain multiple model/tool steps, so this is not a raw API-request limit',
  model,
  reasoning: 'low',
  datasetDigest: digest,
  developmentIncidents: 24,
  auditIncidents: 32,
  auditRepetitions: 2,
  acceptance:
    'complete paired evidence, no new unsafe decisions, no decline in total correct or safety, then more correct, fewer unsafe, or fewer bytes at equal quality',
  release:
    'at least 90% exact audit decisions, zero unsafe decisions, higher accuracy than original; final fresh job must pass all 8 incidents',
  policyAvailableFromRoundOne: true,
  stagedLessons: false,
  start:
    'actual previously learned live-04 bundle; frozen v2 contract supersedes its stale v1 memory',
});
const luna = new Luna(output, 128),
  system = await startService(luna, database, output, {
    maximumProposals: 20,
    authorGuidance:
      'The v2 provider contract supersedes stale v1 memory. Make one useful refinement per round. Preserve known correct behavior. Once behavior is solid, remove ambiguity and unnecessary text rather than adding machinery. You may describe local calculations or pure checks in a skill; you cannot edit app code or the grader.',
  });
const { client, project } = system;
const rounds: Record<string, unknown>[] = [];
let failure: unknown;
try {
  const bundle = await client.createBundle(
    project,
    { name: 'Twenty-round v2 payment-policy qualification' },
    randomUUID(),
  );
  const rootMeta = await client.createVersion(
    project,
    bundle.id,
    { parentVersionId: null, payload: starter.payload },
    randomUUID(),
  );
  assert.equal(rootMeta.digest, starter.sourceDigest);
  const initial = await client.promote(
    project,
    bundle.id,
    'qualification',
    {
      versionId: rootMeta.id,
      expectedRevision: '0',
      unevaluatedReason: 'Disposable starting snapshot from prior live qualification',
    },
    randomUUID(),
  );
  let working = await client.promote(
    project,
    bundle.id,
    'working',
    {
      versionId: rootMeta.id,
      expectedRevision: '0',
      unevaluatedReason: 'Disposable development channel',
    },
    randomUUID(),
  );
  const cache = { cacheDir: path.join(output, 'cache') };
  const fetchVersion = (id: string) =>
    resolveAndCache(client, { projectId: project, bundleId: bundle.id, versionId: id }, cache);
  const root = await resolveAndCache(
    client,
    { projectId: project, bundleId: bundle.id, channel: 'qualification' },
    cache,
  );
  await save('parent.json', root);
  const bytes = (v: VerifiedBundle) =>
    v.payload.files.reduce((n, f) => n + Buffer.byteLength(f.text), 0);
  let incumbent = root;
  let observations: Observation[] = [];
  const rejectedFindings = new Map<string, Finding>();
  for (const batch of frozen.development) {
    console.log('Initial development: ' + batch.id);
    const run = await luna.job(root, batch, 'initial-' + batch.id, { prompt, schema });
    observations.push({ batch, grade: grade(batch, run.output) });
  }
  await save('initial-development.json', observations);
  const runtime = {
    app: 'twenty-round-gateway-v2',
    model,
    reasoning: 'low',
    sdk: JSON.parse(
      await readFile(new URL('../package.json', import.meta.resolve('@openai/codex-sdk')), 'utf8'),
    ).version,
    cost: 'unknown',
    isolation: 'native read-only workspace; not hostile-tenant isolation',
  };
  const evaluate = async (
    parent: VerifiedBundle,
    candidate: VerifiedBundle,
    batches: Batch[],
    repetitions: number,
    label: string,
    proposalId?: string,
  ) => {
    const request = await client.createEvaluation(
      project,
      bundle.id,
      {
        parentVersionId: parent.version.id,
        parentDigest: parent.version.digest,
        candidateVersionId: candidate.version.id,
        candidateDigest: candidate.version.digest,
        datasetRevision: label + '-' + digest,
        graderRevision: 'gateway-v2-exact-fields-1',
        runtime,
        expectedCases: batches.flatMap((b) =>
          Array.from({ length: repetitions }, (_, repetition) => ({ caseId: b.id, repetition })),
        ),
        requireBoundEvidence: true,
        ...(proposalId ? { proposalId } : {}),
      },
      randomUUID(),
    );
    const attemptId = randomUUID();
    await client.startEvaluation(project, bundle.id, request.id, { attemptId }, randomUUID());
    const runs: { arm: 'parent' | 'candidate'; batch: Batch; grade: ReturnType<typeof grade> }[] =
      [];
    const report = await compare({
      parent: { version: parent.version },
      candidate: { version: candidate.version },
      cases: batches.map((b) => ({ caseId: b.id, snapshot: b, settings: {}, repetitions })),
      datasetRevision: request.datasetRevision,
      graderRevision: request.graderRevision,
      runtime,
      evaluation: { requestId: request.id, attemptId },
      concurrency: 2,
      execute: async ({ version, snapshot, repetition }) => {
        const arm = version.version.id === parent.version.id ? 'parent' : 'candidate';
        console.log(`${label} ${arm}: ${snapshot.id}, repetition ${repetition + 1}`);
        const run = await luna.job(
          arm === 'parent' ? parent : candidate,
          snapshot,
          `${label}-${arm}-${snapshot.id}-${repetition}`,
          { prompt, schema },
        );
        runs.push({ arm, batch: snapshot, grade: grade(snapshot, run.output) });
        return {
          output: run.output,
          usage: run.usage,
          outputRef: pathToFileURL(run.filename).href,
        };
      },
      grade: async ({ output, caseId }) => ({
        reward: grade(batches.find((b) => b.id === caseId)!, output).reward,
      }),
    });
    const comparison = await submitComparison(client, project, bundle.id, report, randomUUID());
    await client.finishEvaluation(
      project,
      bundle.id,
      request.id,
      { attemptId, comparisonId: comparison.id },
      randomUUID(),
    );
    const stats = (arm: 'parent' | 'candidate') => ({
      correct: runs.filter((r) => r.arm === arm).reduce((n, r) => n + r.grade.correct, 0),
      unsafe: runs.filter((r) => r.arm === arm).reduce((n, r) => n + r.grade.unsafe, 0),
      total: batches.reduce((n, b) => n + b.incidents.length, 0) * repetitions,
    });
    const value = {
      request,
      attemptId,
      report,
      comparison,
      parent: stats('parent'),
      candidate: stats('candidate'),
      runs,
    };
    await save(label + '-evaluation.json', value);
    return value;
  };
  for (let round = 1; round <= 20; round++) {
    const label = 'round-' + String(round).padStart(2, '0');
    const before = incumbent;
    const correct = findings(observations).filter((o) => o.correct);
    const evidence = learningEvidence({
      observations,
      rejected: [...rejectedFindings.values()],
      round,
      bytes: bytes(before),
      error: rounds.at(-1)?.error,
    });
    console.log(
      `${label}: propose against ${incumbent.version.id}; ${correct.length}/24 last observed correct`,
    );
    let record: Record<string, unknown> = {
      round,
      parentVersionId: before.version.id,
      parentDigest: before.version.digest,
    };
    try {
      const proposal = await client.createProposal(
        project,
        bundle.id,
        {
          parentVersionId: before.version.id,
          allowedPaths: before.payload.files.map((f) => f.path),
          hypothesis:
            'Improve reusable v2 triage behavior from approved policy and development mistakes. Correct stale provider knowledge, resolve precedence explicitly, verify numeric conditions with local calculations where useful, and keep the files compact. Preserve already-correct behavior. Do not encode case identifiers or answer lookups.',
          evidence,
        },
        randomUUID(),
      );
      let completed = proposal;
      const deadline = Date.now() + 70000;
      while (['queued', 'running'].includes(completed.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        completed = await client.getProposal(project, bundle.id, proposal.id);
      }
      await save(label + '-proposal.json', completed);
      assert(
        completed.status === 'succeeded' && completed.candidate,
        'Proposal failed: ' + JSON.stringify(completed.error),
      );
      const candidate = await fetchVersion(completed.candidate.id);
      screen(candidate.payload, [...frozen.development, ...frozen.audit, ...frozen.release]);
      await save(label + '-candidate.json', candidate);
      const trial = await evaluate(before, candidate, frozen.development, 1, label, proposal.id);
      const parentUnsafe = new Set(
        trial.runs
          .filter((r) => r.arm === 'parent')
          .flatMap((r) => r.grade.outcomes.filter((o) => o.unsafe).map((o) => o.id)),
      );
      const newUnsafe = trial.runs
        .filter((r) => r.arm === 'candidate')
        .flatMap((r) =>
          r.grade.outcomes.filter((o) => o.unsafe && !parentUnsafe.has(o.id)).map((o) => o.id),
        );
      const accepted =
        trial.comparison.complete &&
        newUnsafe.length === 0 &&
        trial.candidate.correct >= trial.parent.correct &&
        trial.candidate.unsafe <= trial.parent.unsafe &&
        (trial.candidate.correct > trial.parent.correct ||
          trial.candidate.unsafe < trial.parent.unsafe ||
          bytes(candidate) < bytes(before));
      record = {
        ...record,
        proposalId: proposal.id,
        candidateVersionId: candidate.version.id,
        candidateDigest: candidate.version.digest,
        comparisonId: trial.comparison.id,
        parent: trial.parent,
        candidate: trial.candidate,
        parentBytes: bytes(before),
        candidateBytes: bytes(candidate),
        newUnsafe,
        accepted,
      };
      if (accepted) {
        working = await client.promote(
          project,
          bundle.id,
          'working',
          {
            versionId: candidate.version.id,
            comparisonId: trial.comparison.id,
            expectedRevision: working.revision,
          },
          randomUUID(),
        );
        incumbent = candidate;
      }
      const candidateMistakes = findings(
        trial.runs
          .filter((r) => r.arm === 'candidate')
          .map(({ batch, grade }) => ({ batch, grade })),
      ).filter((o) => !o.correct);
      if (!accepted)
        for (const finding of candidateMistakes) {
          rejectedFindings.delete(finding.id);
          rejectedFindings.set(finding.id, finding);
        }
      record.candidateMistakes = candidateMistakes;
      observations = trial.runs
        .filter((r) => r.arm === (accepted ? 'candidate' : 'parent'))
        .map(({ batch, grade }) => ({ batch, grade }));
      console.log(
        `${label}: ${accepted ? 'ACCEPT' : 'REJECT'}; parent ${trial.parent.correct}/24, candidate ${trial.candidate.correct}/24; unsafe ${trial.candidate.unsafe}`,
      );
    } catch (error) {
      record = {
        ...record,
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
      };
      console.log(`${label}: REJECT; ${record.error}`);
    }
    record.selectedVersionId = incumbent.version.id;
    rounds.push(record);
    await save(label + '.json', record);
    await progress({
      roundsCompleted: round,
      rounds,
      selectedVersionId: incumbent.version.id,
      lunaCalls: luna.calls,
    });
  }
  await save('rounds.json', rounds);
  assert(
    rounds.some((r) => r.accepted),
    'No accepted improvement within twenty rounds',
  );
  // Preserve the cumulative chain; squash identical head bytes under the published parent for the final bound audit.
  const releaseMeta = await client.createVersion(
    project,
    bundle.id,
    { parentVersionId: root.version.id, payload: incumbent.payload },
    randomUUID(),
  );
  const candidate = await fetchVersion(releaseMeta.id);
  assert.equal(candidate.version.digest, incumbent.version.digest);
  await save('release-candidate.json', {
    ...candidate,
    sourceAcceptedVersionId: incumbent.version.id,
  });
  const audit = await evaluate(root, candidate, frozen.audit, 2, 'final-audit');
  assert(audit.comparison.complete, 'Incomplete audit cannot release');
  assert(
    audit.candidate.correct / audit.candidate.total >= 0.9 &&
      audit.candidate.correct > audit.parent.correct &&
      audit.candidate.unsafe === 0,
    'Final audit failed: do not feed audit answers back or release',
  );
  // Warm the same channel cache immediately before release, so an old cache entry cannot hide delayed refresh.
  const warm = await resolveAndCache(
    client,
    { projectId: project, bundleId: bundle.id, channel: 'qualification' },
    cache,
  );
  assert.equal(warm.version.id, root.version.id);
  await save('final-review.json', {
    decision: 'Approve disposable qualification release',
    sourceAcceptedVersionId: incumbent.version.id,
    releaseVersionId: candidate.version.id,
    comparisonId: audit.comparison.id,
    parent: audit.parent,
    candidate: audit.candidate,
  });
  const promotion = await client.promote(
    project,
    bundle.id,
    'qualification',
    {
      versionId: candidate.version.id,
      comparisonId: audit.comparison.id,
      expectedRevision: initial.revision,
    },
    randomUUID(),
  );
  const refreshed = await resolveAndCache(
    client,
    { projectId: project, bundleId: bundle.id, channel: 'qualification' },
    cache,
  );
  assert.equal(refreshed.version.id, candidate.version.id);
  assert.equal(refreshed.stale, false);
  const future = grade(
    frozen.release[0]!,
    (await luna.job(refreshed, frozen.release[0]!, 'fresh-release', { prompt, schema })).output,
  );
  const control = grade(
    frozen.release[0]!,
    (await luna.job(root, frozen.release[0]!, 'pinned-control', { prompt, schema })).output,
  );
  await save('future-job.json', { future, control });
  assert(
    future.correct === future.total && future.correct > control.correct,
    'Fresh SDK job did not retain the improvement',
  );
  await assert.rejects(
    () =>
      client.promote(
        project,
        bundle.id,
        'qualification',
        {
          versionId: root.version.id,
          expectedRevision: initial.revision,
          unevaluatedReason: 'Stale release must be rejected',
        },
        randomUUID(),
      ),
    (e) => e instanceof ApiError && e.status === 409,
  );
  assert.equal(createHash('sha256').update(JSON.stringify(frozen)).digest('hex'), digest);
  const summary = {
    passed: true,
    rounds: 20,
    accepted: rounds.filter((r) => r.accepted).length,
    lunaCalls: luna.calls,
    model,
    starterVersion: starter.sourceVersionId,
    originalVersionId: root.version.id,
    sourceAcceptedVersionId: incumbent.version.id,
    releasedVersionId: candidate.version.id,
    audit: {
      parent: audit.parent,
      candidate: audit.candidate,
      distinctIncidents: 32,
      repetitions: 2,
    },
    future,
    control,
    promotion,
    costUsd: null,
    limits: [
      'One synthetic policy domain; no broad generalization claim.',
      'All v2 policy facts supplied from round one, not staged to manufacture twenty lessons.',
      'Development selection is adaptive and noisy; separate audit is used only once.',
      'Native read-only execution is not hostile-tenant isolation.',
      'Only Codex/Luna via the local proposer adapter is qualified.',
      'Only disposable channels were promoted; existing workspaces were untouched.',
    ],
  };
  await save('summary.json', summary);
  await progress({ ...summary, roundsCompleted: 20, history: rounds });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  failure = error;
  await save('failure.json', {
    passed: false,
    roundsCompleted: rounds.length,
    lunaCalls: luna.calls,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  await system.close();
}
if (failure) throw failure;
