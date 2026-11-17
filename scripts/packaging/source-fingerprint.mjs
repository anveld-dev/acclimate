import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const roots = [
  'packages/sdk/src', 'packages/codex-plugin/src', 'packages/claude-plugin/src',
  'packages/pi-plugin/src', 'packages/cursor-plugin/src', 'python/acclimate',
  'examples/evaluation-starter', 'examples/ci', 'examples/native-repository',
  'scripts/packaging', 'src', 'migrations',
];
const manifests = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json',
  'packages/sdk/package.json', 'packages/codex-plugin/package.json',
  'packages/claude-plugin/package.json', 'packages/pi-plugin/package.json',
  'packages/cursor-plugin/package.json', 'python/pyproject.toml', 'Cargo.toml', 'Cargo.lock',
  'packages/cursor-plugin/README.md',
  'scripts/build-packages.mjs', 'scripts/check-python-package.py',
  'scripts/productization/qualify.py', 'scripts/testing/production.py',
];
const excluded = new Set(['node_modules', '__pycache__', '.cache', '.local', 'dist', '.DS_Store']);

/** Hash explicit release inputs, never ambient configuration or worker state. */
export async function releaseSourceFingerprint(root) {
  const paths = [...manifests];
  async function walk(relative) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      if (excluded.has(entry.name) || entry.name.endsWith('.pyc')) continue;
      const filename = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) paths.push(filename);
      else throw new Error('Release input contains an unsupported filesystem entry');
    }
  }
  for (const directory of roots) await walk(directory);
  const files = [];
  for (const path of [...new Set(paths)].sort()) {
    if (!(await lstat(join(root, path))).isFile()) throw new Error('Release input is not a regular file');
    const bytes = await readFile(join(root, path));
    files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return {
    schemaVersion: 1,
    scope: 'SDK/plugin/Python/service inputs, starter archives and distribution tooling; excludes console runtime and unrelated docs',
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  };
}
