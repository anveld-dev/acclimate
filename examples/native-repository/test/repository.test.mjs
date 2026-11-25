import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fixture } from './support.mjs';
import {
  cleanupQuarantinedJob,
  freezeSourceInventory,
  gradeRepositoryTests,
  inspectNativeJob,
  matchesPattern,
  validateInventory,
} from '../repository-job.mjs';

test('closed source policy rejects controls, hidden paths, prefix and case collisions', () => {
  for (const paths of [
    ['AGENTS.md'],
    ['deep/claude.MD'],
    ['src/.env'],
    ['.acclimate/new.txt'],
    ['src/.Cursor/rules.txt'],
    ['../escape'],
    ['/absolute'],
    ['src\\file'],
    ['con.txt'],
    ['src/a', 'src/A'],
    ['a', 'a-b', 'a/b'],
  ])
    assert.throws(() => validateInventory(paths));
  assert.deepEqual(validateInventory(['tests/a.mjs', 'src/a.js']), ['src/a.js', 'tests/a.mjs']);
  assert.throws(() => validateInventory(['.gitignore']), (error) =>
    error.code === 'native.control_path' && error.path === '.gitignore' &&
    error.message.startsWith('native.control_path: ".gitignore" (dot-prefixed segment)') && /allowDotPaths/.test(error.message));
  assert.throws(() => validateInventory(['src/AGENTS.md']), /native\.control_path: "src\/AGENTS\.md" \(AGENTS\.md is a native control path/);
  assert.throws(() => validateInventory(['a', 'a/b']), /native\.path_collision: "a" \(is both a file and the directory of a\/b\)/);
  assert.deepEqual(validateInventory(['.eslintrc', 'src/a.js'], 10, { allowDotPaths: ['.eslintrc'] }), ['.eslintrc', 'src/a.js']);
  assert.throws(() => validateInventory(['.git/config'], 10, { allowDotPaths: ['.git/config'] }), { code: 'native.control_path' });
  assert.throws(() => validateInventory(['src/**']), /wildcards are accepted only in resultFiles/);
  assert.deepEqual(validateInventory(['src/**', 'lib/*.js'], 10, { patterns: true }), ['lib/*.js', 'src/**']);
  assert.throws(() => validateInventory(['src/a**'], 10, { patterns: true }), /\*\* must be a whole path segment/);
});

test('result patterns match within segments and never select dot paths', () => {
  assert.ok(matchesPattern('src/**', 'src/a/b.js'));
  assert.ok(matchesPattern('src/**', 'src'));
  assert.ok(matchesPattern('**/*.test.mjs', 'tests/unit/a.test.mjs'));
  assert.ok(matchesPattern('src/*.js', 'src/a.js'));
  assert.ok(!matchesPattern('src/*.js', 'src/a/b.js'));
  assert.ok(!matchesPattern('src/**', 'src/.env'));
  assert.ok(!matchesPattern('src/**', 'src/.cache/x.js'));
});

test('missing and symlinked sources name the offending path', async () => {
  await fixture(async ({ source }) => {
    await assert.rejects(freezeSourceInventory({ sourceRoot: source, paths: ['src/missing.js'], revision: 'v1' }),
      { code: 'native.source_unavailable', message: 'native.source_unavailable: "src/missing.js" (listed in sourceFiles but missing from sourceRoot)' });
    await symlink('src/retry.js', path.join(source, 'link.js'));
    await assert.rejects(freezeSourceInventory({ sourceRoot: source, paths: ['link.js'], revision: 'v1' }),
      { code: 'native.unsafe_file', message: 'native.unsafe_file: "link.js" (symlink)' });
  });
});

test('captures immutable source bytes; rejects source symlinks and file budget excess', async () => {
  await fixture(async ({ source, options }) => {
    assert.ok(Object.isFrozen(options.source.files));
    await symlink('src/retry.js', path.join(source, 'link.js'));
    await assert.rejects(
      freezeSourceInventory({ sourceRoot: source, paths: ['link.js'], revision: 'v1' }),
    );
    await writeFile(path.join(source, 'large.txt'), Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(
      freezeSourceInventory({ sourceRoot: source, paths: ['large.txt'], revision: 'v1' }),
    );
    const snapshot = options.source.files.find((file) => file.path === 'src/retry.js');
    await writeFile(path.join(source, 'src/retry.js'), 'changed externally');
    assert.match(Buffer.from(snapshot.dataBase64, 'base64').toString(), /attempt/);
  });
});

test('retains text add/change/delete patch before cleanup and keeps original source unchanged', async () => {
  await fixture(async ({ run, options, cleaned, readOriginal, artifacts }) => {
    const result = await run();
    assert.equal(cleaned(), 1);
    assert.match(await readOriginal(), /attempt/);
    const patch = await readFile(path.join(artifacts, options.context.jobId, 'result.patch'), 'utf8');
    assert.match(patch, /^--- a\/delete.txt/m);
    assert.match(patch, /^\+\+\+ b\/added.txt/m);
    assert.match(patch, /\+export const key = "request";/);
    assert.equal(result.output.repository.patch.bytes, Buffer.byteLength(patch));
    const manifest = JSON.parse(
      await readFile(path.join(artifacts, options.context.jobId, 'manifest.json')),
    );
    assert.deepEqual(
      manifest.changes.map((entry) => entry.status),
      ['added', 'deleted', 'modified'],
    );
    const record = await inspectNativeJob(options.context.privateJobDirectory);
    assert.deepEqual(record.facts, {
      prepared: true,
      launchIntent: true,
      confirmedStopped: true,
      resultsRetained: true,
      cleaned: true,
    });
    await assert.rejects(lstat(record.cwd), { code: 'ENOENT' });
  });
});

test('independent grading uses the original test when a coding agent rewrites its copy', async () => {
  await fixture(async ({ run, source, artifacts }) => {
    const testProgram = "import assert from 'node:assert/strict'; assert.equal(false,true);";
    await writeFile(path.join(source, 'verify.mjs'), testProgram);
    const snapshot = await freezeSourceInventory({
      sourceRoot: source, paths: ['src/retry.js', 'verify.mjs'], revision: 'fixed-tests',
    });
    const resultFiles = ['src/retry.js'];
    const result = await run({
      source: snapshot, resultFiles,
      runHarness: async ({ context }) => {
        await writeFile(path.join(context.cwd, 'verify.mjs'), '');
        assert.equal(spawnSync(process.execPath, ['verify.mjs'], { cwd: context.cwd }).status, 0);
        return { stopped: true, output: { passed: true }, executionStatus: 'task_failed',
          usage: { inputTokens: 11, outputTokens: 2, costUsd: 0.42 } };
      },
    });
    assert.equal(result.executionStatus, 'task_failed');
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 2, costUsd: 0.42 });
    assert.equal(result.output.repository.protectedChangeCount, 1);
    for (let attempt = 0; attempt < 2; attempt++) {
      const grade = await gradeRepositoryTests({
        source: snapshot, artifactRoot: artifacts, resultFiles, repository: result.output.repository,
        runTests: ({ cwd }) => spawnSync(process.execPath, ['verify.mjs'], { cwd }).status === 0,
      });
      assert.deepEqual(grade, { reward: 0, explanation: {
        outcome: 'failed', testsPassed: false, tests: null, rewardMode: 'binary',
        protectedChanges: [{ path: 'verify.mjs', status: 'modified' }],
        undeclaredChanges: { count: 0, paths: [], truncated: false, unsupportedEntries: [], complete: true },
      } });
    }
    const protectedGrade = await gradeRepositoryTests({
      source: snapshot, artifactRoot: artifacts, resultFiles, repository: result.output.repository,
      runTests: async () => true,
    });
    assert.equal(protectedGrade.reward, 0);
  });
});

