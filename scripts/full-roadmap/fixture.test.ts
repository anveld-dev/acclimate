import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureDraft, fixtureEdits } from './fixture.js';
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
for (const file of parent.files)
  test(`fake proposer confines ${file.kind} edits`, () => {
    const draft = fixtureDraft(parent, [file.path]);
    assert.notEqual(draft.payload.files.find((x) => x.path === file.path)?.text, file.text);
    for (const other of parent.files.filter((x) => x.path !== file.path))
      assert.deepEqual(
        draft.payload.files.find((x) => x.path === other.path),
        other,
      );
    assert.deepEqual(
      parent.files.map((x) => x.text),
      ['Instructions', '---\nname: retry\ndescription: Retry review\n---\nReview.', 'Memory'],
    );
  });
test('fake proposer rejects missing paths', () =>
  assert.throws(() => fixtureDraft(parent, ['missing'])));

test('HTTP fixture emits exact anchored edits rather than a full payload', () => {
  const patch = fixtureEdits(parent, ['AGENTS.md']);
  assert.equal(patch.schemaVersion, 1);
  assert.equal(patch.edits.length, 1);
  assert.equal(patch.edits[0].oldText, parent.files[0].text);
  assert.equal(patch.edits[0].path, 'AGENTS.md');
  assert.ok(!('payload' in patch));
});
