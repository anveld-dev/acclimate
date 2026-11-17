#!/usr/bin/env python3
"""Independently retest the fresh distributed CI recipe after gap closure."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts.acceptance.dx_personas.support import PersonaFixture
from scripts.packaging.qualify_dx import ResponseLossProxy

CRITERIA = [
    'C1 distributed archive, installed SDK, headless candidate/request/run/check/export',
    'C2 concrete pass/loss/incomplete and required-export failure exit codes',
    'C3 no automatic promotion; inspected bound release, stale rejection, old pin, rollback',
    'C4 copied evidence verified in separately installed reader project after journal removal',
    'C5 same CI intent after committed response loss and synthetic expiry beyond 24h',
    'C6 distributed optional analysis recipe uses installed SDK and remains descriptive',
]


def acceptance(output):
    if not os.environ.get('ACCLIMATE_PERSONA_RELEASE') or not os.environ.get('ACCLIMATE_PERSONA_SOURCE_SHA256'):
        raise ValueError('Fresh retest requires explicit ACCLIMATE_PERSONA_RELEASE and ACCLIMATE_PERSONA_SOURCE_SHA256')
    fixture = PersonaFixture('ci-release-engineer', output)
    with fixture as f:
        # Criteria are persisted before service interaction beyond fixture startup.
        f.write_json('private/personal-criteria.json', CRITERIA)
        setup = f.bootstrap(name='Release engineer private CI acceptance')
        bundle = setup['bundle']['id']
        route = '/v1/projects/' + f.project + '/bundles/' + bundle
        channel = route + '/channels/stable'
        initial = f.h.call('GET', channel)
        ci = f.install_js(name='ci-app', starter='ci')
        app = ci / 'evaluation'
        command = ['node', str(app / 'acclimate-eval.mjs')]
        # Private application-owned executor: make a concrete infrastructure failure
        # reachable through payload bytes while instrumenting execution count.
        agent = app / 'agent.mjs'
        source = agent.read_text()
        source = "import { appendFileSync } from 'node:fs';\n" + source
        source = source.replace("  const reuseKey =", "  appendFileSync(new URL('./execution-count.log', import.meta.url), 'execute\\n', {mode:0o600});\n  if (instruction.includes('CI_INCOMPLETE')) throw new Error('Controlled private fixture infrastructure failure');\n  const reuseKey =")
        agent.write_text(source)
        entry = app / 'acclimate-eval.mjs'
        entry.write_text("import {existsSync} from 'node:fs';\n" + entry.read_text().replace("configRevision: '1'", "configRevision: 'ci-persona-1'").replace("app: 'payment-starter-1'", "app: 'ci-persona-instrumented-1'").replace('toReviewArtifact: async ({ identity, value }) => ({', "toReviewArtifact: async ({ identity, value }) => existsSync(new URL('./deny-review.flag',import.meta.url)) ? null : ({"))
        proxy = ResponseLossProxy(f.h)
        try:
            config = json.loads(f.evaluator_config.read_text())
            config['serviceUrl'] = proxy.base
            config_path = f.write_json('private/config/ci-evaluator.json', config)
            reader = json.loads(f.reader_config.read_text())
            reader['serviceUrl'] = proxy.base
            reader_path = f.write_json('private/config/ci-reader.json', reader)
            evidence = []

            def pipeline(name, payload, expected, target_bundle=bundle):
                result_dir = f.root / 'jobs' / name
                intent = f.root / 'private/intents' / (name + '.json')
                cmd = ['sh', str(ci / 'ci.sh'), '--config', str(config_path), '--bundle', target_bundle,
                       '--intent', str(intent), '--output-dir', str(result_dir), '--payload', str(payload)]
                f._execute(cmd, ci, expected, parse_json=False)
                handoff = json.loads((result_dir / 'evaluation-request.json').read_text())
                request = f.h.call('GET', '/v1/projects/' + f.project + '/bundles/' + target_bundle + '/evaluation-requests/' + handoff['requestId'], actor='evaluator')
                return result_dir, handoff, request, cmd

            passed_dir, passed_handoff, passed, retry_cmd = pipeline('passing', app / 'candidate.json', 0)
            phases = proxy.snapshot()
            assert set(phases) == {'draft', 'request', 'start', 'submit', 'finish'}
            assert passed['status'] == 'completed'
            assert phases['request']['id'] == passed['id'] == phases['start']['id'] == phases['finish']['id']
            assert phases['submit']['id'] == passed['comparisonId']
            before_count = len((app / 'execution-count.log').read_text().splitlines())
            assert before_count == 4
            before_handoff = (passed_dir / 'evaluation-request.json').read_bytes()
            f.h.sql("UPDATE idempotency SET expires_at=now()-interval '25 hours'")
            f._execute(retry_cmd, ci, 0, parse_json=False)
            assert (passed_dir / 'evaluation-request.json').read_bytes() == before_handoff
            replayed = f.h.call('GET', route + '/evaluation-requests/' + passed['id'], actor='evaluator')
            assert replayed['comparisonId'] == passed['comparisonId']
            assert len((app / 'execution-count.log').read_text().splitlines()) == before_count
            target = ['--config', str(config_path), '--handoff', str(passed_dir / 'evaluation-request.json')]
            verdict = f.run(command + ['check', *target, '--policy', str(app / 'quality-policy.json')], cwd=app)
            evidence.append(dict(id='CI-PASS-REPLAY', exitCodes=[0, 0], requestId=passed['id'], comparisonId=passed['comparisonId'],
                                 lostCommittedPhases=sorted(phases), committedResponseIds=phases, transientDedupAgeHours=25,
                                 executionCallsBefore=before_count, executionCallsAfter=before_count, verdict=verdict))
            losing_payload = f.write_json('private/losing.json', json.loads((app / 'baseline.json').read_text()))
            losing_setup = f.bootstrap(payload=json.loads((app / 'candidate.json').read_text()), name='Known-good baseline for concrete regression')
            losing_dir, losing_handoff, losing, _ = pipeline('losing', losing_payload, 2, losing_setup['bundle']['id'])
            assert losing['status'] == 'completed'
            losing_verdict = f.run(command + ['check', '--config', str(config_path), '--handoff', str(losing_dir / 'evaluation-request.json'), '--policy', str(app / 'quality-policy.json')], cwd=app, expected=2)
            assert losing_verdict['summary']['orientedMeanImprovement'] < 0
            evidence.append(dict(id='CI-LOSING', exitCode=2, requestId=losing['id'], comparisonId=losing['comparisonId'], status=losing['status'], verdict=losing_verdict))
            incomplete_payload = f.write_json('private/incomplete.json', dict(schemaVersion=1, files=[dict(path='instructions.md',kind='instruction',text='CI_INCOMPLETE')]))
            incomplete_dir, _, incomplete, _ = pipeline('incomplete', incomplete_payload, 2)
            assert incomplete['status'] == 'failed'
            incomplete_verdict = f.run(command + ['check', '--config', str(config_path), '--handoff', str(incomplete_dir / 'evaluation-request.json'), '--policy', str(app / 'quality-policy.json')], cwd=app, expected=3)
            evidence.append(dict(id='CI-INCOMPLETE', exitCode=2, checkExitCode=3, requestId=incomplete['id'], comparisonId=incomplete['comparisonId'], status=incomplete['status'], verdict=incomplete_verdict))
            (app / 'deny-review.flag').write_text('Private application declines required review artifact')
            failed_export_dir, _, export_request, _ = pipeline('required-export-unavailable', app / 'candidate.json', 3)
            assert export_request['status'] == 'completed'
            assert not list(failed_export_dir.glob('review-*/manifest.json'))
            evidence.append(dict(id='CI-EXPORT-FAILURE', exitCode=3, requestId=export_request['id'], comparisonId=export_request['comparisonId'], status=export_request['status'], committedManifestCount=0))
            assert f.h.call('GET', channel) == initial
            evidence.append(dict(id='NO-AUTOPROMOTION', channelRevision=initial['revision'], versionId=initial['version']['id']))

            # App-owned release inspection uses service-bound immutable versions and comparison.
            comparison = f.h.call('GET', route + '/comparisons/' + passed['comparisonId'])
            assert comparison['candidateVersionId'] == passed['candidateVersionId']
            assert comparison['candidateDigest'] == passed['candidateDigest']
            assert comparison['parentVersionId'] == initial['version']['id']
            assert comparison['evaluation']['requestId'] == passed['id']
            assert comparison['complete'] is True
            assert verdict['summary']['orientedMeanImprovement'] >= 0.25
            # The newly distributed recipe analyzes already saved evidence only.
            # This deterministic fixture deliberately supplies no stochastic protocol.
            analysis_files = ['ANALYSIS.md', 'analyze.mjs', 'analyze.py']
            assert all((app / filename).is_file() for filename in analysis_files)
            descriptor_script = app / 'descriptor.mjs'
            descriptor_script.write_text("import {app} from './acclimate-eval.mjs'; console.log(JSON.stringify(app.descriptor));\n")
            descriptor = f.run(['node', str(descriptor_script)], cwd=app)
            analysis_comparison = f.write_json('private/analysis/comparison.json', comparison)
            analysis_descriptor = f.write_json('private/analysis/descriptor.json', descriptor)
            analysis_binding = f.write_json('private/analysis/trusted-binding.json', verdict['expectedBinding'])
            analysis = f.run(['node', str(app / 'analyze.mjs'), str(analysis_comparison), str(analysis_descriptor), str(analysis_binding)], cwd=app)
            assert analysis['interpretation'] == 'app-asserted-fixed-case-analysis'
            assert analysis['executionAttested'] is False and analysis['uncertaintyProtocol'] is None
            assert all(metric['status'] == 'descriptive' and metric['uncertainty']['status'] == 'not_requested'
                       and metric['uncertainty']['interval'] is None for metric in analysis['metrics'])
            assert analysis['metrics'][0]['summary']['orientedMeanImprovement'] == 0.5
            analysis_result = f.write_json('private/analysis/result.json', analysis)
            evidence.append(dict(id='OPTIONAL-DESCRIPTIVE-ANALYSIS', exitCode=0, result=analysis,
                                 resultSha256=hashlib.sha256(analysis_result.read_bytes()).hexdigest(),
                                 sourceRecipeSha256={filename:hashlib.sha256((app / filename).read_bytes()).hexdigest() for filename in analysis_files},
                                 automaticConfidenceGate=False, stochasticProtocolSupplied=False))
            parent_version = f.h.call('GET', route + '/versions/' + passed['parentVersionId'])
            candidate_version = f.h.call('GET', route + '/versions/' + passed['candidateVersionId'])
            assert parent_version['digest'] == passed['parentDigest']
            assert candidate_version['digest'] == passed['candidateDigest']
            # A session resolves its fixed immutable old version through the installed SDK.
            pin_config = f.write_json('private/config/pin-reader.json', dict(baseUrl=f.base_url,token=f.h.tokens['viewer'],project=f.project,bundle=bundle,version=passed['parentVersionId']))
            pin_script = app / 'pin.mjs'
            pin_script.write_text("import {readFile} from 'node:fs/promises'; import {AcclimateClient,resolveAndCache} from '@acclimate/sdk'; const c=JSON.parse(await readFile(process.argv[2],'utf8')); const client=new AcclimateClient({baseUrl:c.baseUrl,token:c.token,scope:'review-reader'}); const p=await resolveAndCache(client,{projectId:c.project,bundleId:c.bundle,versionId:c.version},{cacheDir:new URL('./session-cache',import.meta.url).pathname}); console.log(JSON.stringify({versionId:p.version.id,digest:p.version.digest}));\n")
            old_pin = f.run(['node', str(pin_script), str(pin_config)], cwd=app)
            promotion_body = dict(versionId=passed['candidateVersionId'], expectedRevision=initial['revision'], comparisonId=passed['comparisonId'])
            denied = f.h.call('POST', channel + '/promotions', promotion_body, actor='evaluator',status=403)
            promoted = f.h.call('POST', channel + '/promotions', promotion_body)
            stale = f.h.call('POST', channel + '/promotions', promotion_body, status=409)
            assert stale['error']['code'] == 'revision_conflict'
            assert f.run(['node', str(pin_script), str(pin_config)], cwd=app) == old_pin
            rolled = f.h.call('POST', channel + '/promotions', dict(versionId=passed['parentVersionId'],expectedRevision=promoted['revision'],unevaluatedReason='Private acceptance rollback to previously released baseline after explicit review'))
            assert f.run(['node', str(pin_script), str(pin_config)], cwd=app) == old_pin
            assert f.h.call('GET', channel)['version']['id'] == old_pin['versionId']
            evidence.append(dict(id='RELEASE-ROLLBACK', operatorPrincipal=promoted['reviewer'],evaluatorHttpStatus=403,evaluatorDeniedCode=denied['error']['code'], staleHttpStatus=409,staleErrorCode=stale['error']['code'],
                                 revisions=[initial['revision'],promoted['revision'],rolled['revision']], pinnedVersion=old_pin, promotedVersionId=promoted['version']['id'], rollbackVersionId=rolled['version']['id']))
            # Copy a committed selected artifact, remove only terminal owned worker state,
            # then independently verify using a distinct read-only principal.
            export = sorted(passed_dir.glob('review-*/manifest.json'))[0].parent
            reader_app = f.install_js(name='separate-reviewer', starter='evaluation')
            assert not reader_app.is_relative_to(ci) and reader_app != app
            download = reader_app / 'downloaded-review'
            shutil.copytree(export, download)
            handoff_copy = reader_app / 'downloaded-handoff.json'
            shutil.copyfile(passed_dir / 'evaluation-request.json', handoff_copy)
            journal = Path(config['journalRoot'])
            shutil.rmtree(journal)
            verified = f.run(['node',str(reader_app / 'acclimate-eval.mjs'),'verify-export','--manifest',str(download / 'manifest.json'),'--read-config',str(reader_path),'--handoff',str(handoff_copy)],cwd=reader_app)
            assert verified['provenance'] == 'online_scalar_binding' and verified['executionAttested'] is False
            assert not journal.exists()
            for file in download.rglob('*'):
                if file.is_file():
                    content = file.read_bytes()
                    for secret in f.h.tokens.values():
                        assert secret.encode() not in content
                    assert str(journal).encode() not in content
            evidence.append(dict(id='DOWNLOADED-REVIEW',verification=verified,journalsRemoved=True,journalsRecreated=False,readerPrincipalId='viewer',readerRights=['read'],credentialCanariesAbsent=True,
                                 separateInstalledReaderProject=True,readerExitCode=0,
                                 manifestSha256=hashlib.sha256((download / 'manifest.json').read_bytes()).hexdigest()))
            f.verify_release_unchanged()
            result = dict(schemaVersion=1,persona='ci-release-engineer',decision='accept',assessment='independent fresh-release gap-closure retest',criteria=CRITERIA,evidence=evidence,
                        releaseVersion=f.manifest['version'],ciArchiveSha256=hashlib.sha256((f.release / f._starter('ci')['file']).read_bytes()).hexdigest(),
                        releaseSourceInventorySha256=f.manifest['source']['sha256'],serviceBinarySha256=f.service_sha256,
                        releaseManifestSha256=f.release_manifest_sha256,releaseChecksumsSha256=f.release_checksums_sha256,
                        installationProvenance=f.installation_proofs,consumerOutsideCheckout=not f.consumer_root.is_relative_to(ROOT),
                        limits=['Model-free private real Rust/PostgreSQL service; no hosted CI or paid provider exercised.',
                                '25-hour expiry simulated in fixture SQL, not a wall-clock wait.',
                                'Old session pin uses installed SDK immutable version selection and cache; native harness session not exercised.',
                                'Service binary is hashed, without binary-to-source build attestation.'])
        finally:
            proxy.close()
    result['cleanup'] = json.loads((fixture.root / 'private/cleanup.json').read_text())
    assert result['cleanup']['databaseDirectoryRemoved'] and result['cleanup']['serviceStopped']
    # Do not publish fixture host paths or process IDs in the shareable report.
    result['cleanup'] = {key:value for key,value in result['cleanup'].items() if key != 'servicePid'}
    return result

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=Path('/private/tmp/acclimate-ci-gap-retest-20261117'))
    parser.add_argument('--report',type=Path,default=ROOT / 'docs/acceptance/developer-personas-gap-closure-20261117/ci-release-engineer.json')
    args=parser.parse_args()
    result=acceptance(args.output)
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'persona':result['persona'],'decision':result['decision'],'evidenceIds':[x['id'] for x in result['evidence']]}))
