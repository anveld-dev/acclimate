import { spawnSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedHarness, runCodexTask } from './harnesses.mjs';
import { freezeSourceInventory, gradeRepositoryTests, runRepositoryJob, sha256, validateInventory, LIMITS } from './repository-job.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const config = JSON.parse(await readFile(new URL('native.json', import.meta.url), 'utf8').catch(error => {
  if (error.code === 'ENOENT')
    throw Object.assign(new Error('Create native.json beside application.mjs.'), { code: 'ACCLIMATE_NATIVE_CONFIG_MISSING' });
  throw error;
}));
const sourceRoot = await realpath(path.resolve(directory, config.sourceRoot));
const source = await freezeSourceInventory({
  sourceRoot, paths: config.sourceFiles, revision: config.sourceRevision ?? 'repository-source-policy-v1',
});
const resultFiles = validateInventory(config.resultFiles, LIMITS.resultFiles);
const testFiles = validateInventory(config.testFiles, LIMITS.sourceFiles);
const protectedPaths = new Set(source.files.map(file => file.path).filter(name => !resultFiles.includes(name)));
if (testFiles.some(name => !protectedPaths.has(name)))
  throw Object.assign(new Error('Each testFiles entry must be a protected sourceFiles entry outside resultFiles.'), {
    code: 'ACCLIMATE_NATIVE_TEST_NOT_PROTECTED',
  });
if (typeof config.model !== 'string' || !config.model.trim()) throw new Error('Set model in native.json.');

const installed = await installedHarness('codex');
const stateRoot = path.resolve(directory, config.stateRoot);
const workspaceParent = path.join(stateRoot, 'workspaces');
const artifactRoot = path.join(stateRoot, 'artifacts');
const turnTimeoutMs = config.turnTimeoutMs ?? 110_000;
const testTimeoutMs = config.testTimeoutMs ?? 30_000;
for (const limit of [turnTimeoutMs, testTimeoutMs]) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_147_483_647)
    throw new Error('Set timeouts to positive milliseconds within the Node timer range.');
}
const selectedMemoryPaths = config.approvedMemoryPaths ?? [];
const env = Object.fromEntries(
  ['PATH', 'HOME', 'CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY']
    .filter(name => process.env[name] !== undefined)
    .map(name => [name, process.env[name]]),
);
const policy = { env, model: config.model };
const testSettings = { testFiles, resultFiles, testTimeoutMs, node: process.version, platform: process.platform, arch: process.arch };

// The installed CLI fingerprints this module and the listed helper/lockfile bytes.
export const revisionFiles = ['harnesses.mjs', 'repository-job.mjs', 'package-lock.json'];
export const configId = 'native-repository';
export const cases = config.cases;
export const runtime = {
  settings: {
    harness: installed.name, model: policy.model, turnTimeoutMs, selectedMemoryPaths,
    environmentNames: Object.keys(env), deploymentRevision: config.deploymentRevision ?? null,
    ...testSettings,
  },
  artifacts: { frozenSource: 'sha256:' + source.sha256 },
};
// Bind the actual grader implementation, complete frozen inputs and test command on every CLI load.
const graderCode = await Promise.all(['application.mjs', 'repository-job.mjs'].map(async name =>
  sha256(await readFile(path.join(directory, name)))));
export const grader = {
  artifactDigest: 'sha256:' + sha256(JSON.stringify([graderCode, source.sha256, testSettings])),
};

export async function execute({ bundle, context, caseId, repetition, input, signal }) {
  if (typeof input?.prompt !== 'string' || !input.prompt.trim()) throw new Error('A native case needs input.prompt.');
  return runRepositoryJob({
    bundle, context, caseId, repetition, signal, source, resultFiles, selectedMemoryPaths,
    harness: installed.name, prepare: installed.prepare, workspaceParent, artifactRoot,
    runHarness: task => runCodexTask({
      ...task, prompt: input.prompt, policy,
      signal: AbortSignal.any([signal, AbortSignal.timeout(turnTimeoutMs)]),
    }),
  });
}

export async function grade({ output, signal }) {
  return gradeRepositoryTests({
    source, artifactRoot, resultFiles, repository: output.repository,
    runTests: ({ cwd }) => {
      signal.throwIfAborted();
      const run = spawnSync(process.execPath, ['--test', '--', ...testFiles], {
        cwd, timeout: testTimeoutMs, env: {}, stdio: 'ignore',
      });
      if (run.error || run.signal || ![0, 1].includes(run.status)) throw new Error('grader.test_runner_unavailable');
      return run.status === 0;
    },
  });
}
