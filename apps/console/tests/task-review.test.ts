import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskEditor } from '../src/components/learning-tasks';
import { ImportList } from '../src/components/task-review';
import {
  confirmationSummary,
  describeAdmissionReason,
  describeImportReason,
  describeTrialError,
  filterCards,
  linkedTask,
  scoreText,
  shortTaskId,
  type ImportSummary,
} from '../src/lib/task-review';
import { taskReviewRequest } from '../src/server/task-review-core';
import { describeLearning } from '../src/lib/central-learning';
import { consoleEnvironment } from './console-fixture';

const env = { ...consoleEnvironment, CONSOLE_ALLOW_EDITS: 'true' };
const scope = { workspaceId: 'example', bundleId: 'bundle' };
const id = '6f1c2a9e-0b1d-4c55-9a8e-1f2e3d4c5b6a';
const card = (overrides: Record<string, unknown> = {}) => ({
  taskId: id,
  addedRevision: 1,
  input: 'Question',
  grader: { type: 'criteria' as const, criteria: ['Be specific'] },
  source: 'import',
  split: 'held-out',
  admission: 'pending',
  ...overrides,
});
const none = { split: '', admission: '', source: '', flagged: false, needsConfirmation: false };

test('filters select a split and the held-out cards waiting for a person', () => {
  const cards = [
    card({ taskId: 'waiting' }),
    card({ taskId: 'confirmed', confirmedBy: 'person' }),
    card({ taskId: 'evolve', split: 'evolve' }),
  ];
  const ids = (f: Partial<typeof none>) =>
    filterCards(cards, { ...none, ...f } as never).map((c) => c.taskId);
  assert.deepEqual(ids({ split: 'evolve' }), ['evolve']);
  assert.deepEqual(ids({ split: 'held-out' }), ['waiting', 'confirmed']);
  assert.deepEqual(ids({ needsConfirmation: true }), ['waiting']);
  assert.deepEqual(ids({}), ['waiting', 'confirmed', 'evolve']);
});

test('task links come from the fragment or the task search parameter', () => {
  assert.equal(linkedTask({ hash: '#task-' + id, search: '' }), id);
  assert.equal(linkedTask({ hash: '', search: '?tab=learning&task=abc' }), 'abc');
  assert.equal(linkedTask({ hash: '#rounds', search: '' }), undefined);
  assert.equal(shortTaskId(id), '6f1c2a9e');
  assert.equal(shortTaskId('refunds-1'), 'refunds-1');
});

test('cards carry a linkable id, a copy control and a rerun for failed checks', () => {
  const failed = card({ split: 'evolve', admission: 'set-aside', admissionReason: 'check-failed' });
  const html = renderToStaticMarkup(
    createElement(TaskEditor, { card: failed, edit: true, run: () => {}, recheck: () => {} }),
  );
  assert.match(html, new RegExp(`<article[^>]*id="task-${id}"`));
  assert.match(html, /6f1c2a9e/);
  assert.match(html, /aria-label="Copy ID of task 6f1c2a9e"/);
  assert.match(html, /Run check again/);
  // Try task is the primary action; Delete task waits behind the card's More menu.
  assert.match(html, /data-variant="default"[^>]*>Try task</);
  assert.match(html, /aria-label="More actions for task 6f1c2a9e"[^>]*aria-haspopup="menu"/);
  assert.match(html, /data-tone="danger"[^>]*>Set aside</);
  assert.match(html, /data-tone="neutral"[^>]*>evolve</);
  for (const other of [card(), { ...failed, admissionReason: 'judge-unstable' }])
    assert.doesNotMatch(
      renderToStaticMarkup(
        createElement(TaskEditor, { card: other, edit: true, run: () => {}, recheck: () => {} }),
      ),
      /Run check again/,
    );
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(TaskEditor, { card: failed, edit: false, run: () => {} })),
    /Run check again|More actions|Try task/,
  );
  const reference = renderToStaticMarkup(
    createElement(TaskEditor, {
      card: card({
        sourceFile: 'example-agent-tasks.jsonl',
        sourceRow: 3,
        grader: { type: 'criteria', criteria: ['Be specific'], reference: 'Use the form.' },
      }),
      edit: false,
      run: () => {},
    }),
  );
  assert.match(reference, /example-agent-tasks\.jsonl, row 3/);
  assert.match(
    reference,
    /<details[^>]*><summary[^>]*>[\s\S]*Reference answer<\/summary>[\s\S]*Use the form\./,
  );
});

test('trial results show the score and the cause of a failure', () => {
  const render = (trial: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(TaskEditor, {
        card: card(),
        edit: false,
        run: () => {},
        trial: { taskId: id, trialId: 't', ...trial } as never,
      }),
    );
  assert.match(
    render({ status: 'scored', verdict: { passed: false, score: 2 / 3, reasons: [] } }),
    /Failed · Score 0\.667 · Judge reasoning/,
  );
  const failed = render({ status: 'failed', error: { code: 'sandbox-start' } });
  assert.match(failed, /Executor error/);
  assert.match(failed, /could not start a sandbox/);
  assert.match(failed, /Error code: sandbox-start\./);
  assert.match(render({ status: 'failed' }), /The trial did not finish\. Try again\./);
  assert.equal(describeTrialError('new-code'), 'The trial failed (new-code). Try again.');
  assert.match(
    describeTrialError('provider-rejected'),
    /key was revoked.*Check the provider settings\./,
  );
  assert.equal(scoreText(1), 'Score 1.000');
});

