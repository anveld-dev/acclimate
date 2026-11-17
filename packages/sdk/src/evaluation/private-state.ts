import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { EvaluationError } from './errors.js';

function safe(info: Stats, directory: boolean): boolean {
  return (
    !info.isSymbolicLink() &&
    (directory ? info.isDirectory() : info.isFile()) &&
    !(info.mode & 0o077) &&
    (process.getuid === undefined || info.uid === process.getuid())
  );
}

export async function privateDirectory(path: string): Promise<void> {
  await privateDirectoryWithSync(path, syncDirectory);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error();
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Package-internal OS seam: tests can inspect/fault directory sync ordering. */
export async function privateDirectoryWithSync(
  path: string,
  sync: (directory: string) => Promise<void>,
): Promise<void> {
  try {
    const destination = resolve(path),
      missing: string[] = [];
    let ancestor = destination;
    while (
      !(await lstat(ancestor).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }))
    ) {
      missing.push(ancestor);
      ancestor = dirname(ancestor);
    }
    if ((await realpath(ancestor)) !== ancestor) throw new Error();
    for (const directory of [...missing].reverse()) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      // A cooperating creator may have won mkdir. Validate and flush the same
      // related entry rather than trusting that its fsync has already finished.
      if (!safe(await lstat(directory), true) || (await realpath(directory)) !== directory)
        throw new Error();
    }
    if (!safe(await lstat(destination), true) || (await realpath(destination)) !== destination)
      throw new Error();
    // With all links present, deepest-first syncing covers each new directory's
    // metadata and child entries; the existing immediate ancestor persists the
    // topmost new link. Existing unrelated ancestors are not touched.
    for (const directory of missing) await sync(directory);
    if (missing.length) await sync(ancestor);
  } catch {
    throw new EvaluationError('config.permissions');
  }
}

async function checkFile(path: string, absent = false): Promise<void> {
  try {
    if (!safe(await lstat(path), false)) throw new Error();
  } catch (error) {
    if (absent && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new EvaluationError('config.permissions');
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
      throw new EvaluationError('config.permissions');
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

export async function readPrivateText(path: string, maximum = 64 * 1024): Promise<string> {
  if ((await realpath(dirname(path))) !== resolve(dirname(path)))
    throw new EvaluationError('config.permissions');
  await checkFile(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new EvaluationError('config.permissions');
  });
  try {
    const info = await handle.stat();
    if (!safe(info, false) || !(info.mode & 0o400) || info.size > maximum)
      throw new EvaluationError('config.permissions');
    // Bound the read itself as well as the initial stat (the file can grow).
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new EvaluationError('config.schema');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    throw new EvaluationError('config.schema');
  } finally {
    await handle.close();
  }
}

export async function readPrivateJson(
  path: string,
  maximum = 64 * 1024,
): Promise<Record<string, unknown>> {
  const text = await readPrivateText(path, maximum);
  try {
    const result: unknown = JSON.parse(text);
    assertUniqueJsonKeys(text);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch {
    throw new EvaluationError('config.schema');
  }
}

/** Scan syntax-validated JSON without losing duplicate decoded property names. */
function assertUniqueJsonKeys(text: string): void {
  const stack: ({ keys: Set<string>; expectingKey: boolean } | null)[] = [];
  for (let position = 0; position < text.length; position++) {
    const token = text[position];
    if (token === '{') stack.push({ keys: new Set(), expectingKey: true });
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') {
      const frame = stack.at(-1);
      if (frame) frame.expectingKey = true;
    } else if (token === '"') {
      const start = position++;
      while (text[position] !== '"') {
        if (text[position] === '\\') position++;
        position++;
      }
      const frame = stack.at(-1);
      if (frame?.expectingKey) {
        const key = JSON.parse(text.slice(start, position + 1)) as string;
        if (frame.keys.has(key)) throw new Error();
        frame.keys.add(key);
        frame.expectingKey = false;
      }
    }
  }
}