test('large patches and outputs stay private and retained solution files are verified on regrade', async () => {
  await fixture(async ({ run, options, artifacts }) => {
    const content = JSON.stringify({ message: '"'.repeat(280000) });
    const resultFiles = ['added.txt'];
    const result = await run({
      resultFiles,
      runHarness: async ({ context }) => {
        await writeFile(path.join(context.cwd, 'added.txt'), content);
        return { stopped: true, output: content };
      },
    });
    assert.ok(Buffer.byteLength(JSON.stringify(result.output)) < 1024 * 1024);
    assert.equal(result.output.result, null);
    const directory = path.join(artifacts, options.context.jobId);
    assert.match(await readFile(path.join(directory, 'result.patch'), 'utf8'), /message/);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'output.json'), 'utf8')), content);
    const grade = () => gradeRepositoryTests({
      source: options.source, artifactRoot: artifacts, resultFiles, repository: result.output.repository,
      runTests: async ({ cwd }) => await readFile(path.join(cwd, 'added.txt'), 'utf8') === content,
    });
    assert.equal((await grade()).reward, 1);
    await writeFile(path.join(directory, 'files/added.txt'), 'different');
    await assert.rejects(grade(), { code: 'native.artifact_digest' });
  });
});

test('selected memory excludes bytes and all returned resource metadata', async () => {
  await fixture(async ({ run }) => {
    await run({
      runHarness: async ({ context }) => {
        assert.equal(context.memoryFiles.length, 1);
        assert.equal(context.resources.length, 1);
        assert.equal(context.resources[0].path, 'memory/yes.md');
        assert.ok(!JSON.stringify(context).includes('NO-PRIVATE-CANARY'));
        await assert.rejects(readFile(path.join(context.cwd, '.acclimate/memory/no.md')), {
          code: 'ENOENT',
        });
        assert.equal(await readFile(context.memoryFiles[0].absolutePath, 'utf8'), 'YES');
        assert.ok(Object.isFrozen(context.memoryFiles[0]));
        return { stopped: true, output: true };
      },
    });
  });
});

