import { cp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeReleaseMetadata } from './packaging/release-metadata.mjs';
import { cleanPackageEmissions, packageBuildInputs, writePackageBuildReceipt } from './packaging/build-receipt.mjs';

await writeReleaseMetadata(resolve('.'));
const buildInputs = await packageBuildInputs(resolve('.'));
// TypeScript leaves deleted source outputs behind. Clear the package emission
// trees before compiling so removed modules cannot survive in the release.
await cleanPackageEmissions(resolve('.'));
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });

async function verifyLocalImports(directory, distributionRoot = resolve(directory)) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) {
      await verifyLocalImports(filename, distributionRoot);
    } else if (/\.(?:js|d\.ts)$/.test(entry.name)) {
      const source = await readFile(filename, 'utf8');
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g)) {
        const destination = resolve(dirname(filename), match[1]);
        if (!destination.startsWith(distributionRoot + '/'))
          throw new Error(`Distribution import escapes installed package: ${filename}`);
        if (!(await stat(destination).catch(() => null))?.isFile())
          throw new Error(`Distribution import is missing from installed package: ${filename}`);
      }
    }
  }
}

// Compile with the repository's NodeNext configuration, then give each package its
// own self-contained output tree. The source tree's relative cross-package imports
// become the supported SDK package entry points in the distribution.
for (const name of ['sdk', 'codex-plugin', 'claude-plugin', 'pi-plugin', 'cursor-plugin']) {
  const output = join('packages', name, 'dist');
  await rm(output, { recursive: true, force: true });
  await cp(join('dist', 'packages', name, 'src'), output, { recursive: true });
  async function rewrite(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await rewrite(file);
      else if (/\.(?:js|d\.ts)$/.test(entry.name)) {
        const text = await readFile(file, 'utf8');
        const updated = text
          .replaceAll('../../sdk/src/types.js', '@acclimate/sdk')
          .replaceAll('../../sdk/src/cache.js', '@acclimate/sdk')
          .replaceAll('../../sdk/src/internal/native-files.js', '@acclimate/sdk/native-files');
        if (updated.includes('../../sdk/src/')) throw new Error(`Unmapped SDK import in ${file}`);
        await writeFile(file, updated);
      }
    }
  }
  if (name !== 'sdk') await rewrite(output);
  await verifyLocalImports(output);
}
await writePackageBuildReceipt(resolve('.'), buildInputs);
