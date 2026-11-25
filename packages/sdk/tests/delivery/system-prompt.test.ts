import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { systemPrompt, validatePayload, type BundlePayload } from '../../src/index.js';
// @ts-expect-error The executor's runner is plain JavaScript.
import { messages } from '../../../../executor/runner/chat.mjs';

const fixture = JSON.parse(
  await readFile(new URL('../../../../contracts/fixtures/system-prompt-v1.json', import.meta.url), 'utf8'),
) as { payload: BundlePayload; systemPrompt: string };

test('systemPrompt renders the shared fixture byte for byte', () => {
  validatePayload(fixture.payload);
  assert.equal(systemPrompt(fixture.payload), fixture.systemPrompt);
});

test('systemPrompt is the system message the learning runner sends', () => {
  assert.deepEqual(messages(fixture.payload, 'Hello'), [
    { role: 'system', content: systemPrompt(fixture.payload) },
    { role: 'user', content: 'Hello' },
  ]);
  const empty: BundlePayload = { schemaVersion: 1, files: [] };
  assert.equal(systemPrompt(empty), messages(empty, 'Hello')[0].content);
});
