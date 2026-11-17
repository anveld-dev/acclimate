import test from 'node:test';
import assert from 'node:assert/strict';
import type { LearningEnrollmentStatus } from '@acclimate/sdk';
import { consoleEnvironment } from './console-fixture';
import { connectionLearning } from '../src/server/integration-core';
import { learningPolicy } from '../src/server/connection-learning-policy';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const roundId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const target = { projectId: 'workspace', integrationId: id };
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
  automaticRollout: false,
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
    concurrentRollout?: boolean;
    omitRollbackPolicy?: boolean;
  } = {},
) {
  let status = options.status === undefined ? enrollment : options.status;
  let concurrentRollout = options.concurrentRollout;
  const requests: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, method, body, headers: new Headers(init?.headers) });

    if (url.includes('/v1/projects?'))
      return Response.json({
        items: [{ id: target.projectId, name: 'Workspace', role: options.role ?? 'admin' }],
        nextCursor: null,
      });
    if (/\/integrations\?/.test(url))
      return Response.json({
        items: [
          { id, projectId: target.projectId, bundleId: 'bundle', channel: 'stable', enabled: true },
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
      if (status && concurrentRollout !== undefined) {
        status = { ...status, automaticRollout: concurrentRollout };
        concurrentRollout = undefined;
      }
      const { expectedAutomaticRollout, ...policy } = body;
      if (
        expectedAutomaticRollout !== undefined &&
        expectedAutomaticRollout !== status?.automaticRollout
      )
        return Response.json({ error: { code: 'learning_conflict' } }, { status: 409 });
      status = { ...(status ?? enrollment), ...policy };
      return Response.json(status);
    }
    if (url.endsWith('/stop') && method === 'POST') {
      status = { ...enrollment, ...status, stoppedAt: '2026-11-17T15:00:00Z' };
      return Response.json(status);
    }
    if (url.endsWith('/restore') && method === 'POST' && status) {
      status = { ...status, deliveredVersionId: body.target.versionId, deliveredRevision: (BigInt(status.deliveredRevision) + 1n).toString() };
      return Response.json({ id: 'restore-promotion' });
    }
    if (url.endsWith('/renew') || url.endsWith(`/rounds/${roundId}/review`))
      return Response.json({ ok: true });
    throw Error(`Unexpected request ${method} ${url}`);
  };
  return { fetcher, requests };
}

test('connect learning is opt-in and returns the effective delivery target without evaluator controls', async () => {
  const f = fixture({ status: null });
  assert.deepEqual(await connectionLearning(env, { ...target, action: 'read' }, f.fetcher), {
    ok: true,
    status: null,
  });
  const result = await connectionLearning(env, { ...target, action: 'enroll', setup }, f.fetcher);
  assert(result.ok && result.status);
  assert.equal(result.status.automaticRollout, false);
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

test('rollout toggles retain installed settings and repeated requests avoid another write', async () => {
  const f = fixture();
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await connectionLearning(
      env,
      { ...target, action: 'rollout', automaticRollout: true },
      f.fetcher,
    );
    assert(result.ok && result.status?.automaticRollout);
  }
  const writes = f.requests.filter((request) => request.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.body, {
    ...learningPolicy(setup),
    automaticRollout: true,
    expectedAutomaticRollout: false,
  });
  const stopped = await connectionLearning(env, { ...target, action: 'stop' }, f.fetcher);
  assert(stopped.ok && stopped.status?.stoppedAt);
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
    assert.equal(updated.status.automaticRollout, false);
  }
  const writes = f.requests.filter((request) => request.method === 'PUT');
  assert.deepEqual(
    writes.map((request) => request.body),
    [
      { ...learningPolicy(setup), automaticRollback: true, expectedAutomaticRollout: false },
      { ...learningPolicy(setup), automaticRollback: false, expectedAutomaticRollout: false },
    ],
  );
  const denied = fixture({ role: 'editor' });
  const result = await connectionLearning(
    env,
    { ...target, action: 'rollback', automaticRollback: true },
    denied.fetcher,
  );
  assert(!result.ok);
  assert(denied.requests.every((request) => request.method === 'GET'));

  const enabled = fixture({ status: { ...enrollment, automaticRollback: true } });
  const rollout = await connectionLearning(
    env,
    { ...target, action: 'rollout', automaticRollout: true },
    enabled.fetcher,
  );
  assert(rollout.ok && rollout.status?.automaticRollout && rollout.status.automaticRollback);
  const rolloutWrite = enabled.requests.find((request) => request.method === 'PUT');
  assert.deepEqual(rolloutWrite?.body, {
    ...learningPolicy(setup),
    automaticRollout: true,
    expectedAutomaticRollout: false,
  });
});

