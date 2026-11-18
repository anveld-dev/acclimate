import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, chmod, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { canonicalJson, sha256Bytes } from '../../src/learning/identity.js';
import { openLearningStore, LearningStoreError } from '../../src/learning/store.js';

async function fixture() {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'learning-store-'));
  return {
    directory,
    store: await openLearningStore(directory),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
function code(expected: string) {
  return (error: unknown) => error instanceof LearningStoreError && error.code === expected;
}

test('checkpoint CAS survives reopen and rejects stale state', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.store.readCheckpoint(), null);
    await f.store.writeCheckpoint(null, { revision: 0, campaignId: 'campaign', reservation: 20 });
    const reopened = await openLearningStore(f.directory);
    assert.deepEqual(await reopened.readCheckpoint(), {
      revision: 0,
      campaignId: 'campaign',
      reservation: 20,
    });
    await reopened.writeCheckpoint(0, { revision: 1, campaignId: 'campaign', reservation: 20 });
    await assert.rejects(
      f.store.writeCheckpoint(0, { revision: 1, reservation: 0 }),
      code('checkpoint-conflict'),
    );
    assert.equal(
      (await reopened.readCheckpoint<{ revision: number; reservation: number }>())!.reservation,
      20,
    );
    await assert.rejects(f.store.writeCheckpoint(1, { revision: 3 }), code('revision'));
  } finally {
    await f.cleanup();
  }
});

test('immutable artifacts verify retained bytes and reject tampering and symlinks', async () => {
  const f = await fixture();
  try {
    const ref = await f.store.putArtifact({ result: 'completed', usage: null });
    assert.deepEqual(await f.store.readArtifact(ref), { result: 'completed', usage: null });
    assert.deepEqual(await f.store.putArtifact({ usage: null, result: 'completed' }), ref);
    const filename = path.join(f.directory, 'artifacts', ref.id + '.json');
    await writeFile(filename, '{"result":"different"}\n', { mode: 0o600 });
    await assert.rejects(f.store.readArtifact(ref));
    await assert.rejects(f.store.putArtifact({ result: 'completed', usage: null }));
    await rm(filename);
    const other = path.join(f.directory, 'other.json');
    await writeFile(other, '{"result":"completed","usage":null}\n', { mode: 0o600 });
    await symlink(other, filename);
    await assert.rejects(f.store.readArtifact(ref));
    await assert.rejects(
      f.store.readArtifact({ ...ref, id: '../other' }),
      code('artifact-reference'),
    );
  } finally {
    await f.cleanup();
  }
});

test('inbox persists exact command deduplication and an atomic stop barrier', async () => {
  const f = await fixture();
  try {
    const command = { kind: 'observe', runId: 'run-1' };
    const receipt = await f.store.submit('observe-1', command);
    assert.equal(receipt.sequence, 1);
    assert.deepEqual(
      await f.store.submit('observe-1', { runId: 'run-1', kind: 'observe' }),
      receipt,
    );
    await assert.rejects(
      f.store.submit('observe-1', { ...command, runId: 'run-2' }),
      code('command-conflict'),
    );
    await f.store.submit('stop-1', { kind: 'request-stop', reason: 'operator stopped' });
    const reopened = await openLearningStore(f.directory);
    assert.equal(await reopened.admissionBarrier(), true);
    const inbox = await reopened.readInbox(1);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].sequence, 2);
    assert.equal(inbox[0].commandId, 'stop-1');
    let dispatched = false;
    await assert.rejects(
      reopened.withAdmission(async () => {
        dispatched = true;
      }),
      code('admission-closed'),
    );
    assert.equal(dispatched, false);
    await reopened.withInboxLock(async () => reopened.setAdmissionBarrier(false));
    await reopened.withAdmission(async () => {
      dispatched = true;
    });
    assert.equal(dispatched, true);
  } finally {
    await f.cleanup();
  }
});

test('worker ownership excludes another process lock while stop submission stays available', async () => {
  const f = await fixture();
  try {
    const other = await openLearningStore(f.directory);
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const work = f.store.withWorkerLock(async (lock) => {
      lock.assertOwned();
      entered();
      await pending;
      lock.assertOwned();
    });
    await ready;
    await assert.rejects(
      other.withWorkerLock(async () => {}),
      code('busy'),
    );
    await other.submit('stop', { kind: 'request-stop', reason: 'stop active work' });
    assert.equal(await f.store.admissionBarrier(), true);
    release();
    await work;
    await other.withWorkerLock(async (lock) => lock.assertOwned());
  } finally {
    await f.cleanup();
  }
});

