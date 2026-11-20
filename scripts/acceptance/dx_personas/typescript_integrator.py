#!/usr/bin/env python3
"""Own compiled TypeScript adopter app against an installed, checksummed release.

No SDK source imports, provider calls, builds, or public service writes.
ResponseLossProxy is explicitly a transport fault fixture forwarding real HTTP.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from scripts.acceptance.dx_personas.support import PersonaFixture
from scripts.packaging.qualify_dx import ResponseLossProxy, replace_private_json


# Defined before starting any consumer command. These are this persona's own bar.
CRITERIA = {
    'installed_typescript': 'Compile a strict external TS app importing only installed public SDK entry points.',
    'meaningful_pair': 'Saved support-ticket cases, versioned instructions, and independent grading produce measurable candidate improvement.',
    'bound_request': 'Describe the installed app, freeze that descriptor in a real immutable request, and finish its paired evaluation.',
    'callback_lifetime': 'Task/expected/output/bundle copies stay isolated; prepared content remains readable across await and is cleaned after execution.',
    'durable_retry': 'Lose a real committed comparison response; retain request/attempt/comparison identity and add no callbacks on replay.',
    'diagnostics': 'A changed dataset revision identifies that field before callbacks run.',
    'review_handoff': 'Explicitly redact selected roles, copy a portable export with independently retained trusted handoff, delete journals, and verify in an independent read-only process; identify physical-host limits.',
    'derived_manifest': 'Derive one captured case inventory from actual private cases, grader source, compiled artifacts and used settings; roundtrip and mutate each identity input.',
    'public_helpers': 'Strictly compile and run installed manifest/progress/analysis public subpaths, with import boundaries and type contracts.',
}

APP = r'''import { appendFile, readFile, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareFiles, AcclimateClient } from '@acclimate/sdk';
import { createHash } from 'node:crypto';
import { createEvaluationManifest, restoreEvaluationManifest, type EvaluationManifestInput } from '@acclimate/sdk/evaluation/manifest';
import { createEvaluationProgressReporter, type EvaluationProgressUpdate } from '@acclimate/sdk/evaluation/progress';
import { analyzeComparison, type AnalysisOptions } from '@acclimate/sdk/evaluation/analysis';
import { gradeTask } from './grader.js';
import { defineEvaluation, type EvaluationCase, type Json } from '@acclimate/sdk/evaluation';
import { evaluationMain } from '@acclimate/sdk/evaluation/cli';

type Input = { text: string; visited: string[] };
type Expected = { priority: string; visited: string[] };
type Output = { priority: string; versionId: string; digest: string; lifetimeRead: boolean; cleaned: boolean };
const cases: EvaluationCase<Input, Expected>[] = JSON.parse(await readFile('saved-cases.json', 'utf8'));
const audit = async (value: Json) => appendFile('callbacks.ndjson', JSON.stringify(value) + '\n', { mode: 0o600 });
const hash = (bytes: string | Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const settings = { app: 'ticket-router-ts-2', model: 'none', tools: 'private-files-only', urgencyPattern: '\\burgent\\b', negationPattern: '\\bnot urgent\\b' };
const manifestInput: EvaluationManifestInput<Input, Expected> = {
  configId: 'ticket-priority-typescript', execution: 'model-free', cases,
  grader: { sourceUtf8: await readFile('grader.ts', 'utf8') },
  runtime: { settings, artifacts: {
    'app.js': hash(await readFile(new URL('./app.js', import.meta.url))),
    'grader.js': hash(await readFile(new URL('./grader.js', import.meta.url))),
  } },
};
const manifest = createEvaluationManifest(manifestInput);
await writeFile('private-manifest.json', manifest.privateManifestJson, { mode: 0o600 });
const flag = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const config = process.argv.includes('--config') ? JSON.parse(await readFile(flag('--config'), 'utf8')) : null;
const target = process.argv.includes('--handoff') ? JSON.parse(await readFile(flag('--handoff'), 'utf8')) : null;
const progressClient = config ? new AcclimateClient({ baseUrl: config.serviceUrl, token: config.evaluatorToken, scope: config.evaluatorPrincipalId }) : null;
let sequence = 0;
if (false) {
  // @ts-expect-error Progress has a closed public phase union.
  const badPhase: EvaluationProgressUpdate = { sequence: 1, phase: 'private', completed: 0, total: 1 };
  // @ts-expect-error Analysis requires an independently supplied expected binding.
  const badAnalysis: AnalysisOptions = { comparison: {}, expectedDescriptor: manifest.descriptor };
  void badPhase; void badAnalysis;
}
const app = defineEvaluation<Input, Expected, Output>({
  ...manifest.definition,
  datasetRevision: process.argv.includes('--changed-dataset') ? 'changed-private-dataset' : manifest.definition.datasetRevision,
  execute: async args => {
    const { version, input, context, signal } = args;
    signal.throwIfAborted();
    if ('expected' in args || input.visited.length || !Object.isFrozen(context)) throw Error('isolation');
    input.visited.push('mutated locally');
    const prepared = await prepareFiles(version, path.join(context.privateJobDirectory, 'prepared'));
    const instruction = prepared.files.find(f => f.kind === 'instruction')!;
    let lifetimeRead = false;
    let priority = '';
    try {
      await new Promise(resolve => setTimeout(resolve, 8));
      signal.throwIfAborted();
      const policy = await readFile(instruction.absolutePath, 'utf8');
      lifetimeRead = policy.includes('Ticket priority policy');
      if (!lifetimeRead || policy.includes('MUTATED')) throw Error('bundle isolation');
      const urgent = new RegExp(settings.urgencyPattern, 'i').test(input.text);
      const negated = new RegExp(settings.negationPattern, 'i').test(input.text);
      priority = urgent && !(policy.includes('Respect negated urgency') && negated) ? 'high' : 'normal';
      // The next side/repetition must still receive the original verified content.
      version.payload.files[0]!.text = 'MUTATED only within this callback';
    } finally { await prepared.cleanup(); }
    let cleaned = false;
    try { await access(instruction.absolutePath); } catch { cleaned = true; }
    if (!cleaned) throw Error('cleanup');
    const output = { priority, versionId: version.version.id, digest: version.version.digest, lifetimeRead, cleaned };
    const reporter = createEvaluationProgressReporter(progressClient!, {
      workspaceId: target.workspaceId, bundleId: target.bundleId, requestId: context.requestId, attemptId: context.attemptId,
    });
    const progressReported = await reporter.report({ sequence: ++sequence, phase: 'executing', completed: sequence, total: 12,
      case: { caseId: args.caseId, repetition: args.repetition } });
    await audit({ event: 'execute', side: context.side, caseId: args.caseId, repetition: args.repetition,
      requestId: context.requestId, attemptId: context.attemptId, versionId: output.versionId,
      digest: output.digest, lifetimeRead, cleaned, progressReported, inputWasClean: true, expectedAbsent: true });
    return { output, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  },
  grade: gradeTask,
});

if (process.argv[2] === 'manifest-check') {
  const restored = restoreEvaluationManifest<Input, Expected>(manifest.privateManifestJson);
  const mutate = (change: (value: EvaluationManifestInput<Input, Expected>) => void) => {
    const value = structuredClone(manifestInput); change(value); return createEvaluationManifest(value).descriptor;
  };
  const changes = {
    input: mutate(x => { x.cases[0]!.input.text += ' altered'; }),
    expected: mutate(x => { x.cases[0]!.expected.priority = 'altered'; }),
    grader: mutate(x => { x.grader = { sourceUtf8: 'changed grader source' }; }),
    build: mutate(x => { x.runtime.artifacts['app.js'] = hash('different compiled artifact'); }),
    settings: mutate(x => { x.runtime.settings.urgencyPattern = 'different'; }),
  };
  const publicText = JSON.stringify(manifest.descriptor);
  if (JSON.stringify(restored.descriptor) !== publicText || JSON.stringify(app.descriptor) !== publicText) throw Error('manifest roundtrip/definition');
  for (const [name, changed] of Object.entries(changes)) {
    if (changed.runtime.configRevision === manifest.descriptor.runtime.configRevision) throw Error('unchanged identity ' + name);
  }
  if (publicText.includes(cases[0]!.input.text) || publicText.includes('sourceUtf8')) throw Error('private manifest leak');
  const boundaries = [];
  for (const specifier of ['@acclimate/sdk/dist/evaluation/manifest.js', '@acclimate/sdk/src/evaluation/progress.ts']) {
    try { await import(specifier); throw Error('internal import accepted'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; boundaries.push(specifier); }
  }
  console.log(JSON.stringify({ descriptor: manifest.descriptor, roundtrip: true, definitionMatches: true, mutations: changes, deniedInternalImports: boundaries,
    privateManifestSha256: hash(manifest.privateManifestJson), publicDescriptorHasPrivatePlaintext: false }));
} else if (process.argv[2] === 'analysis-check') {
  const evidence = JSON.parse(await readFile('analysis-input.json', 'utf8'));
  console.log(JSON.stringify(analyzeComparison({ ...evidence, expectedDescriptor: app.descriptor })));
} else process.exitCode = await evaluationMain(app, process.argv.slice(2).filter(x => x !== '--changed-dataset'), {
  review: { toReviewArtifact: async ({ identity, value }) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const released: Record<string, Json> = identity.role === 'output'
      ? { priority: value.priority, versionId: value.versionId, digest: value.digest }
      : { observed: value.observed, expected: value.expected, matched: value.matched };
    return { mediaType: 'application/json', value: released };
  } },
});
'''


GRADER = r'''import { appendFile } from 'node:fs/promises';
import type { EvaluationDefinition } from '@acclimate/sdk/evaluation';
type Input = { text: string; visited: string[] };
type Expected = { priority: string; visited: string[] };
type Output = { priority: string; versionId: string; digest: string; lifetimeRead: boolean; cleaned: boolean };
export const gradeTask: EvaluationDefinition<Input, Expected, Output>['grade'] = async ({ output, expected, caseId, repetition }) => {
  if (expected.visited.length) throw Error('expected isolation');
  const matched = output.priority === expected.priority;
  expected.visited.push('mutated by grader');
  const observed = output.priority;
  output.priority = 'MUTATED by grader';
  await appendFile('callbacks.ndjson', JSON.stringify({ event: 'grade', caseId, repetition, expectedWasClean: true, observed, matched }) + '\n', { mode: 0o600 });
  return { reward: Number(matched), explanation: { observed, expected: expected.priority, matched } };
};
'''


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    with PersonaFixture('typescript-integrator', args.output) as f:
        (f.root / 'private').chmod(0o700)
        f.write_json('private/criteria-before-execution.json', CRITERIA)
        baseline = {'schemaVersion': 1, 'files': [{'path': 'routing/policy.md', 'kind': 'instruction',
            'text': 'Ticket priority policy: route tickets containing urgent to high priority; others to normal.'}]}
        candidate = {'schemaVersion': 1, 'files': [{'path': 'routing/policy.md', 'kind': 'instruction',
            'text': 'Ticket priority policy: Respect negated urgency. A ticket saying not urgent is normal; other urgent tickets are high.'}]}
        setup = f.bootstrap(baseline, name='TypeScript support-ticket routing acceptance')
        bundle = setup['bundle']['id']
        app = f.install_js(name='own-typescript-app')
        # The archive is the documented offline installer; no starter application code is used.
        for item in app.iterdir():
            if item.name not in ('node_modules', 'package.json', 'package-lock.json'):
                if item.is_dir(): shutil.rmtree(item)
                else: item.unlink()
        typescript = ROOT / 'node_modules/typescript'
        assert json.loads((typescript / 'package.json').read_text())['version'] == '5.9.3'
        shutil.copytree(typescript, app / 'node_modules/typescript')
        (app / 'node_modules/@types').mkdir(exist_ok=True)
        shutil.copytree(ROOT / 'node_modules/@types/node', app / 'node_modules/@types/node')
        shutil.copytree(ROOT / 'node_modules/undici-types', app / 'node_modules/undici-types')
        (app / 'app.ts').write_text(APP)
        (app / 'grader.ts').write_text(GRADER)
        f.write_json(app / 'tsconfig.json', {'compilerOptions': {'strict': True, 'target': 'ES2022',
            'module': 'NodeNext', 'moduleResolution': 'NodeNext', 'outDir': 'dist', 'skipLibCheck': True},
            'include': ['app.ts', 'grader.ts']})
        cases = [{'caseId': case, 'repetitions': 2, 'input': {'text': text, 'visited': []},
                  'expected': {'priority': expected, 'visited': []}}
                 for case, text, expected in [('outage', 'Urgent: service is down', 'high'),
                     ('negated', 'Not urgent: weekly usage digest', 'normal'),
                     ('routine', 'Please update my mailing address', 'normal')]]
        f.write_json(app / 'saved-cases.json', cases)
        f.write_json(app / 'candidate.json', candidate)
        policy = {'schemaVersion': 1, 'id': 'ticket-routing-quality', 'revision': '1',
            'metric': {'name': 'correct routing', 'unit': 'reward', 'direction': 'higher'},
            'aggregation': 'equal-case-means', 'minimumMeanImprovement': 0.3,
            'maximumCaseRegression': 0, 'candidateThreshold': 1,
            'requiredCases': ['outage', 'negated', 'routine'], 'maximumCandidateTaskFailures': 0,
            'cost': {'maximumCandidateUsd': 0},
            # Three saved cases: a point-estimate check; the paired-t default needs 10.
            'inference': {'method': 'none'}}
        f.write_json(app / 'quality-policy.json', policy)
        f.run(['node', 'node_modules/typescript/bin/tsc', '--project', 'tsconfig.json'], cwd=app)
        command = ['node', 'dist/app.js']
        descriptor = f.run(command + ['describe'], cwd=app)
        assert len(descriptor['expectedCases']) == 6
        manifest_check = f.run(command + ['manifest-check'], cwd=app)
        proxy = ResponseLossProxy(f.h)  # FAULT FIXTURE: forwards real service HTTP, drops committed responses.
        try:
            config = json.loads(f.evaluator_config.read_text())
            config['serviceUrl'] = proxy.base
            replace_private_json(f.evaluator_config, config)
            reader = json.loads(f.reader_config.read_text())
            reader['serviceUrl'] = proxy.base
            replace_private_json(f.reader_config, reader)
            handoff = app / 'handoff.json'
            f.run(command + ['doctor', '--config', f.evaluator_config, '--bundle', bundle,
                            '--policy', app / 'quality-policy.json'], cwd=app)
            creation = ['request', '--config', f.evaluator_config, '--bundle', bundle, '--channel', 'stable',
                '--payload', app / 'candidate.json', '--intent', f.root / 'private/intent.json', '--out', handoff]
            f.run(command + creation, cwd=app)
            frozen = json.loads(handoff.read_text())
            target = ['--config', f.evaluator_config, '--handoff', handoff]
            # A local descriptor change must be caught before starting any application callbacks.
            assert not (app / 'callbacks.ndjson').exists()
            f.run(command + ['run', *target, '--changed-dataset'], cwd=app, expected=1)
            diagnostic_log = sorted((f.root / 'private/commands').glob('*.stderr'))[-1]
            diagnostic = json.loads(diagnostic_log.read_text())['error']
            assert diagnostic['code'] == 'descriptor.mismatch'
            assert diagnostic['mismatchFields'] == ['datasetRevision']
            assert diagnostic['executionState'] == 'not_started'
            assert not (app / 'callbacks.ndjson').exists()
            f.run(command + ['run', *target], cwd=app)
            callbacks = (app / 'callbacks.ndjson').read_bytes()
            events = [json.loads(line) for line in callbacks.splitlines()]
            executions = [e for e in events if e['event'] == 'execute']
            grades = [e for e in events if e['event'] == 'grade']
            assert len(executions) == len(grades) == 12
            assert all(e['lifetimeRead'] and e['cleaned'] and e['expectedAbsent'] for e in executions)
            assert all(e['expectedWasClean'] for e in grades)
            route = '/v1/workspaces/' + f.project + '/bundles/' + bundle + '/evaluation-requests/' + frozen['requestId']
            first = f.h.call('GET', route, actor='evaluator')
            assert first['status'] == 'completed'
            assert {e['attemptId'] for e in executions} == {first['attemptId']}
            losses = proxy.snapshot()
            assert set(losses) == {'draft', 'request', 'start', 'submit', 'finish'}
            assert losses['submit']['id'] == first['comparisonId']
            assert losses['request']['id'] == frozen['requestId']
            check = f.run(command + ['check', *target, '--policy', app / 'quality-policy.json'], cwd=app)
            comparison = f.h.call('GET', '/v1/workspaces/' + f.project + '/bundles/' + bundle + '/comparisons/' + first['comparisonId'], actor='evaluator')
            f.write_json(app / 'analysis-input.json', {'comparison': comparison, 'expectedBinding': check['expectedBinding']})
            analysis = f.run(command + ['analysis-check'], cwd=app)
            assert analysis['metrics'][0]['counts']['comparablePairs'] == 6
            assert analysis['metrics'][0]['uncertainty']['status'] == 'not_requested'
            assert all(event['progressReported'] for event in executions)
            progress = f.h.call('GET', route + '/progress', actor='viewer')
            assert progress['requestId'] == first['id']

            f.h.sql("UPDATE idempotency SET expires_at=now()-interval '25 hours'")
            f.run(command + ['run', *target], cwd=app)
            second = f.h.call('GET', route, actor='evaluator')
            assert (first['id'], first['attemptId'], first['comparisonId']) == (second['id'], second['attemptId'], second['comparisonId'])
            assert (app / 'callbacks.ndjson').read_bytes() == callbacks
            indexes = list((f.root / 'private/journals').glob('*/artifact-index.json'))
            assert len(indexes) == 1
            index = json.loads(indexes[0].read_text())
            output_entries = [e for e in index['entries'] if e['role'] == 'output']
            assert len(output_entries) == 12
            for entry in output_entries:
                output = json.loads((indexes[0].parent / entry['file']).read_text())['value']
                assert output['priority'] in ('high', 'normal')  # grader mutations did not overwrite retained output
            selection = {'schemaVersion': 1, 'entries': [
                {'caseId': 'negated', 'repetition': 0, 'side': 'parent', 'role': role, 'required': True}
                for role in ('output', 'grader-explanation')]}
            f.write_json(app / 'selection.json', selection)
            exported = f.root / 'private/shared-failed-case'
            f.run(command + ['export', *target, '--selection', app / 'selection.json', '--out', exported], cwd=app)
            # Retain trusted request identity separately before exporting. This is same-host
            # process isolation and byte-preserving copy, never physical-host evidence.
            reader_app = f.consumer_root / 'independent-reader'
            reader_app.mkdir(mode=0o700)
            copied = reader_app / 'downloaded-review'
            shutil.copytree(exported, copied)
            trusted_handoff = reader_app / 'independently-retained-request.json'
            shutil.copyfile(handoff, trusted_handoff)
            trusted_handoff.chmod(0o600)
            original_files = {str(p.relative_to(exported)): digest(p) for p in exported.rglob('*') if p.is_file()}
            copied_files = {str(p.relative_to(copied)): digest(p) for p in copied.rglob('*') if p.is_file()}
            assert original_files == copied_files
            export_manifest = json.loads((copied / 'manifest.json').read_text())
            roles = [role for entry in export_manifest['entries'] for role in entry['roles'] if role['availability'] == 'exported']
            assert {role['role'] for role in roles} == {'output', 'grader-explanation'}
            for role in roles:
                value = json.loads((copied / role['file']['path']).read_text())
                expected_fields = {'priority', 'versionId', 'digest'} if role['role'] == 'output' else {'observed', 'expected', 'matched'}
                assert set(value) == expected_fields
            shutil.rmtree(f.root / 'private/journals')
            assert not (f.root / 'private/journals').exists()
            # Independent Node process/cwd, only public installed verification API.
            reader_source = "import { verifyReviewExport } from '@acclimate/sdk/evaluation/artifacts'; console.log(JSON.stringify(await verifyReviewExport({manifestPath:process.argv[2],online:{readConfigPath:process.argv[3],expectedHandoff:JSON.parse(await (await import('node:fs/promises')).readFile(process.argv[4],'utf8'))}})));"
            (app / 'reader.mjs').write_text(reader_source)
            verified = f.run(['node', app / 'reader.mjs', copied / 'manifest.json', f.reader_config, trusted_handoff], cwd=reader_app)

            assert verified['provenance'] == 'online_scalar_binding'
            assert verified['executionAttested'] is False
            command_summaries = [json.loads(p.read_text()) for p in sorted((f.root / 'private/commands').glob('*.json'))
                                 if p.stem.isdigit()]
            report = {'schemaVersion': 1, 'persona': 'typescript-integrator', 'date': '2026-11-17',
                'criteriaDefinedBeforeExecution': CRITERIA,
                'criteria': {key: 'accepted' for key in CRITERIA},
                'releaseSourceInventorySha256': f.manifest['source']['sha256'],
                'releaseManifestSha256': f.release_manifest_sha256, 'releaseChecksumsSha256': f.release_checksums_sha256,
                'installationProofs': f.installation_proofs, 'physicallyExternalConsumer': not app.resolve().is_relative_to(ROOT.resolve()),
                'manifestCheck': manifest_check, 'analysis': analysis, 'progress': progress,
                'portableReview': {'separateNodeProcess': True, 'independentWorkingDirectory': True, 'sourceJournalRemoved': True,
                    'separateReadOnlyPrincipal': True, 'trustedHandoffSha256': digest(trusted_handoff), 'copiedFileHashes': copied_files,
                    'physicalSecondMachine': False, 'trustScope': 'same-host independently retained trusted handoff; read-only online scalar binding; artifact self-consistency'},
                'serviceBinarySha256': f.service_sha256, 'binarySourceBuildAttested': False,
                'typescriptVersion': '5.9.3', 'appSourceSha256': digest(app / 'app.ts'),
                'compiledAppSha256': digest(app / 'dist/app.js'), 'savedCasesSha256': digest(app / 'saved-cases.json'),
                'graderSourceSha256': digest(app / 'grader.ts'), 'compiledGraderSha256': digest(app / 'dist/grader.js'),
                'callbackAuditSha256BeforeAndAfterReplay': hashlib.sha256(callbacks).hexdigest(),
                'transientExpiryMethod': "Fixture sets expires_at=now()-interval '25 hours'; no wall-clock 25-hour wait.",
                'blockingGapsWithinExecutedScope': [],
                'descriptor': descriptor, 'requestId': first['id'], 'attemptId': first['attemptId'],
                'comparisonId': first['comparisonId'], 'status': first['status'],
                'callbackCounts': {'execute': len(executions), 'grade': len(grades), 'newOnReplay': 0},
                'lostCommittedResponsePhases': sorted(losses), 'committedComparisonId': losses['submit']['id'],
                'replayBeyondTransientDedupHours': 25, 'policy': check,
                'descriptorMismatch': diagnostic, 'reviewVerification': verified,
                'faultFixture': 'ResponseLossProxy forwarding actual HTTP and dropping successful committed responses once per lifecycle phase',
                'commands': command_summaries,
                'remainingFriction': ['Durable JS runtime requires POSIX and python3 fcntl in addition to Node.',
                    'Release distribution remains operator-managed.',
                    'Physical second-machine execution remains unqualified: no independently established other-host identity/transport was available to this persona; same-host independent-process portable-copy review passed.',
                    'This deterministic content-consuming app makes no model or native harness quality claim.']}
            # Actual local retrieval + reader verification succeeds; remote distribution remains a boundary.
            report['criteria']['review_handoff'] = 'partial'
            report['criteria']['portable_local_handoff'] = 'accepted'
            report['criteria']['physical_second_machine'] = 'partial'
            report['observations'] = observations(report)
            report['scope'] = 'Real isolated PostgreSQL 16/Rust HTTP service; own deterministic installed-package application; model-free.'
            report['limits'] = ['No provider or native harness call; no production mutation.',
                'No minimum Node-version qualification or service binary/source-build attestation.',
                'Only dataset mismatch diagnostics exercised; unauthorized/not-found/transport diagnostic distinctions were not evaluated.',
                'Response-loss fixture retries committed writes within a run; terminal replay is a separate process. No worker kill or cancellation trial.']
            f.verify_release_unchanged()
            f.write_json('private/report.json', report)
            (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
            print(json.dumps({'status': 'passed', 'report': str(args.output / 'report.json'),
                'requestId': first['id'], 'comparisonId': first['comparisonId'], 'callbacks': len(events)}))
        finally:
            proxy.close()
    report['cleanup'] = json.loads((f.root / 'private/cleanup.json').read_text())
    report['cleanup'].pop('servicePid', None)
    (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')


def observations(report):
    return {
        'installed_typescript': 'Strict TypeScript 5.9.3 compiled own app and grader; six installed public SDK subpaths plus root only; internal source/dist imports rejected.',
        'meaningful_pair': report['policy']['summary'],
        'bound_request': {'status': report['status'], 'pairs': report['policy']['counts']['comparablePairs']},
        'callback_lifetime': {'execute': 12, 'grade': 12, 'inputAndExpectedCopiesClean': True,
            'graderOutputMutationAbsentFromRetainedArtifacts': True, 'awaitThenReadThenCleanup': True},
        'durable_retry': {'committedSubmitIdEqualsComparisonId': report['committedComparisonId'] == report['comparisonId'],
            'requestAttemptComparisonIdsUnchanged': True, 'newCallbacksOnReplay': 0},
        'derived_manifest': {'roundtrip': report['manifestCheck']['roundtrip'], 'singleCapturedInventory': report['manifestCheck']['definitionMatches'],
            'mutationIdentityComponents': sorted(report['manifestCheck']['mutations'])},
        'public_helpers': {'strictConsumerTypeContracts': True, 'deniedInternalImports': report['manifestCheck']['deniedInternalImports'],
            'actualComparisonAnalysis': report['analysis']['metrics'][0]['status'], 'progressAcceptedReports': report['progress']['observation']['sequence']},
        'diagnostics': report['descriptorMismatch'],
        'review_handoff': {'localReadOnlyVerification': report['reviewVerification']['status'],
            'crossMachineAuthenticatedTransfer': 'not exercised', 'portableCopyAfterJournalRemoval': report['portableReview']},
    }


if __name__ == '__main__':
    main()
