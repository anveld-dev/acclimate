"""Actual-service, installed-plugin acceptance; owned deterministic children only."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import tarfile

from scripts.acceptance.dx_personas.support import PersonaFixture


PREFLIGHT = r'''import { realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyInstalledArtifacts } from './verify-install.mjs';
const app=await realpath(process.cwd());
const names=JSON.parse(process.argv[2]);
const installedHelperResults=await verifyInstalledArtifacts(['codex','claude','pi','cursor'],{codexSdk:names.includes('@openai/codex-sdk')});
const results=[];
for(const name of names){
  const filename=await realpath(fileURLToPath(import.meta.resolve(name)));
  if(!filename.startsWith(path.join(app,'node_modules')+path.sep)) throw new Error('persona.external_install_boundary_failed');
  const data=await readFile(filename);
  const metadata=JSON.parse(await readFile(path.join(app,'node_modules',name,'package.json'),'utf8'));
  results.push({package:name,version:metadata.version,entrypointSha256:createHash('sha256').update(data).digest('hex'),resolvedWithinConsumer:true});
}
console.log(JSON.stringify({allResolvedWithinConsumer:true,installedHelperResults,packages:results}));
'''


CHILD = r'''import { readFile, writeFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
process.once('message', async ({context: c, hold}) => {
  try {
    assert.match(await readFile(c.instructionPath, 'utf8'), /request-scoped/);
    assert.match(await readFile(c.skillPaths[0], 'utf8'), /Preserve request identity/);
    assert.equal(c.memoryFiles.length, 1);
    assert.equal(c.memoryFiles[0].path, 'memory/selected.md');
    assert.match(await readFile(c.memoryFiles[0].absolutePath, 'utf8'), /^SELECTED-MEMORY-[a-f0-9]{32}\n$/);
    assert.ok(!JSON.stringify(c).includes('WITHHELD-CANARY'));
    let checked = 0;
    async function walk(dir) {
      for (const entry of await readdir(dir, {withFileTypes:true})) {
        const filename = path.join(dir, entry.name);
        if(entry.isDirectory()) await walk(filename);
        else { assert.ok(!(await readFile(filename,'utf8')).includes('WITHHELD-CANARY')); checked++; }
      }
    }
    await walk(c.cwd);
    assert.match(await readFile(path.join(c.cwd,'src/retry.js'),'utf8'), /requestId.*attempt/);
    const before = spawnSync(process.execPath, ['--test','tests/retry.test.mjs'], {cwd:c.cwd, encoding:'utf8'});
    assert.equal(before.status, 1);
    await writeFile(path.join(c.cwd,'src/retry.js'), 'export function retryKey(requestId, attempt) {\n  void attempt;\n  return requestId;\n}\n');
    const after = spawnSync(process.execPath, ['--test','tests/retry.test.mjs'], {cwd:c.cwd, encoding:'utf8'});
    assert.equal(after.status, 0);
    process.send({ok:true, baselineExit:before.status, testsExit:after.status, filesChecked:checked, selectedMemory:['memory/selected.md'], output:after.stdout});
    if (hold) setInterval(()=>{},1000);
    else process.disconnect();
  } catch(error) { process.send({ok:false, code:error.code, message:error.message}); process.exitCode=1; process.disconnect(); }
});
'''


CONSUMER = r'''import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AcclimateClient, resolveAndCache } from '@acclimate/sdk';
import { freezeSourceInventory, runRepositoryJob, inspectNativeJob, cleanupQuarantinedJob, sha256 } from './repository-job.mjs';
import { installedHarness } from './harnesses.mjs';

const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const root=config.stateRoot;
const client=new AcclimateClient({baseUrl:config.baseUrl, token:config.readToken, scope:config.scope});
const bundle=await resolveAndCache(client,{workspaceId:config.workspaceId,bundleId:config.bundleId,versionId:config.versionId},{cacheDir:path.join(root,'cache'),offline:false});
assert.equal(bundle.version.digest,config.digest);
assert.equal(bundle.stale,false);
const sourceRoot=path.resolve('fixture');
const source=await freezeSourceInventory({sourceRoot, paths:['package.json','src/retry.js','tests/retry.test.mjs'],revision:'plugin-persona-retry-fixture-v1'});
const before=await readFile(path.join(sourceRoot,'src/retry.js'));
const conflicts=[];
for(const conflict of ['AGENTS.md','nested/claude.MD','.cursor/skills/retry-review/SKILL.md']) {
  try { await freezeSourceInventory({sourceRoot,paths:[conflict],revision:'conflict-probe-v1'}); assert.fail('conflict allowed'); }
  catch(error) { assert.equal(error.code,'native.control_path'); conflicts.push({path:conflict,code:error.code}); }
}
const results=[];
const owned=[];
async function jobContext(harness, mode) {
  const context={requestId:randomUUID(),attemptId:randomUUID(),side:'candidate',jobId:sha256(Buffer.from(harness+':'+mode))};
  context.privateJobDirectory=path.join(root,'jobs',context.jobId);
  await mkdir(context.privateJobDirectory,{mode:0o700});
  await writeFile(path.join(context.privateJobDirectory,'binding.json'),JSON.stringify({requestId:context.requestId,attemptId:context.attemptId,side:context.side,jobId:context.jobId,caseId:'request-scoped-retry',repetition:0,versionId:bundle.version.id,digest:bundle.version.digest})+'\n',{mode:0o600,flag:'wx'});
  return context;
}
function childRun(effective, hold) {
  const child=fork(path.resolve('persona-child.mjs'),[],{cwd:effective.cwd,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe','ipc']});
  owned.push(child);
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const message=new Promise((resolve,reject)=> {child.once('message',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error('child exited before result '+code)));});
  child.send({context:effective,hold});
  return {child,exited,message};
}
try {
  for(const harness of ['codex','claude','pi','cursor']) {
    const context=await jobContext(harness,'success');
    let evidence;
    const result=await runRepositoryJob({version:bundle,context,source,harness,prepare:(await installedHarness(harness)).prepare,workspaceParent:path.join(root,'workspaces'),artifactRoot:path.join(root,'artifacts'),caseId:'request-scoped-retry',repetition:0,selectedMemoryPaths:['memory/selected.md'],resultFiles:['src/retry.js'],runHarness:async({context:effective,acknowledge})=>{
      const run=childRun(effective,false);
      await acknowledge({kind:'owned-deterministic-node-child',value:String(run.child.pid)});
      evidence=await run.message; assert.equal(evidence.ok,true,evidence.message);
      const exit=await run.exited; assert.equal(exit.code,0);
      return {stopped:true,output:{...evidence,childExit:exit.code}};
    }});
    const record=await inspectNativeJob(context.privateJobDirectory);
    assert.equal(record.facts.confirmedStopped,true);assert.equal(record.facts.resultsRetained,true);assert.equal(record.facts.cleaned,true);
    assert.equal(await lstat(record.cwd).then(()=>true,()=>false),false);
    const manifest=JSON.parse(await readFile(record.artifactManifest.path,'utf8'));
    const patch=await readFile(path.join(path.dirname(record.artifactManifest.path),'result.patch'));
    assert.equal(sha256(patch),manifest.patch.sha256);assert.match(patch.toString(),/\+  return requestId;/);
    results.push({harness,versionId:bundle.version.id,digest:bundle.version.digest,sourceManifestSha256:source.sha256,selectedMemorySha256:manifest.selectedMemorySha256,patchSha256:manifest.patch.sha256,patchBytes:patch.length,baselineExit:evidence.baselineExit,testsExit:evidence.testsExit,childExit:0,resourceFilesChecked:evidence.filesChecked,withheldMemoryAbsent:true,resultsRetainedBeforeCleanup:record.facts.resultsRetained,cleaned:record.facts.cleaned});
  }
  const context=await jobContext('codex','uncertain');
  let held;
  await assert.rejects(runRepositoryJob({version:bundle,context,source,harness:'codex',prepare:(await installedHarness('codex')).prepare,workspaceParent:path.join(root,'workspaces'),artifactRoot:path.join(root,'artifacts'),caseId:'request-scoped-retry',repetition:0,selectedMemoryPaths:['memory/selected.md'],resultFiles:['src/retry.js'],runHarness:async({context:effective,acknowledge})=>{
    held=childRun(effective,true);await acknowledge({kind:'owned-deterministic-node-child',value:String(held.child.pid)});
    const message=await held.message;assert.equal(message.ok,true,message.message);
    return {stopped:false,output:message};
  }}),{name:'ExecutionUncertainError'});
  const uncertain=await inspectNativeJob(context.privateJobDirectory);
  assert.equal(held.child.exitCode,null);assert.equal(held.child.signalCode,null);
  assert.equal(uncertain.facts.cleaned,false);assert.equal(uncertain.facts.confirmedStopped,false);
  assert.ok((await lstat(uncertain.cwd)).isDirectory());
  await assert.rejects(cleanupQuarantinedJob({privateJobDirectory:context.privateJobDirectory,confirmStopped:async()=>false}),{code:'native.termination_unconfirmed'});
  held.child.kill('SIGKILL');const reaped=await held.exited;assert.equal(reaped.signal,'SIGKILL');
  await cleanupQuarantinedJob({privateJobDirectory:context.privateJobDirectory,confirmStopped:async()=>held.child.signalCode==='SIGKILL'});
  assert.equal((await inspectNativeJob(context.privateJobDirectory)).facts.cleaned,true);
  assert.deepEqual(await readFile(path.join(sourceRoot,'src/retry.js')),before);
  assert.deepEqual(await readdir(path.join(root,'workspaces')),[]);
  console.log(JSON.stringify({schemaVersion:1,persona:'coding-agent-plugin-author',evidence:'actual-service-installed-plugins-owned-deterministic-child-only',providerCalls:0,credentialKind:'service-issued-content-read',pinned:{versionId:bundle.version.id,digest:bundle.version.digest},sourceUnchanged:true,conflicts,results,uncertain:{quarantinedWhileChildAlive:true,unconfirmedCleanupRejected:true,termination:'owned-child-SIGKILL-and-reap',recoveryCleaned:true},remainingWorkspaces:0}));
} finally {
  await Promise.all(owned.map(child=>child.exitCode===null&&child.signalCode===null?new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGKILL');}):Promise.resolve()));
}
'''


LIVE_CODEX = r'''import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AcclimateClient, resolveAndCache } from '@acclimate/sdk';
import { Codex } from '@openai/codex-sdk';
import { prepare } from '@acclimate/codex-plugin';
import { codexRuntimeInputs } from './harnesses.mjs';
import { freezeSourceInventory, runRepositoryJob, inspectNativeJob, sha256 } from './repository-job.mjs';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const root=config.stateRoot;
const bundle=await resolveAndCache(new AcclimateClient({baseUrl:config.baseUrl,token:config.readToken,scope:config.scope}),{workspaceId:config.workspaceId,bundleId:config.bundleId,versionId:config.versionId},{cacheDir:path.join(root,'live-cache'),offline:false});
assert.equal(bundle.version.digest,config.digest);
const sourceRoot=path.resolve('fixture');
const source=await freezeSourceInventory({sourceRoot,paths:['package.json','src/retry.js','tests/retry.test.mjs'],revision:'plugin-persona-retry-fixture-v1'});
const context={requestId:randomUUID(),attemptId:randomUUID(),side:'candidate',jobId:sha256(Buffer.from('codex-live-'+randomUUID()))};
context.privateJobDirectory=path.join(root,'jobs',context.jobId);
await mkdir(context.privateJobDirectory,{mode:0o700});
await writeFile(path.join(context.privateJobDirectory,'binding.json'),JSON.stringify({requestId:context.requestId,attemptId:context.attemptId,side:context.side,jobId:context.jobId,caseId:'request-scoped-retry',repetition:0,versionId:bundle.version.id,digest:bundle.version.digest})+'\n',{mode:0o600,flag:'wx'});
const events=[];
let actualThreadId=null, failure=null, completion=null, expectedMarkers=null, baselineExit=null;
let hostFinalTestsExit=null, unchangedTests=null;
const originalSource=await readFile(path.join(sourceRoot,'src/retry.js'));
const originalTests=await readFile(path.join(sourceRoot,'tests/retry.test.mjs'));
let result;
try {
  result=await runRepositoryJob({version:bundle,context,source,harness:'codex',prepare,workspaceParent:path.join(root,'workspaces'),artifactRoot:path.join(root,'artifacts'),caseId:'request-scoped-retry',repetition:0,selectedMemoryPaths:['memory/selected.md'],resultFiles:['src/retry.js'],contextPolicyRevision:'plugin-persona-v1:selected-only:no-network:workspace-write',runHarness:async({context:effective,acknowledge})=>{
    baselineExit=spawnSync(process.execPath,['--test','tests/retry.test.mjs'],{cwd:effective.cwd,encoding:'utf8'}).status;
    assert.equal(baselineExit,1);
    const instruction=await readFile(effective.instructionPath,'utf8');
    const skill=await readFile(effective.skillPaths[0],'utf8');
    expectedMarkers={instruction:instruction.match(/INSTRUCTION-MARKER: (\S+)/)[1],skill:skill.match(/SKILL-MARKER: (\S+)/)[1],memory:(await readFile(effective.memoryFiles[0].absolutePath,'utf8')).trim()};
    const runtime=codexRuntimeInputs(effective,{env:config.sdkEnv,model:config.runtimePolicy.model,config:config.runtimePolicy.config,configOverrides:config.runtimePolicy.configOverrides});
    const thread=new Codex(runtime.constructorOptions).startThread({...runtime.threadOptions,modelReasoningEffort:'low'});
    const prompt=`Use $retry-review to fix the bug in this small existing repository. Read the prepared instruction file ${effective.instructionPath}, skill ${effective.skillPaths[0]}, and the sole approved memory file ${effective.memoryFiles[0].absolutePath}. Read src/retry.js and tests/retry.test.mjs. Run node --test tests/retry.test.mjs before editing to observe the failure. Make the minimum source change required by the instruction and test; leave all test files unchanged. Run the same test after editing. Do not access credentials, environment files, unrelated host paths or network. In the final response report the exact INSTRUCTION-MARKER, SKILL-MARKER and approved memory text found only in those files, plus the change and test result.`;
    assert.ok(Object.values(expectedMarkers).every(marker=>!prompt.includes(marker)));
    try {
      const turn=await thread.runStreamed(prompt,{signal:AbortSignal.timeout(110000)});
      for await(const event of turn.events) {
        events.push(event);
        if(event.type==='thread.started'){actualThreadId=event.thread_id;await acknowledge({kind:'codex-thread',value:actualThreadId});}
        if(event.type==='turn.completed')completion=event.usage;
        if(event.type==='turn.failed'||event.type==='error')throw new Error(event.error?.message??event.message);
      }
      // Installed SDK 0.169.0 exhausts this stream only after awaiting codex exec's exit.
    } catch(error) {failure={name:error.name,message:error.message};throw error;}
    hostFinalTestsExit=spawnSync(process.execPath,['--test','tests/retry.test.mjs'],{cwd:effective.cwd,encoding:'utf8'}).status;
    unchangedTests=originalTests.equals(await readFile(path.join(effective.cwd,'tests/retry.test.mjs')));
    return {stopped:true,output:{threadId:actualThreadId,hostFinalTestsExit,unchangedTests}};
  }});
} catch(error) { if(!failure)failure={name:error.name,message:error.message}; }
await writeFile(path.join(root,'live-codex-events.json'),JSON.stringify(events)+'\n',{mode:0o600,flag:'wx'});
if(failure)await writeFile(path.join(root,'live-codex-failure.json'),JSON.stringify(failure)+'\n',{mode:0o600,flag:'wx'});
const record=await inspectNativeJob(context.privateJobDirectory);
const completedItems=events.filter(e=>e.type==='item.completed').map(e=>e.item);
const commands=completedItems.filter(e=>e.type==='command_execution');
const changes=completedItems.filter(e=>e.type==='file_change');
const response=completedItems.filter(e=>e.type==='agent_message').map(e=>e.text).join('\n');
const markerMatches=expectedMarkers?Object.fromEntries(Object.entries(expectedMarkers).map(([key,value])=>[key,response.includes(value)])):{};
const reads=Object.fromEntries([['instruction','AGENTS.md'],['skill','SKILL.md'],['memory','selected.md'],['source','src/retry.js'],['tests','tests/retry.test.mjs']].map(([key,fragment])=>[key,commands.some(item=>item.command.includes(fragment)&&item.exit_code===0)]));
const testCommands=commands.filter(item=>item.command.includes('--test')&&item.command.includes('retry.test.mjs')).map(item=>({itemId:item.id,exitCode:item.exit_code,status:item.status}));
let patch=null;
if(record.artifactManifest){const manifestBytes=await readFile(record.artifactManifest.path);assert.equal(sha256(manifestBytes),record.artifactManifest.sha256);const manifest=JSON.parse(manifestBytes);const patchBytes=await readFile(path.join(path.dirname(record.artifactManifest.path),'result.patch'));assert.equal(sha256(patchBytes),manifest.patch.sha256);patch={sha256:manifest.patch.sha256,bytes:manifest.patch.bytes,manifestSha256:record.artifactManifest.sha256,sourceManifestSha256:manifest.sourceManifestSha256,retainedAfterCleanup:true};}
const sourceUnchanged=originalSource.equals(await readFile(path.join(sourceRoot,'src/retry.js')));
const passed=!!result&&completion!==null&&hostFinalTestsExit===0&&unchangedTests&&Object.values(markerMatches).every(Boolean)&&Object.values(reads).every(Boolean)&&testCommands.some(c=>c.exitCode!==0)&&testCommands.some(c=>c.exitCode===0)&&record.facts.resultsRetained&&record.facts.cleaned&&sourceUnchanged;
const blocker=failure?(/auth|login|log in|unauthorized|401|credential/i.test(failure.message)?'existing-sdk-authentication-unavailable':/model.*(not|unsupported|available)/i.test(failure.message)?'configured-model-unavailable':/timeout|abort/i.test(failure.name+' '+failure.message)?'bounded-native-session-aborted-quarantined':'native-session-failed-private-error-retained'):passed?null:'provider-finished-acceptance-evidence-incomplete';
console.log(JSON.stringify({schemaVersion:1,harness:'codex',sdkVersion:'0.169.0',model:'gpt-6-luna',evidence:'actual-service-installed-sdk-native-provider-session',passed,blocker,versionId:bundle.version.id,digest:bundle.version.digest,threadId:actualThreadId,turnCompleted:completion!==null,eventTypes:[...new Set(events.map(event=>event.type))],eventCount:events.length,runtimePolicy:config.runtimePolicy,usage:completion,baselineExit,hostFinalTestsExit,unchangedTests,markerMatches,observedSuccessfulCommandsMentioning:reads,testCommands,fileChangeItems:changes.length,itemTypes:[...new Set(completedItems.map(i=>i.type))],patch,sourceUnchanged,facts:record.facts,cleanupAfter:'normal-sdk-stream-exhaustion-awaits-codex-exec-exit',providerBehaviorLimits:['One fresh session on a tiny repository; no general behavioral improvement estimate.','No resumed-session reload or forced provider cancellation qualified.','Resource command matching is observable retrieval evidence; it is not a skill-discovery event.']}));
'''


def public_evidence(evidence, fixture_root, consumer_app):
    """Sanitize private run metadata without publishing paths, prompts or markers."""
    report = json.loads(json.dumps(evidence))
    report['deterministicProviderCalls'] = 0
    report.pop('providerCalls', None)  # One native turn can make several provider requests.
    report['nativeSessionAttempts'] = 1 if 'liveCodex' in report else 0
    report['consumerOutsideCheckout'] = not consumer_app.resolve().is_relative_to(Path(__file__).resolve().parents[3])
    report['sourceCheckoutRevision'] = subprocess.run(
        ['git', 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True).stdout.strip()
    report['commands'] = [
        'python3.11 -m scripts.acceptance.dx_personas.plugin_author --output <private-output> --live-codex',
        'npm --prefix <external-consumer> install --workspaces=false --offline --ignore-scripts --no-audit --no-fund <release-sdk-and-plugin-tarballs>',
        'node persona-launch.mjs <private-config> <persistent-workspace-parent>',
        'npm --prefix <external-consumer> install --workspaces=false --offline --ignore-scripts --no-audit --no-fund @openai/codex-sdk@0.169.0',
        'node persona-live-launch.mjs <private-config> <persistent-workspace-parent>',
    ] if 'liveCodex' in report else ['node persona-launch.mjs <private-config> <persistent-workspace-parent>']
    report['remainingWorkspaces'] = len(list((fixture_root / 'state/workspaces').iterdir()))
    for result in report['results']:
        job_id = hashlib.sha256((result['harness'] + ':success').encode()).hexdigest()
        record = json.loads((fixture_root / 'state/jobs' / job_id / 'job.json').read_text())
        manifest = Path(record['artifactManifest']['path'])
        assert hashlib.sha256(manifest.read_bytes()).hexdigest() == record['artifactManifest']['sha256']
        result.update(manifestSha256=record['artifactManifest']['sha256'], facts=record['facts'])
    uncertain_id = hashlib.sha256(b'codex:uncertain').hexdigest()
    report['uncertain']['recoveredFacts'] = json.loads((fixture_root / 'state/jobs' / uncertain_id / 'job.json').read_text())['facts']
    report['cleanup'] = {key: value for key, value in json.loads(
        (fixture_root / 'private/cleanup.json').read_text()).items() if key != 'servicePid'}
    if 'liveCodex' in report:
        report['evidence'] = 'actual-service-all-four-deterministic-children-plus-real-Codex-native-session'
        events = json.loads((fixture_root / 'state/live-codex-events.json').read_text())
        items = [event['item'] for event in events if event.get('type') == 'item.completed']
        commands = [item for item in items if item['type'] == 'command_execution']
        report['liveCodex']['eventLedger'] = [dict(
            type=event['type'],
            **({'itemId': event['item']['id'], 'itemType': event['item']['type']} if 'item' in event else {}))
            for event in events]
        report['liveCodex']['fileChangeEvidence'] = []
        for item in items:
            if item['type'] == 'file_change':
                paths = []
                for change in item['changes']:
                    relative = Path(change['path']).relative_to(fixture_root / 'state/workspaces')
                    paths.append(dict(path=str(Path(*relative.parts[1:])), kind=change['kind']))
                report['liveCodex']['fileChangeEvidence'].append(dict(itemId=item['id'], status=item['status'], changes=paths))
        report['liveCodex']['toolEvidence'] = []
        for item in commands:
            reads = [relative for relative in ('AGENTS.md', '.agents/skills/retry-review/SKILL.md',
                     '.acclimate/memory/memory/selected.md', 'src/retry.js', 'tests/retry.test.mjs')
                     if 'cat ' in item['command'] and 'cat >' not in item['command'] and relative in item['command']]
            source_write = 'cat > src/retry.js' in item['command']
            report['liveCodex']['toolEvidence'].append(dict(
                itemId=item['id'], operation='read-resources-and-source' if reads else 'write-source' if source_write else 'repository-test' if '--test' in item['command'] else 'other-command',
                relativeReadPaths=reads, exitCode=item.get('exit_code')))
        warnings = [item.get('message', '') for item in items if item['type'] == 'error']
        report['liveCodex']['nonfatalAmbientConfigurationWarnings'] = dict(
            deprecatedMultiAgentSettings=sum('multi_agent' in message for message in warnings),
            ignoredRemoteConnectionsSetting=sum('remote_connections' in message for message in warnings),
            marketplaceRootOutsideCodexHome=sum('marketplace' in message for message in warnings),
            total=len(warnings))
        app = consumer_app
        report['liveCodex']['consumerScriptSha256'] = hashlib.sha256(
            (app / 'persona-live-codex.mjs').read_bytes()).hexdigest()
        report['liveCodex']['installedSdkImplementationSha256'] = hashlib.sha256(
            (app / 'node_modules/@openai/codex-sdk/dist/index.js').read_bytes()).hexdigest()
        report['liveCodex']['installedSdkRelativePath'] = 'app/native-repository-starter/node_modules/@openai/codex-sdk/dist/index.js'
        # Record this platform's optional CLI payload as well as the SDK entrypoint.
        binary_root = app / 'node_modules/@openai/codex-darwin-arm64'
        binaries = list(binary_root.glob('vendor/*/bin/codex')) + list(binary_root.glob('vendor/*/codex/codex'))
        if len(binaries) != 1:
            raise AssertionError('Expected exactly one installed native Codex CLI binary')
        if len(binaries) == 1:
            binary = binaries[0].resolve()
            if not binary.is_relative_to(app.resolve()):
                raise AssertionError('Native CLI binary escaped the installed consumer')
            report['liveCodex']['nativeCliBinarySha256'] = hashlib.sha256(binary.read_bytes()).hexdigest()
            report['liveCodex']['nativeCliWithinConsumer'] = True
    return report


def verify_starter_helpers(fixture):
    starter = fixture._starter('native-repository')
    archive = fixture.release / starter['file']
    paths = ('package.json', 'verify-install.mjs', 'harnesses.mjs')
    with tarfile.open(archive, 'r:gz') as source:
        files = [dict(path=name, sha256=hashlib.sha256(source.extractfile(
            starter['directory'] + '/' + name).read()).hexdigest()) for name in paths]
    return dict(releaseArchiveSha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
                ownManifestPresent=True, installedVerifierUsed=True,
                files=files)


def remove_one_use_sdk_config(path, live_evidence):
    """Remove only our one-use configuration after a normally completed, drained SDK run."""
    if not (live_evidence and live_evidence.get('turnCompleted') is True
            and live_evidence.get('facts', {}).get('confirmedStopped') is True
            and live_evidence.get('cleanupAfter') == 'normal-sdk-stream-exhaustion-awaits-codex-exec-exit'):
        return False
    path.unlink(missing_ok=True)
    return not path.exists()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--live-codex', action='store_true', help='Explicitly authorized paid native Codex qualification')
    parser.add_argument('--report', type=Path, help='Write sanitized public acceptance JSON')
    args = parser.parse_args()
    if args.output.resolve().is_relative_to(Path(__file__).resolve().parents[3]):
        parser.error('--output must be physically outside the source checkout')
    payload = dict(schemaVersion=1, files=[
        dict(path='instructions.md', kind='instruction', text='Keep payment retries request-scoped.\nINSTRUCTION-MARKER: ' + secrets.token_hex(16) + '\n'),
        dict(path='skills/retry-review/SKILL.md', kind='skill', text='---\nname: retry-review\ndescription: Check payment retry identity.\n---\nPreserve request identity.\nSKILL-MARKER: ' + secrets.token_hex(16) + '\n'),
        dict(path='memory/selected.md', kind='memory', text='SELECTED-MEMORY-' + secrets.token_hex(16) + '\n'),
        dict(path='memory/withheld.md', kind='memory', text='WITHHELD-CANARY-' + secrets.token_hex(16) + '\n'),
    ])
    checkout = Path(__file__).resolve().parents[3]
    enclosing_files = {name: (checkout / name).read_bytes() for name in
                       ('package.json', 'package-lock.json', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb')
                       if (checkout / name).is_file()}
    with PersonaFixture('plugin-author', args.output) as fixture:
        fixture.write_json('criteria-before-execution.json', dict(schemaVersion=1, criteria=[
            'actual-service-pinned-content-read-and-installed-release',
            'all-four-plugins-owned-child-source-resources-tests-retained-patch',
            'source-conflicts-and-withheld-memory-exclusion',
            'uncertain-child-quarantine-and-reaped-recovery',
            'installed-native-manifest-verifier-and-explicit-runtime-helper',
            'source-unchanged-deterministic-no-provider-calls',
            *(['authorized-one-fresh-codex-0.169.0-gpt-6-luna-turn-bounded-110s'] if args.live_codex else [])]))
        setup = fixture.bootstrap(payload, name='Plugin author native source task')
        root = '/v1/workspaces/' + fixture.project
        integration = fixture.h.call('POST', root + '/connections', dict(
            bundleId=setup['bundle']['id'], channel='stable', displayName='Disposable plugin author reader'))
        credential = fixture.h.call('POST', root + '/connections/' + integration['id'] + '/credentials', dict(kind='content-read'))
        starter_proof = verify_starter_helpers(fixture)
        app = fixture.install_js(starter='native-repository', plugin='codex')
        test_repository = checkout / 'examples/native-repository/test/fixture'
        shutil.copytree(test_repository, app / 'fixture')
        starter_proof['consumerRepositoryFiles'] = {
            str(path.relative_to(test_repository)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(test_repository.rglob('*')) if path.is_file()
        }
        for entry in starter_proof['files']:
            # npm deliberately adds dependency declarations to the archive's own manifest.
            if entry['path'] != 'package.json' and hashlib.sha256((app / entry['path']).read_bytes()).hexdigest() != entry['sha256']:
                raise AssertionError('Installed starter helper differs from release bytes')
        fixture._install(['npm', 'install', '--prefix', str(app), '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
                          *map(str, (fixture._package('@acclimate/' + harness + '-plugin') for harness in ('claude', 'pi', 'cursor')))], app)
        (app / 'persona-preflight.mjs').write_text(PREFLIGHT)
        packages = ['@acclimate/sdk', *('@acclimate/' + harness + '-plugin' for harness in ('codex', 'claude', 'pi', 'cursor'))]
        installation = fixture.run(['node', 'persona-preflight.mjs', json.dumps(packages)], app)
        installation['releaseArchiveByteVerification'] = [fixture._verify_npm_package(app, fixture._package(package)) for package in packages]
        state = fixture.root / 'state'
        for directory in (state, state / 'workspaces', state / 'jobs', state / 'artifacts'):
            directory.mkdir(mode=0o700)
        config = fixture.write_json('private/native-config.json', dict(
            baseUrl=fixture.base_url, workspaceId=fixture.project, scope='plugin-author-content-reader',
            readToken=credential['secret'], bundleId=setup['bundle']['id'], versionId=setup['version']['id'],
            digest=setup['version']['digest'], stateRoot=str(state)))
        (app / 'persona-child.mjs').write_text(CHILD)
        (app / 'persona-consumer.mjs').write_text(CONSUMER)
        # TMPDIR is set on the dedicated process before any plugin import.
        launcher = "import {spawn} from 'node:child_process';const child=spawn(process.execPath,['persona-consumer.mjs',process.argv[2]],{env:{...process.env,TMPDIR:process.argv[3]},stdio:'inherit'});child.once('exit',code=>{process.exitCode=code??1;});"
        (app / 'persona-launch.mjs').write_text(launcher)
        evidence = fixture.run(['node', 'persona-launch.mjs', config, state / 'workspaces'], app)
        evidence['installation'] = installation
        evidence['nativeStarter'] = starter_proof
        if args.live_codex:
            fixture._install(['npm', 'install', '--prefix', str(app), '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '@openai/codex-sdk@0.169.0'], app)
            evidence['liveInstallation'] = fixture.run(['node', 'persona-preflight.mjs', json.dumps([*packages, '@openai/codex-sdk'])], app)
            evidence['liveInstallation']['releaseArchiveByteVerification'] = [fixture._verify_npm_package(app, fixture._package(package)) for package in packages]
            runtime_policy = dict(
                revision='plugin-persona-gap-retest-v1:explicit-env-config:fresh-session:110s',
                model='gpt-6-luna', sdkVersion='0.169.0', turnTimeoutMilliseconds=110000,
                environmentNames=sorted(fixture.sdk_env),
                environmentProvenance='support.PersonaFixture.sdk_env-explicit-allowlist',
                config=dict(model_reasoning_effort='low'), configOverrides=[],
                configProvenance='acceptance-script-explicit-structured-config',
                thread=dict(sandboxMode='workspace-write', approvalPolicy='never', networkAccessEnabled=False, webSearchMode='disabled', modelReasoningEffort='low'),
                ambientConfigIsolationProven=False)
            runtime_policy['declarationSha256'] = hashlib.sha256(json.dumps(runtime_policy, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            private_live_config = json.loads(config.read_text())
            private_live_config.update(sdkEnv=fixture.sdk_env, runtimePolicy=runtime_policy)
            live_config = fixture.write_json('private/live-native-config.json', private_live_config)
            (app / 'persona-live-codex.mjs').write_text(LIVE_CODEX)
            (app / 'persona-live-launch.mjs').write_text(launcher.replace('persona-consumer.mjs', 'persona-live-codex.mjs'))
            live_evidence = None
            try:
                # A returned JSON result means the owned launcher subprocess drained.
                live_evidence = fixture.run(['node', 'persona-live-launch.mjs', live_config, state / 'workspaces'], app)
                evidence['liveCodex'] = live_evidence
            finally:
                removed = remove_one_use_sdk_config(live_config, live_evidence)
                fixture.write_json('private/runtime-config-cleanup.json', dict(
                    schemaVersion=1, oneUseSdkConfigurationRemoved=removed,
                    authorization='normally-completed-sdk-turn-and-confirmed-stop' if removed else 'normal-sdk-completion-not-confirmed',
                    globalAuthenticationFilesTouched=False))
                if live_evidence is not None:
                    live_evidence['oneUseSdkConfigurationRemovedAfterNormalCompletion'] = removed
            evidence['nativeStarter']['installedCodexRuntimeInputsUsed'] = True
        assert all((checkout / name).read_bytes() == content for name, content in enclosing_files.items()), 'Enclosing manifest/lockfile changed'
        fixture.verify_release_unchanged()
        assert hashlib.sha256(fixture.service_binary.read_bytes()).hexdigest() == fixture.service_sha256
        evidence.update(enclosingManifestsAndLockfilesUnchanged=True, serviceBinarySha256=fixture.service_sha256,
                        releaseSourceInventorySha256=fixture.manifest['source']['sha256'],
                        releaseManifestSha256=fixture.release_manifest_sha256,
                        releaseChecksumsSha256=fixture.release_checksums_sha256,
                        binarySourceBuildAttested=False,
                        consumerSource='checksummed-native-repository-archive-and-release-tarballs',
                        consumerScriptSha256=hashlib.sha256(CONSUMER.encode()).hexdigest(),
                        childScriptSha256=hashlib.sha256(CHILD.encode()).hexdigest(),
                        consumerExit=0,
                        liveProviderBehavior='qualified-only-as-recorded-in-liveCodex' if args.live_codex else 'unrun-explicit-live-flag-not-supplied')
        fixture.write_json('evidence.json', evidence)
        evidence_path = fixture.root / 'evidence.json'
    report = public_evidence(evidence, fixture.root, app)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(dict(evidencePath=str(evidence_path), **report)))


if __name__ == '__main__':
    main()
