import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ambientConfigDigest, CREDENTIAL_ENV, HARNESS_POLICIES, isolatedEnvironment, loadHarness } from './harnesses.mjs';
import { runInProcessGroup } from './harness-process.mjs';
import {
  discoverSourceFiles, freezeSourceInventory, gradeRepositoryTests, matchesAny, nodeTestRunner,
  runRepositoryJob, sha256, validateInventory, LIMITS,
} from './repository-job.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const configError = (code, message) => Object.assign(new Error(message), { code });
// ACCLIMATE_NATIVE_CONFIG selects another private config; relative paths inside it still resolve from this directory.
const configFile = process.env.ACCLIMATE_NATIVE_CONFIG
  ? path.resolve(directory, process.env.ACCLIMATE_NATIVE_CONFIG)
  : path.join(directory, 'native.json');
const config = JSON.parse(await readFile(configFile, 'utf8').catch(error => {
  if (error.code === 'ENOENT')
    throw configError('ACCLIMATE_NATIVE_CONFIG_MISSING', 'Create native.json beside application.mjs (try native.replay.json for an offline run).');
  throw error;
}));
async function canonical(field) {
  const value = config[field];
  if (typeof value !== 'string' || !value) throw configError('ACCLIMATE_NATIVE_CONFIG', `Set ${field} in native.json.`);
  // realpath resolves /tmp and /var aliases on macOS before the strict directory checks.
  return realpath(path.resolve(directory, value)).catch(() => {
    throw configError('ACCLIMATE_NATIVE_CONFIG', `${field} ${JSON.stringify(value)} does not exist. Create it with mkdir -p -m 700.`);
  });
}
const sourceRoot = await canonical('sourceRoot');
const stateRoot = await canonical('stateRoot');
const allowDotPaths = config.allowDotPaths ?? [];
const inventory = Array.isArray(config.sourceFiles)
  ? { files: config.sourceFiles, skipped: [] }
  : await discoverSourceFiles({ sourceRoot, ...(config.sourceInventory ?? {}), allowDotPaths });
const source = await freezeSourceInventory({
  sourceRoot, paths: inventory.files, revision: config.sourceRevision ?? 'repository-source-policy-v1', allowDotPaths,
});
const resultFiles = validateInventory(config.resultFiles, LIMITS.resultFiles, { patterns: true });
const testFiles = validateInventory(config.testFiles, LIMITS.sourceFiles, { allowDotPaths });
const sourcePaths = new Set(source.files.map(file => file.path));
if (testFiles.some(name => !sourcePaths.has(name) || matchesAny(resultFiles, name)))
  throw configError('ACCLIMATE_NATIVE_TEST_NOT_PROTECTED', 'Each testFiles entry must be a protected sourceFiles entry outside resultFiles.');

// One or more harnesses. With several, every case runs once per harness and the
// harness becomes part of the case key: `<caseId>@<harness>`.
const harnessSpecs = config.harnesses ?? [config.harness ?? 'codex'];
if (!Array.isArray(harnessSpecs) || !harnessSpecs.length) throw configError('ACCLIMATE_NATIVE_CONFIG', 'Set harness or harnesses in native.json.');
const harnesses = new Map();
for (const spec of harnessSpecs) {
  const loaded = await loadHarness(spec, directory);
  if (harnesses.has(loaded.name)) throw configError('ACCLIMATE_NATIVE_CONFIG', `Harness ${loaded.name} is listed twice.`);
  const model = config.models?.[loaded.name] ?? config.model;
  if (loaded.kind !== 'replay' && (typeof model !== 'string' || !model.trim()))
    throw configError('ACCLIMATE_NATIVE_CONFIG', `Set model (or models.${loaded.name}) in native.json.`);
  harnesses.set(loaded.name, { ...loaded, model: loaded.kind === 'replay' ? null : model });
}
const multi = harnesses.size > 1;
const replay = config.replay === undefined ? null : await realpath(path.resolve(directory, config.replay));

const turnTimeoutMs = config.turnTimeoutMs ?? 110_000;
const testTimeoutMs = config.testTimeoutMs ?? 30_000;
for (const limit of [turnTimeoutMs, testTimeoutMs]) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_147_483_647)
    throw configError('ACCLIMATE_NATIVE_CONFIG', 'Set turnTimeoutMs and testTimeoutMs to positive milliseconds within the Node timer range.');
}
const reward = config.reward ?? 'binary';
if (!['binary', 'fraction'].includes(reward)) throw configError('ACCLIMATE_NATIVE_CONFIG', 'Set reward to "binary" or "fraction".');
const selectedMemoryPaths = config.approvedMemoryPaths ?? [];
const passEnv = config.environmentNames ?? [];
const inheritHome = config.inheritHome === true;
const secrets = [...new Set(Object.values(CREDENTIAL_ENV).flat())].map(name => process.env[name]).filter(Boolean);
const testSettings = { testFiles, resultFiles, testTimeoutMs, reward, node: process.version, platform: process.platform, arch: process.arch };

