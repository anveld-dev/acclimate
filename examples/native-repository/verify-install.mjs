import { realpath, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const harnesses = ['codex', 'claude', 'pi', 'cursor'];

async function verifyCodexCli(sdk, entry, boundary, version) {
  const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
  try {
    const manifest = await realpath(createRequire(entry).resolve('@openai/codex/package.json'));
    const platform = await realpath(createRequire(manifest).resolve(platformPackage + '/package.json'));
    if (!manifest.startsWith(boundary) || !platform.startsWith(boundary))
      throw new Error('install.outside_consumer: Codex CLI');
    const cli = JSON.parse(await readFile(manifest, 'utf8'));
    const launcher = await realpath(path.resolve(path.dirname(manifest), cli.bin.codex));
    if (!launcher.startsWith(boundary)) throw new Error('install.outside_consumer: Codex CLI');
    new sdk.Codex({ env: {} });
    const reported = execFileSync(process.execPath, [launcher, '--version'], {
      env: {}, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (reported !== `codex-cli ${version}`) throw new Error('install.codex_cli_version: ' + reported);
    return reported;
  } catch (cause) {
    if (cause.message?.startsWith('install.')) throw cause;
    throw new Error(
      `install.codex_cli_unavailable: install @openai/codex-sdk@${version} with --include=optional ` +
      `and the matching ${platformPackage} package, then rerun verify-install.mjs codex --codex-sdk.`,
      { cause },
    );
  }
}

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
    const installedDirectory = await realpath(path.join(boundary, specifier)).catch(error => {
      if (error.code === 'ENOENT') throw new Error(`install.package_missing: ${specifier}`);
      throw error;
    });
    if (!installedDirectory.startsWith(boundary)) throw new Error(`install.outside_consumer: ${specifier}`);
    const entry = await realpath(fileURLToPath(import.meta.resolve(specifier)));
    if (!entry.startsWith(boundary)) throw new Error(`install.outside_consumer: ${specifier}`);
    // Resolve the manifest by filesystem path; public package exports need not expose it.
    const manifest = JSON.parse(await readFile(path.join(installedDirectory, 'package.json'), 'utf8'));
    if (manifest.name !== specifier) throw new Error(`install.package_identity: ${specifier}`);
    if (specifier === '@acclimate/sdk') releaseVersion = manifest.version;
    else if (specifier.startsWith('@acclimate/') && manifest.version !== releaseVersion)
      throw new Error(`install.release_version_mismatch: ${specifier}`);
    if (specifier === '@openai/codex-sdk' && manifest.version !== '0.169.0')
      throw new Error('install.codex_sdk_version: expected 0.169.0');
    const api = await import(specifier);
    const result = { package: specifier, version: manifest.version, entrypoint: path.relative(consumer, entry) };
    if (specifier === '@openai/codex-sdk') result.cliVersion = await verifyCodexCli(api, entry, boundary, manifest.version);
    results.push(result);
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
