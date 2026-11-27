import assert from 'node:assert/strict';
import test from 'node:test';
import type { BundlePayload } from '@anveld/acclimate-sdk';
import { readImportBatch } from '../src/components/import-content';

const existing: BundlePayload = {
  schemaVersion: 1,
  files: [{ kind: 'instruction', path: 'AGENTS.md', text: 'Retained' }],
};

test('case collisions block the batch and identify the unaffected selection', async () => {
  const safe = new File(['# Keep\n'], 'review.md');
  await assert.rejects(
    readImportBatch([new File(['replacement'], 'agents.md'), safe], existing),
    (
      error: Error & {
        conflicts?: { path: string; reason: string }[];
        remaining?: { file: File; path: string }[];
      },
    ) => {
      assert.match(error.message, /Path collision: agents.md/);
      assert.match(error.conflicts![0].reason, /existing entry “AGENTS.md”/);
      assert.deepEqual(error.remaining, [{ file: safe, path: 'review.md' }]);
      return true;
    },
  );
  const result = await readImportBatch([safe], existing);
  assert.deepEqual(
    result.files.map((f) => f.text),
    ['Retained', '# Keep\n'],
  );
  assert.equal(existing.files.length, 1);
});

test('colliding new files are both excluded and cannot replace each other', async () => {
  await assert.rejects(
    readImportBatch([new File(['a'], 'x.md'), new File(['b'], 'X.md')], existing),
    (error: Error & { remaining?: unknown[]; conflicts?: unknown[] }) => {
      assert.equal(error.conflicts?.length, 2);
      assert.deepEqual(error.remaining, []);
      return true;
    },
  );
});

test('folder collisions preserve canonical paths for the remaining skill files', async () => {
  const file = (name: string, relativePath: string) => {
    const f = new File(['# input'], name);
    Object.defineProperty(f, 'webkitRelativePath', { value: relativePath });
    return f;
  };
  const payload: BundlePayload = {
    schemaVersion: 1,
    files: [{ path: 'skills/review/SKILL.md', kind: 'skill', text: 'old' }],
  };
  await assert.rejects(
    readImportBatch(
      [file('SKILL.md', 'review/SKILL.md'), file('checks.md', 'review/references/checks.md')],
      payload,
      true,
    ),
    (error: Error & { remaining?: { path: string }[] }) => {
      assert.equal(error.remaining?.[0].path, 'skills/review/references/checks.md');
      return true;
    },
  );
});
