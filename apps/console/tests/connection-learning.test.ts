import test from 'node:test';
import assert from 'node:assert/strict';
import type { LearningEnrollmentStatus } from '@acclimate/sdk';
import { consoleEnvironment } from './console-fixture';
import { connectionLearning, lookupLearningOutcome } from '../src/server/integration-core';
import { learningPolicy } from '../src/server/connection-learning-policy';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const roundId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const target = { workspaceId: 'workspace', connectionId: id };
const env = {
  ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'fixture-console-token',
  CONSOLE_SESSION_TOKEN: 'fixture-session-token',
  CONSOLE_ALLOW_EDITS: 'true',
};
const development = {
  datasetRevision: 'development-r1',
  graderRevision: 'grader-r1',
  runtime: { model: 'model-r1' },
  expectedCases: [{ caseId: 'dev-case-1', repetition: 0 }],
  fixtureProtocol: 'installed-v1' as const,
  datasetDigest: '1'.repeat(64),
  caseFingerprints: ['2'.repeat(64)],
};
const audit = {
  ...development,
  datasetRevision: 'audit-r1',
  expectedCases: [{ caseId: 'audit-case-1', repetition: 0 }],
  datasetDigest: 'a'.repeat(64),
  caseFingerprints: ['b'.repeat(64)],
  familyFingerprints: ['c'.repeat(64)],
};
const setup = {
  installationId: 'installed-evaluator',
  outcomePrincipal: 'outcome-principal',
  evaluatorPrincipal: 'evaluator-principal',
  permittedPaths: 'instructions.md',
  maxProposalAdmissions: '3',
  descriptors: JSON.stringify({ development, audits: [audit] }),
};
const enrollment: LearningEnrollmentStatus = {
  ...learningPolicy(setup),
  ...target,
  bundleId: 'bundle',
  channel: 'stable',
  enabled: true,
  authorizedBy: 'admin',
  stoppedAt: null,
  proposalAdmissions: 2,
  renewalRevision: 1,
  requiresRolloutAuthorization: false,
  remainingAudits: 0,
  auditCount: 1,
  automaticRollback: true,
  deliveredVersionId: 'effective-version',
  deliveredRevision: '9',
  rounds: [],
};

function fixture(
  options: {
    role?: string;
    status?: LearningEnrollmentStatus | null;
    omitRollbackPolicy?: boolean;
  } = {},
) {
  let status = options.status === undefined ? enrollment : options.status;
  const requests: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, method, body, headers: new Headers(init?.headers) });

    if (url.includes('/v1/workspaces?'))
      return Response.json({
        items: [{ id: target.workspaceId, name: 'Workspace', role: options.role ?? 'admin' }],
        nextCursor: null,
      });
    if (/\/connections\?/.test(url))
      return Response.json({
        items: [
          { id, workspaceId: target.workspaceId, bundleId: 'bundle', channel: 'stable', enabled: true },
        ],
        nextCursor: null,
      });
    if (url.endsWith('/learning') && method === 'GET') {
      if (!status)
        return Response.json(
          { error: { code: 'not_found', message: 'Learning enrollment not found' } },
          { status: 404 },
        );
      const { automaticRollback, ...rest } = status;
      return Response.json({
        ...rest,
        ...(options.omitRollbackPolicy ? {} : { automaticRollback }),
        secret: 'ignored-secret',
      });
    }
    if (url.endsWith('/learning') && method === 'PUT') {
      status = { ...(status ?? enrollment), ...body, requiresRolloutAuthorization: false };
      return Response.json(status);
    }
    if (url.endsWith('/stop') && method === 'POST') {
      status = { ...enrollment, ...status, stoppedAt: '2026-11-17T15:00:00Z' };
      return Response.json(status);
    }
    if (url.endsWith('/renew')) return Response.json({ ok: true });
    throw Error(`Unexpected request ${method} ${url}`);
  };
  return { fetcher, requests };
}

test('connected setup enrolls the connection and returns the effective delivery target without evaluator controls', async () => {
  const f = fixture({ status: null });
  assert.deepEqual(await connectionLearning(env, { ...target, action: 'read' }, f.fetcher), {
    ok: true,
    status: null,
  });
  const result = await connectionLearning(env, { ...target, action: 'enroll', setup }, f.fetcher);
  assert(result.ok && result.status);
  assert.equal(result.status.requiresRolloutAuthorization, false);
  assert.equal(result.status.automaticRollback, true);
  assert.equal(result.status.deliveredVersionId, 'effective-version');
  assert.equal(result.status.remainingAudits, 0);
  assert(
    !/fixture-console-token|fixture-session-token|ignored-secret|evaluator-principal|audit-case-1/.test(
      JSON.stringify(result),
    ),
  );
  const write = f.requests.find((request) => request.method === 'PUT');
  assert(write);
  assert.equal(write.headers.get('authorization'), 'Bearer fixture-console-token');
  assert.equal(write.headers.get('x-acclimate-session'), 'fixture-session-token');
  assert.deepEqual(write.body, learningPolicy(setup));
});

