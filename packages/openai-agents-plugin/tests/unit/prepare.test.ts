import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeliveredVersion } from '../../../sdk/src/native-files.js';
import type { VerifiedVersion } from '../../../sdk/src/types.js';
import { prepare } from '../../src/index.js';

const verified: VerifiedVersion = {
  version: {
    id: 'ver_oa_1',
    bundleId: 'bun_oa',
    parentVersionId: null,
    digest: 'sha256:oa1',
    createdAt: '2026-11-27T00:00:00Z',
  },
  payload: {
    schemaVersion: 1,
    files: [
      { path: 'instructions.md', kind: 'instruction', text: 'Act as a triage agent.' },
      {
        path: 'skills/escalate/SKILL.md',
        kind: 'skill',
        text: '---\nname: escalate\ndescription: Escalate urgent tickets\n---\nPage on-call.',
      },
    ],
  },
  resolvedAt: 0,
  stale: false,
};

test('openai-agents prepare exposes dynamic instructions, hooks, traceMetadata and skill tools', async () => {
  let started = 0;
  let cleaned = 0;
  const delivery: DeliveredVersion = {
    version: verified,
    reportStarted() {
      started += 1;
      return null;
    },
    async cleanup() {
      cleaned += 1;
    },
  };

  const prepared = prepare(delivery, { includeSkillsInPrompt: false, cleanupOnEnd: true });
  assert.equal(prepared.traceMetadata['acclimate.version_id'], 'ver_oa_1');
  assert.equal(prepared.traceMetadata['acclimate.stale'], 'false');

  const prompt = prepared.instructions();
  assert.ok(prompt.includes('Act as a triage agent.'));
  assert.ok(!prompt.includes('Page on-call.'));
  assert.equal(started, 1);

  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const emitter = {
    on(event: string, listener: (...args: unknown[]) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
    },
  };
  const detach = prepared.attach(emitter);
  for (const fn of listeners.get('agent_start') ?? []) fn();
  assert.equal(started, 2);
  detach();
  assert.equal(listeners.get('agent_start')?.size ?? 0, 0);

  await prepared.hooks.onAgentStart();
  assert.equal(started, 3);

  assert.deepEqual(prepared.skillToolDefinitions.readSkill.parameters.required, ['name', 'filePath']);
  const list = await prepared.skillToolDefinitions.listSkills.execute({});
  assert.equal(list[0]?.name, 'escalate');
  const body = await prepared.skillToolDefinitions.readSkill.execute({ name: 'escalate', filePath: null });
  assert.ok(body.includes('Page on-call.'));

  await prepared.hooks.onAgentEnd();
  assert.equal(cleaned, 1);
});
