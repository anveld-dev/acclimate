import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { privateDirectory, privateDirectoryWithSync, readPrivateJson } from '../../src/evaluation/private-state.js';
import { readEvaluatorConfig, readReaderConfig } from '../../src/evaluation/config.js';
import { EvaluationError } from '../../src/evaluation/errors.js';

async function root() {
  return mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-dir-sync-'));
}

test('private JSON rejects duplicate decoded object keys at any depth without echoing content', async () => {
  const directory = await root();
  const filename = path.join(directory, 'state.json');
  try {
    for (const text of [
      '{"schemaVersion":0,"schemaVersion":1}',
      String.raw`{"private-canary":0,"\u0070rivate-canary":1}`,
      String.raw`{"entries":[{"scope":0,"\u0073cope":1}]}`,
      String.raw`{"nested":{"a\"b":0,"a\u0022b":1}}`,
      '{"__proto__":0,"__proto__":1}',
    ]) {
      await writeFile(filename, text, { mode: 0o600 });
      await assert.rejects(
        readPrivateJson(filename),
        (error) => error instanceof EvaluationError && error.code === 'config.schema' &&
          !JSON.stringify(error).includes('private-canary'),
      );
    }
    const valid = {
      one: { shared: 1 },
      two: { shared: 2 },
      list: [{ shared: 3 }, { shared: 4 }],
      literal: '"shared":{},[]',
      'quote"and\\slash': true,
    };
    await writeFile(filename, JSON.stringify(valid), { mode: 0o600 });
    assert.deepEqual(await readPrivateJson(filename), valid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing evaluator and reader config files have the fixed missing category', async () => {
  const directory = await root();
  const filename = path.join(directory, 'private-missing-canary.json');
  try {
    for (const read of [readEvaluatorConfig, readReaderConfig])
      await assert.rejects(
        read(filename),
        (error) => error instanceof EvaluationError && error.code === 'config.missing' &&
          !JSON.stringify(error).includes('private-missing-canary'),
      );
    await writeFile(filename, '{}', { mode: 0o644 });
    await chmod(filename, 0o644);
    await assert.rejects(readEvaluatorConfig(filename),
      (error) => error instanceof EvaluationError && error.code === 'config.permissions');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('new private directory entries are synced deepest-first through their existing immediate parent', async () => {
  const directory = await root(),
    top = path.join(directory, 'scope'),
    middle = path.join(top, 'jobs'),
    leaf = path.join(middle, 'job');
  const sibling = path.join(directory, 'unrelated');
  await mkdir(sibling, { mode: 0o750 });
  await chmod(sibling, 0o750);
  const synced: string[] = [];
  try {
    await privateDirectoryWithSync(leaf, async (current) => {
      synced.push(current);
      const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        assert.equal((await handle.stat()).isDirectory(), true);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    assert.deepEqual(synced, [leaf, middle, top, directory]);
    for (const current of [leaf, middle, top])
      assert.equal((await lstat(current)).mode & 0o777, 0o700);
    assert.equal((await lstat(sibling)).mode & 0o777, 0o750);
    assert.ok(!synced.includes(path.dirname(directory)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('already existing private directories perform no creation sync or permission rewrite', async () => {
  const directory = await root();
  let syncs = 0;
  try {
    await chmod(directory, 0o500);
    await privateDirectoryWithSync(directory, async () => {
      syncs++;
    });
    assert.equal(syncs, 0);
    assert.equal((await lstat(directory)).mode & 0o777, 0o500);
  } finally {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  }
});

test('directory fsync failure rejects before the caller may rely on durable creation', async () => {
  const directory = await root(),
    leaf = path.join(directory, 'scope', 'job');
  let returned = false;
  try {
    await assert.rejects(
      async () => {
        await privateDirectoryWithSync(leaf, async () => {
          throw new Error('private-path-must-not-leak');
        });
        returned = true;
      },
      (error) =>
        error instanceof EvaluationError &&
        error.code === 'config.permissions' &&
        !String(error).includes('private-path-must-not-leak'),
    );
    assert.equal(returned, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('symlink and nonprivate existing targets fail without syncing unrelated paths', async () => {
  const directory = await root(),
    actual = path.join(directory, 'actual'),
    link = path.join(directory, 'link');
  await mkdir(actual, { mode: 0o700 });
  await symlink(actual, link);
  let syncs = 0;
  try {
    await assert.rejects(
      privateDirectoryWithSync(path.join(link, 'child'), async () => {
        syncs++;
      }),
      EvaluationError,
    );
    await chmod(actual, 0o755);
    await assert.rejects(
      privateDirectoryWithSync(actual, async () => {
        syncs++;
      }),
      EvaluationError,
    );
    assert.equal(syncs, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent cooperating creators leave one private tree and successful durable returns', async () => {
  const directory = await root(),
    leaf = path.join(directory, 'scope', 'jobs', 'job');
  try {
    await Promise.all([privateDirectory(leaf), privateDirectory(leaf)]);
    assert.equal((await lstat(leaf)).mode & 0o777, 0o700);
    assert.equal(await realpath(leaf), leaf);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