test('an administrator authorizes a legacy enrollment once and can stop learning', async () => {
  const f = fixture({ status: { ...enrollment, requiresRolloutAuthorization: true } });
  const before = await connectionLearning(env, { ...target, action: 'read' }, f.fetcher);
  assert(before.ok && before.status?.requiresRolloutAuthorization);
  for (let i = 0; i < 2; i++) {
    const result = await connectionLearning(env, { ...target, action: 'authorize' }, f.fetcher);
    assert(result.ok && result.status && !result.status.requiresRolloutAuthorization);
  }
  assert.deepEqual(f.requests.filter(r => r.method === 'PUT').map(r => r.body), [learningPolicy(setup)]);
  const stopped = await connectionLearning(env, { ...target, action: 'stop' }, f.fetcher);
  assert(stopped.ok && stopped.status?.stoppedAt);
});

test('retired rollout controls are rejected without contacting the service', async () => {
  const f = fixture();
  for (const action of ['rollout', 'restore', 'review']) {
    const result = await connectionLearning(env, { ...target, action } as Parameters<typeof connectionLearning>[1], f.fetcher);
    assert(!result.ok);
  }
  assert.equal(f.requests.length, 0);
});

test('automatic rollback defaults to enabled when a status response omits the policy', async () => {
  const f = fixture({ omitRollbackPolicy: true });
  const read = await connectionLearning(env, { ...target, action: 'read' }, f.fetcher);
  assert(read.ok && read.status?.automaticRollback);
  const enabled = await connectionLearning(
    env,
    { ...target, action: 'rollback', automaticRollback: true },
    f.fetcher,
  );
  assert(enabled.ok && enabled.status?.automaticRollback);
  assert(f.requests.every((request) => request.method === 'GET'));
});

test('automatic rollback is scoped and independently switchable', async () => {
  const f = fixture({ status: { ...enrollment, automaticRollback: false } });
  const read = await connectionLearning(env, { ...target, action: 'read' }, f.fetcher);
  assert(read.ok && !read.status?.automaticRollback);

  for (const automaticRollback of [true, true, false]) {
    const updated = await connectionLearning(
      env,
      { ...target, action: 'rollback', automaticRollback },
      f.fetcher,
    );
    assert(updated.ok && updated.status);
    assert.equal(updated.status.automaticRollback, automaticRollback);
  }
  const writes = f.requests.filter((request) => request.method === 'PUT');
  assert.deepEqual(
    writes.map((request) => request.body),
    [
      { ...learningPolicy(setup), automaticRollback: true },
      { ...learningPolicy(setup), automaticRollback: false },
    ],
  );
  const denied = fixture({ role: 'editor' });
  const result = await connectionLearning(
    env,
    { ...target, action: 'rollback', automaticRollback: true },
    denied.fetcher,
  );
  assert(!result.ok);
  assert(denied.requests.every(r => r.method === 'GET'));
});

test('post-rollout inspection carries only counts, the original parent and the rollback promotion', async () => {
  const fieldAudits = {
    windowSize: 5,
    regressions: 3,
    rollbackPromotionId: 'rollback-promotion',
    privateEvidence: 'raw-field-outcome',
  };
  const f = fixture({
    status: {
      ...enrollment,
      automaticRollback: true,
      deliveredVersionId: 'previous',
      rounds: [
        {
          id: roundId,
          outcomeId: id,
          state: 'promoted',
          reason: null,
          parentVersionId: 'previous',
          candidateVersionId: 'rolled-out-then-replaced',
          proposalId: null,
          developmentRequestId: null,
          developmentComparisonId: null,
          auditRequestId: null,
          auditComparisonId: null,
          promotionId: 'rollout-promotion',
          fieldAudits,
        },
      ],
    },
  });
  const result = await connectionLearning(env, { ...target, action: 'read' }, f.fetcher);
  assert(result.ok && result.status);
  assert.equal(result.status.deliveredVersionId, 'previous');
  const [round] = result.status.rounds;
  assert.equal(round.promotionId, 'rollout-promotion');
  assert.equal(round.parentVersionId, 'previous');
  assert.deepEqual(round.fieldAudits, {
    windowSize: 5,
    regressions: 3,
    rollbackPromotionId: 'rollback-promotion',
  });
  assert(!JSON.stringify(result).includes('raw-field-outcome'));
});