test('unknown memory and prelaunch cancellation never launch and clean prepared inputs', async () => {
  await fixture(async ({ run, cleaned }) => {
    let launched = false;
    await assert.rejects(
      run({
        selectedMemoryPaths: ['memory/unknown.md'],
        runHarness: async () => {
          launched = true;
        },
      }),
      { code: 'native.memory_selection' },
    );
    assert.equal(launched, false);
    assert.equal(cleaned(), 1);
  });
  await fixture(async ({ run, cleaned }) => {
    await assert.rejects(run({ signal: AbortSignal.abort() }), {
      code: 'native.cancelled_before_start',
    });
    assert.equal(cleaned(), 0);
  });
});

test('retention rejects agent-created output symlinks and preserves the stopped workspace', async () => {
  await fixture(async ({ run, cleaned, options }) => {
    await assert.rejects(
      run({
        runHarness: async ({ context }) => {
          await symlink('/etc/hosts', path.join(context.cwd, 'added.txt'));
          return { stopped: true, output: true };
        },
      }),
      { code: 'native.unsafe_file' },
    );
    assert.equal(cleaned(), 0);
    const record = await inspectNativeJob(options.context.privateJobDirectory);
    assert.equal(record.facts.confirmedStopped, true);
    assert.equal(record.facts.resultsRetained, false);
    assert.ok((await lstat(record.cwd)).isDirectory());
  });
});

test('persistent TMPDIR and exact runner binding are checked before native preparation', async () => {
  await fixture(async ({ run, base, options }) => {
    const other = path.join(base, 'other');
    await mkdir(other, { mode: 0o700 });
    await assert.rejects(run({ workspaceParent: other }), {
      code: 'native.persistent_tmpdir_required',
    });
    await writeFile(path.join(options.context.privateJobDirectory, 'binding.json'), '{}', {
      mode: 0o600,
    });
    await assert.rejects(run(), { code: 'native.execution_binding' });
  });
});

test('unconfirmed native work is quarantined with a durable private locator', async () => {
  await fixture(async ({ run, cleaned, options }) => {
    await assert.rejects(
      run({
        runHarness: async ({ acknowledge }) => {
          await acknowledge({ kind: 'fake-process', value: 'unknown-completion' });
          return { stopped: false };
        },
      }),
      (error) => error.name === 'ExecutionUncertainError',
    );
    assert.equal(cleaned(), 0);
    const record = await inspectNativeJob(options.context.privateJobDirectory);
    assert.equal(record.facts.launchIntent, true);
    assert.equal(record.facts.confirmedStopped, false);
    assert.equal(record.externalHandle.value, 'unknown-completion');
    assert.ok((await lstat(record.cwd)).isDirectory());
    await assert.rejects(
      cleanupQuarantinedJob({
        privateJobDirectory: options.context.privateJobDirectory,
        confirmStopped: async () => false,
      }),
      { code: 'native.termination_unconfirmed' },
    );
    const result = await cleanupQuarantinedJob({
      privateJobDirectory: options.context.privateJobDirectory,
      confirmStopped: async () => true,
    });
    assert.equal(result.cleaned, true);
    await assert.rejects(lstat(record.cwd), { code: 'ENOENT' });
  });
});

test('a missing quarantined root without durable cleanup intent never establishes ownership', async () => {
  await fixture(async ({ run, options }) => {
    await assert.rejects(run({ runHarness: async () => ({ stopped: false }) }), {
      name: 'ExecutionUncertainError',
    });
    const record = await inspectNativeJob(options.context.privateJobDirectory);
    await rm(record.cwd, { recursive: true });
    await assert.rejects(
      cleanupQuarantinedJob({
        privateJobDirectory: options.context.privateJobDirectory,
        confirmStopped: async () => true,
      }),
      { code: 'native.ownership_mismatch' },
    );
    assert.equal(
      (await inspectNativeJob(options.context.privateJobDirectory)).facts.cleaned,
      false,
    );
  });
});
