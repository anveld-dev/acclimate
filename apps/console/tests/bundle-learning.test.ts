import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LearningLoop, LearningLoopRequest, LearningRoundSummary } from '@acclimate/sdk';
import { BundleLearning } from '../src/components/bundle-learning';
import { activeRoundStates, enrollmentError } from '../src/lib/learning';
import {
  readLearningState,
  runLearningCommand,
  type LearningState,
} from '../src/server/learning-core';
import { consoleEnvironment } from './console-fixture';

const scope = { workspaceId: 'acme', bundleId: '00000000-0000-4000-8000-000000000001' };
const base = `/v1/workspaces/acme/bundles/${scope.bundleId}`;
const path = base + '/learning';
const env = { ...consoleEnvironment, CONSOLE_ALLOW_EDITS: 'true' };
const body: LearningLoopRequest = {
  channel: 'canary',
  appPrincipalId: 'machine:app',
  setting: { domain: 'support', benchmark: 'refunds', policyModel: 'policy' },
  heldOut: { digest: 'sha256:' + 'a'.repeat(64), cases: 2 },
};
const timestamp = '2026-11-20T12:00:00Z';
const round: LearningRoundSummary = {
  id: '00000000-0000-4000-8000-000000000002',
  number: 1,
  state: 'completed',
  decision: 'adopted',
  reason: null,
  parentVersionId: scope.bundleId,
  adoptedSample: 2,
  adoptedVersionId: scope.bundleId,
  incumbentScore: 0.9,
  heldOutScore: 0.8,
  heldOutError: null,
  createdAt: timestamp,
  endedAt: timestamp,
};
const loop: LearningLoop = {
  ...scope,
  ...body,
  status: 'running',
  pauseReason: null,
  evolveRevision: 2,
  liveCases: 3,
  memoryRevision: 0,
  nextRound: 2,
  failedRounds: 0,
  enrolledBy: 'user:admin',
  createdAt: timestamp,
  updatedAt: timestamp,
  activeRound: null,
  rounds: [round],
};
const empty: Extract<LearningState, { ok: true }> = {
  ok: true,
  bundleName: 'Support',
  loop: null,
  channels: ['canary'],
  principals: [],
  rounds: [],
  activeEvaluation: null,
  caseSnapshot: null,
  canManage: true,
};
const markup = (state: LearningState) =>
  renderToStaticMarkup(
    createElement(BundleLearning, {
      scope,
      state,
      refresh: async () => {},
    }),
  );
const response = (value: unknown, status = 200) => Response.json(value, { status });
const notFound = () =>
  response({ error: { code: 'not_found', message: 'Learning loop not enrolled' } }, 404);
function bundleFixture(url: URL, role = 'admin'): Response | undefined {
  if (url.pathname === '/v1/workspaces') return response({ items: [{ id: 'acme', role }] });
  if (url.pathname === '/v1/workspaces/acme/bundles')
    return response({ items: [{ id: scope.bundleId, name: 'Support' }] });
  if (url.pathname === base + '/channels') return response({ items: [{ name: 'canary' }] });
  if (url.pathname === '/v1/workspaces/acme/machine-tokens')
    return response({
      items: [
        { name: 'App', principalId: 'machine:app', status: 'active', rights: ['write'] },
        { name: 'Read only', principalId: 'machine:read', status: 'active', rights: ['read'] },
        { name: 'Expired', principalId: 'machine:old', status: 'expired', rights: ['evaluate'] },
      ],
    });
}

test('enrollment and recovery render for the appropriate states and roles', () => {
  assert.match(markup(empty), /Enroll loop/);
  assert.match(markup(empty), /acclimate-learning held-out/);
  assert.match(markup({ ...empty, channels: [] }), /Release a version on a channel/);
  assert.doesNotMatch(markup({ ...empty, canManage: false }), /Enroll loop/);
  assert.match(markup({ ok: false, message: 'Access denied' }), /role="alert"[^>]*>Access denied/);
  assert.match(markup({ ...empty, loop }), />Pause<.*>Stop</);
  assert.match(
    markup({ ...empty, loop: { ...loop, status: 'paused', pauseReason: 'operator' } }),
    />Resume<.*operator|operator.*>Resume</,
  );
  assert.match(markup({ ...empty, loop: { ...loop, status: 'stopped' } }), />Restart loop</);
  assert.doesNotMatch(
    markup({ ...empty, canManage: false, loop }),
    />(Pause|Resume|Stop|Add case)</,
  );
});

