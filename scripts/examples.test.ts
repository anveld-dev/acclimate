import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { BundlePayload } from '@acclimate/sdk';
import { systemPrompt } from '../examples/support-agent/prompt.js';
// @ts-expect-error The executor's runner is plain JavaScript.
import { messages } from '../executor/runner/chat.mjs';

const example = (path: string) => readFile(new URL(`../examples/${path}`, import.meta.url));

test('the support agent renders a bundle as the learning executor does', () => {
  const payload: BundlePayload = {
    schemaVersion: 1,
    files: [
      { path: 'memory/facts.md', kind: 'memory', text: 'Refunds take five days.\n' },
      { path: 'skills/refunds/SKILL.md', kind: 'skill', text: 'Refund steps.\n' },
      { path: 'instructions.md', kind: 'instruction', text: 'Answer briefly.\n' },
    ],
  };
  const expected =
    '# instructions.md\nAnswer briefly.\n\n\n# skills/refunds/SKILL.md\nRefund steps.\n\n\n# memory/facts.md\nRefunds take five days.\n';
  assert.equal(systemPrompt(payload), expected);
  assert.deepEqual(messages(payload, 'Hello'), [
    { role: 'system', content: expected },
    { role: 'user', content: 'Hello' },
  ]);
});

test('the ticket triage tasks import as exact tasks, 32 in each split with every queue on both sides', async () => {
  const data = await example('ticket-triage/tickets.csv');
  const [header, ...rows] = data.toString('utf8').trimEnd().split('\n');
  assert.equal(header, 'input,expected');
  assert.equal(rows.length, 64);
  const digest = createHash('sha256').update(data).digest('hex');
  const evolve = new Map<string, number>();
  const heldOut = new Map<string, number>();
  rows.forEach((row, index) => {
    const queue = row.slice(row.lastIndexOf(',') + 1);
    // A short single-line answer is graded exactly.
    assert.match(queue, /^[a-z-]{1,80}$/);
    // The service's rule: the first data row is line 2, and a low first hash byte is held-out.
    const group = `import:${digest}:row:${index + 2}`;
    const split = createHash('sha256').update(group).digest()[0] < 128 ? heldOut : evolve;
    split.set(queue, (split.get(queue) ?? 0) + 1);
  });
  for (const split of [evolve, heldOut]) {
    assert.equal(split.size, 8);
    assert.equal([...split.values()].reduce((sum, count) => sum + count, 0), 32);
    assert.ok(Math.min(...split.values()) >= 3);
  }
});

test('every sample support task has a request, a reference reply and its own criteria', async () => {
  const rows = (await example('learning/example-agent-tasks.jsonl')).toString('utf8').trimEnd().split('\n');
  assert.equal(rows.length, 60);
  for (const row of rows) {
    const task = JSON.parse(row) as { request: string; ideal_reply: string; rubric: string[] };
    assert.ok(task.request && task.ideal_reply);
    assert.equal(task.rubric.length, 4);
  }
});
