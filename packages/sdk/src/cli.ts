import { constants } from 'node:fs';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolveAndCache } from './cache.js';
import { AcclimateClient, ApiError } from './client.js';
import { AcclimateError, AcclimateUsageError } from './errors.js';
import { defaultCacheDir } from './prepare.js';
import { CliError, readPullConfig } from './pull-config.js';
import { releasePayload, releaseVersion, rollbackChannel, type ReleaseResult } from './release.js';
import type { BundleFile, BundlePayload } from './types.js';
import { fileKindForPath, validatePayload } from './validation.js';


const commands = {
  pull: 'pull --bundle <name or id> --out <file> [--channel <name>] [--config <file>]',
  publish: 'publish <payload.json or folder> --bundle <name> [--create] [--channel <name>] [--reason <text>]',
  release: 'release <version-id> --bundle <name> [--channel <name>] [--reason <text>]',
  rollback: 'rollback --bundle <name> [--channel <name>] [--reason <text>]',
} as const;
type Command = keyof typeof commands;

export const cliHelp = `Usage: acclimate <command> [flags]

Commands:
  ${commands.pull}
      Save the channel's released payload to a new file.
  ${commands.publish}
      Upload a payload file or folder as a new version and release it.
  ${commands.release}
      Point the channel at an existing version.
  ${commands.rollback}
      Point the channel back at the version it served before its latest release.

Every command reads ACCLIMATE_URL, ACCLIMATE_WORKSPACE and ACCLIMATE_TOKEN.
--url and --workspace override the first two. --channel defaults to stable.
Each command prints one JSON line on stdout and a sentence on stderr.
`;

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

interface Target {
  client: AcclimateClient;
  workspaceId: string;
  cacheDir?: string;
}

function usage(command: Command | undefined, code: string, message: string, field?: string): CliError {
  return new CliError(code, message, {
    ...(field ? { field } : {}),
    hint: command ? 'Usage: acclimate ' + commands[command] : 'Run acclimate --help.',
  });
}

function target(flags: Flags): Target {
  const baseUrl = flags.url || process.env.ACCLIMATE_URL;
  const workspaceId = flags.workspace || process.env.ACCLIMATE_WORKSPACE;
  const token = process.env.ACCLIMATE_TOKEN;
  if (!baseUrl || !workspaceId || !token)
    throw new CliError('config.missing', 'Set ACCLIMATE_URL, ACCLIMATE_WORKSPACE and ACCLIMATE_TOKEN.', {
      hint: '--url and --workspace can replace the first two. The token is read only from ACCLIMATE_TOKEN.',
    });
  return { client: new AcclimateClient({ baseUrl, token, scope: workspaceId }), workspaceId };
}

/** Find a bundle by name, or take a UUID as its ID. */
async function bundleId({ client, workspaceId }: Target, value: string, create = false) {
  if (uuid.test(value)) return value;
  const matches: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listBundles(workspaceId, { cursor, limit: 100 });
    for (const bundle of page.items) if (bundle.name === value) matches.push(bundle.id);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  if (matches.length > 1)
    throw new CliError('bundle.ambiguous', `More than one bundle is named ${JSON.stringify(value)}.`, {
      field: '--bundle',
      hint: 'Pass the bundle ID instead.',
    });
  if (!matches.length && !create)
    throw new CliError('bundle.missing', `No bundle is named ${JSON.stringify(value)} in this workspace.`, {
      field: '--bundle',
      hint: 'Check the name and ACCLIMATE_WORKSPACE, or pass --create to publish a new bundle.',
    });
  return matches[0];
}

