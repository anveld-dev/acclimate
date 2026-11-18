import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { prepare } from '../../src/index.js';
import type { VerifiedBundle } from '../../../sdk/src/types.js';

const verified: VerifiedBundle = {
  version: { id: 'v3', bundleId: 'b', parentVersionId: null, digest: 'd', createdAt: 'now' },
  resolvedAt: 0,
  stale: false,
  payload: {
    schemaVersion: 1,
    files: [
      { path: 'instructions/core.md', kind: 'instruction', text: 'Pi instruction.' },
      {
        path: 'skills/lookup/SKILL.md',
        kind: 'skill',
        text: '---\nname: lookup\ndescription: Find values.\n---\nUse me.',
      },
      { path: 'memory/private.md', kind: 'memory', text: 'Memory stays host supplied.' },
    ],
  },
};

test('Pi preparation creates resource-loader inputs without selecting a made-up native memory option', async () => {
  const prepared = await prepare(verified);
  try {
    assert.equal(prepared.resources.length, 3);
    assert.equal(
      await readFile(prepared.resources[1]!.absolutePath, 'utf8'),
      verified.payload.files[1]!.text,
    );
    assert.equal(
      await readFile(prepared.resources[2]!.absolutePath, 'utf8'),
      'Memory stays host supplied.',
    );
    assert.equal(prepared.memoryFiles[0]!.path, 'memory/private.md');
    assert.equal(prepared.memoryFiles[0]!.text, 'Memory stays host supplied.');
  } finally {
    await prepared.cleanup();
  }
  await assert.rejects(access(prepared.cwd), { code: 'ENOENT' });
});

test('Pi rejects malformed skill paths and duplicate payload paths before staging', async () => {
  const badPath = structuredClone(verified);
  badPath.payload.files[1]!.path = 'skills/../SKILL.md';
  await assert.rejects(prepare(badPath), /invalid file/);
  const duplicate = structuredClone(verified);
  duplicate.payload.files.push({ ...duplicate.payload.files[1]!, path: 'SKILLS/LOOKUP/skill.md' });
  await assert.rejects(prepare(duplicate), /duplicate or case-colliding paths/);
  const prefix = structuredClone(verified);
  prefix.payload.files.push({ path: 'memory', kind: 'memory', text: 'file collides with memory/' });
  await assert.rejects(prepare(prefix), /file\/directory path collision/);
});