test('new enrollment carries explicit rollback policy and rejects invalid values', () => {
  assert.equal(learningPolicy({ ...setup, automaticRollback: true }).automaticRollback, true);
  assert.equal(learningPolicy({ ...setup, automaticRollback: false }).automaticRollback, false);
  assert.throws(
    () => learningPolicy({ ...setup, automaticRollback: 'true' }),
    /post-rollout policy/,
  );
});

test('renewal binds the selected connection and operation identity', async () => {
  const f = fixture();
  assert.equal(
    (
      await connectionLearning(
        env,
        {
          ...target,
          action: 'renew',
          renewalId: roundId,
          expectedRevision: 1,
          proposalAdmissions: '5',
          descriptors: JSON.stringify([audit]),
        },
        f.fetcher,
      )
    ).ok,
    true,
  );
  const [renew] = f.requests.filter((request) => request.method === 'POST');
  assert(renew.url.endsWith(`/workspaces/workspace/connections/${id}/learning/renew`));
  assert.deepEqual(renew.body, {
    renewalId: roundId,
    expectedRevision: 1,
    proposalAdmissions: 5,
    audits: [audit],
  });
});

test('learning rejects cross-connection status, out-of-scope targets and requests without live admin edit access', async () => {
  const f = fixture();
  const off = await connectionLearning(
    { ...env, CONSOLE_ALLOW_EDITS: 'false' },
    { ...target, action: 'stop' },
    f.fetcher,
  );
  assert.equal(off.ok, false);
  assert.equal(f.requests.length, 0);
  for (const role of ['viewer', 'editor']) {
    const denied = fixture({ role });
    const result = await connectionLearning(env, { ...target, action: 'stop' }, denied.fetcher);
    assert.equal(result.ok, false);
    assert.equal(denied.requests.length, 1);
  }
  assert.equal(
    (
      await connectionLearning(
        env,
        {
          ...target,
          action: 'stop',
          connectionId: roundId,
        },
        f.fetcher,
      )
    ).ok,
    false,
  );
  assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0);
  const mismatched = fixture({ status: { ...enrollment, connectionId: roundId } });
  assert.equal(
    (await connectionLearning(env, { ...target, action: 'read' }, mismatched.fetcher)).ok,
    false,
  );
});

test('an overlapping or invalid descriptor is blocked before enrollment', async () => {
  const f = fixture();
  const result = await connectionLearning(
    env,
    {
      ...target,
      action: 'enroll',
      setup: {
        ...setup,
        descriptors: JSON.stringify({
          development,
          audits: [{ ...audit, expectedCases: development.expectedCases }],
        }),
      },
    },
    f.fetcher,
  );
  assert(!result.ok);
  assert.match(result.message, /disjoint/);
  assert(f.requests.every((request) => request.method === 'GET'));
});

const committedDevelopment = {
  ...development,
  fixtureProtocol: 'installed-v1' as const,
  datasetDigest: '1'.repeat(64),
  caseFingerprints: ['2'.repeat(64)],
};
const committedAudit = { ...audit, fixtureProtocol: 'installed-v1' as const };
const quality = {
  schemaVersion: 1 as const,
  id: 'quality',
  revision: '2',
  metric: { direction: 'higher' as const, name: 'correctness', unit: 'score' },
  aggregation: 'equal-case-means' as const,
  minimumMeanImprovement: 0.1,
  maximumCaseRegression: 0.01,
  requiredCases: [],
  minimumRepetitionsPerCase: 1,
};
const stages = {
  development: quality,
  audit: { ...quality, minimumMeanImprovement: 0, protectedCaseThresholds: { 'audit-case-1': 1 } },
};

test('automatic enrollment binds installed fixtures, scoped skills and separate stage objectives', () => {
  assert.throws(() => learningPolicy({ ...setup, automaticRollout: false }), /requires automatic rollout/);
  assert.throws(() => learningPolicy({ ...setup, descriptors: JSON.stringify({ development: { ...development, fixtureProtocol: undefined }, audits: [audit] }) }), /commitments/);
  const policy = learningPolicy({
    ...setup,
    descriptors: JSON.stringify({ development: committedDevelopment, audits: [committedAudit] }),
    createSkillNames: 'refunds',
    retireSkillNames: 'old-refunds',
    selectionPolicies: JSON.stringify(stages),
  });
  assert.deepEqual(policy.development, committedDevelopment);
  assert.deepEqual(policy.audits, [committedAudit]);
  assert.deepEqual(policy.skillPackages, {
    createSkillNames: ['refunds'],
    retireSkillNames: ['old-refunds'],
  });
  assert.deepEqual(policy.selectionPolicies, stages);
  assert.throws(
    () => learningPolicy({ ...setup, createSkillNames: 'skills/../../test' }),
    /skill names/,
  );
  assert.throws(
    () =>
      learningPolicy({
        ...setup,
        selectionPolicies: JSON.stringify({ development: {}, audit: quality }),
      }),
    /selection policies/,
  );
});

