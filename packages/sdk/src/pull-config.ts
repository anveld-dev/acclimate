import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

/** A failure the `acclimate` command reports with a stable `code`. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: { field?: string; hint?: string; httpStatus?: number; requestId?: string } = {},
  ) {
    super(message);
    this.name = 'CliError';
  }
}
const permissions = () =>
  new CliError('config.permissions', 'Keep the pull config and token file private to their owner.', {
    field: '--config',
  });
const schema = () => new CliError('config.schema', 'The pull config is not valid.', { field: '--config' });

async function readPrivateText(filename: string, limit: number) {
  const file = path.resolve(filename);
  const parent = await lstat(path.dirname(file));
  if (file !== (await realpath(file)) || parent.mode & 0o077 || parent.uid !== process.getuid?.())
    throw permissions();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== parent.uid || stat.size > limit)
      throw permissions();
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function readPullConfig(filename: string) {
  const text = await readPrivateText(filename, 65536).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      throw new CliError('config.unreadable', `Cannot read ${filename}.`, { field: '--config' });
    throw error;
  });
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw schema();
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw schema();
  if (
    'tokenFile' in config &&
    ('token' in config ||
      typeof config.tokenFile !== 'string' ||
      !path.isAbsolute(config.tokenFile))
  )
    throw schema();
  const token = config.tokenFile
    ? (await readPrivateText(config.tokenFile, 8192)).replace(/\r?\n$/, '')
    : (config.token ?? process.env.ACCLIMATE_TOKEN);
  if (
    config.schemaVersion !== 1 ||
    ![config.workspaceId, config.serviceUrl, config.scope, config.cacheDir, token].every(
      (value) => typeof value === 'string' && value.trim(),
    ) ||
    !path.isAbsolute(config.cacheDir)
  )
    throw schema();
  const url = new URL(config.serviceUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw new CliError('config.url', 'serviceUrl must be an HTTPS origin, or HTTP on localhost.', {
      field: '--config',
    });
  return {
    serviceUrl: String(config.serviceUrl),
    workspaceId: String(config.workspaceId),
    scope: String(config.scope),
    cacheDir: String(config.cacheDir),
    token: String(token),
  };
}
