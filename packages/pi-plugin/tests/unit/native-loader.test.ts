import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepare } from '../../src/index.js';
import { createPiResourceLoader } from '../../src/native.js';
import type { VerifiedVersion } from '../../../sdk/src/types.js';

const bundle: VerifiedVersion = {
  version: {
    id: 'native-pi',
    bundleId: 'b',
    parentVersionId: null,
    digest: 'digest',
    createdAt: 'now',
  },
  resolvedAt: 0,
  stale: false,
  payload: {
    schemaVersion: 1,
    files: [
      { path: 'instructions/core.md', kind: 'instruction', text: 'Instruction marker.' },
      {
        path: 'skills/lookup/SKILL.md',
        kind: 'skill',
        text: '---\nname: lookup\ndescription: Find values.\n---\nRead references/data.md.',
      },
      { path: 'skills/lookup/references/data.md', kind: 'skill', text: 'Reference marker.' },
      { path: 'memory/selected.md', kind: 'memory', text: 'Selected memory marker.' },
      { path: 'memory/other.md', kind: 'memory', text: 'Other memory marker.' },
    ],
  },
};

test('real Pi loader exposes prepared instructions and skill, with explicitly selected memory', async () => {
  const prepared = await prepare(bundle);
  try {
    const loader = await createPiResourceLoader(prepared, ['memory/selected.md']);
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, [
      { path: prepared.instructionPath, content: 'Instruction marker.' },
    ]);
    const { skills, diagnostics } = loader.getSkills();
    assert.deepEqual(diagnostics, []);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, 'lookup');
    assert.equal(skills[0]!.filePath, prepared.skillPaths[0]);
    assert.match(await readFile(skills[0]!.filePath, 'utf8'), /Read references\/data\.md/);
    assert.equal(
      await readFile(join(skills[0]!.baseDir, 'references/data.md'), 'utf8'),
      'Reference marker.',
    );
    assert.deepEqual(loader.getAppendSystemPrompt(), ['Selected memory marker.']);
    assert.deepEqual((await createPiResourceLoader(prepared)).getAppendSystemPrompt(), []);
    await assert.rejects(
      createPiResourceLoader(prepared, ['memory/missing.md']),
      /Unknown prepared memory path/,
    );
  } finally {
    await prepared.cleanup();
  }
});
