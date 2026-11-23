import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

async function readPrivateText(filename: string, limit: number) {
  const file = path.resolve(filename);
  const parent = await lstat(path.dirname(file));
  if (file !== (await realpath(file)) || parent.mode & 0o077 || parent.uid !== process.getuid?.())
    throw new Error('Use a private configuration directory.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== parent.uid || stat.size > limit)
      throw new Error('Use a private configuration file.');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function readPullConfig(filename: string) {
  const config = JSON.parse(await readPrivateText(filename, 65536));
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Invalid pull configuration.');
  if (
    'tokenFile' in config &&
    ('token' in config ||
      typeof config.tokenFile !== 'string' ||
      !path.isAbsolute(config.tokenFile))
  )
    throw new Error('Invalid token source.');
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
    throw new Error('Invalid pull configuration.');
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
    throw new Error('Invalid service URL.');
  return {
    serviceUrl: String(config.serviceUrl),
    workspaceId: String(config.workspaceId),
    scope: String(config.scope),
    cacheDir: String(config.cacheDir),
    token: String(token),
  };
}
