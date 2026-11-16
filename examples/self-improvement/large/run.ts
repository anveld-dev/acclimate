import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, submitComparison } from '../../../packages/sdk/src/compare.js';
import { resolveAndCache, ApiError } from '../../../packages/sdk/src/index.js';
import type { VerifiedBundle } from '../../../packages/sdk/src/types.js';
import { Luna, model } from '../luna.js';
import { startService } from '../service.js';
import { helperObserved, helperOutput } from '../repair/observed.js';
import { grade } from '../twenty/domain.js';
import {
  consistency,
  inventorySchema,
  prompt,
  type LargeDataset,
  type LargeBatch,
} from './domain.js';

const args = process.argv.slice(2),
  arg = (key: string) => args[args.indexOf(key) + 1];
assert(
  args.includes('--live') &&
    args.includes('--output') &&
    args.includes('--source-run') &&
    args.includes('--frozen-dataset'),
  'Use the isolated --large qualification wrapper',
);
const output = path.resolve(arg('--output')!),
  source = path.resolve(arg('--source-run')!),
  fixturePath = path.resolve(arg('--frozen-dataset')!);
const database = process.env.EVALUATION_TEST_DATABASE_URL;
assert(database, 'Explicit disposable PostgreSQL required');
const frozen = JSON.parse(await readFile(fixturePath, 'utf8')) as LargeDataset;
const verifyDelivery = args.includes('--verify-delivery');
assert(
  !verifyDelivery || frozen.future,
  'Delivery verification requires a pre-frozen future batch',
);
const experiment = JSON.parse(
  await readFile(path.join(path.dirname(fixturePath), 'experiment.json'), 'utf8'),
);
const digest = createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
assert.equal(digest, experiment.datasetDigest, 'Frozen large audit changed');
const originalSource = JSON.parse(
  await readFile(path.join(source, 'parent.json'), 'utf8'),
) as VerifiedBundle;
const candidateSource = JSON.parse(
  await readFile(path.join(source, 'release-candidate.json'), 'utf8'),
) as VerifiedBundle;
const save = (name: string, value: unknown) =>
  writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
await save('frozen-dataset.json', frozen);
await save('experiment.json', experiment);
await save('source-versions.json', {
  sourceRun: source,
  original: originalSource.version,
  candidate: candidateSource.version,
  sourceFile: 'release-candidate.json',
});
const luna = new Luna(output, 20),
  system = await startService(luna, database, output, { maximumProposals: 0 });