/** Read a payload file, or a folder whose `skills/` files are skills and `memory/` files memory. */
export async function readPayloadSource(source: string): Promise<BundlePayload> {
  const info = await lstat(source).catch(() => {
    throw new CliError('payload.unreadable', `Cannot read ${source}.`, { field: 'source' });
  });
  let payload: unknown;
  if (info.isDirectory()) {
    const files: BundleFile[] = [];
    const walk = async (directory: string, prefix: string): Promise<void> => {
      const entries = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => !entry.name.startsWith('.'))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        const relative = prefix + entry.name;
        if (entry.isDirectory()) await walk(file, relative + '/');
        else if (!entry.isFile())
          throw new CliError('payload.invalid', `${relative} is not a regular file.`, { field: 'source' });
        else {
          if ((await lstat(file)).size > 256 * 1024)
            throw new CliError('payload.invalid', `${relative} is larger than 256 KiB.`, { field: 'source' });
          let text: string;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file));
          } catch {
            throw new CliError('payload.invalid', `${relative} is not UTF-8 text.`, { field: 'source' });
          }
          files.push({ path: relative, kind: fileKindForPath(relative), text });
        }
      }
    };
    await walk(source, '');
    payload = { schemaVersion: 1, files };
  } else {
    try {
      payload = JSON.parse(await readFile(source, 'utf8'));
    } catch {
      throw new CliError('payload.invalid', `${source} is not a JSON payload file.`, { field: 'source' });
    }
  }
  try {
    validatePayload(payload);
  } catch (error) {
    throw new CliError('payload.invalid', `${source} is not a valid bundle payload: ${(error as Error).message}.`, {
      field: 'source',
    });
  }
  return payload;
}

