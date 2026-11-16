import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentOptions } from '@cursor/sdk';
import { prepare } from '../../src/index.js';
import { cursorLocalOptions } from '../../src/native.js';
import type { VerifiedBundle } from '../../../sdk/src/types.js';

const bundle: VerifiedBundle = {
  version: { id: 'v1', bundleId: 'b', parentVersionId: null, digest: 'digest', createdAt: 'now' },
  resolvedAt: 0,
  stale: false,
  payload: {
    schemaVersion: 1,
    files: [{ path: 'instructions/core.md', kind: 'instruction', text: 'Instruction.' }],
  },
};

test('local options satisfy the real Cursor SDK AgentOptions type', async () => {
  const prepared = await prepare(bundle);
  try {
    const options: AgentOptions = cursorLocalOptions(prepared);
    assert.deepEqual(options.local, { cwd: prepared.cwd, settingSources: ['project'] });
    assert.equal(options.systemPrompt, undefined);
  } finally {
    await prepared.cleanup();
  }
});
