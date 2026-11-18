import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureEdits } from './fixture.js';
import type { BundlePayload } from '../../packages/sdk/src/types.js';
const parent: BundlePayload = {
  schemaVersion: 1,
  files: [
    { path: 'AGENTS.md', kind: 'instruction', text: 'Instructions' },
    {
      path: 'skills/retry/SKILL.md',
      kind: 'skill',
      text: '---\nname: retry\ndescription: Retry review\n---\nReview.',
    },
    { path: 'context.md', kind: 'memory', text: 'Memory' },
  ],
};
test('the HTTP proposer emits a single anchored edit for the allowed file', () => {
  const file = parent.files[1];
  const patch = fixtureEdits(parent, [file.path]);
  assert.equal(patch.schemaVersion, 1);
  assert.deepEqual(patch.edits.map((edit) => edit.path), [file.path]);
  assert.equal(patch.edits[0].oldText, file.text);
  assert.notEqual(patch.edits[0].newText, file.text);
  assert.ok(!('payload' in patch));
});

test('the HTTP proposer refuses an allowlist with no matching file', () => {
  assert.throws(() => fixtureEdits(parent, ['missing']), /No allowed file/);
});
