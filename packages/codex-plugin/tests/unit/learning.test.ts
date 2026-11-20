import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { codex } from '../../src/native.js';

test('Codex runs one native session in the prepared workspace and returns the transcript tail', async () => {
  let cwd = '';
  let sessions = 0;
  const agent = codex({
    model: 'fake-codex', effort: 'high', parse: message => ({ message }),
    client: {
      startThread(options) {
        sessions++;
        cwd = options.workingDirectory;
        assert.equal(options.model, 'fake-codex');
        assert.equal(options.modelReasoningEffort, 'high');
        return {
          async runStreamed(prompt) {
            assert.equal(prompt, '{"ticket":1}');
            assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), 'Help.');
            return {
              events: (async function* () {
                yield { type: 'item.completed', item: { type: 'agent_message', text: 'DiscardMe' + 'é'.repeat(9000) } };
                yield { type: 'item.completed', item: { type: 'command_execution', command: 'lookup' } };
                yield { type: 'error', message: 'Recoverable error' };
                yield { type: 'item.completed', item: { type: 'agent_message', text: 'done' } };
              })(),
            };
          },
        };
      },
    },
  });
  const result = await agent.execute({
    version: {
      version: { id: 'v', bundleId: 'b', createdAt: 'now', parentVersionId: null, digest: 'sha256:fake' },
      payload: { schemaVersion: 1, files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'Help.' }] },
      stale: false, resolvedAt: 0,
    },
    input: { ticket: 1 }, caseId: 'a', rollout: 0, signal: new AbortController().signal,
    instructions: '', instructionFiles: [], skillFiles: [], memoryFiles: [],
  });
  assert.equal(agent.model, 'fake-codex');
  assert.equal(sessions, 1);
  assert.deepEqual(result.output, { message: 'done' });
  assert.match(result.trace!, /lookup.*\n.*Recoverable error.*\n.*done/);
  assert(!result.trace!.includes('DiscardMe'));
  assert(Buffer.byteLength(result.trace!) <= 16 * 1024);
  await assert.rejects(access(cwd), { code: 'ENOENT' });
});
