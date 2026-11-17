import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BundlePayload, VerifiedBundle } from '../../src/types.js';
import { canonicalJson } from '../../src/learning/identity.js';
import {
  planCandidate,
  textDigest,
  packageDigest,
  MutationError,
  REFERENCE_PREFLIGHT_ID,
  type MutationPolicyV1,
  type MutationV1,
  type ParentBinding,
} from '../../src/learning/mutations.js';
import { prepareNativeFiles } from '../../src/internal/native-files.js';

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Perform a useful reusable job\n---\nRead references/data.json.\n`;
function fixture(
  files: BundlePayload['files'] = [
    { path: 'AGENTS.md', kind: 'instruction', text: 'First sentence. Second sentence.\n' },
  ],
) {
  const payload: BundlePayload = { schemaVersion: 1, files };
  // Preserve noncanonical server serialization to guard against re-hashing canonical payloads.
  const payloadBytes = Buffer.from(JSON.stringify(payload, null, 2));
  const digest = `sha256:${createHash('sha256').update(payloadBytes).digest('hex')}` as const;
  const parent: VerifiedBundle = {
    version: {
      id: 'parent',
      bundleId: 'bundle',
      parentVersionId: null,
      digest,
      createdAt: '2026-01-01',
    },
    payload,
    resolvedAt: 1,
    stale: false,
  };
  const binding: ParentBinding = {
    projectId: 'project',
    bundleId: 'bundle',
    versionId: 'parent',
    contentDigest: digest,
  };
  const policy: MutationPolicyV1 = {
    schemaVersion: 1,
    mode: 'fixed-files',
    compatibilityTarget: 'codex',
    editablePaths: ['AGENTS.md'],
    createSkillNames: [],
    retireSkillNames: [],
    maxChangedArtifacts: 10,
    maxChangedFiles: 10,
    maxAddedTextBytes: 4096,
    maxFinalFiles: 20,
    maxFinalBytes: 4096,
    requiredPreflightIds: ['domain.behavior'],
  };
  const admission = textDigest('authorized correction');
  const mutation: MutationV1 = {
    schemaVersion: 1,
    parent: binding,
    policyDigest: textDigest(canonicalJson(policy)),
    rationale: 'Apply an authorized correction',
    admissionDigests: [admission],
    operations: [
      {
        op: 'editText',
        file: { path: 'AGENTS.md', kind: 'instruction', textDigest: textDigest(files[0].text) },
        replacements: [{ oldText: 'First', newText: 'Better' }],
      },
    ],
  };
  return {
    parent,
    payloadBytes,
    binding,
    compatibilityTarget: 'codex' as const,
    mutation,
    policy,
    authorizedAdmissionDigests: [admission],
  };
}
function refreshPolicy(f: ReturnType<typeof fixture>) {
  f.mutation.policyDigest = textDigest(canonicalJson(f.policy));
}
function throwsCode(fn: () => unknown, code: string) {
  assert.throws(fn, (e) => e instanceof MutationError && e.code === code);
}

test('plans simultaneous exact original edits preserving unrelated bytes and input objects', () => {
  const f = fixture();
  const edit = f.mutation.operations[0];
  assert.equal(edit.op, 'editText');
  if (edit.op !== 'editText') throw new Error();
  edit.replacements = [
    { oldText: 'First', newText: 'Second' },
    { oldText: 'Second sentence', newText: 'Final sentence' },
  ];
  const before = { ...structuredClone(f), payloadBytes: Buffer.from(f.payloadBytes) };
  const plan = planCandidate(f);
  assert.equal(plan.payload.files[0].text, 'Second sentence. Final sentence.\n');
  assert.deepEqual(f, before);
  assert.equal(plan.parent.contentDigest, f.parent.version.digest);
  assert.equal(plan.referenceReview.state, 'not-required');
  assert.deepEqual(plan.requiredPreflightIds, ['domain.behavior']);
  assert.throws(() => {
    plan.payload.files[0].text = 'caller changed plan';
  }, TypeError);
  assert.equal(f.parent.payload.files[0].text, before.parent.payload.files[0].text);
});

test('requires original verified bytes, scope and trusted target rather than reserialized digest', () => {
  const f = fixture();
  assert.doesNotThrow(() => planCandidate(f));
  throwsCode(
    () => planCandidate({ ...f, payloadBytes: Buffer.from(canonicalJson(f.parent.payload)) }),
    'mutation.parent_mismatch',
  );
  throwsCode(
    () => planCandidate({ ...f, binding: { ...f.binding, projectId: 'another-project' } }),
    'mutation.parent_mismatch',
  );
  throwsCode(
    () => planCandidate({ ...f, compatibilityTarget: 'claude' }),
    'mutation.policy_mismatch',
  );
  f.parent.payload.files[0].text += ' changed';
  throwsCode(() => planCandidate(f), 'mutation.parent_mismatch');
});

test('cannot self-authorize policy or admission, and rejects undeclared fields', () => {
  const f = fixture();
  throwsCode(
    () => planCandidate({ ...f, authorizedAdmissionDigests: [] }),
    'mutation.capability_denied',
  );
  const forged = structuredClone(f);
  forged.policy.editablePaths = ['something-else'];
  throwsCode(() => planCandidate(forged), 'mutation.policy_mismatch');
  (f.mutation as any).permissions = ['all'];
  throwsCode(() => planCandidate(f), 'mutation.invalid');
});

test('rejects ambiguous, stale, overlapping, empty and noop text preconditions', () => {
  for (const replacement of [
    [{ oldText: 'sentence', newText: 'rule' }],
    [{ oldText: 'missing', newText: 'rule' }],
    [
      { oldText: 'First sentence', newText: 'rule' },
      { oldText: 'sentence.', newText: 'rule' },
    ],
    [{ oldText: '', newText: 'rule' }],
  ]) {
    const f = fixture();
    const op = f.mutation.operations[0];
    if (op.op !== 'editText') throw new Error();
    op.replacements = replacement;
    throwsCode(() => planCandidate(f), 'mutation.precondition_failed');
  }
  const f = fixture();
  const op = f.mutation.operations[0];
  if (op.op !== 'editText') throw new Error();
  op.replacements = [{ oldText: 'First', newText: 'First' }];
  throwsCode(() => planCandidate(f), 'mutation.no_change');
  op.file.textDigest = textDigest('stale');
  throwsCode(() => planCandidate(f), 'mutation.precondition_failed');
});

test('empty scaffold can be filled but only with one empty original anchor', () => {
  const f = fixture([{ path: 'AGENTS.md', kind: 'instruction', text: '' }]);
  const op = f.mutation.operations[0];
  if (op.op !== 'editText') throw new Error();
  op.replacements = [{ oldText: '', newText: 'A useful instruction' }];
  assert.equal(planCandidate(f).payload.files[0].text, 'A useful instruction');
  op.replacements.push({ oldText: '', newText: 'another' });
  throwsCode(() => planCandidate(f), 'mutation.precondition_failed');
});

function packageFixture() {
  const f = fixture([
    { path: 'AGENTS.md', kind: 'instruction', text: 'Use the new skill.' },
    { path: 'skills/old/SKILL.md', kind: 'skill', text: skill('old') },
    { path: 'skills/old/references/data.json', kind: 'skill', text: '{"old":true}' },
    { path: 'skills/sibling/SKILL.md', kind: 'skill', text: skill('sibling') },
  ]);
  f.policy.mode = 'skill-packages';
  f.policy.createSkillNames = ['new'];
  f.policy.retireSkillNames = ['old'];
  refreshPolicy(f);
  f.mutation.operations = [
    {
      op: 'createSkill',
      name: 'new',
      files: [
        { relativePath: 'references/data.json', text: '{"new":true}' },
        { relativePath: 'SKILL.md', text: skill('new') },
      ],
    },
    {
      op: 'retireSkill',
      name: 'old',
      expectedPackageDigest: packageDigest(f.parent.payload, 'old'),
    },
  ];
  return f;
}

test('atomic multi-file skill creation/retirement preserves siblings and requires reference preflight', async () => {
  const f = packageFixture(),
    plan = planCandidate(f);
  assert.deepEqual(
    plan.payload.files.map((f) => f.path),
    [
      'AGENTS.md',
      'skills/sibling/SKILL.md',
      'skills/new/SKILL.md',
      'skills/new/references/data.json',
    ],
  );
  assert.deepEqual(plan.referenceReview, {
    state: 'required',
    paths: ['skills/new', 'skills/old'],
  });
  assert.ok(plan.requiredPreflightIds.includes(REFERENCE_PREFLIGHT_ID));
  assert.equal(plan.payload.files[1].text, f.parent.payload.files[3].text);
  const prepared = await prepareNativeFiles(
    { ...f.parent, payload: plan.payload },
    {
      instructionPath: 'AGENTS.md',
      skillRoot: '.agents/skills',
      memoryRoot: '.memory',
    },
    'learning-mutation-',
    'codex',
  );
  try {
    assert.equal(
      await readFile(join(prepared.cwd, '.agents/skills/new/references/data.json'), 'utf8'),
      '{"new":true}',
    );
  } finally {
    await prepared.cleanup();
  }
});

test('package integrity holds even for generic target and before any candidate is published', () => {
  const f = packageFixture();
  const op = f.mutation.operations[0];
  if (op.op !== 'createSkill') throw new Error();
  const before = structuredClone(f.parent);
  op.files = [{ relativePath: 'helper.py', text: 'print(1)' }];
  throwsCode(() => planCandidate(f), 'mutation.package_invalid');
  f.policy.compatibilityTarget = 'generic';
  refreshPolicy(f);
  throwsCode(
    () => planCandidate({ ...f, compatibilityTarget: 'generic' }),
    'mutation.package_invalid',
  );
  assert.deepEqual(f.parent, before);
});

test('rejects package drift, traversal, collisions and overlapping operation ownership', () => {
  const stale = packageFixture();
  const retire = stale.mutation.operations[1];
  if (retire.op !== 'retireSkill') throw new Error();
  retire.expectedPackageDigest = textDigest('different package');
  throwsCode(() => planCandidate(stale), 'mutation.precondition_failed');
  const traversal = packageFixture();
  const create = traversal.mutation.operations[0];
  if (create.op !== 'createSkill') throw new Error();
  create.files[0].relativePath = '../outside';
  throwsCode(() => planCandidate(traversal), 'mutation.invalid');
  const conflict = packageFixture();
  conflict.mutation.operations.push({
    op: 'editText',
    file: { path: 'skills/old/SKILL.md', kind: 'skill', textDigest: textDigest(skill('old')) },
    replacements: [{ oldText: 'Read', newText: 'Use' }],
  });
  throwsCode(() => planCandidate(conflict), 'mutation.operation_conflict');
  const collision = packageFixture();
  const c = collision.mutation.operations[0];
  if (c.op !== 'createSkill') throw new Error();
  c.files.push({ relativePath: 'skill.md', text: 'case collision' });
  throwsCode(() => planCandidate(collision), 'mutation.package_invalid');
});

test('capabilities and UTF-8 limits cannot be widened by proposed changes', () => {
  const f = packageFixture();
  f.policy.mode = 'fixed-files';
  refreshPolicy(f);
  throwsCode(() => planCandidate(f), 'mutation.capability_denied');
  const bytes = fixture();
  bytes.policy.maxAddedTextBytes = 1;
  refreshPolicy(bytes);
  const op = bytes.mutation.operations[0];
  if (op.op !== 'editText') throw new Error();
  op.replacements = [{ oldText: 'First', newText: 'Firsté' }];
  throwsCode(() => planCandidate(bytes), 'mutation.limit_exceeded');
  bytes.policy.maxFinalFiles = 129;
  refreshPolicy(bytes);
  throwsCode(() => planCandidate(bytes), 'mutation.limit_exceeded');
});