/** Save a channel's released payload as a new private JSON file. */
export async function pullPayload(
  { client, workspaceId, cacheDir }: Target,
  options: { bundle: string; channel: string; out: string },
) {
  const id = await bundleId({ client, workspaceId }, options.bundle);
  const missing = (httpStatus?: number) =>
    new CliError('bundle.missing', `No version of this bundle is released on ${JSON.stringify(options.channel)}.`, {
      field: '--bundle',
      hint: 'Check the bundle, the --channel and the workspace.',
      ...(httpStatus ? { httpStatus } : {}),
    });
  let resolved, source;
  try {
    source = await client.inspectSource(workspaceId, id, options.channel);
    if (!source) throw missing();
    resolved = await resolveAndCache(
      client,
      { workspaceId, bundleId: id, versionId: source.version.id },
      { cacheDir: cacheDir ?? (await defaultCacheDir()) },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw missing(404);
    throw error;
  }
  const out = path.resolve(options.out);
  const handle = await open(
    out,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST')
      throw new CliError('usage.invalid_flag', `${options.out} already exists. Choose a new --out file.`, {
        field: '--out',
      });
    throw error;
  });
  try {
    await handle.writeFile(JSON.stringify(resolved.payload, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const files = resolved.payload.files.length;
  return {
    result: {
      schemaVersion: 1 as const,
      bundleId: id,
      channel: options.channel,
      versionId: resolved.version.id,
      digest: resolved.version.digest,
      revision: source.revision,
      files,
      out,
    },
    sentence: `Saved ${options.channel} (version ${resolved.version.id}, ${files} ${files === 1 ? 'file' : 'files'}) to ${out}.`,
  };
}

function released(result: ReleaseResult, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    bundleId: result.bundleId,
    channel: result.channel,
    revision: result.revision,
    versionId: result.version.id,
    digest: result.version.digest,
    changed: result.changed,
    ...extra,
  };
}

type Flags = Partial<Record<'url' | 'workspace' | 'config' | 'bundle' | 'channel' | 'out' | 'reason', string>> & {
  create?: boolean;
  help?: boolean;
};

async function run(command: Command, flags: Flags, positionals: string[]) {
  const channel = flags.channel || 'stable';
  const need = (...names: (keyof Flags)[]) => {
    for (const name of names)
      if (!flags[name]) throw usage(command, 'usage.missing_flag', `--${name} is required.`, '--' + name);
  };
  const operands = command === 'publish' || command === 'release' ? 1 : 0;
  if (positionals.length !== operands)
    throw usage(
      command,
      'usage.invalid_argument',
      operands
        ? `Pass one ${command === 'publish' ? 'payload file or folder' : 'version ID'}.`
        : `${command} takes no arguments.`,
    );
  if (command === 'pull') {
    need('bundle', 'out');
    const config = flags.config ? await readPullConfig(flags.config) : undefined;
    const where = config
      ? {
          client: new AcclimateClient({ baseUrl: config.serviceUrl, scope: config.scope, token: config.token }),
          workspaceId: config.workspaceId,
          cacheDir: config.cacheDir,
        }
      : target(flags);
    return pullPayload(where, { bundle: flags.bundle!, channel, out: flags.out! });
  }
  need('bundle');
  const where = target(flags);
  if (command === 'publish') {
    const source = positionals[0];
    const payload = await readPayloadSource(source);
    const reason = flags.reason || `Published ${path.basename(path.resolve(source))}`;
    const id = await bundleId(where, flags.bundle!, flags.create);
    if (!id) {
      const setup = await where.client.createBundleSetup(
        where.workspaceId,
        { name: flags.bundle!, origin: 'imported', channel, payload, reason },
        randomUUID(),
      );
      return {
        result: released(
          {
            bundleId: setup.bundle.id,
            channel,
            revision: setup.resolution.revision,
            version: setup.version,
            changed: true,
          },
          { created: true },
        ),
        sentence: `Created bundle ${JSON.stringify(flags.bundle)} and released version ${setup.version.id} on ${channel}.`,
      };
    }
    const result = await releasePayload(where.client, where.workspaceId, id, payload, { channel, reason });
    return {
      result: released(result, { created: false }),
      sentence: result.changed
        ? `Released version ${result.version.id} on ${channel} (revision ${result.revision}).`
        : `No change: ${channel} already serves this payload as version ${result.version.id}.`,
    };
  }
  const id = (await bundleId(where, flags.bundle!))!;
  if (command === 'release') {
    const result = await releaseVersion(where.client, where.workspaceId, id, positionals[0], {
      channel,
      reason: flags.reason || 'Released with the acclimate command',
    });
    return {
      result: released(result),
      sentence: result.changed
        ? `Released version ${result.version.id} on ${channel} (revision ${result.revision}).`
        : `No change: ${channel} already serves version ${result.version.id}.`,
    };
  }
  const result = await rollbackChannel(where.client, where.workspaceId, id, {
    channel,
    reason: flags.reason || 'Rolled back with the acclimate command',
  }).catch((error: unknown) => {
    if (error instanceof AcclimateUsageError && error.field === 'channel')
      throw new CliError('release.none', `${channel} has no earlier version to roll back to.`, { field: '--channel' });
    throw error;
  });
  return {
    result: released(result),
    sentence: `Rolled ${channel} back to version ${result.version.id} (revision ${result.revision}).`,
  };
}

function failure(error: unknown) {
  if (error instanceof CliError) return { code: error.code, message: error.message, ...error.detail };
  if (error instanceof ApiError)
    return {
      code: error.code,
      message: error.message,
      httpStatus: error.status,
      ...(error.requestId ? { requestId: error.requestId } : {}),
    };
  if (error instanceof AcclimateError) return { code: error.code, message: error.message };
  if ((error as NodeJS.ErrnoException)?.code?.startsWith?.('ERR_PARSE_ARGS'))
    return { code: 'usage.invalid_flag', message: (error as Error).message, hint: 'Run acclimate --help.' };
  return { code: 'cli.failed', message: 'The command failed. Check the command, the settings and the service.' };
}

/** Run one `acclimate` command and return its exit status: 0, 1 for a failure, 2 for a usage error. */
export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    process.stdout.write(cliHelp);
    return name ? 0 : 2;
  }
  try {
    if (!Object.hasOwn(commands, name)) throw usage(undefined, 'usage.unknown_command', `Unknown command ${JSON.stringify(name)}.`);
    const command = name as Command;
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        url: { type: 'string' },
        workspace: { type: 'string' },
        config: { type: 'string' },
        bundle: { type: 'string' },
        channel: { type: 'string' },
        out: { type: 'string' },
        reason: { type: 'string' },
        create: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      process.stdout.write(`Usage: acclimate ${commands[command]}\n`);
      return 0;
    }
    const { result, sentence } = await run(command, values as Flags, positionals);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.stderr.write(sentence + '\n');
    return 0;
  } catch (error) {
    const detail = failure(error);
    process.stdout.write(JSON.stringify({ error: detail }) + '\n');
    process.stderr.write(`acclimate: ${detail.message}${'hint' in detail && detail.hint ? ` ${detail.hint}` : ''}\n`);
    return detail.code.startsWith('usage.') ? 2 : 1;
  }
}
