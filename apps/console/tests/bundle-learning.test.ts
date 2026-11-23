import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  LearningCandidate,
  LearningLoop,
  LearningLoopRequest,
  LearningMemory,
  LearningRound,
  LearningRoundSummary,
} from '@acclimate/sdk';
import { BundleLearning } from '../src/components/bundle-learning';
import { activeRoundStates } from '../src/lib/learning';
import { readLearningState, type LearningState } from '../src/server/learning-core';
import { consoleEnvironment } from './console-fixture';

const scope = { workspaceId: 'acme', bundleId: '00000000-0000-4000-8000-000000000001' };
const base = `/v1/workspaces/acme/bundles/${scope.bundleId}`;
const path = base + '/learning';
const env = { ...consoleEnvironment, CONSOLE_ALLOW_EDITS: 'true' };
const body: LearningLoopRequest = {
  channel: 'canary',
  taskModel: 'task',
  judgeModel: 'judge',
  setting: { domain: 'support', benchmark: 'refunds' },
};
const timestamp = '2026-11-20T12:00:00Z';
const round: LearningRoundSummary = {
  id: '00000000-0000-4000-8000-000000000002',
  number: 1,
  diff: null,
  diagnosis: null,
  evolveScore: 0.9,
  trigger: 'start',
  incumbentReused: false,
  taskModel: 'task',
  judgeModel: 'judge',
  taskRevision: 2,
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
  taskRevision: 2,
  setting: { ...body.setting, policyModel: body.taskModel },
  admittedEvolve: 0,
  admittedHeldOut: 0,
  maxRoundsPerDay: 4,
  waiting: null,
  alert: null,
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

  rounds: [],
  activeEvaluation: null,
  history: [],
  blocked: [],
  channelHead: null,
  progress: null,
  canManage: true,
  canEditCases: true,
  detail: null,
  memory: null,
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
}

test('enrollment and recovery render for the appropriate states and roles', () => {
  assert.match(markup(empty), /Save learning settings/);
  assert.match(markup({ ...empty, loop }), /Import material/);
  assert.match(
    markup({ ...empty, loop: { ...loop, status: 'paused' } }),
    /Start needs 20 more evolve and 20 more held-out/,
  );
  assert.doesNotMatch(markup({ ...empty, canManage: false }), /Save learning settings/);
  assert.match(markup({ ok: false, message: 'Access denied' }), /role="alert"/);
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
        heldOutError: 'held-out-evaluation-failed',
        heldOutScore: null,
        state: 'completed',
      },
      {
        ...round,
        id: 'kept-unchecked',
        number: 5,
        decision: 'kept',
        adoptedSample: null,
        adoptedVersionId: null,
        heldOutError: 'held-out-evaluation-failed',
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
        evolveScore: 0.6,
        heldOutScore: 0,
      },
      round,
    ],
  });
  assert.match(html, /Round 1 · Evolve score · 0\.9/);
  assert.match(html, /Round 2 · Evolve score · 0\.6/);
  assert.match(html, /Round 2 · Held-out score \(monitoring only\) · 0/);
  assert.match(html, /This version was released, but the regression check could not run\./);
  assert.match(html, /The regression check on held-out tasks could not run\./);
  assert.doesNotMatch(html, /held-out-evaluation-failed/);
  assert.match(html, />Failed<\/td>/);
  assert.match(html, />Stopped<\/td>/);
  assert.match(html, /adopted.*kept|kept.*adopted/);
  assert.match(html, /Small held-out sets/);
  assert.doesNotMatch(html, />(Approve|Review|Rollout)</);
});

test('distinguishes an unenrolled bundle from access and service errors', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === path) return notFound();
    return bundleFixture(url) ?? response({}, 500);
  };
  const state = await readLearningState(env, scope, fetcher);
  assert.deepEqual(state, empty);
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
  assert.doesNotMatch(JSON.stringify(state), /sentinel/);
});

