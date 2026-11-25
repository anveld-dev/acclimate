import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { prepare } from '../../src/index.js';
import { claudeSessionOptions } from '../../src/native.js';
import type { VerifiedVersion } from '../../../sdk/src/types.js';

const bundle: VerifiedVersion = {
  version: {
    id: 'native-claude',
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

test('prepared Claude session options conform to the pinned native SDK', async () => {
  const prepared = await prepare(bundle);
  try {
    const options: Options = claudeSessionOptions(prepared);
    assert.deepEqual(options, {
      cwd: prepared.cwd,
      settingSources: ['project'],
      skills: ['lookup'],
    });
    assert.equal(prepared.memoryFiles[0]!.text, 'Memory.');
  } finally {
    await prepared.cleanup();
  }
});

test('an empty skill list is omitted so the Agent SDK keeps its default skills', async () => {
  const withoutSkills = structuredClone(bundle);
  withoutSkills.payload.files = withoutSkills.payload.files.filter((file) => file.kind !== 'skill');
  const prepared = await prepare(withoutSkills);
  try {
    const options: Options = claudeSessionOptions(prepared);
    assert.deepEqual(options, { cwd: prepared.cwd, settingSources: ['project'] });
    assert.equal('skills' in options, false);
  } finally {
    await prepared.cleanup();
  }
});