test('renders round states, evaluation progress and decreasing measured scores', () => {
  for (const state of activeRoundStates) {
    const html = markup({
      ...empty,
      loop: { ...loop, activeRound: { ...round, state } },
      activeEvaluation: {
        role: 'incumbent',
        sample: null,
        split: 'evolve',
        status: 'running',
        cases: 4,
        reportedCases: 2,
      },
    });
    assert.match(html, /aria-current="step"[^>]*>[^<]+ \(current\)/);
    assert.match(html, /2 of 4 cases reported/);
  }
  const html = markup({
    ...empty,
    loop,
    rounds: [
      {
        ...round,
        id: 'fifth',
        number: 5,
        state: 'stopped',
        decision: null,
        reason: 'stopped',
        heldOutScore: null,
      },
      {
        ...round,
        id: 'fourth',
        number: 4,
        state: 'failed',
        decision: null,
        reason: 'incumbent-evaluation-failed',
        incumbentScore: null,
        heldOutScore: null,
      },
      {
        ...round,
        id: 'third',
        number: 3,
        heldOutError: 'Monitoring timed out',
        heldOutScore: null,
        state: 'completed',
      },
      {
        ...round,
        id: 'second',
        number: 2,
        decision: 'kept',
        reason: 'no-candidates',
        incumbentScore: 0.6,
        heldOutScore: 0,
      },
      round,
    ],
    caseSnapshot: {
      roundNumber: 1,
      revision: 1,
      cases: [{ caseId: 'evolve-01', meanScore: 0.6, passedRollouts: 3 }],
    },
  });
  assert.match(html, /Round 1 · Incumbent evolve score · 0\.9/);
  assert.match(html, /Round 2 · Incumbent evolve score · 0\.6/);
  assert.match(html, /Round 2 · Held-out score \(monitoring only\) · 0/);
  assert.match(html, /Monitoring timed out/);
  assert.match(html, />Failed<\/td>/);
  assert.match(html, />Stopped<\/td>/);
  assert.match(html, /adopted.*kept|kept.*adopted/);
  assert.match(html, /evolve-01/);
  assert.doesNotMatch(html, />(Approve|Review|Rollout)</);
});

test('distinguishes an unenrolled bundle from access and service errors', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === path) return notFound();
    return bundleFixture(url) ?? response({}, 500);
  };
  const state = await readLearningState(env, scope, fetcher);
  assert.deepEqual(state, { ...empty, principals: [{ name: 'App', principalId: 'machine:app' }] });
  for (const status of [403, 503]) {
    const denied = await readLearningState(
      env,
      scope,
      async (input) =>
        bundleFixture(new URL(String(input))) ?? response({ error: { code: 'denied' } }, status),
    );
    assert.equal(denied.ok, false);
    assert.match(markup(denied), /role="alert"/);
  }
});

test('round pagination uses before and round reads omit trace requests and held-out case data', async () => {
  const activeRound = { ...round, state: 'scoring_held_out' as const };
  const paths: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-acclimate-session'), env.CONSOLE_SESSION_TOKEN);
    paths.push(url.pathname + url.search);
    if (url.pathname === path) return response({ ...loop, activeRound });
    if (url.pathname === path + '/rounds')
      return url.searchParams.has('before')
        ? response({ items: [], next: null })
        : response({ items: [activeRound], next: 1 });
    if (url.pathname === path + '/rounds/' + round.id)
      return response({
        ...activeRound,
        evolveRevision: 1,
        evaluations: [
          {
            role: 'retained',
            sample: null,
            split: 'heldOut',
            status: 'running',
            cases: 2,
            reportedCases: 1,
            caseSummaries: [{ caseId: 'held-out sentinel' }],
            report: { trace: 'held-out trace sentinel' },
          },
          {
            role: 'incumbent',
            split: 'evolve',
            status: 'scored',
            caseSummaries: [
              {
                caseId: 'case-a',
                passedRollouts: 3,
                meanScore: 0.6,
                trace: 'evolve trace sentinel',
              },
            ],
          },
        ],
      });
    return bundleFixture(url) ?? response({}, 500);
  };
  const state = await readLearningState(env, scope, fetcher);
  assert.ok(state.ok);
  assert.deepEqual(
    paths.filter((item) => item.startsWith(path + '/rounds')),
    [path + '/rounds?limit=100', path + '/rounds?limit=100&before=1', path + '/rounds/' + round.id],
  );
  assert.equal(state.activeEvaluation?.status, 'running');
  assert.deepEqual(state.caseSnapshot?.cases, [
    { caseId: 'case-a', passedRollouts: 3, meanScore: 0.6 },
  ]);
  assert.doesNotMatch(JSON.stringify(state), /sentinel/);
});

