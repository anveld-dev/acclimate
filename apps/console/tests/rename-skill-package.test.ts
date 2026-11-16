import assert from 'node:assert/strict';
import test from 'node:test';
import type { BundlePayload } from '@acclimate/sdk';
import { renameSkillPackage } from '../src/lib/rename-skill-package';

const source: BundlePayload = {
  schemaVersion: 1,
  files: [
    {
      path: 'skills/review/SKILL.md',
      kind: 'skill',
      text: '---\nname: review\ndescription: Review changes.\n---\n',
    },
    {
      path: 'skills/review/references/SKILL.md',
      kind: 'skill',
      text: 'name: preserve-this-support-text\n',
    },
    { path: 'skills/reviewer/SKILL.md', kind: 'skill', text: 'name: reviewer\n' },
    { path: 'memory/approved.md', kind: 'memory', text: 'Approved memory' },
  ],
};

test('package rename updates all package paths and only its own manifest name atomically', () => {
  const original = structuredClone(source);
  const renamed = renameSkillPackage(source, 'review', 'careful-review');
  assert.deepEqual(
    renamed.files.map((file) => file.path),
    [
      'skills/careful-review/SKILL.md',
      'skills/careful-review/references/SKILL.md',
      'skills/reviewer/SKILL.md',
      'memory/approved.md',
    ],
  );
  assert.match(renamed.files[0].text, /^name: careful-review$/m);
  assert.equal(renamed.files[1].text, source.files[1].text);
  assert.equal(renamed.files[2], source.files[2]);
  assert.deepEqual(source, original);
});

test('invalid or colliding package names leave browser edits unchanged', () => {
  const original = structuredClone(source);
  for (const name of ['Invalid Name', '../escape', '', 'reviewer'])
    assert.throws(() => renameSkillPackage(source, 'review', name));
  const caseCollision: BundlePayload = {
    ...source,
    files: [...source.files, { path: 'skills/EXISTING/reference.md', kind: 'skill', text: '' }],
  };
  assert.throws(() => renameSkillPackage(caseCollision, 'review', 'existing'), /already exists/);
  assert.deepEqual(source, original);
});