const changes = {
  edits: [{ path: 'AGENTS.md', oldText: 'Stop', newText: 'Retry' }],
  files: [],
};
const candidate: LearningCandidate = {
  sample: 2,
  status: 'evaluated',
  dropReason: null,
  diagnosis: { problem: { new: 'Agent stops early' }, predicted: ['case-a', 'case-b'] },
  rationale: 'Retry after an error',
  changes,
  scan: { clean: true, findings: [] },
  screen: { verdict: 'evaluate', reason: 'Targets the diagnosis' },
  versionId: 'released-version',
  evaluationId: 'evaluation',
  evolveScore: 1,
};
const detailRound: LearningRound = {
  ...round,
  channel: 'canary',
  channelRevision: '7',
  evolveRevision: 2,
  memoryRevision: 0,
  memoryDigest: 'memory-digest',
  historyDigest: null,
  setting: loop.setting,
  optimizerReasoningEffort: null,
  optimizerModel: 'optimizer',
  adoptedVersionId: candidate.versionId,
  selection: {
    decision: 'adopt',
    sample: 2,
    reason: 'Fixed the failures',
    versionId: candidate.versionId,
    digest: 'digest',
    model: 'optimizer',
    inputDigest: 'input-digest',
  },
  candidates: [
    { ...candidate, sample: 1, diagnosis: { problem: { id: 'P1' }, predicted: [] } },
    candidate,
    {
      ...candidate,
      sample: 3,
      status: 'dropped',
      dropReason: 'scanner-rejected',
      rationale: null,
      changes: null,
      diagnosis: null,
      screen: null,
      evolveScore: null,
      scan: { clean: false, findings: [{ rule: 'email', field: 'rationale', path: null }] },
    },
    {
      ...candidate,
      sample: 4,
      status: 'screened_out',
      screen: { verdict: 'skip', reason: 'Repeated a direction' },
    },
    { ...candidate, sample: 5, status: 'evaluation_failed', evolveScore: null },
  ],
  evaluations: [],
};
const provenance = { ...loop.setting, round: 1 };
const memory: LearningMemory = {
  currentRevision: 2,
  memoryRevision: 1,
  memoryDigest: 'memory-digest',
  improvementMemory: {
    schemaVersion: 1,
    memoryRevision: 1,
    problems: [
      {
        id: 'P1',
        rootCause: 'Agent stops early',
        openedRound: 1,
        attempts: [
          {
            round: 1,
            sample: 2,
            accepted: true,
            backfilled: false,
            what: { rationale: 'Keep trying', changes },
            files: ['AGENTS.md'],
            predicted: ['case-a', 'case-b'],
            fixed: ['case-a'],
            missed: ['case-b'],
            passed: 9,
            total: 10,
            domain: body.setting.domain,
            provenance,
          },
        ],
      },
    ],
  },
  records: [
    {
      revision: 1,
      problemId: 'P1',
      roundId: round.id,
      round: 1,
      versionId: 'released-version',
      provenance: {
        ...provenance,
        optimizerModel: 'optimizer',
        evolveRevision: 2,
      },
    },
  ],
};

test('round detail and historical memory load with the session and render for editors', async () => {
  const urls: string[] = [];
  const state = await readLearningState(
    env,
    scope,
    async (input, init) => {
      const url = new URL(String(input));
      assert.equal(
        new Headers(init?.headers).get('x-acclimate-session'),
        env.CONSOLE_SESSION_TOKEN,
      );
      urls.push(url.pathname + url.search);
      if (url.pathname === path) return response(loop);
      if (url.pathname === path + '/rounds') return response({ items: [round], next: null });
      if (url.pathname === path + '/rounds/' + round.id) return response(detailRound);
      if (url.pathname === path + '/memory') return response(memory);
      return bundleFixture(url, 'editor') ?? response({}, 500);
    },
    { round: String(round.number), memory: '1' },
  );
  assert.ok(state.ok);
  assert.equal(state.canManage, false);
  assert.equal(state.canEditCases, true);
  assert.ok(urls.includes(path + '/memory?revision=1'));
  const html = markup(state);
  assert.equal([...html.matchAll(/<h4[^>]*>Sample /g)].length, 5);
  for (const label of [
    'Sample 2 · Adopted',
    'Adopted sample 2',
    'Fixed the failures',
    'The proposal failed the content scan.',
    'email · rationale',
    'Agent stops early',
    'Targets the diagnosis',
    'skip · Repeated a direction',
    'AGENTS.md',
    '- Stop',
    '+ Retry',
    '1 versus 0.9',
    'released-version',
    '#revision-8',
    'Round 1 · sample 2 · Accepted',
    '9 / 10',
    'Optimizer model optimizer · evolve revision 2',
    'Revision 1 of 2',
    'Export held-out tasks',
  ])
    assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /appToken|>Pause</);
});

