import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { freezeSourceInventory, runRepositoryJob, sha256 } from '../repository-job.mjs';

export async function fixture(callback) {
  const previous = process.env.TMPDIR;
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'native-recipe-test-')));
  const locations = Object.fromEntries(
    ['source', 'workspaces', 'jobs', 'artifacts'].map((name) => [name, path.join(base, name)]),
  );
  for (const directory of Object.values(locations)) await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(locations.source, 'src'), { mode: 0o700 });
  await writeFile(path.join(locations.source, 'src/retry.js'), 'export const key = "attempt";\n');
  await writeFile(path.join(locations.source, 'delete.txt'), 'delete this\n');
  process.env.TMPDIR = locations.workspaces;
  try {
    const source = await freezeSourceInventory({
      sourceRoot: locations.source,
      paths: ['src/retry.js', 'delete.txt'],
      revision: 'test-source-1',
    });
    const payload = {
      schemaVersion: 1,
      files: [
        { path: 'instructions.md', kind: 'instruction', text: 'request-scoped retry' },
        { path: 'memory/yes.md', kind: 'memory', text: 'YES' },
        { path: 'memory/no.md', kind: 'memory', text: 'NO-PRIVATE-CANARY' },
      ],
    };
    const bundle = {
      version: {
        id: randomUUID(),
        bundleId: randomUUID(),
        digest: 'sha256:' + sha256(Buffer.from(JSON.stringify(payload))),
        parentVersionId: null,
        createdAt: new Date().toISOString(),
      },
      payload,
      resolvedAt: Date.now(),
      stale: false,
    };
    const context = {
      requestId: randomUUID(),
      attemptId: randomUUID(),
      side: 'candidate',
      jobId: sha256(Buffer.from(randomUUID())),
      privateJobDirectory: path.join(locations.jobs, 'one'),
    };
    await mkdir(context.privateJobDirectory, { mode: 0o700 });
    await writeFile(
      path.join(context.privateJobDirectory, 'binding.json'),
      JSON.stringify({
        requestId: context.requestId,
        attemptId: context.attemptId,
        side: context.side,
        jobId: context.jobId,
        caseId: 'task',
        repetition: 0,
        versionId: bundle.version.id,
        digest: bundle.version.digest,
      }),
      { mode: 0o600 },
    );
    let cleaned = 0;
    const prepare = async () => {
      const cwd = await mkdtemp(path.join(locations.workspaces, 'fixture-'));
      await mkdir(path.join(cwd, '.acclimate', 'memory'), { recursive: true, mode: 0o700 });
      const instructionPath = path.join(cwd, 'AGENTS.md');
      await writeFile(instructionPath, 'request-scoped retry', { mode: 0o600 });
      const memoryFiles = [];
      for (const file of payload.files.filter((file) => file.kind === 'memory')) {
        const absolutePath = path.join(cwd, '.acclimate', 'memory', path.basename(file.path));
        await writeFile(absolutePath, file.text, { mode: 0o600 });
        memoryFiles.push({ path: file.path, text: file.text, absolutePath });
      }
      return {
        cwd,
        versionId: bundle.version.id,
        digest: bundle.version.digest,
        instructionPath,
        skillPaths: [],
        memoryFiles,
        settingSources: ['project'],
        resources: memoryFiles.map((file) => ({
          path: file.path,
          kind: 'memory',
          absolutePath: file.absolutePath,
        })),
        async cleanup() {
          cleaned++;
          await rm(cwd, { recursive: true });
        },
      };
    };
    const options = {
      bundle,
      context,
      source,
      harness: 'codex',
      prepare,
      workspaceParent: locations.workspaces,
      artifactRoot: locations.artifacts,
      caseId: 'task',
      repetition: 0,
      selectedMemoryPaths: ['memory/yes.md'],
      resultFiles: ['src/retry.js', 'delete.txt', 'added.txt'],
      runHarness: async ({ context: effective }) => {
        await writeFile(
          path.join(effective.cwd, 'src/retry.js'),
          'export const key = "request";\n',
        );
        await rm(path.join(effective.cwd, 'delete.txt'));
        await writeFile(path.join(effective.cwd, 'added.txt'), 'added\n');
        return { stopped: true, output: { passed: true } };
      },
    };
    return await callback({
      base,
      ...locations,
      options,
      cleaned: () => cleaned,
      readOriginal: () => readFile(path.join(locations.source, 'src/retry.js'), 'utf8'),
      run: (changes = {}) => runRepositoryJob({ ...options, ...changes }),
    });
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(base, { recursive: true, force: true });
  }
}
