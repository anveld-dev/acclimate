import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeliveredVersion } from '../../../sdk/src/native-files.js';
import type { VerifiedVersion } from '../../../sdk/src/types.js';
import { createAcclimateMiddleware, prepare } from '../../src/index.js';

const verified: VerifiedVersion = {
  version: {
    id: 'ver_ai_1',
    bundleId: 'bun_ai',
    parentVersionId: null,
    digest: 'sha256:ai1',
    createdAt: '2026-11-27T00:00:00Z',
  },
  payload: {
    schemaVersion: 1,
    files: [
      { path: 'instructions.md', kind: 'instruction', text: 'Follow policy.' },
      {
        path: 'skills/returns/SKILL.md',
        kind: 'skill',
        text: '---\nname: returns\ndescription: Handle return requests\n---\nCheck receipt date.',
      },
      { path: 'memory/notes.md', kind: 'memory', text: 'Holiday extension active.' },
    ],
  },
  resolution: {
    channel: 'stable',
    revision: '3',
    version: {
      id: 'ver_ai_1',
      bundleId: 'bun_ai',
      parentVersionId: null,
      digest: 'sha256:ai1',
      createdAt: '2026-11-27T00:00:00Z',
    },
  },
  resolvedAt: 0,
  stale: false,
};

test('ai-sdk prepare builds middleware, telemetry, skillTools and forwards receipts/cleanup', async () => {
  let startedCount = 0;
  let cleanedCount = 0;
  const delivery: DeliveredVersion = {
    version: verified,
    reportStarted() {
      startedCount += 1;
      return {
        eventId: 'evt-1',
        connectionId: '00000000-0000-0000-0000-000000000001',
        workspaceId: 'ws-1',
        bundleId: 'bun_ai',
        versionId: 'ver_ai_1',
        digest: 'sha256:ai1',
        stage: 'started',
        occurredAt: '2026-11-27T00:00:00Z',
        source: 'cache',
      };
    },
    async cleanup() {
      cleanedCount += 1;
    },
  };

  const prepared = prepare(delivery, { includeSkillsInPrompt: false, approvedMemoryPaths: [] });
  assert.equal(prepared.versionId, 'ver_ai_1');
  assert.equal(prepared.telemetry.metadata['acclimate.channel'], 'stable');
  assert.ok(prepared.system.includes('Follow policy.'));
  assert.ok(!prepared.system.includes('Check receipt date.'));
  assert.deepEqual(prepared.memoryFiles, []);

  const transformed = await prepared.middleware.transformParams({
    type: 'generate',
    params: { prompt: [{ role: 'user', content: 'Help me return boots' }] },
  });
  assert.equal(startedCount, 1);
  assert.equal(transformed.prompt[0]?.role, 'system');
  assert.equal(transformed.prompt[0]?.content, prepared.system);

  const merged = await prepared.middleware.transformParams({
    type: 'generate',
    params: {
      prompt: [
        { role: 'system', content: 'Extra caller instruction.' },
        { role: 'user', content: 'Help' },
      ],
    },
  });
  assert.equal(merged.prompt.length, 2);
  assert.equal(merged.prompt[0]?.content, `${prepared.system}\n\nExtra caller instruction.`);

  const wrappedTools = prepared.createSkillTools((schema) => ({ wrapped: true, schema }));
  assert.equal(wrappedTools.read_acclimate_skill.inputSchema.wrapped, true);
  const list = await wrappedTools.list_acclimate_skills.execute({});
  assert.deepEqual(list, [{ name: 'returns', description: 'Handle return requests', files: [] }]);
  const skillText = await wrappedTools.read_acclimate_skill.execute({ name: 'returns', filePath: null });
  assert.ok(skillText.includes('Check receipt date.'));

  await prepared.cleanup();
  await prepared.cleanup();
  assert.equal(cleanedCount, 1);
});

test('createAcclimateMiddleware works directly on VerifiedVersion', async () => {
  const middleware = createAcclimateMiddleware(verified);
  assert.equal(middleware.specificationVersion, 'v3');
  const transformed = await middleware.transformParams({
    type: 'stream',
    params: { prompt: [{ role: 'user', content: 'Hi' }] },
  });
  assert.equal(transformed.prompt.length, 2);
  assert.equal(transformed.prompt[0]?.role, 'system');

  const dupBundle: VerifiedVersion = {
    ...verified,
    payload: {
      schemaVersion: 1,
      files: [
        { path: 'instructions.md', kind: 'instruction', text: 'Policy.' },
        { path: 'skills/a/SKILL.md', kind: 'skill', text: '---\nname: dup\ndescription: First\n---\n1' },
        { path: 'skills/b/SKILL.md', kind: 'skill', text: '---\nname: dup\ndescription: Second\n---\n2' },
      ],
    },
  };
  const dupPrepared = prepare(dupBundle);
  assert.ok(dupPrepared.system.includes('Policy.'));
  await assert.rejects(() => dupPrepared.skillTools.list_acclimate_skills.execute({}));
});
