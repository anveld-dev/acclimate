import { readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './support.mjs';

const mode = process.argv[2];
await fixture(async ({ base, run, options }) => {
  const notify = async (stage) => {
    const record = JSON.parse(
      await readFile(path.join(options.context.privateJobDirectory, 'job.json')),
    );
    process.send({
      stage,
      base,
      privateJobDirectory: options.context.privateJobDirectory,
      cwd: record.cwd,
      artifactDirectory: path.join(
        path.dirname(path.dirname(options.context.privateJobDirectory)),
        'artifacts',
        options.context.jobId,
      ),
    });
  };
  let prepare = options.prepare;
  if (mode === 'retained' || mode === 'cleanup-deleted') {
    prepare = async (...args) => {
      const prepared = await options.prepare(...args);
      return {
        ...prepared,
        cleanup: async () => {
          if (mode === 'cleanup-deleted') await prepared.cleanup();
          await notify(mode);
          await new Promise(() => {});
        },
      };
    };
  }
  try {
    await run({
      prepare,
      runHarness: async ({ context, acknowledge }) => {
        if (mode === 'launch') {
          await notify('launch');
          await new Promise(() => {});
        }
        await acknowledge({ kind: 'owned-test-process', value: String(process.pid) });
        if (mode === 'accepted') {
          await notify('accepted');
          await new Promise(() => {});
        }
        if (mode === 'retention-error')
          await symlink('/etc/hosts', path.join(context.cwd, 'added.txt'));
        return { stopped: true, output: { fixture: true } };
      },
    });
  } catch {
    if (mode !== 'retention-error') throw new Error('fixture.unexpected_fault');
    await notify('retention-error');
    await new Promise(() => {});
  }
});