test('task review requests use the bulk confirm and recheck routes', async () => {
  const seen: { method?: string; path: string; body: unknown }[] = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      method: init?.method,
      path: new URL(String(url)).pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json({ revision: 4, results: [], taskIds: [] });
  };
  await taskReviewRequest(env, { ...scope, action: 'confirm', taskIds: ['a', 'b'] }, fetcher);
  await taskReviewRequest(env, { ...scope, action: 'recheck', id: 'a' }, fetcher);
  await taskReviewRequest(env, { ...scope, action: 'recheckAll' }, fetcher);
  const base = '/v1/workspaces/example/bundles/bundle/learning/tasks';
  assert.deepEqual(seen, [
    { method: 'POST', path: base + '/confirm', body: { taskIds: ['a', 'b'] } },
    { method: 'POST', path: base + '/a/recheck', body: undefined },
    { method: 'POST', path: base + '/recheck', body: {} },
  ]);
  await assert.rejects(
    taskReviewRequest(
      { ...env, CONSOLE_ALLOW_EDITS: 'false' },
      { ...scope, action: 'recheckAll' },
      fetcher,
    ),
    /disabled/,
  );
  await assert.rejects(
    taskReviewRequest({ ...env, CONSOLE_SESSION_TOKEN: '' }, { ...scope, action: 'imports' }),
  );
});

test('confirmation results say which tasks were confirmed', () => {
  assert.equal(
    confirmationSummary({
      revision: 3,
      results: [
        { taskId: 'a', result: 'confirmed' },
        { taskId: 'b', result: 'confirmed' },
        { taskId: 'c', result: 'already-confirmed' },
        { taskId: 'd', result: 'not-found' },
      ],
    }),
    'Confirmed 2 tasks. Their admission checks run next. 1 had already been confirmed. 1 no longer exist. Refresh the tasks to see the current list.',
  );
});

const imports: ImportSummary[] = [
  {
    importId: 'newest',
    createdAt: '2026-11-20T10:00:00Z',
    source: 'answers.csv',
    rows: 3,
    converted: 1,
    pending: 0,
    setAsideCount: 2,
    status: 'completed',
    message: null,
    setAside: [
      { row: 2, source: 'answers.csv', reason: 'duplicate' },
      { row: 3, source: 'answers.csv', reason: 'too-large' },
    ],
  },
  {
    importId: 'older',
    createdAt: '2026-11-19T10:00:00Z',
    source: 'conversations.txt',
    rows: 1,
    converted: 0,
    pending: 1,
    setAsideCount: 0,
    status: 'failed',
    message: 'Conversion failed',
    setAside: [],
  },
];

test('past imports are listed from the service with their set-aside rows', async () => {
  const listed = await taskReviewRequest(env, { ...scope, action: 'imports' }, async (url) => {
    assert.equal(
      new URL(String(url)).pathname,
      '/v1/workspaces/example/bundles/bundle/learning/tasks/imports',
    );
    return Response.json({ items: imports });
  });
  assert.deepEqual(listed, imports);
  const html = renderToStaticMarkup(createElement(ImportList, { imports }));
  assert.ok(html.indexOf('answers.csv') < html.indexOf('conversations.txt'));
  // Each import shows its file, its date on one line and its counts as badges.
  const [newest, older] = html.split('</li></ul></div></details></li>');
  assert.match(
    newest,
    /<time dateTime="2026-11-20T10:00:00Z"[^>]*>Nov 20, 2026, 10:00 UTC<\/time>/,
  );
  for (const badge of ['Completed', '3 rows', '1 converted', '0 pending', '2 set aside'])
    assert.match(newest, new RegExp(`data-slot="badge"[^>]*>${badge}</span>`), badge);
  for (const badge of ['Failed', '1 row', '0 converted', '1 pending', '0 set aside'])
    assert.match(older, new RegExp(`data-slot="badge"[^>]*>${badge}</span>`), badge);
  assert.match(html, /aria-label="Rows set aside from answers.csv"/);
  assert.match(html, /Row 2: This row matches a task that already exists\./);
  assert.match(html, /Row 3: The row is over 64 KiB\./);
  assert.match(html, /Conversion failed Fix the material and import it again\./);
  assert.doesNotMatch(html, /Set-aside rows/);
  assert.equal(describeImportReason('no-reference').startsWith('No usable reference'), true);
  // An outcome kept after its conversion failed is a task to edit, not a row to import again.
  assert.match(describeAdmissionReason('not-converted'), /Edit it to add grading criteria/);
  assert.equal(describeAdmissionReason('check-failed'), describeLearning('check-failed'));
  assert.match(renderToStaticMarkup(createElement(ImportList, { imports: [] })), /No imports yet/);
});
