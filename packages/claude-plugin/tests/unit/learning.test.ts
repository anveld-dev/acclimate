import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { claude } from '../../src/native.js';

test('Claude uses the native project workspace and returns the final message with tool and error events', async () => {
  let sessions = 0;
  let cwd = '';
  const agent = claude({
    model: 'fake-claude', effort: 'low',
    async *query({ prompt, options }) {
      sessions++;
      cwd = options.cwd;
      assert.equal(await readFile(join(cwd, 'CLAUDE.md'), 'utf8'), 'Help.');
      assert.deepEqual(options.settingSources, ['project']);
      assert.equal(options.persistSession, false);
      assert.equal(options.model, 'fake-claude');
      assert.equal(options.effort, 'low');
      assert.equal(prompt, 'ticket');
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'lookup' }] } };
      yield { type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } };
      yield { type: 'result', subtype: 'success', result: 'done' };
    },
  });
  const result = await agent.execute({
    version: {
      version: { id: 'v', bundleId: 'b', createdAt: 'now', parentVersionId: null, digest: 'sha256:fake' },
      payload: { schemaVersion: 1, files: [{ path: 'CLAUDE.md', kind: 'instruction', text: 'Help.' }] },
      stale: false, resolvedAt: 0,
    },
    input: 'ticket', caseId: 'a', rollout: 0, signal: new AbortController().signal,
    instructions: '', instructionFiles: [], skillFiles: [], memoryFiles: [],
  });
  assert.equal(agent.model, 'fake-claude');
  assert.equal(sessions, 1);
  assert.equal(result.output, 'done');
  assert.match(result.trace!, /tool_use.*lookup.*\n.*tool_result.*is_error.*\n.*done/);
  await assert.rejects(access(cwd), { code: 'ENOENT' });
});
