import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageNames } from './release-metadata.mjs';

export const buildInputFiles = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json',
  'scripts/build-packages.mjs', 'scripts/packaging/build-receipt.mjs',
  'scripts/packaging/release-metadata.mjs',
  ...packageNames.map(name => `packages/${name}/package.json`),
];

export async function cleanPackageEmissions(root) {
  for (const name of packageNames)
    await rm(join(root, 'dist/packages', name, 'src'), { recursive: true, force: true });
}

async function fingerprint(root, files, directories) {
  const paths = [...files];
  async function walk(relative) {
    if (!(await lstat(join(root, relative))).isDirectory())
      throw new Error('Package build tree is not a regular directory');
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error('Package build contains an unsupported filesystem entry');
    }
  }
  for (const directory of directories) await walk(directory);
  const hashes = [];
  for (const path of paths.sort()) {
    if (!(await lstat(join(root, path))).isFile()) throw new Error('Package build input is not a regular file');
    hashes.push([path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')]);
  }
  return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}

export const packageBuildInputs = root => fingerprint(root, buildInputFiles,
  packageNames.map(name => `packages/${name}/src`));
const packageBuildOutputs = root => fingerprint(root, [],
  packageNames.map(name => `packages/${name}/dist`));

export async function writePackageBuildReceipt(root, inputs) {
  if (await packageBuildInputs(root) !== inputs)
    throw new Error('Package source changed during compilation; rebuild from stable inputs');
  const receipt = { schemaVersion: 1, inputs, outputs: await packageBuildOutputs(root) };
  await writeFile(join(root, 'dist/.package-build-receipt.json'), JSON.stringify(receipt) + '\n');
}

export async function verifyPackageBuildReceipt(root) {
  let receipt;
  try { receipt = JSON.parse(await readFile(join(root, 'dist/.package-build-receipt.json'), 'utf8')); }
  catch { throw new Error('Package build receipt is missing or invalid; run npm run build:packages'); }
  if (receipt.schemaVersion !== 1 || receipt.inputs !== await packageBuildInputs(root) ||
      receipt.outputs !== await packageBuildOutputs(root))
    throw new Error('Package build is stale or modified; run npm run build:packages');
}
