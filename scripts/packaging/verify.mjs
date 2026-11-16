import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const version = JSON.parse(await readFile(join(root, 'packages/sdk/package.json'), 'utf8')).version;
const outputIndex = process.argv.indexOf('--output');
const output = resolve(
  outputIndex >= 0 ? process.argv[outputIndex + 1] : join(root, 'artifacts/releases', version),
);
if (!version || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version))
  throw new Error('Invalid package version');
await mkdir(resolve(output, '..'), { recursive: true, mode: 0o700 });
try {
  await readdir(output);
  throw new Error('Release output already exists; choose a fresh --output directory.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const pythonExecutable =
  process.env.ACCLIMATE_PACKAGE_PYTHON ||
  ['python3', 'python3.12', 'python3.11'].find((command) => {
    try {
      const [major, minor] = execFileSync(
        command,
        ['-c', 'import sys; print(str(sys.version_info.major)+"."+str(sys.version_info.minor))'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .trim()
        .split('.')
        .map(Number);
      return major === 3 && minor >= 11;
    } catch {
      return false;
    }
  });
if (!pythonExecutable)
  throw new Error('Python 3.11+ required; set ACCLIMATE_PACKAGE_PYTHON to its executable.');
const temp = await mkdtemp(join(tmpdir(), 'acclimate-package-check-'));
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });
async function reservePort() {
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
async function verifyConsoleRuntime() {
  const destination=join(temp,'relocated-console');
  await cp(join(root,'apps/console/.output'),destination,{recursive:true});
  const port=await reservePort(), upstreamPort=await reservePort();
  const host=`console.example.invalid:${port}`;
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>
    !key.startsWith('ACCLIMATE_')&&!key.startsWith('CONSOLE_')&&key!=='DATABASE_URL'));
  Object.assign(env,{HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'production',
    CONSOLE_ORIGIN:`https://${host}`,CONSOLE_OIDC_ISSUER:'https://issuer.example.invalid',
    CONSOLE_OIDC_CLIENT_ID:'artifact-fixture',CONSOLE_OIDC_CLIENT_SECRET:randomUUID(),
    CONSOLE_LOGIN_TOKEN:randomUUID(),CONSOLE_SERVICE_TOKEN:randomUUID(),
    CONSOLE_SERVICE_URL:`http://127.0.0.1:${upstreamPort}`,CONSOLE_PUBLIC_API_URL:'https://api.example.invalid'});
  const child=spawn(process.execPath,[join(destination,'server/index.mjs')],{
    cwd:destination,env,stdio:['ignore','ignore','ignore']});
  let startupError;
  child.once('error',error=>{startupError=error});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  const request=route=>fetch(`http://127.0.0.1:${port}${route}`,{
    headers:{Host:host},signal:AbortSignal.timeout(3000)});
  try {
    let ready=false;
    for(let attempt=0;attempt<100;attempt++) {
      if(startupError||child.exitCode!==null||child.signalCode!==null)
        throw new Error('Relocated console runtime exited before liveness');
      try {if((await request('/health')).status===200){ready=true;break}} catch {}
      await delay(100);
    }
    if(!ready) throw new Error('Relocated console runtime did not become live');
    if((await request('/ready')).status!==503)
      throw new Error('Relocated console must report unavailable upstream as not ready');
    console.log('Relocated standalone console artifact: liveness passed, absent-upstream readiness denied.');
  } finally {
    if(child.exitCode===null&&child.signalCode===null) child.kill('SIGTERM');
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    try {await exited} finally {clearTimeout(timer)}
  }
}

try {
  if (process.argv.includes('--console-runtime')) await verifyConsoleRuntime();
  if (!process.argv.includes('--skip-build')) run('npm', ['run', 'build:packages']);
  const names = ['sdk', 'codex-plugin', 'claude-plugin', 'pi-plugin', 'cursor-plugin'];
  for (const name of names)
    run('npm', [
      'pack',
      '--offline',
      '--pack-destination',
      temp,
      '--workspace',
      `@acclimate/${name}`,
    ]);
  const tarballs = names.map((name) => join(temp, `acclimate-${name}-${version}.tgz`));
  await writeFile(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(
    'npm',
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs],
    temp,
  );
  await writeFile(
    join(temp, 'consumer.mjs'),
    `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AcclimateClient, ApiError, resolveAndCache, prepareFiles } from '@acclimate/sdk';
import { validatePayload, compatibilityIssues } from '@acclimate/sdk/validation';
import { prepare as codex } from '@acclimate/codex-plugin';
import { prepare as claude } from '@acclimate/claude-plugin';
import { prepare as pi } from '@acclimate/pi-plugin';
import { prepare as cursor } from '@acclimate/cursor-plugin';
for (const value of [AcclimateClient, ApiError, resolveAndCache, prepareFiles, codex, claude, pi, cursor]) assert.equal(typeof value, 'function');
const bundle = {version:{id:'v1',bundleId:'b',parentVersionId:null,digest:'sha256:test',createdAt:'now'},payload:{schemaVersion:1,files:[{path:'instructions.md',kind:'instruction',text:'Hello'}]},resolvedAt:0,stale:false};
validatePayload(bundle.payload);
assert.deepEqual(compatibilityIssues(bundle.payload, 'codex'), []);
for (const prepare of [codex, claude, pi, cursor]) { const staged = await prepare(bundle); assert.equal(await readFile(staged.instructionPath, 'utf8'), 'Hello'); await staged.cleanup(); }
`,
  );
  await writeFile(
    join(temp, 'consumer.ts'),
    `
import { AcclimateClient, type VerifiedBundle } from '@acclimate/sdk';
import { validatePayload, compatibilityIssues } from '@acclimate/sdk/validation';
import { prepare as codex } from '@acclimate/codex-plugin';
import { prepare as claude } from '@acclimate/claude-plugin';
import { prepare as pi } from '@acclimate/pi-plugin';
import { prepare as cursor } from '@acclimate/cursor-plugin';
declare const bundle: VerifiedBundle;
validatePayload(bundle.payload);
void compatibilityIssues(bundle.payload, 'codex');
void [AcclimateClient, codex(bundle), claude(bundle), pi(bundle), cursor(bundle)];
`,
  );
  run(process.execPath, ['consumer.mjs'], temp);
  run(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'consumer.ts',
    ],
    temp,
  );
  // Native-specific APIs use optional peers; install both into the isolated app
  // before checking their types. The SDK-only runtime check above needs neither.
  // Copy the already installed, lockfile-resolved peer dependency tree. This
  // avoids network access and avoids a fresh resolver selecting uncached versions.
  await cp(join(root, 'node_modules'), join(temp, 'node_modules'), {
    recursive: true,
    force: false,
    filter: (source) =>
      !source.startsWith(join(root, 'node_modules/@acclimate')) && !source.includes('/.bin'),
  });
  await writeFile(
    join(temp, 'native.mjs'),
    `
import assert from 'node:assert/strict';
import { prepare as claude } from '@acclimate/claude-plugin';
import { claudeSessionOptions } from '@acclimate/claude-plugin/native';
import { prepare as pi } from '@acclimate/pi-plugin';
import { createPiResourceLoader } from '@acclimate/pi-plugin/native';
import { prepare as cursor } from '@acclimate/cursor-plugin';
import { cursorLocalOptions } from '@acclimate/cursor-plugin/native';
const bundle = {version:{id:'v1',bundleId:'b',parentVersionId:null,digest:'sha256:test',createdAt:'now'},payload:{schemaVersion:1,files:[{path:'instructions.md',kind:'instruction',text:'Hello'}]},resolvedAt:0,stale:false};
const c = await claude(bundle); assert.equal(claudeSessionOptions(c).cwd, c.cwd); await c.cleanup();
const p = await pi(bundle); const loader = await createPiResourceLoader(p); assert.ok(loader); await p.cleanup();
const cu = await cursor(bundle); assert.equal(cursorLocalOptions(cu).local.cwd, cu.cwd); await cu.cleanup();
`,
  );
  run(process.execPath, ['native.mjs'], temp);
  await writeFile(
    join(temp, 'native.ts'),
    `
import { prepare as claude } from '@acclimate/claude-plugin';
import { claudeSessionOptions } from '@acclimate/claude-plugin/native';
import { prepare as pi } from '@acclimate/pi-plugin';
import { createPiResourceLoader } from '@acclimate/pi-plugin/native';
import { prepare as cursor } from '@acclimate/cursor-plugin';
import { cursorLocalOptions } from '@acclimate/cursor-plugin/native';
import type { VerifiedBundle } from '@acclimate/sdk';
declare const bundle: VerifiedBundle;
void [claude(bundle).then(claudeSessionOptions), pi(bundle).then(p => createPiResourceLoader(p)), cursor(bundle).then(cursorLocalOptions)];
`,
  );
  run(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'native.ts',
    ],
    temp,
  );
  const installed = JSON.parse(
    await readFile(join(temp, 'node_modules/@acclimate/sdk/package.json'), 'utf8'),
  );
  if (installed.version !== version) throw new Error('Unexpected installed SDK version');
  const stage = await mkdtemp(join(resolve(output, '..'), '.release-'));
  try {
    for (const artifact of tarballs) await cp(artifact, join(stage, artifact.split('/').pop()));
    run(pythonExecutable, [
      'scripts/check-python-package.py',
      '--expected-version',
      version,
      '--output',
      stage,
    ]);
    const artifacts = [];
    for (const name of (await readdir(stage)).sort()) {
      const bytes = await readFile(join(stage, name));
      artifacts.push({
        name,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    await writeFile(
      join(stage, 'SHA256SUMS'),
      artifacts.map((a) => `${a.sha256}  ${a.name}\n`).join(''),
    );
    await writeFile(
      join(stage, 'manifest.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          version,
          createdAt: new Date().toISOString(),
          artifacts,
          checks: {
            npmOfflineInstall: 'passed',
            runtimeImports: 'passed',
            typescriptConsumer: 'passed',
            nativeOptionalPeers: 'passed',
            pythonIsolatedWheel: 'passed',
            standaloneConsoleRuntime: process.argv.includes('--console-runtime') ? 'passed' : 'not run',
          },
          publication: 'not run',
          externalQualification: 'not run',
        },
        null,
        2,
      ) + '\n',
    );
    await rename(stage, output);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  console.log('Retained tarballs, wheel, checksums and isolated consumer evidence: ' + output);
} finally {
  await rm(temp, { recursive: true, force: true });
}