test('a rollback toggle cannot overwrite a concurrent rollout policy change', async () => {
  const f = fixture({
    status: { ...enrollment, automaticRollback: false },
    concurrentRollout: true,
  });
  const toggle = { ...target, action: 'rollback', automaticRollback: true } as const;
  const conflict = await connectionLearning(env, toggle, f.fetcher);
  assert(!conflict.ok);
  assert.match(conflict.message, /Refresh/);
  const read = await connectionLearning(env, { ...target, action: 'read' }, f.fetcher);
  assert(read.ok && read.status?.automaticRollout);
  assert.equal(read.status.automaticRollback, false);

  const retried = await connectionLearning(env, toggle, f.fetcher);
  assert(retried.ok && retried.status?.automaticRollout && retried.status.automaticRollback);
  const writes = f.requests.filter((request) => request.method === 'PUT');
  assert.deepEqual(
    writes.map((request) => request.body),
    [
      { ...learningPolicy(setup), automaticRollback: true, expectedAutomaticRollout: false },
      {
        ...learningPolicy(setup),
        automaticRollout: true,
        automaticRollback: true,
        expectedAutomaticRollout: true,
      },
    ],
  );
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

test('renewal and review bind the current selected connection, operation identity and decision', async () => {
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
  assert.equal(
    (
      await connectionLearning(
        env,
        {
          ...target,
          action: 'review',
          roundId,
          approve: false,
        },
        f.fetcher,
      )
    ).ok,
    true,
  );
  const [renew, review] = f.requests.filter((request) => request.method === 'POST');
  assert(renew.url.endsWith(`/projects/workspace/integrations/${id}/learning/renew`));
  assert.deepEqual(renew.body, {
    renewalId: roundId,
    expectedRevision: 1,
    proposalAdmissions: 5,
    audits: [audit],
  });
  assert.equal(renew.headers.get('idempotency-key'), roundId);
  assert(
    review.url.endsWith(`/projects/workspace/integrations/${id}/learning/rounds/${roundId}/review`),
  );
  assert.deepEqual(review.body, { approve: false });
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
          integrationId: roundId,
        },
        f.fetcher,
      )
    ).ok,
    false,
  );
  assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0);
  const mismatched = fixture({ status: { ...enrollment, integrationId: roundId } });
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
  assert.throws(() => learningPolicy({ ...setup, automaticRollout: true }), /commitments/);
  const policy = learningPolicy({
    ...setup,
    automaticRollout: true,
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
    expectedAutomaticRollout: false,
    skillPackages: { createSkillNames: [], retireSkillNames: [] },
    selectionPolicies: stages,
  });
});

test('a skill permission update submits explicitly reviewed future paths', async () => {
  const f = fixture();
  const result = await connectionLearning(env, {
    ...target, action: 'skills', createSkillNames: 'refunds', retireSkillNames: '',
    permittedPaths: 'instructions.md\nskills/refunds/SKILL.md',
  }, f.fetcher);
  assert(result.ok && result.status);
  assert.deepEqual(result.status.permittedPaths, ['instructions.md', 'skills/refunds/SKILL.md']);
  assert.deepEqual(result.status.skillPackages, {createSkillNames: ['refunds'], retireSkillNames: []});
});

test('reviewed restores bind the exact connection, current revision, selected target and reason even after stop', async () => {
  const restoreTarget = { kind: 'source' as const, versionId: roundId, revision: '12' };
  const f = fixture({
    status: { ...enrollment, stoppedAt: '2026-11-17T15:00:00Z', restoreTargets: [restoreTarget] },
  });
  const read = await connectionLearning(env, { ...target, action: 'read' }, f.fetcher);
  assert(read.ok && read.status);
  assert.deepEqual(read.status.restoreTargets, [restoreTarget]);
  const request = {
    ...target,
    action: 'restore' as const,
    restoreId: id,
    expectedRevision: '9',
    target: restoreTarget,
    reason: 'Apply reviewed refund policy.',
  };
  const result = await connectionLearning(env, request, f.fetcher);
  assert(result.ok && result.status);
  assert.equal(result.status.deliveredRevision, '10');
  assert.equal(result.status.deliveredVersionId, roundId);
  const write = f.requests.find((entry) => entry.method === 'POST');
  assert(write);
  assert(write.url.endsWith(`/integrations/${id}/learning/restore`));
  assert.equal(write.headers.get('idempotency-key'), id);
  assert.deepEqual(write.body, {
    restoreId: id,
    expectedRevision: '9',
    target: restoreTarget,
    reason: request.reason,
  });
  const invalid = await connectionLearning(env, { ...request, expectedRevision: '9.0' }, f.fetcher);
  assert(!invalid.ok);
  assert.equal(f.requests.filter((entry) => entry.method === 'POST').length, 1);
});
