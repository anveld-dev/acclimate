import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { selectedModels, pendingTaskReads } from '../src/lib/central-learning';
import { TaskEditor } from '../src/components/learning-tasks';
import { streamImport } from '../src/server/stream-import';
import { RolloutEvidence } from '../src/components/learning-evidence';
import { centralRequest } from '../src/server/central-core';
import { consoleEnvironment } from './console-fixture';
const env = { ...consoleEnvironment, CONSOLE_ALLOW_EDITS: 'true' };
const scope = { workspaceId: 'example', bundleId: 'bundle' };
test('imports preserve spreadsheet bytes, filename and the signed-in session', async () => {
  const bytes = Buffer.from([0, 255, 1, 2]);
  const request = new Request(
    'https://console.example/learning-import?workspaceId=example&bundleId=bundle&filename=a%20%26%20b.xlsx',
    {
      method: 'POST',
      body: bytes,
      headers: {
        origin: env.CONSOLE_ORIGIN,
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    },
  );
  await streamImport(request, env, async (input, init) => {
    assert.equal(new URL(String(input)).searchParams.get('filename'), 'a & b.xlsx');
    assert.equal(new Headers(init?.headers).get('x-acclimate-session'), env.CONSOLE_SESSION_TOKEN);
    assert.equal(init?.body, request.body);
    assert.deepEqual(Buffer.from(await new Response(init?.body).arrayBuffer()), bytes);
    return Response.json({ rows: 1 });
  });
});
test('learning actions require a person and scope all routes', async () => {
  for (const data of [
    { ...scope, action: 'export' as const },
    { ...scope, action: 'edit' as const, id: '..', body: { confirm: true } },
  ]) {
    await assert.rejects(centralRequest({ ...env, CONSOLE_SESSION_TOKEN: '' }, data));
  }
  await assert.rejects(centralRequest(env, { ...scope, action: 'trial', id: '..' }), /identifier/);
  await assert.rejects(
    centralRequest({ ...env, CONSOLE_ALLOW_EDITS: 'false' }, { ...scope, action: 'start' }),
    /disabled/,
  );
});
test('cards expose provenance, admission and held-out criteria confirmation to editors', () => {
  const card = {
    taskId: 'card',
    addedRevision: 2,
    input: 'Question',
    grader: { type: 'criteria' as const, criteria: ['Be specific'] },
    source: 'outcome',
    split: 'held-out',
    admission: 'set-aside',
    admissionReason: 'judge-unstable',
  };
  const html = renderToStaticMarkup(createElement(TaskEditor, { card, edit: true, run: () => {} }));
  const tried = renderToStaticMarkup(
    createElement(TaskEditor, {
      card,
      edit: true,
      run: () => {},
      trial: {
        taskId: 'card',
        trialId: 'one',
        status: 'completed',
        output: 'trial output',
        verdict: { passed: true },
      },
    }),
  );
  assert.match(tried, /<article[\s\S]*trial output[\s\S]*<\/article>/);
  assert.doesNotMatch(html, /Trial result/);
  for (const label of [
    'Production outcome',
    'Be specific',
    'The judge gave inconsistent results on the reference answer.',
    'Confirm criteria',
    'Edit task',
    'Try task',
  ])
    assert.ok(html.includes(label));
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(TaskEditor, { card, edit: false, run: () => {} })),
    /Confirm criteria|Delete task/,
  );
});

test('round evidence displays judge reasons and gateway responses', () => {
  const html = renderToStaticMarkup(
    createElement(RolloutEvidence, {
      r: {
        score: 0,
        passed: false,
        reasons: ['Missing the refund date'],
        gatewayLog: [{ response: 'Tomorrow' }],
      },
      i: 0,
    }),
  );
  assert.match(html, /Missing the refund date/);
  assert.match(html, /Gateway log/);
  assert.match(html, /Tomorrow/);
});
test('provider failures explain the service-side error', async () => {
  await assert.rejects(
    centralRequest(
      env,
      {
        ...scope,
        action: 'saveProvider',
        body: { baseUrl: 'https://provider.example', allowedModels: ['task'] },
      },
      async () =>
        Response.json(
          { error: { code: 'provider-unavailable', message: 'Unavailable' } },
          { status: 503 },
        ),
    ),
    /check the encryption key/,
  );
});
test('task listing follows service cursors once per page', async () => {
  const seen: (string | null)[] = [];
  const cards = await centralRequest(env, { ...scope, action: 'tasks' }, async (url) => {
    const cursor = new URL(String(url)).searchParams.get('after');
    seen.push(cursor);
    return Response.json({ items: [cursor ?? 'first'], next: cursor ? null : 'second' });
  });
  assert.deepEqual(seen, [null, 'second']);
  assert.deepEqual(cards, ['first', 'second']);
});