test('dispatch and stop are serialized by the short inbox lock', async () => {
  const f = await fixture();
  try {
    const other = await openLearningStore(f.directory);
    await f.store.writeCheckpoint(null, { revision: 0, dispatched: false });
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const admitted = f.store.withAdmission(async () => {
      await f.store.writeCheckpoint(0, { revision: 1, dispatched: true });
      entered();
      await pending;
    });
    await ready;
    const stop = other.submit('stop-after-dispatch', { kind: 'request-stop', reason: 'stop' });
    release();
    await admitted;
    await stop;
    assert.equal(
      (await f.store.readCheckpoint<{ revision: number; dispatched: boolean }>())!.dispatched,
      true,
    );
    await assert.rejects(
      f.store.withAdmission(async () => {}),
      code('admission-closed'),
    );
  } finally {
    await f.cleanup();
  }
});

test('corrupt state, relocated checkpoint and nonprivate directories fail closed', async () => {
  const f = await fixture();
  try {
    await f.store.writeCheckpoint(null, { revision: 0, campaignId: 'private' });
    const filename = path.join(f.directory, 'checkpoint.json');
    const saved = await readFile(filename, 'utf8');
    await writeFile(filename, saved.replace('"revision":0', '"revision":7'), { mode: 0o600 });
    await assert.rejects(f.store.readCheckpoint(), code('corrupt'));
    await writeFile(filename, saved.replace(f.directory, '/different-owner-directory'), {
      mode: 0o600,
    });
    await assert.rejects(f.store.readCheckpoint(), code('checkpoint-scope'));
    await chmod(f.directory, 0o755);
    await assert.rejects(openLearningStore(f.directory));
    await chmod(f.directory, 0o700);
  } finally {
    await f.cleanup();
  }
});

