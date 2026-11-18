import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AcclimateClient,
  type DeliveryReceiptRequest,
  type VerifiedBundle,
} from '../../src/index.js';
import {
  createLearningFieldAuditor,
  createLearningOutcomeReporter,
  type LearningFieldGrade,
} from '../../src/learning/index.js';

const projectId = 'test-project';
const integrationId = 'a7100000-0000-0000-0000-000000000001';
const outcomeId = 'a7100000-0000-0000-0000-000000000002';
const version = {
  id: 'version',
  bundleId: 'bundle',
  parentVersionId: null,
  digest: 'sha256:' + 'e'.repeat(64),
  createdAt: '2026-11-13T00:00:00Z',
};
const bundle: VerifiedBundle = {
  version,
  payload: { schemaVersion: 1, files: [] },
  resolvedAt: Date.now(),
  stale: false,
  connection: { projectId, integrationId },
  resolution: { channel: 'stable', revision: '2', version },
};

test('terminal reporter binds outcomes to fresh delivery and sends only bounded teaching data', async () => {
  const requests: Request[] = [];
  const client = new AcclimateClient({
    baseUrl: 'http://localhost:8090',
    token: 'outcome-principal',
    scope: 'outcome',
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ outcomeId, accepted: true, eligible: true });
    },
  });
  const report = createLearningOutcomeReporter({ client, projectId, integrationId });
  const outcome = {
    outcomeId,
    status: 'failed' as const,
    feedback: { expected: ' validated ', observed: 'skipped' },
    privateTask: 'never sent',
  };
  assert.deepEqual(await report(bundle, outcome), { outcomeId, accepted: true, eligible: true });
  const request = requests[0]!;
  assert.equal(
    new URL(request.url).pathname,
    '/v1/workspaces/' + projectId + '/connections/' + integrationId + '/learning/outcomes',
  );
  assert.equal(request.headers.get('idempotency-key'), outcomeId);
  assert.equal(request.headers.get('authorization'), 'Bearer outcome-principal');
  assert.deepEqual(await request.json(), {
    outcomeId,
    versionId: version.id,
    digest: version.digest,
    status: 'failed',
    deliveryRevision: '2',
    feedback: { expected: 'validated', observed: 'skipped' },
  });
  await assert.rejects(report({ ...bundle, stale: true }, outcome), /fresh bundle/);
  await assert.rejects(report({ ...bundle, connection: undefined }, outcome), /fresh bundle/);
  await assert.rejects(
    report(bundle, {
      ...outcome,
      feedback: {
        expected: 'x'.repeat(2049),
        observed: 'y',
      },
    }),
    /bounded teaching/,
  );
  await assert.rejects(
    report(bundle, {
      ...outcome,
      feedback: {
        expected: 'same',
        observed: ' same ',
      },
    }),
    /graded discrepancy/,
  );
  assert.equal(requests.length, 1);
});

