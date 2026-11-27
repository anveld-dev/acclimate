import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const sdk = new URL('packages/sdk/', root);

interface Manifest {
  exports: Record<string, { import: string }>;
  bin: Record<string, string>;
}

test('the SDK references document every public entry point, runtime export and command', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', sdk), 'utf8')) as Manifest;
  const reference = await readFile(
    new URL('apps/docs/content/docs/reference/typescript-sdk.mdx', root),
    'utf8',
  );
  const documented = new Set([...reference.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
  const missing: string[] = [];
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const entry = '@anveld/sdk' + subpath.slice(1);
    if (!documented.has(entry)) missing.push(entry);
    const source = new URL(target.import.replace('./dist/', 'src/').replace(/\.js$/, '.ts'), sdk);
    for (const name of Object.keys(await import(source.href)))
      if (!documented.has(name)) missing.push(`${entry}: ${name}`);
  }
  for (const command of Object.keys(manifest.bin))
    if (!documented.has(command)) missing.push(`bin: ${command}`);
  assert.deepEqual(missing, [], 'Document these in reference/typescript-sdk.mdx');
});
