import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './support.mjs';
import {
  cleanupQuarantinedJob,
  freezeSourceInventory,
  inspectNativeJob,
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
    assert.match(result.output.repository.patch, /^--- a\/delete.txt/m);
    assert.match(result.output.repository.patch, /^\+\+\+ b\/added.txt/m);
    assert.match(result.output.repository.patch, /\+export const key = "request";/);
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
