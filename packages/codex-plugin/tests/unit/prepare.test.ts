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
  await assert.rejects(access(result.cwd), { code: 'ENOENT' });
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

test('keeps skill and original memory order when a bundle has no instruction', async () => {
  const input = bundle();
  input.payload.files = [
    { path: 'memory/z-last.md', kind: 'memory', text: 'First selected memory.' },
    {
      path: 'skills/zebra/SKILL.md',
      kind: 'skill',
      text: '---\nname: zebra\ndescription: Review zebra.\n---\nFirst selected skill.',
    },
    input.payload.files[2]!,
    { path: 'memory/a-first.md', kind: 'memory', text: 'Second selected memory.' },
    input.payload.files[1]!,
  ];
  const result = await prepare(input);
  try {
    assert.equal(result.instructionPath, null);
    assert.deepEqual(
      result.skillPaths.map((file) => file.slice(result.cwd.length + 1)),
      ['.agents/skills/zebra/SKILL.md', '.agents/skills/lookup/SKILL.md'],
    );
    assert.deepEqual(
      result.memoryFiles.map(({ path, text }) => ({ path, text })),
      [
        { path: 'memory/z-last.md', text: 'First selected memory.' },
        { path: 'memory/a-first.md', text: 'Second selected memory.' },
      ],
    );
    for (const memory of result.memoryFiles)
      assert.equal(await readFile(memory.absolutePath, 'utf8'), memory.text);
    assert.deepEqual(Object.keys(result).sort(), [
      'cleanup',
      'cwd',
      'digest',
      'instructionPath',
      'memoryFiles',
      'reportStarted',
      'skillPaths',
      'versionId',
    ]);
    assert.equal(result.reportStarted(), null);
  } finally {
    await result.cleanup();
  }
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

test('accepts client.prepare() output so start receipts survive native preparation', async () => {
  const receipt = { stage: 'started' } as never;
  let started = 0;
  let released = 0;
  const delivery = {
    bundle: bundle(),
    reportStarted() {
      started++;
      return receipt;
    },
    async cleanup() {
      released++;
    },
  };
  const prepared = await prepare(delivery);
  assert.equal(prepared.versionId, 'v1');
  assert.equal(await readFile(prepared.instructionPath!, 'utf8'), 'Use concise answers.');
  assert.equal(prepared.reportStarted(), receipt);
  assert.equal(started, 1);
  await prepared.cleanup();
  assert.equal(released, 1);
});
