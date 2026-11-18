import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { prepare } from '../../src/index.js';
import type { VerifiedBundle } from '../../../sdk/src/types.js';

const bundle: VerifiedBundle = {
  version: { id: 'v1', bundleId: 'b', parentVersionId: null, digest: 'digest', createdAt: 'now' },
  resolvedAt: 0,
  stale: false,
  payload: {
    schemaVersion: 1,
    files: [
      { path: 'instructions/core.md', kind: 'instruction', text: 'Instruction.' },
      {
        path: 'skills/lookup/SKILL.md',
        kind: 'skill',
        text: '---\nname: lookup\ndescription: Find values.\n---\nRead references/data.md.',
      },
      { path: 'skills/lookup/references/data.md', kind: 'skill', text: 'Reference.' },
      { path: 'memory/private.md', kind: 'memory', text: 'Memory.' },
    ],
  },
};

test('stages native project inputs privately and cleans only its workspace', async () => {
  const prepared = await prepare(bundle, { approvedMemoryPaths: ['memory/private.md'] });
  try {
    assert.deepEqual(prepared.settingSources, ['project']);
    assert.equal(path.relative(prepared.cwd, prepared.instructionPath!), 'AGENTS.md');
    assert.equal(await readFile(prepared.instructionPath!, 'utf8'), 'Instruction.');
    assert.equal(
      path.relative(prepared.cwd, prepared.skillPaths[0]!),
      '.cursor/skills/lookup/SKILL.md',
    );
    assert.equal(
      await readFile(path.join(prepared.cwd, '.cursor/skills/lookup/references/data.md'), 'utf8'),
      'Reference.',
    );
    assert.equal(prepared.memoryFiles[0]!.text, 'Memory.');
    assert.equal((await stat(prepared.cwd)).mode & 0o777, 0o700);
    assert.equal((await stat(prepared.instructionPath!)).mode & 0o777, 0o600);
  } finally {
    await prepared.cleanup();
    await prepared.cleanup();
  }
  await assert.rejects(access(prepared.cwd), { code: 'ENOENT' });
});

test('rejects Cursor-incompatible skill names and invalid manifests', async () => {
  const invalid = structuredClone(bundle);
  invalid.payload.files[1]!.path = 'skills/Look_up/SKILL.md';
  await assert.rejects(prepare(invalid), /Cursor skill names require/);
  const mismatch = structuredClone(bundle);
  mismatch.payload.files[1]!.text = '---\nname: wrong\ndescription: Find values.\n---';
  await assert.rejects(prepare(mismatch), /Skill metadata requires/);
});

test('memory is absent unless explicitly approved', async () => {
  const prepared = await prepare(bundle);
  try {
    assert.deepEqual(prepared.memoryFiles, []);
    await assert.rejects(access(path.join(prepared.cwd, '.acclimate')), { code: 'ENOENT' });
  } finally {
    await prepared.cleanup();
  }
  await assert.rejects(
    prepare(bundle, { approvedMemoryPaths: ['memory/missing.md'] }),
    /Approved memory not found/,
  );
});