test('policy rotation can update the development evaluator and stage policies without spending or adding audits', async () => {
  const f = fixture();
  const result = await connectionLearning(
    env,
    {
      ...target,
      action: 'renew',
      expectedRevision: 1,
      renewalId: roundId,
      proposalAdmissions: '',
      descriptors: '',
      development: JSON.stringify(committedDevelopment),
      selectionPolicies: JSON.stringify(stages),
    },
    f.fetcher,
  );
  assert(result.ok);
  assert.deepEqual(f.requests.find((entry) => entry.url.endsWith('/renew'))?.body, {
    renewalId: roundId,
    expectedRevision: 1,
    proposalAdmissions: 0,
    audits: [],
    development: committedDevelopment,
    selectionPolicies: stages,
  });
});

test('operators can remove structural permissions while retaining enrolled selection policies', async () => {
  const f = fixture({
    status: {
      ...enrollment,
      selectionPolicies: stages,
      skillPackages: { createSkillNames: ['refunds'], retireSkillNames: [] },
    },
  });
  const result = await connectionLearning(
    env,
    {
      ...target,
      action: 'skills',
      createSkillNames: '',
      retireSkillNames: '',
    },
    f.fetcher,
  );
  assert(result.ok && result.status);
  assert.deepEqual(result.status.skillPackages, { createSkillNames: [], retireSkillNames: [] });
  assert.deepEqual(result.status.policySummary, {
    development: 'quality · 2',
    audit: 'quality · 2',
  });
  assert(!JSON.stringify(result).includes('audit-case-1'));
  assert.deepEqual(f.requests.find((entry) => entry.method === 'PUT')?.body, {
    ...learningPolicy(setup),
    skillPackages: { createSkillNames: [], retireSkillNames: [] },
    selectionPolicies: stages,
  });
});

test('a skill permission update submits explicitly reviewed future paths', async () => {
  const f = fixture();
  const result = await connectionLearning(
    env,
    {
      ...target,
      action: 'skills',
      createSkillNames: 'refunds',
      retireSkillNames: '',
      permittedPaths: 'instructions.md\nskills/refunds/SKILL.md',
    },
    f.fetcher,
  );
  assert(result.ok && result.status);
  assert.deepEqual(result.status.permittedPaths, ['instructions.md', 'skills/refunds/SKILL.md']);
  assert.deepEqual(result.status.skillPackages, {
    createSkillNames: ['refunds'],
    retireSkillNames: [],
  });
});

test('read-only outcome lookup scopes the UUID and omits private data from the browser response', async () => {
  const requests: string[] = [];
  const status = await lookupLearningOutcome(
    { ...env, CONSOLE_ALLOW_EDITS: 'false' },
    { ...target, outcomeId: roundId },
    async (url) => {
      requests.push(String(url));
      return Response.json({
        outcomeId: roundId,
        status: 'failed',
        versionId: id,
        deliveryRevision: '2',
        receivedAt: '2026-11-17T12:00:00Z',
        secret: 'private-job',
        currentDelivery: { versionId: id, revision: '3', secret: 'private-job' },
        fieldAudit: {
          verdict: 'regression',
          controlVersionId: id,
          triggeredRollback: true,
          secret: 'private-job',
        },
        servedRelease: {
          promotionId: id,
          versionId: roundId,
          revision: '2',
          withdrawn: true,
          rollback: { promotionId: roundId, versionId: id, revision: '3', secret: 'private-job' },
          developmentRequestId: null,
          auditRequestId: roundId,
          secret: 'private-job',
        },
        corrections: [
          {
            correctionId: id,
            roundId: null,
            state: 'awaiting_baseline_recheck',
            reason: null,
            incidentReplay: null,
            feedback: 'private-job',
          },
        ],
      });
    },
  );
  assert.ok(status.ok);
  assert.equal(status.outcome.corrections[0]?.state, 'awaiting_baseline_recheck');
  assert.equal(status.outcome.servedRelease?.withdrawn, true);
  assert.equal(status.outcome.fieldAudit?.triggeredRollback, true);
  assert.equal(status.outcome.currentDelivery?.revision, '3');
  assert.equal(JSON.stringify(status).includes('private-job'), false);
  assert.equal(requests.length, 1);
  assert.ok(
    requests[0]!.endsWith(
      '/workspaces/workspace/connections/' + id + '/learning/outcomes/' + roundId,
    ),
  );
});
