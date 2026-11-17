import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installedHarness } from './harnesses.mjs';
import {
  freezeSourceInventory,
  inspectNativeJob,
  runRepositoryJob,
  sha256,
} from './repository-job.mjs';

const executeFile = promisify(execFile);
async function main() {
  const [stateRoot, target] = process.argv.slice(2);
  const source = await freezeSourceInventory({
    sourceRoot: fileURLToPath(new URL('./fixture', import.meta.url)),
    paths: ['package.json', 'src/retry.js', 'tests/retry.test.mjs'],
    revision: 'retry-fixture-v1',
  });
  const payload = {
    schemaVersion: 1,
    files: [
      {
        path: 'instructions.md',
        kind: 'instruction',
        text: 'Keep payment retries request-scoped.\n',
      },
      {
        path: 'skills/retry-review/SKILL.md',
        kind: 'skill',
        text: '---\nname: retry-review\ndescription: Check payment retry identity.\n---\nPreserve request identity.\n',
      },
      { path: 'memory/selected.md', kind: 'memory', text: 'SELECTED-MEMORY\n' },
      { path: 'memory/withheld.md', kind: 'memory', text: 'WITHHELD-CANARY\n' },
    ],
  };
  const bundle = {
    version: {
      id: '11111111-1111-4111-8111-111111111111',
      bundleId: '22222222-2222-4222-8222-222222222222',
      parentVersionId: null,
      digest:
        'sha256:' +
        createHash('sha256')
          .update(JSON.stringify(payload) + '\n')
          .digest('hex'),
      createdAt: '2026-11-16T00:00:00Z',
    },
    payload,
    resolvedAt: Date.now(),
    stale: false,
  };
  const context = {
    requestId: '33333333-3333-4333-8333-333333333333',
    attemptId: '44444444-4444-4444-8444-444444444444',
    side: 'candidate',
    jobId: sha256(Buffer.from('native-demo:' + target)),
  };
  context.privateJobDirectory = path.join(stateRoot, 'jobs', context.jobId);
  await mkdir(context.privateJobDirectory, { mode: 0o700 });
  await writeFile(
    path.join(context.privateJobDirectory, 'binding.json'),
    JSON.stringify({
      requestId: context.requestId,
      attemptId: context.attemptId,
      side: context.side,
      jobId: context.jobId,
      caseId: 'request-scoped-retry',
      repetition: 0,
      versionId: bundle.version.id,
      digest: bundle.version.digest,
    }) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  const harness = await installedHarness(target);
  const result = await runRepositoryJob({
    bundle,
    context,
    source,
    harness: target,
    prepare: harness.prepare,
    workspaceParent: path.join(stateRoot, 'workspaces'),
    artifactRoot: path.join(stateRoot, 'artifacts'),
    caseId: 'request-scoped-retry',
    repetition: 0,
    selectedMemoryPaths: ['memory/selected.md'],
    resultFiles: ['src/retry.js'],
    runHarness: async ({ context: effective, acknowledge }) => {
      await acknowledge({ kind: 'deterministic-fixture', value: 'synchronous-no-provider' });
      const instruction = await readFile(effective.instructionPath, 'utf8');
      const skill = await readFile(effective.skillPaths[0], 'utf8');
      if (
        !instruction.includes('request-scoped') ||
        !skill.includes('Preserve request identity') ||
        effective.memoryFiles.length !== 1 ||
        effective.memoryFiles[0].text !== 'SELECTED-MEMORY\n' ||
        JSON.stringify(effective).includes('WITHHELD-CANARY')
      )
        throw new Error('fixture.context_mismatch');
      // This deterministic fixture is the actual-agent replacement seam. It makes no model call.
      await writeFile(
        path.join(effective.cwd, 'src/retry.js'),
        'export function retryKey(requestId, attempt) {\n  void attempt;\n  return requestId;\n}\n',
      );
      await executeFile(process.execPath, ['--test', 'tests/retry.test.mjs'], {
        cwd: effective.cwd,
      });
      return { stopped: true, output: { retryInvariantPassed: true, fixture: true } };
    },
  });
  const record = await inspectNativeJob(context.privateJobDirectory);
  const original = await readFile(
    fileURLToPath(new URL('./fixture/src/retry.js', import.meta.url)),
    'utf8',
  );
  if (
    !original.includes('`${requestId}:${attempt}`') ||
    !result.output.repository.patch.includes('+  return requestId;') ||
    !record.facts.cleaned ||
    !record.facts.resultsRetained
  )
    throw new Error('fixture.lifetime_mismatch');
  console.log(
    JSON.stringify({
      harness: target,
      sourceManifestSha256: source.sha256,
      retainedPatch: true,
      cleaned: true,
      evidence: 'deterministic-wiring-only',
    }),
  );
}

main().catch(() => {
  console.error(JSON.stringify({ error: { code: 'native.fixture_failed' } }));
  process.exitCode = 1;
});
