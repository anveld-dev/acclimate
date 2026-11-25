// Local operator commands for the native repository starter. Output contains
// private paths and job handles; keep it on this host.
//
//   node native.mjs jobs list
//   node native.mjs jobs inspect JOB_ID
//   node native.mjs jobs cleanup JOB_ID --confirm-stopped
//   node native.mjs check-bundle PAYLOAD.json
//   node native.mjs inventory
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupQuarantinedJob, discoverSourceFiles, inspectNativeJob, listNativeJobs, processGroupAlive } from './repository-job.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const USAGE = 'Usage: node native.mjs jobs list | jobs inspect JOB_ID | jobs cleanup JOB_ID --confirm-stopped | check-bundle PAYLOAD.json | inventory';

class UsageError extends Error {}

async function loadConfig() {
  const file = process.env.ACCLIMATE_NATIVE_CONFIG ? path.resolve(here, process.env.ACCLIMATE_NATIVE_CONFIG) : path.join(here, 'native.json');
  const config = JSON.parse(await readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') throw new UsageError(`native.json not found at ${file}. Create it first (see README.md).`);
    throw error;
  }));
  const resolve = (field) => realpath(path.resolve(here, config[field])).catch(() => {
    throw new UsageError(`${field} ${JSON.stringify(config[field])} does not exist.`);
  });
  return { config, stateRoot: await resolve('stateRoot'), sourceRoot: () => resolve('sourceRoot') };
}

async function findJob(stateRoot, jobId) {
  if (!/^[a-f0-9]{64}$/.test(jobId ?? '')) throw new UsageError('Pass the 64-character JOB_ID shown by `jobs list`.');
  const job = (await listNativeJobs(path.join(stateRoot, 'artifacts'))).find((item) => item.jobId === jobId);
  if (!job) throw new UsageError(`No job ${jobId} under ${path.join(stateRoot, 'artifacts')}.`);
  return job;
}

async function jobs([action, jobId, ...flags]) {
  const { stateRoot } = await loadConfig();
  if (action === 'list') return listNativeJobs(path.join(stateRoot, 'artifacts'));
  if (action === 'inspect') {
    const job = await findJob(stateRoot, jobId);
    const failure = job.failureFile ? JSON.parse(await readFile(job.failureFile, 'utf8')) : null;
    const record = job.privateJobDirectory ? await inspectNativeJob(job.privateJobDirectory).catch(() => null) : null;
    return { ...job, record, failure };
  }
  if (action === 'cleanup') {
    if (!flags.includes('--confirm-stopped'))
      throw new UsageError('cleanup deletes the quarantined workspace. Verify the agent process and any provider job stopped, then pass --confirm-stopped.');
    const job = await findJob(stateRoot, jobId);
    if (!job.privateJobDirectory) throw new UsageError('This job has no locator.json; use cleanupQuarantinedJob from repository-job.mjs.');
    const record = await inspectNativeJob(job.privateJobDirectory);
    const group = record.externalHandles?.find((handle) => handle.kind === 'process-group');
    if (group && processGroupAlive(Number(group.value)))
      throw new UsageError(`Process group ${group.value} is still running. Stop it (kill -KILL -${group.value}) before cleanup.`);
    return cleanupQuarantinedJob({ privateJobDirectory: job.privateJobDirectory, confirmStopped: async () => true });
  }
  throw new UsageError(USAGE);
}

async function checkBundle([file]) {
  if (!file) throw new UsageError('Pass a payload JSON file: { "schemaVersion": 1, "files": [...] } or a version with .payload.');
  const { config } = await loadConfig();
  const { compatibilityIssues, validatePayload } = await import('@acclimate/sdk');
  const parsed = JSON.parse(await readFile(path.resolve(file), 'utf8'));
  const payload = parsed?.payload ?? parsed;
  validatePayload(payload);
  const targets = (config.harnesses ?? [config.harness ?? 'codex'])
    .map((spec) => (typeof spec === 'string' ? spec : null))
    .filter((name) => name && name !== 'replay');
  const issues = [...new Set(targets.length ? targets : ['codex'])].flatMap((target) =>
    compatibilityIssues(payload, target).map((issue) => ({ target, ...issue })));
  if (issues.length) process.exitCode = 1;
  return { compatible: issues.length === 0, issues };
}

async function inventory() {
  const { config, sourceRoot } = await loadConfig();
  if (Array.isArray(config.sourceFiles)) return { mode: 'explicit', files: config.sourceFiles, skipped: [] };
  return { mode: 'git-ls-files', ...(await discoverSourceFiles({ sourceRoot: await sourceRoot(), ...(config.sourceInventory ?? {}), allowDotPaths: config.allowDotPaths ?? [] })) };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const commands = { jobs, 'check-bundle': checkBundle, inventory };
  if (!commands[command]) throw new UsageError(USAGE);
  console.log(JSON.stringify(await commands[command](rest), null, 2));
}

main().catch((error) => {
  // One line with the code, the offending path or rule, and the fix.
  const line = error.code && String(error.message).startsWith(error.code) ? error.message : `${error.code ?? error.name}: ${error.message}`;
  console.error(error instanceof UsageError ? error.message : line);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
