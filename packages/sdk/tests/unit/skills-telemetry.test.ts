import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSkillLookup,
  DeliveryError,
  extractBundleSkills,
  renderBundlePrompt,
  selectApprovedMemory,
  systemPrompt,
  telemetryAttributes,
  telemetryMetadata,
  type BundlePayload,
  type VerifiedVersion,
} from '../../src/index.js';

const payload: BundlePayload = {
  schemaVersion: 1,
  files: [
    { path: 'instructions.md', kind: 'instruction', text: 'Be helpful and concise.' },
    {
      path: 'skills/triage/SKILL.md',
      kind: 'skill',
      text: '---\nname: triage\ndescription: Classify incoming tickets\n---\nAlways assign P0-P3.',
    },
    {
      path: 'skills/triage/rubric.md',
      kind: 'skill',
      text: 'P0 means production outage.',
    },
    { path: 'memory/customer-notes.md', kind: 'memory', text: 'VIP account.' },
    { path: 'memory/internal.md', kind: 'memory', text: 'Internal note.' },
  ],
};

const verified: VerifiedVersion = {
  version: {
    id: 'ver_123',
    bundleId: 'bun_456',
    parentVersionId: null,
    digest: 'sha256:abcdef',
    createdAt: '2026-11-27T00:00:00Z',
  },
  payload,
  resolution: {
    channel: 'stable',
    revision: '7',
    version: {
      id: 'ver_123',
      bundleId: 'bun_456',
      parentVersionId: null,
      digest: 'sha256:abcdef',
      createdAt: '2026-11-27T00:00:00Z',
    },
  },
  resolvedAt: 1700000000000,
  stale: false,
};

test('extractBundleSkills parses frontmatter and supporting files', () => {
  const skills = extractBundleSkills(payload);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, 'triage');
  assert.equal(skills[0]?.description, 'Classify incoming tickets');
  assert.equal(skills[0]?.body, 'Always assign P0-P3.');
  assert.deepEqual(skills[0]?.files, [{ path: 'rubric.md', text: 'P0 means production outage.' }]);

  const literalSkills = extractBundleSkills({
    schemaVersion: 1,
    files: [
      {
        path: 'skills/multi/SKILL.md',
        kind: 'skill',
        text: '---\nname: multi\ndescription: |-\n  Line one.\n\n  Line two.\n---\nBody.',
      },
    ],
  });
  assert.equal(literalSkills[0]?.description, 'Line one.\n\nLine two.');
});

test('renderBundlePrompt matches systemPrompt by default and supports filtering', () => {
  assert.equal(renderBundlePrompt(payload), systemPrompt(payload));

  const withoutSkills = renderBundlePrompt(payload, {
    includeSkills: false,
    approvedMemoryPaths: ['memory/customer-notes.md'],
  });
  assert.ok(withoutSkills.includes('Be helpful and concise.'));
  assert.ok(!withoutSkills.includes('Classify incoming tickets'));
  assert.ok(withoutSkills.includes('VIP account.'));
  assert.ok(!withoutSkills.includes('Internal note.'));
});

test('selectApprovedMemory rejects unknown memory paths', () => {
  assert.throws(
    () => selectApprovedMemory(payload, ['memory/missing.md']),
    (error: unknown) => error instanceof DeliveryError && error.code === 'invalid_payload',
  );
});

test('createSkillLookup lists and reads manifests and supporting files safely', () => {
  const lookup = createSkillLookup(payload);
  assert.deepEqual(lookup.listSkills(), [
    { name: 'triage', description: 'Classify incoming tickets', files: ['rubric.md'] },
  ]);
  assert.ok(lookup.readSkill('triage').includes('Always assign P0-P3.'));
  assert.equal(lookup.readSkill('triage', 'rubric.md'), 'P0 means production outage.');
  assert.throws(() => lookup.readSkill('missing'), DeliveryError);
  assert.throws(() => lookup.readSkill('triage', '../secret.md'), DeliveryError);
});

test('telemetryAttributes and telemetryMetadata emit standard OTel attributes', () => {
  const attrs = telemetryAttributes(verified);
  assert.deepEqual(attrs, {
    'acclimate.bundle_id': 'bun_456',
    'acclimate.version_id': 'ver_123',
    'acclimate.digest': 'sha256:abcdef',
    'acclimate.stale': false,
    'acclimate.channel': 'stable',
    'acclimate.revision': '7',
  });
  assert.deepEqual(telemetryMetadata(verified), attrs);
});