test('task polling starts only for pending work and stops on the terminal response', () => {
  const job = { importId: 'batch', rows: 2, pending: 2, converted: 0 };
  assert.equal(pendingTaskReads(undefined, undefined, [{ admission: 'pending' }]).enabled, true);
  assert.equal(pendingTaskReads().enabled, false);
  assert.deepEqual(pendingTaskReads({ trialId: 'one', status: 'pending' }, job), {
    enabled: true,
    trialId: 'one',
    importId: 'batch',
  });
  assert.deepEqual(pendingTaskReads({ trialId: 'one', status: 'scored' }, job), {
    enabled: true,
    trialId: undefined,
    importId: 'batch',
  });
  for (const done of [
    { ...job, pending: 0 },
    { ...job, status: 'failed' },
  ])
    assert.equal(pendingTaskReads(undefined, done).enabled, false);
});
test('import rejects cross-origin requests, missing sessions and disabled edits before forwarding', async () => {
  for (const [environment, origin, status] of [
    [env, 'https://other.example', 403],
    [{ ...env, CONSOLE_SESSION_TOKEN: '' }, env.CONSOLE_ORIGIN, 401],
    [{ ...env, CONSOLE_ALLOW_EDITS: 'false' }, env.CONSOLE_ORIGIN, 403],
  ] as const) {
    const response = await streamImport(
      new Request(env.CONSOLE_ORIGIN, { method: 'POST', body: 'abc', headers: { origin } }),
      environment,
      () => {
        throw Error('unexpected upstream request');
      },
    );
    assert.equal(response.status, status);
  }
});

test('removed model choices resolve to the values shown in setup', () => {
  assert.deepEqual(selectedModels(['new-task', 'new-judge'], 'removed', 'retired'), {
    task: 'new-task',
    judge: 'new-judge',
  });
});

test('provider update omits an empty replacement key and preserves service verification results', async () => {
  const provider = { baseUrl: 'https://provider.example', allowedModels: ['task', 'judge'] };
  const verification = { status: 'pending', models: [], checkedAt: null };
  const saved = await centralRequest(
    env,
    { ...scope, action: 'saveProvider', body: provider },
    async (_, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), provider);
      return Response.json({ ...provider, hasKey: true, verification });
    },
  );
  assert.deepEqual(saved, { ...provider, hasKey: true, verification });
});
test('rollback reports an already restored parent without issuing a mutation', async () => {
  const result = await centralRequest(
    env,
    { ...scope, action: 'rollback', body: { roundId: 'round' } },
    async (url, init) => {
      assert.equal(init?.method, 'GET');
      return String(url).includes('/rounds/')
        ? Response.json({
            channel: 'stable',
            parentVersionId: 'parent',
            adoptedVersionId: 'adopted',
          })
        : Response.json({ items: [{ channel: 'stable', version: { id: 'parent' } }] });
    },
  );
  assert.match(JSON.stringify(result), /already live/);
});
test('each unconfirmed held-out card has a confirm action, and another card’s trial stays off it', () => {
  const html = renderToStaticMarkup(
    createElement(TaskEditor, {
      card: {
        taskId: 'two',
        addedRevision: 1,
        source: 'console',
        input: 'hello',
        split: 'held-out',
        admission: 'pending',
        grader: { type: 'exact', expected: 'hi' },
      },
      edit: true,
      run: () => {},
      trial: { taskId: 'one', trialId: 'other', status: 'pending' },
    }),
  );
  assert.match(html, /Confirm expected answer/);
  assert.match(html, /Needs your confirmation/);
  assert.match(html, /never shown to the optimizer/);
  assert.doesNotMatch(html, /Waiting for admission checks/);
  assert.doesNotMatch(html, /Trial result/);
});
