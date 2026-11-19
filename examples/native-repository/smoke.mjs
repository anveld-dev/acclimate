// Offline end-to-end check of this starter: the replay harness edits a copy of
// fixture/, the real grader runs its Node tests, and two versions are compared.
// No server, credentials or model calls are involved.
//
//   node smoke.mjs [--keep]
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');

function verifiedVersion(instruction) {
  const payload = { schemaVersion: 1, files: [{ path: 'instructions.md', kind: 'instruction', text: instruction }] };
  return {
    version: {
      id: randomUUID(), bundleId: randomUUID(), parentVersionId: null,
      digest: 'sha256:' + digest(JSON.stringify(payload) + '\n'), createdAt: new Date().toISOString(),
    },
    payload, resolvedAt: Date.now(), stale: false,
  };
}

async function main() {
  const keep = process.argv.includes('--keep');
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acclimate-native-smoke-')));
  try {
    for (const name of ['workspaces', 'artifacts', 'journal']) await mkdir(path.join(base, name), { mode: 0o700 });
    const example = JSON.parse(await readFile(path.join(here, 'native.replay.json'), 'utf8'));
    const configFile = path.join(base, 'native.json');
    await writeFile(configFile, JSON.stringify({ ...example, stateRoot: base }), { mode: 0o600 });
    process.env.ACCLIMATE_NATIVE_CONFIG = configFile;
    process.env.TMPDIR = path.join(base, 'workspaces');
    const app = await import('./application.mjs');
    const versions = {
      parent: verifiedVersion('Keep payment retries working.\n'),
      candidate: verifiedVersion('Keep payment retries request-scoped.\n'),
    };
    const results = {};
    for (const [side, bundle] of Object.entries(versions)) {
      for (const item of app.cases) {
        const context = { requestId: randomUUID(), attemptId: randomUUID(), side, jobId: digest(randomUUID()) };
        context.privateJobDirectory = path.join(base, 'journal', context.jobId);
        await mkdir(context.privateJobDirectory, { mode: 0o700 });
        await writeFile(path.join(context.privateJobDirectory, 'binding.json'), JSON.stringify({
          requestId: context.requestId, attemptId: context.attemptId, side, jobId: context.jobId,
          caseId: item.caseId, repetition: 0, versionId: bundle.version.id, digest: bundle.version.digest,
        }), { mode: 0o600 });
        const signal = new AbortController().signal;
        const execution = await app.execute({ bundle, context, caseId: item.caseId, repetition: 0, input: item.input, signal });
        const grade = await app.grade({ output: execution.output, expected: item.expected, caseId: item.caseId, repetition: 0, signal });
        results[side] = {
          ...results[side],
          [item.caseId]: {
            executionStatus: execution.executionStatus ?? 'completed',
            reward: grade.reward,
            outcome: grade.explanation.outcome,
            tests: grade.explanation.tests,
            undeclaredChanges: grade.explanation.undeclaredChanges?.paths ?? [],
          },
        };
      }
    }
    console.log(JSON.stringify({ harness: app.runtime.settings.harness, evidence: 'offline-replay-no-model', ...results }));
  } finally {
    if (keep) console.error(`smoke: kept ${base}`);
    else await rm(base, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const line = error.code && String(error.message).startsWith(error.code) ? error.message : `${error.code ?? error.name}: ${error.message}`;
  console.error(`smoke: ${line}`);
  process.exitCode = 1;
});