const { client, project } = system;
let failure: unknown;
try {
  const bundle = await client.createBundle(
    project,
    { name: 'Large distributed-evidence qualification' },
    randomUUID(),
  );
  const parentMeta = await client.createVersion(
    project,
    bundle.id,
    { parentVersionId: null, payload: originalSource.payload },
    randomUUID(),
  );
  const candidateMeta = await client.createVersion(
    project,
    bundle.id,
    { parentVersionId: parentMeta.id, payload: candidateSource.payload },
    randomUUID(),
  );
  assert.equal(parentMeta.digest, originalSource.version.digest);
  assert.equal(candidateMeta.digest, candidateSource.version.digest);
  const cache = { cacheDir: path.join(output, 'cache') };
  const parent = await resolveAndCache(
    client,
    { projectId: project, bundleId: bundle.id, versionId: parentMeta.id },
    cache,
  );
  const candidate = await resolveAndCache(
    client,
    { projectId: project, bundleId: bundle.id, versionId: candidateMeta.id },
    cache,
  );
  await save('parent.json', parent);
  await save('candidate.json', candidate);
  const requiresHelper = candidate.payload.files.some(
    (f) => f.path === 'skills/payment-triage/scripts/triage.py',
  );
  const initial = verifyDelivery
    ? await client.promote(
        project,
        bundle.id,
        'qualification',
        {
          versionId: parent.version.id,
          expectedRevision: '0',
          unevaluatedReason: 'Disposable audit starting version',
        },
        randomUUID(),
      )
    : undefined;
  const runtime = {
    app: 'large-distributed-v2-1',
    model,
    reasoning: 'low',
    jobDeadlineSeconds: '360',
    metrics: JSON.stringify(frozen.metrics),
    cost: 'unknown',
    isolation: 'native read-only; not hostile-tenant isolation',
  };
  const request = await client.createEvaluation(
    project,
    bundle.id,
    {
      parentVersionId: parent.version.id,
      parentDigest: parent.version.digest,
      candidateVersionId: candidate.version.id,
      candidateDigest: candidate.version.digest,
      datasetRevision: 'large-v2-' + digest,
      graderRevision: 'v2-exact-fields-and-alias-consistency-1',
      runtime,
      expectedCases: frozen.batches.flatMap((b) =>
        [0, 1].map((repetition) => ({ caseId: b.id, repetition })),
      ),
      requireBoundEvidence: true,
    },
    randomUUID(),
  );
  const attemptId = randomUUID();
  await client.startEvaluation(project, bundle.id, request.id, { attemptId }, randomUUID());
  const runs: {
    arm: 'parent' | 'candidate';
    repetition: number;
    batch: LargeBatch;
    output: unknown;
    grade: ReturnType<typeof grade>;
    elapsedMs: number;
    helperObserved: boolean;
    helperCorrect: number;
  }[] = [];
  const report = await compare({
    parent: { version: parent.version },
    candidate: { version: candidate.version },
    cases: frozen.batches.map((b) => ({ caseId: b.id, snapshot: b, settings: {}, repetitions: 2 })),
    datasetRevision: request.datasetRevision,
    graderRevision: request.graderRevision,
    runtime,
    evaluation: { requestId: request.id, attemptId },
    concurrency: 2,
    execute: async ({ version, snapshot, repetition }) => {
      const arm = version.version.id === parent.version.id ? 'parent' : 'candidate';
      console.log(
        `Large ${arm}: ${snapshot.id}, repetition ${repetition + 1}; 32 requests and ${snapshot.files.length} evidence files`,
      );
      const run = await luna.job(
        arm === 'parent' ? parent : candidate,
        { id: snapshot.id, incidents: snapshot.manifest },
        `${arm}-${snapshot.id}-${repetition}`,
        {
          prompt,
          schema: inventorySchema(snapshot.manifest.map((i) => i.id)),
          files: snapshot.files,
          timeoutMs: 360000,
        },
      );
      const result = grade(snapshot, run.output);
      runs.push({
        arm,
        repetition,
        batch: snapshot,
        output: run.output,
        grade: result,
        elapsedMs: run.elapsedMs,
        helperObserved: helperObserved(
          run.commands,
          snapshot.manifest.map((i) => i.id),
        ),
        helperCorrect: grade(
          snapshot,
          helperOutput(
            run.commands,
            snapshot.manifest.map((i) => i.id),
          ),
        ).correct,
      });
      console.log(`Large ${arm}: ${snapshot.id} => ${result.correct}/32; unsafe ${result.unsafe}`);
      return { output: run.output, usage: run.usage, outputRef: pathToFileURL(run.filename).href };
    },
    grade: async ({ output, caseId }) => ({
      reward: grade(frozen.batches.find((b) => b.id === caseId)!, output).reward,
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
  await save('comparison.json', comparison);
  await save('comparison-request.json', report);
  // Store grades and refs, without duplicating megabytes of inputs for each executed arm.
  await save(
    'grades.json',
    runs.map(({ batch, ...r }) => ({ ...r, batchId: batch.id })),
  );
  const stats = (arm: 'parent' | 'candidate') => ({
    correct: runs.filter((r) => r.arm === arm).reduce((n, r) => n + r.grade.correct, 0),
    total: frozen.metrics.incidentViews * 2,
    unsafe: runs.filter((r) => r.arm === arm).reduce((n, r) => n + r.grade.unsafe, 0),
    consistency: [0, 1].map((rep) =>
      consistency(
        frozen,
        runs.filter((r) => r.arm === arm && r.repetition === rep),
      ),
    ),
  });
  const baseline = stats('parent'),
    learned = stats('candidate');
  const adoption = {
    required: requiresHelper,
    expectedJobs: frozen.batches.length * 2,
    observedJobs: runs.filter((r) => r.arm === 'candidate' && r.helperObserved).length,
    exactDecisions: runs
      .filter((r) => r.arm === 'candidate')
      .reduce((n, r) => n + r.helperCorrect, 0),
  };
  const passed =
    comparison.complete &&
    learned.correct / learned.total >= 0.95 &&
    learned.correct > baseline.correct &&
    learned.unsafe === 0 &&
    (!adoption.required ||
      (adoption.observedJobs === adoption.expectedJobs &&
        adoption.exactDecisions === learned.total)) &&
    learned.consistency.every(
      (s) => s.checked === s.expected && s.violations === 0 && s.missing === 0,
    );
  const result = {
    passed,
    complete: comparison.complete,
    metrics: frozen.metrics,
    repetitions: 2,
    baseline,
    learned,
    helperAdoption: adoption,
    lunaCalls: luna.calls,
    model,
    comparisonId: comparison.id,
    sourceCandidateDigest: candidateSource.version.digest,
    costUsd: null,
    limits: [
      'Same synthetic policy domain, scaled to distributed evidence and repeated views.',
      '96 distinct base events plus 32 aliases; repetitions and aliases are not independent incidents.',
      'Dataset bytes are tool-accessible input, not a claim that the model consumed all bytes as context tokens.',
      'No new candidate edits, policy facts or audit feedback were sent to the proposer.',
      'Native read-only mode is not hostile-tenant isolation.',
      'No production or existing workspace was modified.',
    ],
  };
  await save('result.json', result);
  console.log(JSON.stringify(result, null, 2));
  assert(
    passed,
    'Large audit did not pass its preregistered accuracy, safety and consistency gates',
  );
  let delivery: unknown = null;
  if (verifyDelivery && initial && frozen.future) {
    const warm = await resolveAndCache(
      client,
      { projectId: project, bundleId: bundle.id, channel: 'qualification' },
      cache,
    );
    assert.equal(warm.version.id, parent.version.id);
    await save('review.json', {
      decision: 'Approve disposable qualified release',
      comparisonId: comparison.id,
      candidateVersion: candidate.version,
      sourceCandidateDigest: candidateSource.version.digest,
    });
    const promotion = await client.promote(
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
    const fetched = await resolveAndCache(
      client,
      { projectId: project, bundleId: bundle.id, channel: 'qualification' },
      cache,
    );
    assert.equal(fetched.version.id, candidate.version.id);
    assert.equal(fetched.stale, false);
    const next = frozen.future;
    const futureRun = await luna.job(
      fetched,
      { id: next.id, incidents: next.manifest },
      'fresh-release',
      {
        prompt,
        schema: inventorySchema(next.manifest.map((i) => i.id)),
        files: next.files,
        timeoutMs: 360000,
      },
    );
    const controlRun = await luna.job(
      parent,
      { id: next.id, incidents: next.manifest },
      'pinned-control',
      {
        prompt,
        schema: inventorySchema(next.manifest.map((i) => i.id)),
        files: next.files,
        timeoutMs: 360000,
      },
    );
    const future = grade(next, futureRun.output),
      control = grade(next, controlRun.output);
    delivery = {
      future,
      control,
      promotion,
      versionId: fetched.version.id,
      cacheRefreshed: true,
      helperObserved: helperObserved(
        futureRun.commands,
        next.manifest.map((i) => i.id),
      ),
    };
    await save('delivery.json', delivery);
    assert(
      future.correct === future.total && future.unsafe === 0 && future.correct > control.correct,
      'Fresh SDK delivery job failed',
    );
    assert(
      !requiresHelper ||
        helperObserved(
          futureRun.commands,
          next.manifest.map((i) => i.id),
        ),
      'Fresh job did not invoke the learned helper',
    );
    assert(
      !requiresHelper ||
        grade(
          next,
          helperOutput(
            futureRun.commands,
            next.manifest.map((i) => i.id),
          ),
        ).correct === next.incidents.length,
      'Fresh helper computation failed',
    );
    await assert.rejects(
      () =>
        client.promote(
          project,
          bundle.id,
          'qualification',
          {
            versionId: parent.version.id,
            expectedRevision: initial.revision,
            unevaluatedReason: 'Stale revision must fail',
          },
          randomUUID(),
        ),
      (e) => e instanceof ApiError && e.status === 409,
    );
  }
  await save('summary.json', { ...result, lunaCalls: luna.calls, delivery });
} catch (error) {
  failure = error;
  await save('failure.json', {
    passed: false,
    lunaCalls: luna.calls,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  await system.close();
}
if (failure) throw failure;
