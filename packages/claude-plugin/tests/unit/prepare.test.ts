import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { prepare } from '../../src/index.js';
import type { VerifiedBundle } from '../../../sdk/src/types.js';

const verified: VerifiedBundle = {
  version: { id: 'v2', bundleId: 'b', parentVersionId: null, digest: 'd', createdAt: 'now' },
  resolvedAt: 0,
  stale: false,
  payload: {
    schemaVersion: 1,
    files: [
      { path: 'instructions/core.md', kind: 'instruction', text: 'Claude instruction.' },
      {
        path: 'skills/lookup/SKILL.md',
        kind: 'skill',
        text: '---\nname: lookup\ndescription: Find values.\n---\nUse me.',
      },
      { path: 'memory/private.md', kind: 'memory', text: 'Memory is explicit.' },
    ],
  },
};

test('Claude preparation selects project resources and maps content into native paths', async () => {
  const prepared = await prepare(verified);
  try {
    assert.deepEqual(prepared.settingSources, ['project']);
    assert.equal(await readFile(prepared.instructionPath!, 'utf8'), 'Claude instruction.');
    assert.equal(await readFile(prepared.skillPaths[0]!, 'utf8'), verified.payload.files[1]!.text);
    assert.equal(prepared.memoryFiles[0]!.path, 'memory/private.md');
    assert.equal(
      await readFile(prepared.memoryFiles[0]!.absolutePath, 'utf8'),
      'Memory is explicit.',
    );
  } finally {
    await prepared.cleanup();
  }
  await assert.rejects(access(prepared.cwd), { code: 'ENOENT' });
});

test('Claude rejects skill metadata mismatch and case-insensitive duplicate names', async () => {
  const bad = structuredClone(verified);
  bad.payload.files[1]!.text = '---\nname: other\ndescription: wrong.\n---';
  await assert.rejects(prepare(bad), /\[skill_metadata\]/);
  const duplicate = structuredClone(verified);
  duplicate.payload.files.push({
    path: 'skills/LOOKUP/extra.md',
    kind: 'skill',
    text: 'duplicate name tree',
  });
  await assert.rejects(prepare(duplicate), /Skill names differ only by case/);
});
