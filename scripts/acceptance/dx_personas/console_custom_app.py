#!/usr/bin/env python3
"""Continuous console -> downloaded handoff -> installed custom-app evaluator.

Uses production console output, real isolated Rust/PostgreSQL, fixture TLS/OIDC
and Chromium. Application callbacks and public CLI come from an external app
installed from the verified release. Never executes the checkout evaluator helper.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT), str(Path(__file__).resolve().parent)]

from playwright.sync_api import expect
from support import PersonaFixture
from first_adopter import install_routing_app, BASELINE, CANDIDATE, add_continuous_console_evidence
from scripts.bdd.world import World
from scripts.bdd.interactions import open_details
from features.steps.console import ensure_editor, save_browser
from types import SimpleNamespace
from scripts.testing.desktop_layouts import build_fingerprint

PRIVATE_OUTPUT = Path('/private/tmp/acclimate-first-adopter-console-20261117')
PUBLIC_REPORT = ROOT/'docs/acceptance/developer-personas-20261117/first-time-adopter-console.json'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report-dir', type=Path, default=PUBLIC_REPORT.parent)
    parser.add_argument('--output', type=Path, default=PRIVATE_OUTPUT)
    args = parser.parse_args()
    args.report_dir = args.report_dir.resolve()
    args.report_dir.mkdir(parents=True, exist_ok=True)
    public_report = args.report_dir/PUBLIC_REPORT.name
    console_fingerprint = build_fingerprint()
    assertions = []
    def check(name, observed, expected):
        assert observed == expected, (name, observed, expected)
        assertions.append(dict(name=name, expected=expected, observed=observed, passed=True))

    with PersonaFixture(name='console-custom-app', output=args.output) as f:
        app = f.install_js(name='support-routing', starter='evaluation')
        check('app staged outside repository', app.is_relative_to(ROOT), False)
        check('SDK resolves inside external consumer',
              f.installation_proofs['support-routing']['resolvedWithinConsumer'], True)
        install_routing_app(f, app)
        policy = {'schemaVersion':1, 'id':'support-routing-quality', 'revision':'1',
                  'metric':{'name':'correct queue','unit':'reward','direction':'higher'},
                  'aggregation':'equal-case-means','minimumMeanImprovement':0.5,
                  'maximumCaseRegression':0,'candidateThreshold':1,
                  'requiredCases':['compromised-account','ordinary-issue'],
                  'maximumCandidateTaskFailures':0,'cost':{'maximumCandidateUsd':0},
                  'inference':{'method':'none'}}
        f.write_json(app/'quality-policy.json', policy)
        cli = [shutil.which('node'), str(app/'acclimate-eval.mjs')]
        command_steps = []
        def run(action, *arguments):
            value = f.run(cli+[action,*map(str,arguments)], cwd=app)
            meta = json.loads((f.root/'private/commands'/f'{f._log_sequence:04d}.json').read_text())
            command_steps.append({'step':action, **meta})
            return value

        descriptor = run('describe')
        descriptor_text = json.dumps(descriptor, separators=(',',':'))
        check('same support-routing app descriptor', descriptor['runtime']['configId'], 'first-adopter-support-routing')
        check('same application cases', sorted(c['caseId'] for c in descriptor['expectedCases']),
              ['compromised-account','ordinary-issue'])
        setup = f.bootstrap(payload=BASELINE, name='Continuous first adopter custom application')

        # Borrow the BDD browser identity/console fixtures without another database.
        w = World.__new__(World)
        w.h, w.actor, w.sessions = f.h, 'operator', {}
        w.root = '/v1/workspaces/'+f.project
        w.setup, w.original = setup, setup['resolution']
        w.bundle = w.root+'/bundles/'+setup['bundle']['id']
        w.channel = w.bundle+'/channels/stable'
        w.dev_console = False
        context = SimpleNamespace(world=w)
        browser = None
        try:
            browser = w.browser()
            p = browser.page
            # Use the public HTTPS service identity emitted by this exact console.
            # Trust only the generated fixture CA, not a disabled TLS verifier.
            f.clean_env['NODE_EXTRA_CA_CERTS'] = str(browser.ca_path)
            evaluator = json.loads(f.evaluator_config.read_text())
            evaluator['serviceUrl'] = browser.origin
            reader = json.loads(f.reader_config.read_text())
            reader['serviceUrl'] = browser.origin
            evaluator_config = f.write_json(f.root/'private/config/console-evaluator.json', evaluator)
            reader_config = f.write_json(f.root/'private/config/console-reader.json', reader)
            run('doctor','--config',evaluator_config,'--bundle',setup['bundle']['id'],
                '--policy',app/'quality-policy.json')

            browser.select_bundle()
            ensure_editor(context)
            p.get_by_role('textbox',name='Content',exact=True).fill(CANDIDATE['files'][0]['text'])
            save_browser(context)
            saved = w.call('GET',w.channel+'/drafts')['items'][0]
            p.get_by_role('link',name='Continue to evaluation',exact=True).click()
            open_details(p,'Set up evaluation request')
            public_config = p.get_by_label('Public evaluator configuration (JSON)',exact=True)
            expect(public_config).to_have_value('')
            expect(p.get_by_role('button',name='Create evaluation request',exact=True)).to_be_disabled()
            check('untouched console requires an app descriptor', public_config.input_value(), '')
            public_config.fill(descriptor_text)
            expect(public_config).to_have_value(descriptor_text)
            expect(p.get_by_label('Selected evaluator summary',exact=True)).to_contain_text('first-adopter-support-routing')
            expect(p.get_by_role('button',name='Create evaluation request',exact=True)).to_be_enabled()
            p.get_by_role('button',name='Create evaluation request',exact=True).click()
            expect(p.get_by_role('status').filter(has_text='Evaluation request created. Run it in your app, then return here for the results.')).to_be_visible()
            request = w.call('GET',w.bundle+'/evaluation-requests')['items'][0]
            check('browser request freezes custom descriptor runtime', request['runtime'], descriptor['runtime'])
            check('browser request freezes saved candidate', request['candidateVersionId'], saved['snapshotVersion']['id'])
            check('browser request freezes custom dataset', request['datasetRevision'], descriptor['datasetRevision'])
            check('browser request freezes custom grader', request['graderRevision'], descriptor['graderRevision'])
            check('browser request freezes declared case inventory', request['expectedCases'], descriptor['expectedCases'])
            check('browser request requires bound evidence', request['requireBoundEvidence'], True)
            p.get_by_role('button',name='Copy handoff JSON',exact=True).click()
            copied = json.loads(p.evaluate('navigator.clipboard.readText()'))
            with p.expect_download() as download_event:
                p.get_by_role('button',name='Download handoff',exact=True).click()
            download = download_event.value
            check('actual public download filename', download.suggested_filename, 'handoff.json')
            handoff_path = app/'browser-downloaded-handoff.json'
            download.save_as(handoff_path)
            handoff_path.chmod(0o600)
            handoff_bytes = handoff_path.read_bytes()
            handoff = json.loads(handoff_bytes)
            check('download equals actual clipboard handoff', handoff, copied)
            check('download identifies exact console-created request', handoff['requestId'], request['id'])
            check('download service identity matches private evaluator selection', handoff['serviceUrl'], browser.origin)
            for secret in [*f.h.tokens.values(),str(evaluator_config),str(reader_config),str(f.root)]:
                assert secret.encode() not in handoff_bytes, 'Private value in public handoff'
            check('no callbacks before explicit app CLI run', (app/'callback-events.jsonl').exists(), False)

            target = ['--config',evaluator_config,'--handoff',handoff_path]
            run('doctor',*target)
            run('run','--live',*target)
            quality = run('check',*target,'--policy',app/'quality-policy.json')
            export_dir = f.root/'private/console-review-export'
            run('export',*target,'--out',export_dir)
            verified = run('verify-export','--manifest',export_dir/'manifest.json',
                           '--read-config',reader_config,'--handoff',handoff_path)
            authoritative = w.call('GET',w.bundle+'/evaluation-requests/'+request['id'])
            comparison = w.call('GET',w.bundle+'/comparisons/'+authoritative['comparisonId'])
            check('download remained byte-identical through CLI use', digest(handoff_path.read_bytes()), digest(handoff_bytes))
            check('same browser request completed by installed app', authoritative['status'], 'completed')
            check('comparison bound to browser request', comparison['evaluation']['requestId'], request['id'])
            check('parent mean', quality['summary']['parentMean'], 0.5)
            check('candidate mean', quality['summary']['candidateMean'], 1)
            check('improvement', quality['summary']['orientedMeanImprovement'], 0.5)
            check('quality policy pass', quality['verdict'], 'pass')
            check('independent read-only verification', verified['provenance'], 'online_scalar_binding')
            events = [json.loads(line) for line in (app/'callback-events.jsonl').read_text().splitlines()]
            check('four actual custom application callbacks', len(events), 4)
            check('all callbacks awaited reads and safely retained outputs',
                  all(e['awaitedRead'] and e['resultRetained'] and e['inputsRemoved'] for e in events), True)
            check('callbacks consumed exact frozen parent/candidate IDs', sorted({e['versionId'] for e in events}),
                  sorted([request['parentVersionId'], request['candidateVersionId']]))
            p.reload(wait_until='networkidle')
            p.get_by_role('link',name=__import__('re').compile(r'^Inspect evidence for ')).click()
            rewards = p.get_by_role('region',name='Observed paired rewards',exact=True)
            expect(rewards.get_by_text('Complete evidence',exact=True)).to_be_visible(timeout=30000)
            expect(rewards.get_by_text('Scored pairs',exact=True).locator('..').locator('dd')).to_have_text('2 / 2')
            check('browser reviewed complete two-pair app evidence', True, True)
            expect(rewards.get_by_text('Observed equal-case mean', exact=False)).to_be_visible()
            open_details(p, 'How scores are calculated')
            expect(rewards.get_by_text('Repetitions are averaged within each case, then cases receive equal weight.', exact=False)).to_be_visible()
            check('console explains equal-case weighting', True, True)
            check('production console build remained unchanged', build_fingerprint(), console_fingerprint)
            p.screenshot(path=str(f.root/'private/console-evidence.png'), full_page=True)
            (f.root/'private/console-evidence.png').chmod(0o600)
            check('no browser JavaScript errors', len(browser.errors), 0)
            check('evaluation did not promote channel', w.call('GET',w.channel)['revision'], '1')
            browser.context.tracing.stop(path=str(f.root/'private/console-custom-app-trace.zip'))
            (f.root/'private/console-custom-app-trace.zip').chmod(0o600)

            public = {'schemaVersion':1, 'persona':'first-time-adopter', 'criterion':3,
                      'disposition':'accepted', 'sameContinuousFixture':True,
                      'journey':'installed custom app describe -> actual console custom descriptor -> saved candidate request -> actual public download -> installed CLI doctor/run/check/export -> independent read-only verify -> browser evidence review',
                      'modelCalls':0,'promotions':0,'assertions':assertions,
                      'descriptor':descriptor,'descriptorPastedSha256':digest(descriptor_text.encode()),
                      'downloadSha256':digest(handoff_bytes), 'requestId':request['id'],
                      'bundleId':setup['bundle']['id'],'comparisonId':authoritative['comparisonId'],
                      'parentVersionId':request['parentVersionId'],'candidateVersionId':request['candidateVersionId'],
                      'parentDigest':request['parentDigest'],'candidateDigest':request['candidateDigest'],
                      'scalarResults':[{'caseId':pair['caseId'],'repetition':pair['repetition'],
                                        'parentReward':pair['parent']['reward'],'candidateReward':pair['candidate']['reward']}
                                       for pair in comparison['results']],
                      'policy':quality,'readerVerification':verified,'commands':command_steps,
                      'installedReleaseProvenance':f.installation_proofs['support-routing'],
                      'releaseName':f.release.name,
                      'releaseChecksumsSha256':f.release_checksums_sha256,
                      'releaseManifestSha256':digest((f.release/'manifest.json').read_bytes()),
                      'releaseSourceInventorySha256':f.manifest['source']['sha256'],
                      'serviceBinarySha256':f.service_sha256,'binarySourceBuildAttested':False,
                      'consoleMode':'existing production .output/server/index.mjs',
                      'consoleOutputSha256':console_fingerprint,
                      'visibleEvidenceScreenshotSha256':digest((f.root/'private/console-evidence.png').read_bytes()),
                      'browserVersion':browser.browser.version,
                      'runtime':{'node':subprocess.run([cli[0],'--version'],env=f.clean_env,
                                   capture_output=True,text=True,check=True).stdout.strip(),
                                 'python':sys.version.split()[0],
                                 'postgres':f.h.pg('postgres','--version').stdout.strip()},
                      'limits':['TLS/OIDC fixture identity through real browser discovery/code/JWKS and secure session; no production identity provider.',
                                'Actual custom callbacks are model-free deterministic support routing; no native/model quality claim.',
                                'Fixtures provision the workspace, operator authority, release and evaluator access.',
                                'Existing service/console output is exercised without rebuilding or attesting source-to-binary provenance.']}
            for secret in [*f.h.tokens.values(),str(f.root),str(evaluator_config),str(reader_config)]:
                assert secret not in json.dumps(public), 'Private value in public report'
            public_report.write_text(json.dumps(public,indent=2)+'\n')
            headless_path = public_report.with_name('first-time-adopter.json')
            if headless_path.is_file():
                headless = json.loads(headless_path.read_text())
                add_continuous_console_evidence(headless, args.report_dir)
                headless_path.write_text(json.dumps(headless,indent=2)+'\n')
            print(json.dumps({'report':str(public_report.relative_to(ROOT)),
                              'assertions':len(assertions),'requestId':request['id'],'disposition':'accepted'}))
        except BaseException:
            if browser:
                try:
                    p.screenshot(path=str(f.root/'private/failure.png'),full_page=True)
                    browser.context.tracing.stop(path=str(f.root/'private/failure-trace.zip'))
                except Exception:
                    pass
            raise
        finally:
            if browser:
                browser.close()
    public['cleanup'] = json.loads((f.root/'private/cleanup.json').read_text())
    public['cleanup'].pop('servicePid', None)
    public_report.write_text(json.dumps(public, indent=2)+'\n')
    if headless_path.is_file():
        headless = json.loads(headless_path.read_text())
        add_continuous_console_evidence(headless, args.report_dir)
        headless_path.write_text(json.dumps(headless, indent=2)+'\n')


if __name__ == '__main__':
    main()