test('renders keep and empty candidate and memory states', () => {
  const html = markup({
    ...empty,
    loop,
    detail: {
      ok: true,
      parentFiles: null,
      round: {
        ...detailRound,
        reverted: false,
        confirmedParentScore: null,
        confirmedAdoptionScore: null,
        candidates: [],
        decision: 'kept',
        reason: 'no-survivors',
        selection: null,
      },
    },
    memory: {
      ok: true,
      memory: { ...memory, improvementMemory: { ...memory.improvementMemory, problems: [] } },
    },
  });
  assert.match(html, /No candidates recorded/);
  assert.match(html, /Kept incumbent.*No candidate passed screening/);
  assert.match(html, /No problems recorded/);
});

test('whole-file changes use verified incumbent content for replacements and deletions', async () => {
  const current = JSON.stringify({
    schemaVersion: 1,
    files: [
      { kind: 'instruction', path: 'AGENTS.md', text: 'Original instructions' },
      { kind: 'memory', path: 'old.md', text: 'Removed note' },
    ],
  });
  const digest = 'sha256:' + createHash('sha256').update(current).digest('hex');
  const state = await readLearningState(
    env,
    scope,
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname === path) return response(loop);
      if (url.pathname === path + '/rounds') return response({ items: [round], next: null });
      if (url.pathname === path + '/rounds/' + round.id)
        return response({
          ...detailRound,
          candidates: [
            {
              ...candidate,
              changes: {
                edits: [],
                files: [
                  { op: 'write', path: 'AGENTS.md', text: 'Replacement instructions' },
                  { op: 'delete', path: 'old.md' },
                ],
              },
            },
          ],
        });
      if (url.pathname === base + '/versions/' + round.parentVersionId)
        return response({ id: round.parentVersionId, digest });
      if (url.pathname === base + '/versions/' + round.parentVersionId + '/payload')
        return new Response(current);
      return bundleFixture(url) ?? response({}, 500);
    },
    { round: round.id },
  );
  const html = markup(state);
  assert.match(html, /- Original instructions/);
  assert.match(html, /\+ Replacement instructions/);
  assert.match(html, /- Removed note/);
});

test('rollback is offered only on the live version and monitoring leads after start', () => {
  const html = markup({
    ...empty,
    loop,
    rounds: [round, { ...round, id: 'older', adoptedVersionId: 'old' }],
    channelHead: round.adoptedVersionId,
  });
  assert.equal((html.match(/>Roll back</g) ?? []).length, 1);
  assert.ok(html.indexOf('Scores by round') < html.indexOf('Learning setup'));
  assert.doesNotMatch(
    markup({ ...empty, loop, rounds: [round], channelHead: 'external' }),
    />Roll back</,
  );
});

test('running controls, waiting instructions, rollout progress and restores use service state', () => {
  const active = {
    ...loop,
    activeRound: round,
    waiting: 'no-executor',
    alert: { roundId: round.id, score: 0.5, previousScore: 0.8, flippedTasks: 4, reverted: true },
  };
  const html = markup({
    ...empty,
    loop: active,
    rounds: [round],
    progress: { scored: 17, total: 100 },
    history: [{ time: timestamp, actor: 'person@example', roundId: round.id }],
    blocked: [
      { digest: 'removed-digest', createdAt: timestamp, removedBy: 'operator', note: 'bad answer' },
    ],
  });
  for (const message of [
    'Stop learning',
    'start an executor',
    '17 of 100 rollouts scored',
    'restored the previous version',
    'person@example',
    'removed-digest',
    'Unblock version',
  ])
    assert.ok(html.includes(message), message);
  const stopped = markup({ ...empty, loop: { ...loop, status: 'stopped', waiting: null } });
  assert.doesNotMatch(stopped, />Stop learning</);
  assert.match(stopped, /automatically, without approval/);
});