test('a killed worker releases ownership while its dispatched intent and reservation survive', async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await f.store.writeCheckpoint(null, { revision: 0, operation: 'prepared', reservation: 40 });
    const storeUrl = new URL('../../src/learning/store.ts', import.meta.url).href;
    const script = `
      import { openLearningStore } from ${JSON.stringify(storeUrl)};
      const store = await openLearningStore(${JSON.stringify(f.directory)});
      await store.withWorkerLock(async () => {
        await store.withAdmission(async () => {
          await store.writeCheckpoint(0, { revision: 1, operation: 'dispatching', reservation: 40 });
        });
        process.stdout.write(${JSON.stringify('dispatch-intent-saved\n')});
        await new Promise(() => {});
      });
    `;
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      let output = '',
        errors = '';
      child!.stderr!.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      child!.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('dispatch-intent-saved\n')) resolve();
      });
      child!.once('error', reject);
      child!.once('exit', (status) => reject(new Error(`Worker exited ${status}: ${errors}`)));
    });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    let recovered = false;
    for (let attempt = 0; attempt < 50 && !recovered; attempt++) {
      try {
        await f.store.withWorkerLock(async () => {
          assert.deepEqual(await f.store.readCheckpoint(), {
            revision: 1,
            operation: 'dispatching',
            reservation: 40,
          });
          recovered = true;
        });
      } catch (error) {
        if (!code('busy')(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(recovered, true);
  } finally {
    child?.kill('SIGKILL');
    await f.cleanup();
  }
});

test('resuming a consumed command cannot erase a subsequently queued stop', async () => {
  const f = await fixture();
  try {
    await f.store.submit('stop-1', { kind: 'request-stop', reason: 'first' });
    const resume = await f.store.submit('resume-1', {
      kind: 'resume',
      reason: 'resume first stop',
    });
    await f.store.submit('stop-2', { kind: 'request-stop', reason: 'later stop' });
    await f.store.setAdmissionBarrier(false, resume.sequence);
    assert.equal(await f.store.admissionBarrier(), true);
    const latest = await f.store.submit('resume-2', {
      kind: 'resume',
      reason: 'resume later stop',
    });
    await f.store.setAdmissionBarrier(false, latest.sequence);
    assert.equal(await f.store.admissionBarrier(), false);
  } finally {
    await f.cleanup();
  }
});

test('a continuation from released worker ownership cannot write later checkpoints', async () => {
  const f = await fixture();
  try {
    await f.store.writeCheckpoint(null, { revision: 0, dispatched: false });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let staleWrite!: Promise<void>;
    await f.store.withWorkerLock(async () => {
      await assert.rejects(
        f.store.withWorkerLock(async () => {}),
        code('busy'),
      );
      staleWrite = pending.then(() =>
        f.store.writeCheckpoint(0, { revision: 1, dispatched: true }),
      );
    });
    release();
    await assert.rejects(staleWrite);
    assert.equal(
      (await f.store.readCheckpoint<{ revision: number; dispatched: boolean }>())!.dispatched,
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('a full observation inbox reserves admission for stop and resolution', async () => {
  const f = await fixture();
  try {
    const command = { kind: 'observe' };
    const sha256 = sha256Bytes(canonicalJson(command));
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      commandId: 'observation-' + index,
      command,
      sha256,
      sequence: index + 1,
    }));
    await writeFile(
      path.join(f.directory, 'inbox.json'),
      canonicalJson({
        schemaVersion: 2,
        compactedThrough: 0,
        directory: f.directory,
        admissionClosed: false,
        entries,
      }),
      { mode: 0o600 },
    );
    await assert.rejects(f.store.submit('overflow', command), code('inbox-full'));
    const resolution = await f.store.submit('resolve', { kind: 'resolve-uncertainty' });
    const stop = await f.store.submit('stop', { kind: 'request-stop' });
    assert.equal(resolution.sequence, 10_001);
    assert.equal(stop.sequence, 10_002);
    const reopened = await openLearningStore(f.directory);
    assert.equal(await reopened.admissionBarrier(), true);
    assert.deepEqual(
      (await reopened.readInbox(10_000)).map((entry) => entry.commandId),
      ['resolve', 'stop'],
    );
  } finally {
    await f.cleanup();
  }
});

test('byte saturation reserves stop capacity and compaction keeps pending stops and replay receipts', async () => {
  const f = await fixture();
  try {
    const command = {
      kind: 'observe',
      payload: Array.from({ length: 16 }, () => 'a'.repeat(1024 * 1024 - 32)),
    };
    const first = await f.store.submit('first', command);
    const next = { kind: 'observe', payload: 'b'.repeat(1024) };
    await assert.rejects(f.store.submit('second', next), code('inbox-full'));
    const stop = await f.store.submit('stop', { kind: 'request-stop', reason: 's'.repeat(1024) });
    assert.equal(stop.sequence, 2);
    await f.store.writeCheckpoint(null, { revision: 0, appliedSequence: first.sequence });
    const second = await f.store.submit('second', next);
    assert.equal(second.sequence, 3);
    const reopened = await openLearningStore(f.directory);
    assert.deepEqual(await reopened.submit('first', command), first);
    await assert.rejects(reopened.submit('first', { kind: 'resume' }), code('command-conflict'));
    assert.deepEqual(
      (await reopened.readInbox(first.sequence)).map((entry) => entry.sequence),
      [2, 3],
    );
    await assert.rejects(reopened.readInbox(0), code('sequence'));
    await reopened.setAdmissionBarrier(false, first.sequence);
    assert.equal(await reopened.admissionBarrier(), true);
  } finally {
    await f.cleanup();
  }
});

test('queued resolutions cannot exhaust the stop reserve', async () => {
  const f = await fixture();
  try {
    const command = { kind: 'resolve-uncertainty' };
    const sha256 = sha256Bytes(canonicalJson(command));
    const entries = Array.from({ length: 64 }, (_, index) => ({
      commandId: 'resolution-' + index,
      command,
      sha256,
      sequence: index + 1,
    }));
    await writeFile(
      path.join(f.directory, 'inbox.json'),
      canonicalJson({
        schemaVersion: 2,
        compactedThrough: 0,
        directory: f.directory,
        admissionClosed: false,
        entries,
      }),
      { mode: 0o600 },
    );
    await assert.rejects(f.store.submit('overflow', command), code('inbox-full'));
    const stop = await f.store.submit('stop', { kind: 'request-stop' });
    assert.equal(stop.sequence, 65);
    assert.equal(await f.store.admissionBarrier(), true);
  } finally {
    await f.cleanup();
  }
});
