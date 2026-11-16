import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { LocalSetupError } from './local-diagnostics.js';

function safe(info: Stats, directory: boolean): boolean {
  return (
    !info.isSymbolicLink() &&
    (directory ? info.isDirectory() : info.isFile()) &&
    !(info.mode & 0o077) &&
    (process.getuid === undefined || info.uid === process.getuid())
  );
}

export async function privateDirectory(path: string): Promise<void> {
  try {
    let ancestor = resolve(path);
    while (
      !(await lstat(ancestor).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }))
    )
      ancestor = dirname(ancestor);
    if ((await realpath(ancestor)) !== ancestor) throw new Error();
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (!safe(await lstat(path), true) || (await realpath(path)) !== resolve(path))
      throw new Error();
  } catch {
    throw new LocalSetupError('private_path_unsafe');
  }
}

async function checkFile(path: string, absent = false): Promise<void> {
  try {
    if (!safe(await lstat(path), false)) throw new Error();
  } catch (error) {
    if (absent && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new LocalSetupError('private_path_unsafe');
  }
}

/** Same-directory atomic replacement; partial config is never observable. */
export async function atomicPrivateWrite(
  path: string,
  text: string,
  { privateParent = true }: { privateParent?: boolean } = {},
): Promise<void> {
  if (privateParent) await privateDirectory(dirname(path));
  else {
    const parent = await lstat(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (await realpath(dirname(path))) !== resolve(dirname(path)) ||
      parent.mode & 0o022 ||
      (process.getuid !== undefined && parent.uid !== process.getuid())
    )
      throw new LocalSetupError('private_path_unsafe');
  }
  await checkFile(path, true);
  const temporary = resolve(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await checkFile(path, true);
    await rename(temporary, path);
    const parent = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function readPrivateText(path: string): Promise<string> {
  if ((await realpath(dirname(path))) !== resolve(dirname(path)))
    throw new LocalSetupError('private_path_unsafe');
  await checkFile(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new LocalSetupError('private_path_unsafe');
  });
  try {
    const info = await handle.stat();
    if (!safe(info, false) || !(info.mode & 0o400) || info.size > 64 * 1024)
      throw new LocalSetupError('private_path_unsafe');
    // Bound the read itself as well as the initial stat (the file can grow).
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 64 * 1024) throw new LocalSetupError('config_conflict');
    return buffer.subarray(0, length).toString('utf8');
  } catch (error) {
    if (error instanceof LocalSetupError) throw error;
    throw new LocalSetupError('config_conflict');
  } finally {
    await handle.close();
  }
}

export async function readPrivateJson(path: string): Promise<Record<string, unknown>> {
  const text = await readPrivateText(path);
  try {
    const result: unknown = JSON.parse(text);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch {
    throw new LocalSetupError('config_conflict');
  }
}

