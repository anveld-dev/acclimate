import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Compile with the repository's NodeNext configuration, then give each package its
// own self-contained output tree. The source tree's relative cross-package imports
// become the supported SDK package entry points in the distribution.
for (const name of ['sdk', 'codex-plugin', 'claude-plugin', 'pi-plugin', 'cursor-plugin']) {
  const output = join('packages', name, 'dist');
  await rm(output, { recursive: true, force: true });
  await cp(join('dist', 'packages', name, 'src'), output, { recursive: true });
  if (name === 'sdk') continue;
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
  await rewrite(output);
}
