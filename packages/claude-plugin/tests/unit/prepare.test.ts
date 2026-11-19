import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_PROJECT_OVERLAY, prepare } from '../../src/index.js';
import type { VerifiedBundle } from '../../../sdk/src/types.js';

const verified: VerifiedBundle = {
  version: { id: 'v2', bundleId: 'b', parentVersionId: null, digest: 'd', createdAt: 'now' },
  resolvedAt: 0,
  stale: false,
  payload: {
    schemaVersion: 1,
    files: [
      { path: 'instructions/core.md', kind: 'instruction', text: 'Claude instruction.' },
      {
        path: 'skills/lookup/SKILL.md',
        kind: 'skill',
        text: '---\nname: lookup\ndescription: Find values.\n---\nUse me.',
      },
      { path: 'memory/private.md', kind: 'memory', text: 'Memory is explicit.' },
    ],
  },
};

test('Claude preparation selects project resources and maps content into native paths', async () => {
  const prepared = await prepare(verified);
  try {
    assert.deepEqual(prepared.settingSources, ['project']);
    assert.equal(await readFile(prepared.instructionPath!, 'utf8'), 'Claude instruction.');
    assert.equal(await readFile(prepared.skillPaths[0]!, 'utf8'), verified.payload.files[1]!.text);
    assert.equal(prepared.memoryFiles[0]!.path, 'memory/private.md');
    assert.equal(
      await readFile(prepared.memoryFiles[0]!.absolutePath, 'utf8'),
      'Memory is explicit.',
    );
  } finally {
    await prepared.cleanup();
  }
  await assert.rejects(access(prepared.cwd), { code: 'ENOENT' });
});

test('Claude rejects skill metadata mismatch and case-insensitive duplicate names', async () => {
  const bad = structuredClone(verified);
  bad.payload.files[1]!.text = '---\nname: other\ndescription: wrong.\n---';
  await assert.rejects(prepare(bad), /\[skill_metadata\]/);
  const duplicate = structuredClone(verified);
  duplicate.payload.files.push({
    path: 'skills/LOOKUP/extra.md',
    kind: 'skill',
    text: 'duplicate name tree',
  });
  await assert.rejects(prepare(duplicate), /Skill names differ only by case/);
});

test('baseDir overlays project settings, MCP servers, hooks and subagents but not guidance', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'claude-overlay-'));
  try {
    await mkdir(path.join(repo, '.claude', 'agents'), { recursive: true });
    await mkdir(path.join(repo, '.claude', 'hooks'), { recursive: true });
    await mkdir(path.join(repo, '.claude', 'skills', 'local'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'settings.json'), '{"hooks":{}}');
    await writeFile(path.join(repo, '.claude', 'settings.local.json'), '{"private":true}');
    await writeFile(path.join(repo, '.claude', 'agents', 'reviewer.md'), 'Reviewer');
    await writeFile(path.join(repo, '.claude', 'hooks', 'check.sh'), '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(path.join(repo, '.claude', 'skills', 'local', 'SKILL.md'), 'Local skill');
    await writeFile(path.join(repo, '.mcp.json'), '{"mcpServers":{}}');
    await writeFile(path.join(repo, 'CLAUDE.md'), 'Repository guidance');
    const prepared = await prepare(verified, { baseDir: repo });
    try {
      assert.deepEqual(
        prepared.overlayFiles.map((file) => file.path),
        ['.claude/settings.json', '.claude/agents/reviewer.md', '.claude/hooks/check.sh', '.mcp.json'],
      );
      assert.match(prepared.overlayFiles[0]!.sha256, /^[a-f0-9]{64}$/);
      assert.equal(await readFile(path.join(prepared.cwd, '.mcp.json'), 'utf8'), '{"mcpServers":{}}');
      assert.ok((await stat(path.join(prepared.cwd, '.claude', 'hooks', 'check.sh'))).mode & 0o100);
      assert.equal(await readFile(prepared.instructionPath!, 'utf8'), 'Claude instruction.');
      await assert.rejects(access(path.join(prepared.cwd, '.claude', 'settings.local.json')), { code: 'ENOENT' });
      await assert.rejects(access(path.join(prepared.cwd, '.claude', 'skills', 'local')), { code: 'ENOENT' });
      assert.ok(!CLAUDE_PROJECT_OVERLAY.includes('CLAUDE.md'));
    } finally {
      await prepared.cleanup();
    }
    await symlink('/etc/hosts', path.join(repo, '.claude', 'agents', 'linked.md'));
    await assert.rejects(prepare(verified, { baseDir: repo }), /symlink/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
