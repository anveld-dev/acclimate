import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { lstat, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cleanupQuarantinedJob, inspectNativeJob } from '../repository-job.mjs';

for (const mode of ['launch', 'accepted', 'retention-error', 'retained', 'cleanup-deleted']) {
  test(
    `process loss after ${mode} retains a recoverable owned job`,
    { timeout: 15_000 },
    async () => {
      const child = fork(fileURLToPath(new URL('./fault-worker.mjs', import.meta.url)), [mode], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      const exit = new Promise((resolve) => child.once('exit', resolve));
      let received;
      try {
        received = await new Promise((resolve, reject) => {
          child.once('message', resolve);
          child.once('error', reject);
          child.once('exit', (code) => reject(new Error(`fault worker exited ${code}: ${stderr}`)));
        });
        assert.equal(received.stage, mode);
        child.kill('SIGKILL');
        await exit; // This owned fake process is actually reaped; no PID-only inference.
        const record = await inspectNativeJob(received.privateJobDirectory);
        assert.equal(record.cwd, received.cwd);
        assert.equal(record.facts.launchIntent, true);
        assert.equal(record.facts.cleaned, false);
        assert.equal(
          record.facts.confirmedStopped,
          ['retention-error', 'retained', 'cleanup-deleted'].includes(mode),
        );
        assert.equal(record.facts.resultsRetained, ['retained', 'cleanup-deleted'].includes(mode));
        if (mode === 'cleanup-deleted') {
          assert.equal(record.cleanupIntent, true);
          await assert.rejects(lstat(record.cwd), { code: 'ENOENT' });
        } else assert.ok((await lstat(record.cwd)).isDirectory());
        if (mode === 'accepted') assert.equal(record.externalHandle.kind, 'owned-test-process');
        if (['retained', 'cleanup-deleted'].includes(mode)) {
          const manifest = JSON.parse(await readFile(record.artifactManifest.path));
          assert.equal(manifest.binding.attemptId, record.binding.attemptId);
        }
        await assert.rejects(
          cleanupQuarantinedJob({
            privateJobDirectory: received.privateJobDirectory,
            confirmStopped: async () => false,
          }),
          { code: 'native.termination_unconfirmed' },
        );
        await cleanupQuarantinedJob({
          privateJobDirectory: received.privateJobDirectory,
          confirmStopped: async () => true,
        });
        await assert.rejects(lstat(record.cwd), { code: 'ENOENT' });
        assert.equal((await inspectNativeJob(received.privateJobDirectory)).facts.cleaned, true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exit;
        }
        if (received?.base) await rm(received.base, { recursive: true, force: true });
      }
    },
  );
}
