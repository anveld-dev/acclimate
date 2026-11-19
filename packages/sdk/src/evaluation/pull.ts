import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { resolveAndCache } from '../cache.js';
import { ApiError } from '../client.js';
import { createEvaluationTransport } from '../internal/evaluation-transport.js';
import { readEvaluatorConfig } from './config.js';
import { EvaluationError, EvaluationUsageError } from './errors.js';

export const pullHelp =
  'pull --config CONFIG --bundle ID [--channel CHANNEL] --out FILE  Save the published bundle as a payload to edit.';

/**
 * Save a channel's published payload as the JSON file `compare --payload` reads.
 * The file is new and private to this user. Edit it, then compare it with its parent.
 */
export async function pullPayload(options: {
  configPath: string;
  bundleId: string;
  channel: string;
  out: string;
}) {
  const config = await readEvaluatorConfig(options.configPath);
  const { client } = createEvaluationTransport(config);
  let resolved;
  try {
    resolved = await resolveAndCache(
      client,
      { projectId: config.projectId, bundleId: options.bundleId, channel: options.channel },
      { cacheDir: path.join(config.journalRoot, 'command-cache') },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404)
      throw new EvaluationError('bundle.missing', {
        field: '--bundle',
        reason: `No published version of this bundle on channel ${JSON.stringify(options.channel)}.`,
        hint: 'Check the bundle ID, the --channel and the evaluator config workspace.',
        httpStatus: error.status,
      });
    throw error;
  }
  const out = path.resolve(options.out);
  const handle = await open(
    out,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST')
      throw new EvaluationUsageError('usage.invalid_flag', {
        field: '--out',
        reason: `${options.out} already exists. Choose a new --out file.`,
      });
    throw error;
  });
  try {
    await handle.writeFile(JSON.stringify(resolved.payload, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    schemaVersion: 1 as const,
    bundleId: options.bundleId,
    channel: options.channel,
    versionId: resolved.version.id,
    digest: resolved.version.digest,
    revision: resolved.resolution?.revision ?? null,
    files: resolved.payload.files.length,
    out,
  };
}

/**
 * The `pull` command body. The shared evaluator parser has already checked the flags;
 * errors go through the shared reporter and exit codes.
 */
export async function pullCommand(flags: Record<string, string | boolean>) {
  const text = (name: string) => (typeof flags[name] === 'string' ? (flags[name] as string) : '');
  for (const name of ['config', 'bundle', 'out'])
    if (!text(name))
      throw new EvaluationUsageError('usage.missing_flag', { field: '--' + name, hint: pullHelp });
  const channel = text('channel') || 'stable';
  const result = await pullPayload({
    configPath: text('config'),
    bundleId: text('bundle'),
    channel,
    out: text('out'),
  });
  if (process.stderr.isTTY)
    process.stderr.write(
      `Saved ${channel} (version ${result.versionId}, ${result.files} ${result.files === 1 ? 'file' : 'files'}) to ${result.out}.\n` +
        `Edit it, then run: acclimate-eval compare --config CONFIG --bundle ${result.bundleId} --channel ${channel} --payload ${result.out} --name NAME\n`,
    );
  return { status: 0, result };
}
