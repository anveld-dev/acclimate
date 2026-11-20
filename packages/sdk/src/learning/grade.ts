import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { LoopGrade } from './define.js';

export function exact(path?: string): (output: unknown, expected: unknown) => number {
  return (output, expected) => {
    if (path === undefined) return Number(isDeepStrictEqual(output, expected));
    if (typeof output !== 'object' || output === null || !Object.hasOwn(output, path)) return 0;
    return Number(isDeepStrictEqual((output as Record<string, unknown>)[path], expected));
  };
}

/** Write output.json into an isolated copy of the optional test fixture and run a local command. */
export function tests(command: string, options: { cwd?: string } = {}): LoopGrade<unknown, unknown> {
  const fixture = options.cwd === undefined ? undefined : path.resolve(options.cwd);
  return async (output, _expected, context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'acclimate-grade-'));
    try {
      if (fixture) await cp(fixture, directory, { recursive: true, verbatimSymlinks: true });
      const filename = path.join(directory, 'output.json');
      await rm(filename, { force: true });
      await writeFile(filename, JSON.stringify(output) + '\n', { flag: 'wx' });
      const child = spawn(command, { shell: true, cwd: directory, signal: context.signal, stdio: 'ignore' });
      const [code] = await once(child, 'close');
      context.signal.throwIfAborted();
      return Number(code === 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
