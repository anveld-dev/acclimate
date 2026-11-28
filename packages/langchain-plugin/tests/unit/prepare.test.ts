import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeliveredVersion } from '../../../sdk/src/native-files.js';
import type { VerifiedVersion } from '../../../sdk/src/types.js';
import { prepare } from '../../src/index.js';

const verified: VerifiedVersion = {
  version: {
    id: 'ver_lc_1',
    bundleId: 'bun_lc',
    parentVersionId: null,
    digest: 'sha256:lc1',
    createdAt: '2026-11-27T00:00:00Z',
  },
  payload: {
    schemaVersion: 1,
    files: [
      { path: 'instructions.md', kind: 'instruction', text: 'Route customer questions.' },
      {
        path: 'skills/billing/SKILL.md',
        kind: 'skill',
        text: '---\nname: billing\ndescription: Answer billing questions\n---\nVerify invoice ID.',
      },
    ],
  },
  resolution: {
    channel: 'prod',
    revision: '12',
    version: {
      id: 'ver_lc_1',
      bundleId: 'bun_lc',
      parentVersionId: null,
      digest: 'sha256:lc1',
      createdAt: '2026-11-27T00:00:00Z',
    },
  },
  resolvedAt: 0,
  stale: false,
};

test('langchain prepare builds runnableConfig, systemMessage, callbackHandler and skillTools', async () => {
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

  const prepared = prepare(delivery);
  assert.equal(prepared.systemMessage.role, 'system');
  assert.ok(prepared.systemMessage.content.includes('Route customer questions.'));
  assert.ok(prepared.tags.includes('acclimate:channel:prod'));

  const cfg = prepared.runnableConfig({
    configurable: { thread_id: 'thread-1' },
    metadata: { custom: true },
    tags: ['support'],
  });
  assert.equal(cfg.metadata['acclimate.version_id'], 'ver_lc_1');
  assert.equal(cfg.metadata.custom, true);
  assert.ok(cfg.tags.includes('support'));
  assert.ok(cfg.tags.includes('acclimate'));
  assert.ok(Array.isArray(cfg.callbacks));
  assert.equal(cfg.callbacks.length, 1);

  const copiedHandlers: unknown[] = [];
  const fakeManager = {
    copy(additional?: unknown[]) {
      copiedHandlers.push(...(additional ?? []));
      return { copy: this.copy, handlers: copiedHandlers };
    },
  };
  const cfgWithManager = prepared.runnableConfig({ callbacks: fakeManager });
  assert.equal(copiedHandlers.length, 1);
  assert.equal(copiedHandlers[0], prepared.callbackHandler);
  assert.notEqual(cfgWithManager.callbacks, fakeManager);

  await prepared.callbackHandler.handleChatModelStart();
  assert.equal(started, 1);

  const skillsJson = await prepared.skillTools.listSkills.func({});
  assert.equal(JSON.parse(skillsJson)[0]?.name, 'billing');
  assert.ok((await prepared.skillTools.readSkill.func({ name: 'billing' })).includes('Verify invoice ID.'));

  await prepared.cleanup();
  assert.equal(cleaned, 1);
});
