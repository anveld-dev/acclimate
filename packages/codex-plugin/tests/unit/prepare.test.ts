import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { prepare } from '../../src/index.js';
import type { VerifiedBundle } from '../../../sdk/src/types.js';

const bundle = (): VerifiedBundle => ({
  version: {
    id: 'v1',
    bundleId: 'b1',
    parentVersionId: null,
    digest: 'sha256:fixture',
    createdAt: '2026-01-01T00:00:00Z',
  },
  payload: {
    schemaVersion: 1,
    files: [
      { path: 'instructions/main.md', kind: 'instruction', text: 'Use concise answers.' },
      {
        path: 'skills/lookup/SKILL.md',
        kind: 'skill',
        text: '---\nname: lookup\ndescription: Look up the supplied value.\n---\nReturn the marker.',
      },
      { path: 'skills/lookup/references/guide.md', kind: 'skill', text: 'Reference detail.' },
      { path: 'memory/context.md', kind: 'memory', text: 'Marker: amber' },
    ],
  },
  resolvedAt: Date.now(),
  stale: false,
});

test('prepares native Codex instruction and skill files, returns memory explicitly, and cleans its private workspace', async () => {
  const result = await prepare(bundle());
  try {
    assert.ok(result.skillPaths[0]!.endsWith('/.agents/skills/lookup/SKILL.md'));
    assert.equal(await readFile(result.instructionPath!, 'utf8'), 'Use concise answers.');
    assert.equal(await readFile(result.skillPaths[0]!, 'utf8'), bundle().payload.files[1]!.text);
    assert.equal(
      await readFile(result.skillPaths[0]!.replace('/SKILL.md', '/references/guide.md'), 'utf8'),
      'Reference detail.',
    );
    assert.equal(result.memoryFiles[0]!.path, 'memory/context.md');
    assert.equal(result.memoryFiles[0]!.text, 'Marker: amber');
    assert.equal(await readFile(result.memoryFiles[0]!.absolutePath, 'utf8'), 'Marker: amber');
    assert.equal((await stat(result.cwd)).mode & 0o077, 0);
  } finally {
    await result.cleanup();
  }
  await assert.rejects(access(result.cwd));
});

test('rejects duplicate skill names and orphan skill reference trees', async () => {
  const input = bundle();
  input.payload.files.push({
    path: 'skills/LOOKUP/extra.md',
    kind: 'skill',
    text: 'Duplicate name tree.',
  });
  await assert.rejects(prepare(input), /Skill names differ only by case/);
  const orphan = bundle();
  orphan.payload.files = orphan.payload.files.filter(
    (file) => file.path !== 'skills/lookup/SKILL.md',
  );
  await assert.rejects(prepare(orphan), /requires an exact SKILL.md/);
});

test('delegates payload size and schema limits to shared delivery validation', async () => {
  const tooLarge = bundle();
  tooLarge.payload.files[0]!.text = 'x'.repeat(256 * 1024 + 1);
  await assert.rejects(prepare(tooLarge), /text size limit/);
  const empty = bundle();
  empty.payload.files = [];
  await assert.rejects(prepare(empty), /malformed bundle payload/);
});

test('rejects multiple instruction files and unsafe paths', async () => {
  const input = bundle();
  input.payload.files.push({ path: 'more.md', kind: 'instruction', text: 'second' });
  await assert.rejects(prepare(input), /at most one instruction/);
  const unsafe = bundle();
  unsafe.payload.files[0]!.path = '../escape';
  await assert.rejects(prepare(unsafe), /invalid file/);
});

test('preparing a refreshed version leaves an existing job workspace pinned', async () => {
  const first = bundle();
  const second = bundle();
  second.version = { ...second.version, id: 'v2', parentVersionId: 'v1', digest: 'sha256:second' };
  second.payload.files[0]!.text = 'Updated instruction.';
  second.payload.files[1]!.text =
    '---\nname: lookup\ndescription: Look up the supplied value.\n---\nUpdated skill.';
  second.payload.files[3]!.text = 'Updated memory.';
  const pinned = await prepare(first);
  const refreshed = await prepare(second);
  try {
    assert.notEqual(pinned.cwd, refreshed.cwd);
    assert.deepEqual([pinned.versionId, pinned.digest], ['v1', 'sha256:fixture']);
    assert.deepEqual([refreshed.versionId, refreshed.digest], ['v2', 'sha256:second']);
    assert.equal(await readFile(pinned.instructionPath!, 'utf8'), 'Use concise answers.');
    assert.equal(await readFile(refreshed.instructionPath!, 'utf8'), 'Updated instruction.');
    assert.equal(await readFile(pinned.skillPaths[0]!, 'utf8'), first.payload.files[1]!.text);
    assert.equal(await readFile(refreshed.skillPaths[0]!, 'utf8'), second.payload.files[1]!.text);
    assert.equal(await readFile(pinned.memoryFiles[0]!.absolutePath, 'utf8'), 'Marker: amber');
    assert.equal(await readFile(refreshed.memoryFiles[0]!.absolutePath, 'utf8'), 'Updated memory.');
    await refreshed.cleanup();
    assert.equal(await readFile(pinned.instructionPath!, 'utf8'), 'Use concise answers.');
  } finally {
    await refreshed.cleanup();
    await pinned.cleanup();
  }
});
