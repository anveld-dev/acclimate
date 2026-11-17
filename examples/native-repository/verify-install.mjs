import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const harnesses = ['codex', 'claude', 'pi', 'cursor'];

/** Reject enclosing workspaces and symlinked checkout packages before running a job. */
export async function verifyInstalledArtifacts(names, { codexSdk = false } = {}) {
  const consumer = await realpath(fileURLToPath(new URL('.', import.meta.url)));
  const boundary = path.join(consumer, 'node_modules') + path.sep;
  if (names.some(name => !harnesses.includes(name))) throw new Error('install.unsupported_harness');
  const specifiers = ['@acclimate/sdk', ...new Set(names.map(name => `@acclimate/${name}-plugin`))];
  if (codexSdk) specifiers.push('@openai/codex-sdk');
  const results = [];
  let releaseVersion;
  for (const specifier of specifiers) {
    const entry = await realpath(fileURLToPath(import.meta.resolve(specifier)));
    if (!entry.startsWith(boundary)) throw new Error(`install.outside_consumer: ${specifier}`);
    // Resolve the manifest by filesystem path; public package exports need not expose it.
    const manifest = JSON.parse(await readFile(path.join(boundary, specifier, 'package.json'), 'utf8'));
    if (manifest.name !== specifier) throw new Error(`install.package_identity: ${specifier}`);
    if (specifier === '@acclimate/sdk') releaseVersion = manifest.version;
    else if (specifier.startsWith('@acclimate/') && manifest.version !== releaseVersion)
      throw new Error(`install.release_version_mismatch: ${specifier}`);
    if (specifier === '@openai/codex-sdk' && manifest.version !== '0.169.0')
      throw new Error('install.codex_sdk_version: expected 0.169.0');
    await import(specifier);
    results.push({ package: specifier, version: manifest.version, entrypoint: path.relative(consumer, entry) });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--all', '--codex-sdk', ...harnesses].includes(arg)))
    throw new Error('Usage: node verify-install.mjs [codex|claude|pi|cursor|--all] [--codex-sdk]');
  const selected = args.includes('--all') ? harnesses : args.filter(arg => harnesses.includes(arg));
  console.log(JSON.stringify(await verifyInstalledArtifacts(selected.length ? selected : ['codex'], {
    codexSdk: args.includes('--codex-sdk'),
  })));
}