test('field auditor links the exact started receipt and grades only the authorized predecessor', async (t) => {
  const parentId = 'a7100000-0000-0000-0000-000000000003';
  const eventId = 'a7100000-0000-0000-0000-000000000004';
  const payload = await readFile(
    new URL('../../../../contracts/fixtures/bundle-v1.json', import.meta.url),
  );
  const parent = {
    ...version,
    id: parentId,
    digest: 'sha256:' + createHash('sha256').update(payload).digest('hex'),
  };
  const startedReceipt: DeliveryReceiptRequest = {
    projectId,
    integrationId,
    eventId,
    bundleId: version.bundleId,
    versionId: version.id,
    digest: version.digest,
    channel: 'stable',
    revision: '2',
    stage: 'started',
    source: 'network',
    stale: false,
    occurredAt: new Date().toISOString(),
    resolvedAt: new Date(bundle.resolvedAt).toISOString(),
  };
  const requests: Request[] = [];
  const client = new AcclimateClient({
    baseUrl: 'http://localhost:8090',
    token: 'machine',
    scope: 'machine',
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith('/outcomes'))
        return Response.json({
          outcomeId,
          accepted: true,
          eligible: false,
          fieldAudit: { parentVersionId: parent.id, parentDigest: parent.digest },
        });
      if (request.url.endsWith('/field-audits'))
        return Response.json({ outcomeId, accepted: true, windowSize: 1, regressions: 1 });
      if (request.url.endsWith('/versions/' + parent.id)) return Response.json(parent);
      if (request.url.endsWith('/versions/' + parent.id + '/payload'))
        return new Response(new Uint8Array(payload));
      throw new Error('Unexpected request');
    },
  });
  const cacheDir = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-field-audit-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const outcomeReporter = createLearningOutcomeReporter({ client, projectId, integrationId });
  const outcome = await outcomeReporter(bundle, { outcomeId, status: 'failed', startedReceipt });
  assert.deepEqual(await requests[0]!.json(), {
    outcomeId,
    status: 'failed',
    versionId: version.id,
    digest: version.digest,
    startedReceiptId: startedReceipt.eventId,
    deliveryRevision: '2',
  });
  const sample = { job: 'private input', startedReceipt, outcome };
  const options = { client, projectId, integrationId, cacheDir, samplePercent: 100 };
  let grades: { served: LearningFieldGrade; predecessor: LearningFieldGrade } = {
    served: 'incorrect',
    predecessor: 'correct',
  };
  let executions = 0;
  const prepare = createLearningFieldAuditor({
    ...options,
    evaluate: async ({ job, served, predecessor }) => {
      executions++;
      assert.equal(job, sample.job);
      assert.equal(served, bundle);
      assert.equal(predecessor.version.id, parent.id);
      assert.equal(predecessor.version.digest, parent.digest);
      return grades;
    },
  });
  await assert.rejects(
    prepare(bundle, {
      ...sample,
      startedReceipt: { ...startedReceipt, revision: '1' },
    }),
    /exact fresh started receipt/,
  );
  const unsampled = createLearningFieldAuditor({
    ...options,
    samplePercent: 0,
    evaluate: async () => assert.fail('unsampled job executed'),
  });
  assert.equal(await unsampled(bundle, sample), null);
  assert.equal(executions, 0);
  const body = await prepare(bundle, sample);
  assert.deepEqual(body, {
    outcomeId,
    startedReceiptId: eventId,
    versionId: version.id,
    digest: version.digest,
    revision: '2',
    parentVersionId: parent.id,
    parentDigest: parent.digest,
    verdict: 'loss',
  });
  assert.equal(executions, 1);
  await client.reportLearningFieldAudit(projectId, integrationId, body!);
  assert.equal(requests.at(-1)!.headers.get('idempotency-key'), outcomeId);
  assert.deepEqual(await requests.at(-1)!.json(), body);
  grades = { served: 'incorrect', predecessor: 'incorrect' };
  assert.equal((await prepare(bundle, sample))?.verdict, 'tie');
  grades = { served: 'correct', predecessor: 'indeterminate' };
  assert.equal(await prepare(bundle, sample), null);
  grades = { served: 'correct', predecessor: 'correct' };
  assert.equal((await prepare(bundle, sample))?.verdict, 'tie');
  grades = { served: 'correct', predecessor: 'incorrect' };
  assert.equal((await prepare(bundle, sample))?.verdict, 'win');
});

test('enrollment PUT preserves an explicit false rollout precondition', async () => {
  const requests: Request[] = [];
  const client = new AcclimateClient({
    baseUrl: 'http://localhost:8090',
    token: 'administrator',
    scope: 'administrator',
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({});
    },
  });
  const descriptor = {
    datasetRevision: 'development',
    graderRevision: 'grader',
    runtime: { configId: 'app' },
    expectedCases: [{ caseId: 'case', repetition: 0 }],
  };
  await client.enrollLearning(
    projectId,
    integrationId,
    {
      installationId: 'app-installation',
      permittedPaths: ['instructions/main.md'],
      maxProposalAdmissions: 1,
      development: descriptor,
      audits: [
        {
          ...descriptor,
          datasetRevision: 'audit',
          expectedCases: [{ caseId: 'holdout', repetition: 0 }],
        },
      ],
      automaticRollout: true,
      expectedAutomaticRollout: false,
      outcomePrincipal: 'outcome',
      evaluatorPrincipal: 'evaluator',
    },
    outcomeId,
  );
  assert.equal(requests[0]?.method, 'PUT');
  assert.equal((await requests[0]?.json()).expectedAutomaticRollout, false);
});

test('corrections and rechecks use independent stable ids against their original connection', async () => {
  const requests: Request[] = [];
  const client = new AcclimateClient({
    baseUrl: 'http://localhost:8090',
    scope: 'evaluator',
    token: 'fixture-token',
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ accepted: true });
    },
  });
  const correctionId = 'a7100000-0000-0000-0000-000000000008';
  const correction = {
    correctionId,
    outcomeId,
    feedback: { expected: 'closed', observed: 'open' },
  };
  const recheck = {
    correctionId,
    revision: '3',
    versionId: version.id,
    digest: version.digest,
    verdict: 'reproduced' as const,
  };
  await client.reportLearningCorrection(projectId, integrationId, correction);
  await client.reportLearningRecheck(projectId, integrationId, recheck);
  const prefix = '/v1/workspaces/' + projectId + '/connections/' + integrationId + '/learning/';
  assert.deepEqual(
    requests.map((r) => new URL(r.url).pathname),
    [prefix + 'corrections', prefix + 'rechecks'],
  );
  assert.deepEqual(
    requests.map((r) => r.headers.get('idempotency-key')),
    [correctionId, correctionId + ':3'],
  );
  assert.deepEqual(await Promise.all(requests.map((r) => r.json())), [correction, recheck]);
});
