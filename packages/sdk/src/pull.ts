import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { resolveAndCache } from './cache.js';
import { ApiError } from './client.js';
import { parseArgs } from 'node:util';
import { AcclimateClient } from './client.js';
import { readPullConfig } from './pull-config.js';

class PullError extends Error {
  constructor(
    readonly code: string,
    readonly diagnostic: { field?: string; reason?: string; hint?: string; httpStatus?: number },
  ) {
    super(diagnostic.reason ?? diagnostic.hint ?? code);
  }
}
export const pullHelp =
  'pull --config CONFIG --bundle ID [--channel CHANNEL] --out FILE  Save the published bundle as a payload to edit.';

/**
 * Save a channel's published payload as a JSON file for local editing.
 * The file is new and private to this user.
 */
export async function pullPayload(options: {
  configPath: string;
  bundleId: string;
  channel: string;
  out: string;
}) {
  const config = await readPullConfig(options.configPath);
  const client = new AcclimateClient({
    baseUrl: config.serviceUrl,
    scope: config.scope,
    token: config.token,
  });
  let resolved, source;
  try {
    source = await client.inspectSource(config.workspaceId, options.bundleId, options.channel);
    if (!source)
      throw new PullError('bundle.missing', {
        field: '--bundle',
        reason: 'This channel has no release.',
      });
    resolved = await resolveAndCache(
      client,
      { workspaceId: config.workspaceId, bundleId: options.bundleId, versionId: source.version.id },
      { cacheDir: config.cacheDir },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404)
      throw new PullError('bundle.missing', {
        field: '--bundle',
        reason: `No published version of this bundle on channel ${JSON.stringify(options.channel)}.`,
        hint: 'Check the bundle ID, the --channel and the pull config workspace.',
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
      throw new PullError('usage.invalid_flag', {
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
    revision: source.revision,
    files: resolved.payload.files.length,
    out,
  };
}

export async function pullCommand(flags: Record<string, string | boolean>) {
  const text = (name: string) => (typeof flags[name] === 'string' ? (flags[name] as string) : '');
  for (const name of ['config', 'bundle', 'out'])
    if (!text(name))
      throw new PullError('usage.missing_flag', { field: '--' + name, hint: pullHelp });
  const channel = text('channel') || 'stable';
  const result = await pullPayload({
    configPath: text('config'),
    bundleId: text('bundle'),
    channel,
    out: text('out'),
  });
  if (process.stderr.isTTY)
    process.stderr.write(
      `Saved ${channel} (version ${result.versionId}, ${result.files} ${result.files === 1 ? 'file' : 'files'}) to ${result.out}.\n`,
    );
  return { status: 0, result };
}

export async function pullMain(argv: string[]) {
  if (argv.includes('--help')) {
    console.log(pullHelp);
    return 0;
  }
  try {
    if (argv[0] !== 'pull') throw new PullError('usage.unknown_command', { hint: pullHelp });
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        config: { type: 'string' },
        bundle: { type: 'string' },
        channel: { type: 'string' },
        out: { type: 'string' },
      },
    });
    const { result } = await pullCommand(values as Record<string, string>);
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error(
      JSON.stringify({
        error:
          error instanceof PullError
            ? { code: error.code, ...error.diagnostic }
            : { code: 'pull.failed', reason: 'Check the command, configuration and service.' },
      }),
    );
    return 1;
  }
}
