import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { writeReleaseMetadata } from './release-metadata.mjs';
import { archiveStarters } from './starter-artifacts.mjs';
import { releaseSourceFingerprint } from './source-fingerprint.mjs';
import { verifyPackageBuildReceipt } from './build-receipt.mjs';

const root = resolve(import.meta.dirname, '../..');
const version = JSON.parse(await readFile(join(root, 'packages/sdk/package.json'), 'utf8')).version;
const publicMetadata = await writeReleaseMetadata(root);
const sourceFingerprint = await releaseSourceFingerprint(root);
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
const temp = await realpath(await mkdtemp(join(tmpdir(), 'acclimate-package-check-')));
const run = (command, args, cwd = root, env = process.env) => execFileSync(command, args, { cwd, env, stdio: 'inherit' });
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
  await verifyPackageBuildReceipt(root);
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
import { defineEvaluation, preflightEvaluation, runEvaluation } from '@acclimate/sdk/evaluation';
import { evaluationMain } from '@acclimate/sdk/evaluation/cli';
import { checkComparison } from '@acclimate/sdk/evaluation/policy';
import { exportReviewEvidence, verifyReviewExport } from '@acclimate/sdk/evaluation/artifacts';
import { analyzeComparison } from '@acclimate/sdk/evaluation/analysis';
import { createEvaluationManifest, restoreEvaluationManifest } from '@acclimate/sdk/evaluation/manifest';
import { createEvaluationProgressReporter } from '@acclimate/sdk/evaluation/progress';
import { serveConnectedLearning } from '@acclimate/sdk/learning';
import { prepare as codex } from '@acclimate/codex-plugin';
import { prepare as claude } from '@acclimate/claude-plugin';
import { prepare as pi } from '@acclimate/pi-plugin';
import { prepare as cursor } from '@acclimate/cursor-plugin';
for (const value of [AcclimateClient, ApiError, resolveAndCache, prepareFiles, codex, claude, pi, cursor]) assert.equal(typeof value, 'function');
for (const value of [defineEvaluation, preflightEvaluation, runEvaluation, evaluationMain, checkComparison, exportReviewEvidence, verifyReviewExport, analyzeComparison, createEvaluationManifest, restoreEvaluationManifest, createEvaluationProgressReporter, serveConnectedLearning]) assert.equal(typeof value, 'function');
const application = defineEvaluation({configId:'installed-check',configRevision:'1',datasetRevision:'cases-1',graderRevision:'grade-1',runtime:{app:'fixture'},execution:'model-free',cases:[{caseId:'task',input:{value:1},expected:1}],execute:async()=>({output:1}),grade:async()=>({reward:1})});
assert.equal(application.descriptor.runtime.configId, 'installed-check');
const manifest = createEvaluationManifest({configId:'installed-manifest',execution:'model-free',cases:[{caseId:'task',input:{value:1},expected:1}],grader:{sourceUtf8:'return expected === output;'},runtime:{settings:{temperature:0.1},artifacts:{app:'sha256:'+'a'.repeat(64)}}});
assert.deepEqual(restoreEvaluationManifest(manifest.privateManifestJson).descriptor, manifest.descriptor);
assert.deepEqual(defineEvaluation({...manifest.definition,execute:async()=>({output:1}),grade:async()=>({reward:1})}).descriptor, manifest.descriptor);
assert.deepEqual(application.descriptor.expectedCases,[{caseId:'task',repetition:0}]);
assert.equal(JSON.stringify(application.descriptor).includes('expected"'),false);
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
import { defineEvaluation, preflightEvaluation, runEvaluation } from '@acclimate/sdk/evaluation';
import { evaluationMain } from '@acclimate/sdk/evaluation/cli';
import { checkComparison } from '@acclimate/sdk/evaluation/policy';
import { exportReviewEvidence, verifyReviewExport } from '@acclimate/sdk/evaluation/artifacts';
import { analyzeComparison } from '@acclimate/sdk/evaluation/analysis';
import { createEvaluationManifest, restoreEvaluationManifest } from '@acclimate/sdk/evaluation/manifest';
import { createEvaluationProgressReporter } from '@acclimate/sdk/evaluation/progress';
import { serveConnectedLearning } from '@acclimate/sdk/learning';
import { prepare as codex } from '@acclimate/codex-plugin';
import { prepare as claude } from '@acclimate/claude-plugin';
import { prepare as pi } from '@acclimate/pi-plugin';
import { prepare as cursor } from '@acclimate/cursor-plugin';
declare const bundle: VerifiedBundle;
validatePayload(bundle.payload);
void compatibilityIssues(bundle.payload, 'codex');
void [AcclimateClient, codex(bundle), claude(bundle), pi(bundle), cursor(bundle)];
void [defineEvaluation, preflightEvaluation, runEvaluation, evaluationMain, checkComparison, exportReviewEvidence, verifyReviewExport, analyzeComparison, createEvaluationManifest, restoreEvaluationManifest, createEvaluationProgressReporter, serveConnectedLearning];
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
    ], root, { ...process.env, SOURCE_DATE_EPOCH: '315532800' });
    const wheelName = (await readdir(stage)).find(name => name.endsWith('.whl'));
    if (!wheelName) throw new Error('Verified wheel artifact missing');
    const starters = await archiveStarters(root, stage, publicMetadata);
    const extractedStarters = join(temp, 'distributed-starters');
    await mkdir(extractedStarters, { mode: 0o700 });
    for (const starter of starters)
      run('tar', ['-xzf', join(stage, starter.file), '-C', extractedStarters]);
    const app = join(extractedStarters, 'evaluation-starter');
    run(pythonExecutable, [
      'scripts/packaging/verify-wheel.py', '--wheel', join(stage, wheelName), '--starter', app,
      '--analysis-fixtures', join(root, 'contracts/fixtures/evaluation-analysis/vectors.json'),
    ]);
    // Supply the external application's own adapter and cases after extraction.
    const testApplication = join(root, 'scripts/packaging/fixtures/evaluator');
    for (const name of ['application.mjs', 'agent.mjs', 'cases.json'])
      await cp(join(testApplication, name), join(app, name), { errorOnExist: true, force: false });
    await chmod(join(app, 'cases.json'), 0o600);
    const appEnv = { ...process.env, ACCLIMATE_EVALUATOR_CASES: join(app, 'cases.json') };
    const describe = entry => JSON.parse(execFileSync(process.execPath, [entry, 'describe'], {
      cwd: app, env: appEnv, encoding: 'utf8',
    }));
    const descriptor = describe('acclimate-eval.mjs');
    const bin = join(temp, 'node_modules/.bin/acclimate-eval');
    run(bin, ['--help'], app);
    // The operator CLI runs from an installed SDK, outside any checkout.
    const operatorHelp = execFileSync(join(temp, 'node_modules/.bin/acclimate-operator'), ['--help'], { cwd: app, encoding: 'utf8' });
    if (!operatorHelp.startsWith('Usage: acclimate-operator')) throw new Error('Installed SDK lacks the operator CLI');
    const installedDescriptor = JSON.parse(execFileSync(bin, ['describe'], { cwd: app, env: appEnv, encoding: 'utf8' }));
    if (!isDeepStrictEqual(installedDescriptor, descriptor))
      throw new Error('SDK binary and starter describe different installed applications');

    if (descriptor.runtime.execution !== 'live' || descriptor.runtime.configId !== 'installed-qualification-worker'
        || descriptor.expectedCases.length !== 2)
      throw new Error('Distributed evaluator did not describe its installed application');
    // Node loads the adopter's TypeScript adapter directly. Check the shipped
    // declaration and run that same source through the installed CLI.
    await rename(join(app, 'application.mjs'), join(app, 'qualification-app.mjs'));
    await writeFile(join(app, 'application.mts'), `
import type { ApplicationAdapter } from '@acclimate/sdk/evaluation';
import { configId, runtime, grader, execute as executePayment, grade as gradePayment } from './qualification-app.mjs';
type Task = { scenario: string };
type Result = { charges: number; succeeded: boolean };
const adapter: ApplicationAdapter<Task, Result, Result> = {
  configId, runtime, grader,
  execute: run => executePayment(run),
  grade: run => gradePayment(run),
};
export { configId, runtime, grader };
export const { execute, grade } = adapter;
`);
    run(process.execPath, [
      join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--allowJs',
      // Load only Node's ambient types, as an installed consumer would; workspace
      // @types packages hoisted into the checkout must not leak into this check.
      '--types', 'node',
      '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'application.mts',
    ], app);
    const typed = describe('acclimate-eval.mjs');
    if (typed.runtime.configId !== descriptor.runtime.configId ||
        !isDeepStrictEqual(typed.expectedCases, descriptor.expectedCases))
      throw new Error('Native TypeScript adapter lost application identity or case inventory');
    const analysisFixture = JSON.parse(await readFile(join(root, 'contracts/fixtures/evaluation-analysis/vectors.json'), 'utf8'));
    const analysisInput = join(temp, 'analysis-input');
    await mkdir(analysisInput, { mode: 0o700 });
    const analysisArgs = [];
    for (const key of ['comparison', 'expectedDescriptor', 'expectedBinding']) {
      const filename = join(analysisInput, key + '.json');
      await writeFile(filename, JSON.stringify(analysisFixture.input[key]));
      analysisArgs.push(filename);
    }
    const analysisConfig = join(analysisInput, 'config.json');
    await writeFile(analysisConfig, JSON.stringify({metrics:analysisFixture.input.metrics,observations:analysisFixture.input.observations,uncertainty:analysisFixture.input.uncertainty}));
    analysisArgs.push(analysisConfig);
    const analysisOutput = JSON.parse(execFileSync(process.execPath, [join(extractedStarters, 'evaluation-starter/analyze.mjs'), ...analysisArgs], {cwd:temp,encoding:'utf8'}));
    if (!isDeepStrictEqual(analysisOutput, analysisFixture.vectors[0].expected.result))
      throw new Error('Installed distributed analysis recipe differs from its algorithm vector');

    run('sh', ['-n', 'ci.sh'], join(extractedStarters, 'ci-starter'));
    run(pythonExecutable, ['ci.py', '--help'], join(extractedStarters, 'ci-starter'));
    for (const name of ['action.yml', 'workflows/pr-check.yml', 'workflows/release.yml'])
      if (!(await stat(join(extractedStarters, 'ci-starter', name)).catch(() => null))?.isFile())
        throw new Error(`CI starter is missing ${name}`);
    const native = join(extractedStarters, 'native-repository-starter');
    await cp(join(root, 'examples/native-repository/test'), join(native, 'test'), { recursive: true });
    run(process.execPath, ['--test', 'test/installed.test.mjs'], native);
    await writeFile(join(stage, 'release-metadata.json'), JSON.stringify(publicMetadata, null, 2) + '\n');
    await writeFile(join(stage, 'SOURCE.json'), JSON.stringify(sourceFingerprint, null, 2) + '\n');
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
          packages: publicMetadata.artifacts,
          starters,
          prerequisites: publicMetadata.prerequisites,
          capabilities: publicMetadata.capabilities,
          nativePeers: publicMetadata.nativePeers,
          runtime: {
            node: process.version,
            python: execFileSync(pythonExecutable, ['-c', 'import platform; print(platform.python_version())'], { encoding: 'utf8' }).trim(),
          },
          source: { file: 'SOURCE.json', sha256: sourceFingerprint.sha256, scope: sourceFingerprint.scope },
          checks: {
            npmOfflineInstall: 'passed',
            runtimeImports: 'passed',
            typescriptConsumer: 'passed',
            nativeOptionalPeers: 'passed',
            pythonIsolatedWheel: 'passed',
            installedEvaluatorImports: 'passed',
            installedEvaluatorDescriptor: 'passed',
            typescriptStarterBuild: 'passed',
            pythonEvaluatorImports: 'passed',
            pythonInstalledApplicationDescriptor: 'passed',
            installedNativeRepositoryHelpers: 'passed with external test inputs',
            distributedStarterArchives: 'passed: extracted evaluation/ci/native consumers',
            headlessServiceEvaluation: 'not run; use qualify:dx',
            standaloneConsoleRuntime: process.argv.includes('--console-runtime') ? 'passed' : 'not run',
          },
          publication: 'not run',
          externalQualification: 'not run',
        },
        null,
        2,
      ) + '\n',
    );
    await verifyPackageBuildReceipt(root);
    if ((await releaseSourceFingerprint(root)).sha256 !== sourceFingerprint.sha256)
      throw new Error('Release input changed during packaging; rebuild from a stable source snapshot.');
    await rename(stage, output);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  console.log('Retained tarballs, wheel, checksums and isolated consumer evidence: ' + output);
} finally {
  await rm(temp, { recursive: true, force: true });
}
