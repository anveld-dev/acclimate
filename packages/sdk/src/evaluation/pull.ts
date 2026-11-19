import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { resolveAndCache } from '../cache.js';
import { ApiError } from '../client.js';
import { createEvaluationTransport } from '../internal/evaluation-transport.js';
import { readEvaluatorConfig } from './config.js';
import { EvaluationError } from './errors.js';

export const pullHelp =
  'pull --config CONFIG --bundle ID [--channel CHANNEL] --out FILE  Save the published bundle as a payload to edit.';

class PullUsageError extends Error {}

function parse(argv: readonly string[]) {
  const flags: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]?.startsWith('--') ? argv[index].slice(2) : '';
    const value = argv[index + 1];
    if (!['config', 'bundle', 'channel', 'out'].includes(name) || Object.hasOwn(flags, name))
      throw new PullUsageError(`Usage: acclimate-eval ${pullHelp}`);
    if (!value || value.startsWith('--')) throw new PullUsageError(`Supply a value for --${name}.`);
    flags[name] = value;
  }
  for (const name of ['config', 'bundle', 'out'])
    if (!flags[name])
      throw new PullUsageError(`Missing --${name}. Usage: acclimate-eval ${pullHelp}`);
  return {
    config: flags.config,
    bundle: flags.bundle,
    channel: flags.channel ?? 'stable',
    out: flags.out,
  };
}

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
  const resolved = await resolveAndCache(
    client,
    { projectId: config.projectId, bundleId: options.bundleId, channel: options.channel },
    { cacheDir: path.join(config.journalRoot, 'command-cache') },
  );
  const out = path.resolve(options.out);
  const handle = await open(
    out,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST')
      throw new PullUsageError(`${options.out} already exists. Choose a new --out file.`);
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

export async function pullMain(argv: readonly string[]): Promise<number> {
  try {
    const flags = parse(argv);
    const result = await pullPayload({
      configPath: flags.config,
      bundleId: flags.bundle,
      channel: flags.channel,
      out: flags.out,
    });
    console.log(JSON.stringify(result));
    if (process.stderr.isTTY)
      console.error(
        `Saved ${flags.channel} (version ${result.versionId}, ${result.files} ${result.files === 1 ? 'file' : 'files'}) to ${flags.out}.\n` +
          `Edit it, then run: acclimate-eval compare --config ${flags.config} --bundle ${flags.bundle} --channel ${flags.channel} --payload ${flags.out} --name NAME --live`,
      );
    return 0;
  } catch (error) {
    const message =
      error instanceof PullUsageError
        ? error.message
        : error instanceof ApiError
          ? `The service refused the request (${error.status} ${error.code}). Check the bundle ID, channel and evaluator config.`
          : error instanceof EvaluationError
            ? `Could not read the evaluator config (${error.code}).`
            : 'Could not save the payload. Check the service URL, CA trust and output path.';
    console.error(message);
    return 1;
  }
}
