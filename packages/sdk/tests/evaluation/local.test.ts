import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineEvaluation } from '../../src/evaluation/index.js';
import type { EvaluationDefinition } from '../../src/evaluation/types.js';
import {
  loadLocalPayload,
  localPayloadDigest,
  tryEvaluation,
  LocalRunError,
} from '../../src/evaluation/local.js';
import {
  runControlsFromFlags,
  parseDuration,
  parseSelection,
  selectedCaseIds,
} from '../../src/evaluation/controls.js';
import type { BundlePayload } from '../../src/types.js';

const parentPayload: BundlePayload = {
  schemaVersion: 1,
  files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'Be brief.' }],
};
const candidatePayload: BundlePayload = {
  schemaVersion: 1,
  files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'Be polite.' }],
};
type Definition = EvaluationDefinition<number, number, { text: string; n: number }>;
function definition(overrides: Partial<Definition> = {}): Definition {
  return {
    configId: 'local-test',
    configRevision: '1',
    datasetRevision: 'cases-1',
    graderRevision: 'grader-1',
    runtime: { app: 'local-test' },
    execution: 'model-free',
    cases: [
      { caseId: 'a', input: 1, expected: 1 },
      { caseId: 'b', input: 2, expected: 2, repetitions: 2 },
      { caseId: 'c', input: 3, expected: 3 },
      { caseId: 'd', input: 4, expected: 4 },
    ],
    execute: async ({ version, input }) => ({
      output: { text: version.payload.files[0].text, n: input },
    }),
    grade: async ({ output }) => ({ reward: output.text.includes('polite') ? 1 : 0.5 }),
    ...overrides,
  };
}

async function workspace() {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-local-'));
  return {
    directory,
    run: path.join(directory, 'run'),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('payload folders map skills, memory and instructions with the service validation rules', async () => {
  const w = await workspace();
  try {
    const folder = path.join(w.directory, 'bundle');
    await mkdir(path.join(folder, 'skills', 'lookup'), { recursive: true });
    await mkdir(path.join(folder, 'memory'), { recursive: true });
    await mkdir(path.join(folder, '.git'), { recursive: true });
    await writeFile(path.join(folder, 'AGENTS.md'), '# Agent');
    await writeFile(path.join(folder, 'skills', 'lookup', 'SKILL.md'), 'skill');
    await writeFile(path.join(folder, 'memory', 'prefs.md'), 'memory');
    await writeFile(path.join(folder, '.git', 'HEAD'), 'ignored');
    await writeFile(path.join(folder, '.DS_Store'), 'ignored');
    const loaded = await loadLocalPayload(folder);
    assert.equal(loaded.form, 'directory');
    assert.deepEqual(
      loaded.payload.files.map((file) => [file.path, file.kind]),
      [
        ['AGENTS.md', 'instruction'],
        ['memory/prefs.md', 'memory'],
        ['skills/lookup/SKILL.md', 'skill'],
      ],
    );
    // A file with the same content yields the same digest as the folder.
    const file = path.join(w.directory, 'payload.json');
    await writeFile(file, JSON.stringify(loaded.payload));
    assert.equal((await loadLocalPayload(file)).digest, loaded.digest);

    await writeFile(path.join(folder, 'bad name.md'), 'x');
    await assert.rejects(loadLocalPayload(folder), (error: Error) => {
      assert.ok(error instanceof LocalRunError);
      assert.match(error.message, /^bad name\.md: not a valid bundle file/);
      return true;
    });
    await rm(path.join(folder, 'bad name.md'));
    await symlink(path.join(folder, 'AGENTS.md'), path.join(folder, 'link.md'));
    await assert.rejects(loadLocalPayload(folder), /link\.md: symbolic links are not read/);
    await rm(path.join(folder, 'link.md'));
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        files: [
          { path: 'A.md', kind: 'instruction', text: '' },
          { path: 'a.md', kind: 'memory', text: '' },
        ],
      }),
    );
    await assert.rejects(loadLocalPayload(file), /differ only by case/);
    await writeFile(file, '{"schemaVersion":1,"files":[{"path":"a.md","kind":"notes","text":""}]}');
    await assert.rejects(loadLocalPayload(file), /files\[0\] needs exactly path, kind/);
    const empty = path.join(w.directory, 'empty');
    await mkdir(empty);
    await assert.rejects(loadLocalPayload(empty), /has no files/);
  } finally {
    await w.cleanup();
  }
});

test('try validates every returned shape and shows the output', async () => {
  const w = await workspace();
  try {
    const app = defineEvaluation<number, number, any>({
      ...(definition() as any),
      execute: async ({ caseId }: { caseId: string }) =>
        caseId === 'a'
          ? { output: { when: new Date(0) }, usage: { costUsd: -1, tokens: 3 } }
          : caseId === 'b'
            ? { output: { ok: true }, executionStatus: 'done' }
            : { output: { ok: true }, extra: 1 },
      grade: async ({ output }: { output: { ok?: boolean } }) => ({ reward: output.ok ? 5 : Number.NaN }),
    });
    const result = await tryEvaluation({
      app,
      selection: { kind: 'cases', caseIds: ['a', 'b', 'c'] },
      directory: w.run,
    });
    assert.equal(result.ok, false);
    const [a, b, c] = result.cases;
    assert.deepEqual(
      a.execute.issues.map((issue) => [issue.severity, issue.field]),
      [
        ['error', 'output["when"]'],
        ['error', 'usage.tokens'],
      ],
    );
    assert.match(a.execute.issues[0].message, /toISOString/);
    assert.equal(a.grade.status, 'skipped');
    assert.equal(b.execute.issues[0].field, 'executionStatus');
    assert.equal(c.execute.status, 'ok');
    assert.deepEqual(c.execute.output, { ok: true });
    assert.equal(c.execute.issues[0].field, 'extra');
    assert.equal(c.grade.status, 'ok');
    assert.equal(c.grade.reward, 5);
    assert.match(c.grade.issues[0].message, /outside 0–1/);
    const first = await tryEvaluation({ app: defineEvaluation(definition()), directory: w.run });
    assert.equal(first.ok, true);
    assert.deepEqual(first.cases.map((row) => row.caseId), ['a']);
    assert.equal(first.payload.source, null);
  } finally {
    await w.cleanup();
  }
});