test('enrollment, pause, resume, stop and setup cases send their exact service shapes', async () => {
  const seen: { method?: string; path: string; key: string | null; body?: string | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const fixture = bundleFixture(url);
    if (fixture) return fixture;
    const headers = new Headers(init?.headers);
    const isCase = url.pathname.endsWith('/evolve-cases');
    assert.equal(headers.get('x-acclimate-session'), isCase ? null : env.CONSOLE_SESSION_TOKEN);
    assert.equal(
      headers.get('authorization'),
      `Bearer ${isCase ? 'app-token' : env.CONSOLE_SERVICE_TOKEN}`,
    );
    seen.push({
      path: url.pathname,
      method: init?.method,
      key: headers.get('idempotency-key'),
      body: init?.body as string | undefined,
    });
    return response(isCase ? { evolveRevision: 3, added: 1, retired: 0, liveCases: 4 } : loop);
  };
  assert.deepEqual(await runLearningCommand(env, scope, { action: 'enroll', body }, fetcher), {
    ok: true,
  });
  for (const action of ['pause', 'resume', 'stop'] as const)
    assert.deepEqual(await runLearningCommand(env, scope, { action }, fetcher), { ok: true });
  const added = await runLearningCommand(
    env,
    scope,
    {
      action: 'addCase',
      token: 'app-token',
      caseId: 'setup-1',
      input: '{"key":true}',
      expected: 'null',
    },
    fetcher,
  );
  assert.deepEqual(added, {
    ok: true,
    receipt: { evolveRevision: 3, added: 1, retired: 0, liveCases: 4 },
  });
  assert.deepEqual(
    seen.map((item) => [item.method, item.path, item.body]),
    [
      ['PUT', path, JSON.stringify(body)],
      ['POST', path + '/pause', undefined],
      ['POST', path + '/resume', undefined],
      ['POST', path + '/stop', undefined],
      [
        'POST',
        path + '/evolve-cases',
        '{"cases":[{"caseId":"setup-1","input":{"key":true},"expected":null}]}',
      ],
    ],
  );
  assert.equal(new Set(seen.map(({ key }) => key)).size, 5);
  for (const { key } of seen) assert.match(key ?? '', /^[a-f0-9-]{36}$/);
});

test('rejects invalid enrollment before network and preserves conflict guidance', async () => {
  for (const invalid of [
    { ...body, appPrincipalId: '' },
    { ...body, appPrincipalId: 'é'.repeat(513) },
    { ...body, setting: { ...body.setting, domain: 'é'.repeat(129) } },
    { ...body, setting: { ...body.setting, domain: 'a\nb' } },
    { ...body, heldOut: { ...body.heldOut, cases: 0 } },
  ]) {
    assert.ok(enrollmentError(invalid));
    const result = await runLearningCommand(
      env,
      scope,
      { action: 'enroll', body: invalid },
      async () => {
        assert.fail('invalid enrollment must not fetch');
      },
    );
    assert.equal(result.ok, false);
  }
  const result = await runLearningCommand(env, scope, { action: 'resume' }, async () =>
    response(
      { error: { code: 'learning_conflict', message: 'Use enrollment to restart the loop' } },
      409,
    ),
  );
  assert.deepEqual(result, { ok: false, message: 'Use enrollment to restart the loop' });
});
