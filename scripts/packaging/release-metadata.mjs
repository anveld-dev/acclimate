import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const packageNames = ['sdk', 'codex-plugin', 'claude-plugin', 'pi-plugin', 'cursor-plugin'];

/** Public build metadata only. Checksums are added after actual artifact creation. */
export async function releaseMetadata(root) {
  const manifests = await Promise.all(packageNames.map(async name =>
    JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'))));
  const python = await readFile(join(root, 'python', 'pyproject.toml'), 'utf8');
  const pythonVersion = /^version\s*=\s*"([^"]+)"/m.exec(python)?.[1];
  if (!pythonVersion) throw new Error('Python package version is missing');
  const version = manifests[0].version;
  if (manifests.some(value => value.version !== version) || pythonVersion !== version)
    throw new Error('SDK, plugins and wheel must belong to the same release version');
  // Record the tested native integration versions for reproducible install guidance,
  // including harnesses that applications install independently of the plugins.
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const nativePeers = {};
  for (const [name, version] of [
    ['@openai/codex-sdk', rootManifest.dependencies?.['@openai/codex-sdk']],
    ['@anthropic-ai/claude-agent-sdk', rootManifest.devDependencies?.['@anthropic-ai/claude-agent-sdk']],
  ]) {
    if (version) nativePeers[name] = version;
  }
  for (const manifest of manifests)
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {}))
      if (!name.startsWith('@anveld/')) nativePeers[name] = rootManifest.devDependencies?.[name] ?? range;
  return {
    schemaVersion: 1,
    version,
    artifacts: [
      ...manifests.map(manifest => ({
        package: manifest.name, version: manifest.version, kind: 'npm',
        file: `${manifest.name.slice(1).replace('/', '-')}-${manifest.version}.tgz`,
      })),
      { package: 'acclimate-sdk', version: pythonVersion, kind: 'wheel', file: `acclimate_sdk-${pythonVersion}-py3-none-any.whl` },
    ],
    starters: [{ name: 'native-repository', file: `acclimate-native-repository-starter-${version}.tgz` }],
    prerequisites: {
      node: '>=22.22.0', python: '>=3.11', platform: 'Linux or macOS (POSIX)',
      storage: 'Owner-only local persistent filesystem with flock, atomic rename and fsync',
    },
    nativePeers,
    publication: 'Operator-distributed artifacts; no registry or download endpoint implied',
  };
}

export async function writeReleaseMetadata(root) {
  const value = await releaseMetadata(root);
  const filename = join(root, 'scripts', 'packaging', 'release-metadata.json');
  const encoded = JSON.stringify(value, null, 2) + '\n';
  let current;
  try { current = await readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current !== encoded) await writeFile(filename, encoded);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
  await writeReleaseMetadata(resolve(import.meta.dirname, '../..'));