const harnessIdentity = {};
for (const [name, harness] of harnesses)
  harnessIdentity[name] = {
    ...harness.identity,
    model: harness.model,
    ambientConfig: await ambientConfigDigest(harness.kind === 'custom' ? name : harness.kind, { inheritHome }),
  };

// The installed CLI fingerprints this module, its imports and these runtime-read files.
export const revisionFiles = [
  'harnesses.mjs', 'harness-process.mjs', 'harness-child.mjs', 'repository-job.mjs', 'package-lock.json',
  ...[...harnesses.values()].flatMap(harness => harness.moduleFile ? [harness.moduleFile] : []),
];
export const configId = 'native-repository';
export const cases = multi
  ? config.cases.flatMap(item => [...harnesses.keys()].map(name => ({
      ...item, caseId: `${item.caseId}@${name}`, input: { ...item.input, harness: name },
    })))
  : config.cases;
export const runtime = {
  settings: {
    harness: [...harnesses.keys()].join(','),
    model: multi ? null : [...harnesses.values()][0].model,
    harnesses: harnessIdentity,
    isolation: inheritHome ? 'inherit-home' : 'isolated-home-v1',
    turnTimeoutMs, selectedMemoryPaths,
    environmentNames: [...new Set([...Object.values(CREDENTIAL_ENV).flat(), ...passEnv])].filter(name => process.env[name] !== undefined).sort(),
    deploymentRevision: config.deploymentRevision ?? null,
    sourceInventory: Array.isArray(config.sourceFiles) ? 'explicit' : 'git-ls-files',
    allowDotPaths,
    ...testSettings,
  },
  artifacts: {
    frozenSource: 'sha256:' + source.sha256,
    ...(replay ? { replay: 'sha256:' + sha256(await readFile(replay)) } : {}),
  },
};
// Bind the actual grader implementation, complete frozen inputs and test command on every CLI load.
const graderCode = await Promise.all(['application.mjs', 'repository-job.mjs'].map(async name =>
  sha256(await readFile(path.join(directory, name)))));
export const grader = {
  artifactDigest: 'sha256:' + sha256(JSON.stringify([graderCode, source.sha256, testSettings])),
};

function harnessForCase(caseId, input) {
  if (!multi) return [caseId, [...harnesses.values()][0]];
  const name = input?.harness;
  const suffix = `@${name}`;
  if (!harnesses.has(name) || !caseId.endsWith(suffix)) throw new Error(`native.case_harness: ${JSON.stringify(caseId)}`);
  return [caseId.slice(0, -suffix.length), harnesses.get(name)];
}

export async function execute({ bundle, context, caseId, repetition, input, signal }) {
  if (typeof input?.prompt !== 'string' || !input.prompt.trim()) throw new Error('A native case needs input.prompt.');
  const [baseCaseId, harness] = harnessForCase(caseId, input);
  const kind = harness.kind === 'custom' ? harness.name : harness.kind;
  return runRepositoryJob({
    bundle, context, caseId, repetition, signal, source, resultFiles, selectedMemoryPaths, secrets,
    harness: harness.name, prepare: harness.prepare,
    workspaceParent: path.join(stateRoot, 'workspaces'), artifactRoot: path.join(stateRoot, 'artifacts'),
    runHarness: async task => {
      const isolation = await isolatedEnvironment({ harness: kind, cwd: task.context.cwd, passEnv, inheritHome });
      return runInProcessGroup({
        module: harness.run.module,
        exportName: harness.run.exportName,
        cwd: task.context.cwd,
        env: isolation.env,
        timeoutMs: turnTimeoutMs,
        signal: task.signal,
        acknowledge: task.acknowledge,
        task: {
          context: task.context, binding: task.binding, caseId: baseCaseId, prompt: input.prompt,
          policy: {
            env: isolation.env, model: harness.model, ...(HARNESS_POLICIES[kind] ? { defaults: HARNESS_POLICIES[kind] } : {}),
            ...(replay ? { replay } : {}),
            ...(kind === 'pi' && isolation.authFiles.length ? { authPath: path.join(isolation.home, '.pi', 'agent', 'auth.json') } : {}),
          },
        },
      });
    },
  });
}

export async function grade({ output, signal }) {
  return gradeRepositoryTests({
    source, artifactRoot: path.join(stateRoot, 'artifacts'), resultFiles, repository: output.repository, signal, reward,
    runTests: nodeTestRunner({ testFiles, timeoutMs: testTimeoutMs }),
  });
}
