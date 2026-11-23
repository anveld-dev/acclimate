import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskEditor } from '../src/components/learning-tasks';
import { centralRequest } from '../src/server/central-core';
import { consoleEnvironment } from './console-fixture';
const env = { ...consoleEnvironment, CONSOLE_ALLOW_EDITS: 'true' };
const scope = { workspaceId: 'example', bundleId: 'bundle' };
test('imports preserve spreadsheet bytes, filename and the signed-in session', async () => {
  const bytes = Buffer.from([0, 255, 1, 2]);
  await centralRequest(
    env,
    {
      ...scope,
      action: 'import',
      filename: 'a & b.xlsx',
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      payload: bytes.toString('base64'),
    },
    async (input, init) => {
      assert.equal(new URL(String(input)).searchParams.get('filename'), 'a & b.xlsx');
      assert.equal(
        new Headers(init?.headers).get('x-acclimate-session'),
        env.CONSOLE_SESSION_TOKEN,
      );
      assert.deepEqual(init?.body, bytes);
      return Response.json({ rows: 1 });
    },
  );
});
test('learning actions require a person and scope all routes', async () => {
  for (const data of [
    { ...scope, action: 'export' as const },
    { ...scope, action: 'edit' as const, id: '..' },
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
  for (const label of [
    'Production outcome',
    'Be specific',
    'The judge gave inconsistent results.',
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
