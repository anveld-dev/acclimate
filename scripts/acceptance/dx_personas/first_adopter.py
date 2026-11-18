#!/usr/bin/env python3
"""Use the installed release as a first-time adopter; never call a model/provider.

Acceptance was fixed in the companion persona document before this journey ran.
Only fixture provisioning uses the checkout harness; all application use imports
the operator-distributed public SDK installed outside the checkout.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from support import PersonaFixture

OUTPUT = ROOT / 'artifacts/dx-personas-20261117/first-adopter'
REPORT_DIR = ROOT / 'docs/acceptance/developer-personas-20261117'

BASELINE = {'schemaVersion': 1, 'files': [
    {'path': 'routing.md', 'kind': 'instruction', 'text': 'Route every issue to normal support.'}]}
CANDIDATE = {'schemaVersion': 1, 'files': [
    {'path': 'routing.md', 'kind': 'instruction',
     'text': 'Route compromised accounts to security; route ordinary issues to normal support.'}]}

AGENT = r'''import assert from 'node:assert/strict';
import { mkdtemp, readFile, open, appendFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareFiles } from '@acclimate/sdk';

// An existing deterministic support-routing app: no model or tool credentials.
export async function runExistingAgent({ bundle, task, signal }) {
  signal?.throwIfAborted();
  const job = await mkdtemp(new URL('./private-jobs/job-', import.meta.url));
  const prepared = await prepareFiles(bundle, job);
  let retained = false;
  let result;
  try {
    // The app really reads files after an async boundary, while their lifetime is owned.
    await new Promise(resolve => setTimeout(resolve, 25));
    signal?.throwIfAborted();
    const instruction = (await Promise.all(prepared.files.filter(f => f.kind === 'instruction')
      .map(f => readFile(f.absolutePath, 'utf8')))).join('\n');
    const queue = task.compromised && instruction.includes('compromised accounts to security')
      ? 'security' : 'normal';
    result = { queue, versionId: bundle.version.id, digest: bundle.version.digest,
      consumedFiles: prepared.files.length, awaitedRead: true, expectedLeaked: 'expected' in task };
    assert.equal(result.expectedLeaked, false);
    const saved = await open(join(job, 'result.json'), 'wx', 0o600);
    try { await saved.writeFile(JSON.stringify(result)); await saved.sync(); }
    finally { await saved.close(); }
    retained = true;
  } finally {
    if (retained) await prepared.cleanup();
  }
  await access(join(job, 'result.json'));
  for (const f of prepared.files) {
    let exists = true;
    try { await access(f.absolutePath); } catch { exists = false; }
    assert.equal(exists, false);
  }
  await appendFile(new URL('./callback-events.jsonl', import.meta.url),
    JSON.stringify({ ...result, resultRetained: true, inputsRemoved: true }) + '\n', {mode: 0o600});
  return result;
}
'''

def install_routing_app(f, app):
    (app / 'private-jobs').mkdir(mode=0o700)
    (app / 'agent.mjs').write_text(AGENT)
    cases = [
        {'caseId':'compromised-account', 'input':{'compromised': True}, 'expected':{'queue':'security'}},
        {'caseId':'ordinary-issue', 'input':{'compromised': False}, 'expected':{'queue':'normal'}},
    ]
    f.clean_env['ACCLIMATE_EVALUATOR_CASES'] = str(f.write_json(app / 'cases.json', cases))
    agent_digest = hashlib.sha256(AGENT.encode()).hexdigest()
    (app / 'application.mjs').write_text("""
import { runExistingAgent } from './agent.mjs';
export const configId = 'first-adopter-support-routing';
export const runtime = { settings: {app: 'support-routing'}, artifacts: {app: 'sha256:APP_DIGEST'} };
export async function execute({ bundle, input, signal }) {
  return {output: await runExistingAgent({bundle, task: input, signal}), usage: {costUsd: 0}};
}
export async function grade({ output, expected }) {
  const queueMatches = output.queue === expected.queue;
  return {reward: Number(queueMatches), explanation: {queueMatches}};
}
export const grader = {sourceUtf8: grade.toString()};
export async function toReviewArtifact({ identity, value }) {
  return {mediaType: 'application/json', value: identity.role === 'output'
    ? {queue: value.queue} : {queueMatches: value.queueMatches}};
}
""".replace('APP_DIGEST', agent_digest))


def add_shared_browser_evidence(public):
    """Attribute an already completed root browser run; never start another run."""
    results = ROOT/'artifacts/dx-personas-20261117/console/bdd/results.json'
    coverage = results.with_name('coverage.md')
    if not results.is_file() or not coverage.is_file():
        return
    tags = {'UI-SETUP-01','UI-SETUP-02','UI-EVAL-01','NATIVE-WALK-01'}
    selected = [scenario for feature in json.loads(results.read_text())
                for scenario in feature.get('elements', [])
                if tags.intersection(scenario.get('tags', []))]
    if len(selected) != 6 or any(s.get('status') != 'passed' or
            any(step.get('result',{}).get('status') != 'passed' for step in s.get('steps', []))
            for s in selected):
        return
    public['sharedBrowserEvidence'] = {
        'owner':'root', 'personallyExecutedByThisPersona':False, 'sameContinuousFixture':False,
        'results':str(results.relative_to(ROOT)), 'coverage':str(coverage.relative_to(ROOT)),
        'resultsSha256':hashlib.sha256(results.read_bytes()).hexdigest(),
        'coverageSha256':hashlib.sha256(coverage.read_bytes()).hexdigest(),
        'scenariosPassed':len(selected), 'stepsPassed':sum(len(s['steps']) for s in selected),
        'tags':sorted(tags),
        'scope':'Explicit example selection, public clipboard/download handoff, copied checkout helper and installed native delivery; no custom installed-app descriptor pasted.'}
    public['criteria'][4].update(disposition='accepted-with-shared-attribution',
        evidence='Root Chromium UI-EVAL-01 and NATIVE-WALK-01 require explicit evaluator selection before creation.')
    public['criteria'][4].pop('remaining', None)
    public['criteria'][2]['remaining'] = 'Shared browser run uses checkout example evaluators; custom installed descriptor paste/download/run is not one continuous tested journey.'
    public['limits'][0] = 'No browser session personally executed by this persona; root browser evidence is attributed separately and uses checkout example evaluators.'


def add_continuous_console_evidence(public, report_dir=REPORT_DIR):
    path = report_dir/'first-time-adopter-console.json'
    if not path.is_file():
        return
    continuous = json.loads(path.read_text())
    if (continuous.get('disposition') != 'accepted' or
        continuous.get('sameContinuousFixture') is not True or
        continuous.get('releaseManifestSha256') != public['releaseManifestSha256'] or
        continuous.get('serviceBinarySha256') != public['serviceBinarySha256'] or
        not all(a.get('passed') for a in continuous.get('assertions', []))):
        return
    public['continuousConsoleEvidence'] = {
        'owner':'first-time-adopter', 'report':str(path.relative_to(ROOT)),
        'reportSha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'sameContinuousFixture':True, 'assertionsPassed':len(continuous['assertions']),
        'requestId':continuous['requestId'], 'comparisonId':continuous['comparisonId'],
        'descriptorPastedSha256':continuous['descriptorPastedSha256'],
        'downloadSha256':continuous['downloadSha256']}
    public['criteria'][2].update(disposition='accepted',
        acceptedScope='Actual continuous custom-descriptor console download and installed-app execution',
        evidence='Owned continuous console report, distinct from the original headless request')
    public['criteria'][2].pop('remaining', None)
    public['criteria'][4].update(disposition='accepted',
        evidence='Owned continuous Chromium journey verifies empty evaluator choice and disabled creation before custom selection.')
    public['disposition'] = 'accepted'
    public['limits'][0] = 'Original headless request and separately owned continuous browser request are distinct fixtures; browser acceptance is documented by the continuous console report.'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report-dir', type=Path, default=REPORT_DIR)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    args.report_dir = args.report_dir.resolve()
    args.report_dir.mkdir(parents=True, exist_ok=True)
    assertions = []
    def check(name, observed, expected):
        assert observed == expected, (name, observed, expected)
        assertions.append({'name': name, 'expected': expected, 'observed': observed, 'passed': True})

    with PersonaFixture(name='first-adopter', output=args.output) as f:
        app = f.install_js(name='support-routing', starter='evaluation')
        node = shutil.which('node')
        cli = [node, str(app / 'acclimate-eval.mjs')]
        install_routing_app(f, app)
        policy = {'schemaVersion': 1, 'id': 'support-routing-quality', 'revision': '1',
                  'metric': {'name':'correct queue', 'unit':'reward', 'direction':'higher'},
                  'aggregation':'equal-case-means', 'minimumMeanImprovement':0.5,
                  'maximumCaseRegression':0, 'candidateThreshold':1,
                  'requiredCases':['compromised-account','ordinary-issue'],
                  'maximumCandidateTaskFailures':0, 'cost':{'maximumCandidateUsd':0}}
        f.write_json(app / 'quality-policy.json', policy)
        f.write_json(app / 'candidate.json', CANDIDATE)
        f.write_json(app / 'share-selection.json', {'schemaVersion':1, 'entries':[
            {'caseId':'compromised-account','repetition':0,'side':'candidate','role':role,'required':True}
            for role in ('output','grader-explanation')]})
        setup = f.bootstrap(payload=BASELINE, name='First adopter support routing')
        bundle = setup['bundle']['id']
        descriptor = f.run(cli + ['describe'], cwd=app)
        check('application descriptor owns case inventory',
              sorted(x['caseId'] for x in descriptor['expectedCases']),
              ['compromised-account','ordinary-issue'])
        check('descriptor excludes private expected answers',
              any('expected' in case for case in descriptor['expectedCases']), False)
        f.run(cli + ['doctor','--config',str(f.evaluator_config),'--bundle',bundle,
                     '--policy',str(app/'quality-policy.json')], cwd=app)
        absent_bundle = f.run(cli + ['doctor','--config',str(f.evaluator_config),
            '--bundle','00000000-0000-4000-8000-000000000001'], cwd=app, expected=2)
        check('missing bundle diagnostic', next(c['code'] for c in absent_bundle['checks']
            if c['check'] == 'targetBundle'), 'bundle.missing')
        check('missing bundle remediation', absent_bundle['nextAction'], 'fix_config')
        readonly = json.loads(f.evaluator_config.read_text())
        readonly.update(evaluatorPrincipalId='viewer', evaluatorToken=json.loads(f.reader_config.read_text())['readToken'],
                        journalRoot=str(f.root/'private/readonly-journals'))
        readonly_config = f.write_json(f.root/'private/config/readonly-evaluator.json', readonly)
        readonly_doctor = f.run(cli + ['doctor','--config',str(readonly_config),'--bundle',bundle], cwd=app, expected=2)
        check('read-only identity rejected by evaluator preflight',
              readonly_doctor['authorization'], 'denied')
        check('read-only preflight supplies operator next action', readonly_doctor['nextAction'], 'ask_operator')
        handoff = app / 'evaluation-request.json'
        f.run(cli + ['request','--config',str(f.evaluator_config),'--bundle',bundle,
                     '--channel','stable','--payload',str(app/'candidate.json'),
                     '--intent',str(f.root/'first-intent.json'),'--out',str(handoff)], cwd=app)
        request = json.loads(handoff.read_text())
        missing_handoff = dict(request, requestId='00000000-0000-4000-8000-000000000002')
        missing_path = f.write_json(app/'missing-evaluation-request.json', missing_handoff)
        absent_request = f.run(cli + ['doctor','--config',str(f.evaluator_config),
            '--handoff',str(missing_path)], cwd=app, expected=2)
        check('missing request diagnostic', next(c['code'] for c in absent_request['checks']
            if c['check'] == 'targetRequest'), 'request.missing')
        check('missing request remediation', absent_request['nextAction'], 'fix_config')
        check('doctor never executes callbacks', (app/'callback-events.jsonl').exists(), False)
        target = ['--config',str(f.evaluator_config),'--handoff',str(handoff)]
        f.run(cli + ['doctor',*target], cwd=app)
        f.run(cli + ['run','--live',*target], cwd=app)
        policy_result = f.run(cli + ['check',*target,'--policy',str(app/'quality-policy.json')], cwd=app)
        export_dir = f.root / 'review-export'
        f.run(cli + ['export',*target,'--selection',str(app/'share-selection.json'),
                     '--out',str(export_dir)], cwd=app)
        verified = f.run(cli + ['verify-export','--manifest',str(export_dir/'manifest.json'),
                              '--read-config',str(f.reader_config),'--handoff',str(handoff)], cwd=app)
        events = [json.loads(line) for line in (app/'callback-events.jsonl').read_text().splitlines()]
        check('paired callbacks actually ran', len(events), 4)
        for field in ('awaitedRead','resultRetained','inputsRemoved'):
            check(field, all(e[field] for e in events), True)
        check('private answers absent from agent inputs', any(e['expectedLeaked'] for e in events), False)
        check('callbacks consumed one immutable instruction', sorted({e['consumedFiles'] for e in events}), [1])
        check('two immutable version IDs consumed', len({e['versionId'] for e in events}), 2)
        check('two immutable digests consumed', len({e['digest'] for e in events}), 2)
        route = f'/v1/projects/{f.project}/bundles/{bundle}/evaluation-requests/{request["requestId"]}'
        authoritative = f.h.call('GET', route, actor='evaluator')
        check('service request completed', authoritative['status'], 'completed')
        check('candidate mean', policy_result['summary']['candidateMean'], 1)
        check('parent mean', policy_result['summary']['parentMean'], 0.5)
        check('mean improvement', policy_result['summary']['orientedMeanImprovement'], 0.5)
        check('policy decision', policy_result['verdict'], 'pass')
        check('independent reader verified scalar binding', verified['provenance'], 'online_scalar_binding')
        check('verification does not attest raw execution', verified['executionAttested'], False)
        # Export is public; private run reports remain under the fixture root.
        commands = []
        for metadata in sorted((f.root/'private/commands').glob('*.json')):
            if metadata.name.endswith('.invocation.json'):
                continue
            command_meta = json.loads(metadata.read_text())
            invocation = metadata.with_name(metadata.stem+'.invocation.json')
            action = 'install --offline --ignore-scripts'
            if invocation.exists():
                argv = json.loads(invocation.read_text())['command']
                action = 'installed SDK resolution' if argv[1] == '--input-type=module' else argv[2]
            commands.append({'step':action, **command_meta})
        node_version = subprocess.run([node,'--version'], env=f.clean_env, capture_output=True,
                                      check=True,text=True).stdout.strip()
        docs = ['README.md','docs/getting-started.md','python/README.md',
                'python/tests/typing/README.md','examples/native-repository/README.md']
        public = {'documentationRead':[{'path':path, 'sha256':hashlib.sha256((ROOT/path).read_bytes()).hexdigest()} for path in docs],
                  'schemaVersion':1, 'persona':'first-time-adopter', 'modelCalls':0,
                  'scenario':'application-owned deterministic support-routing loop',
                  'disposition':'partial',
                  'criteria':[
                    {'id':1,'name':'find first value','disposition':'accepted'},
                    {'id':2,'name':'consume versioned content in supported custom loop','disposition':'accepted'},
                    {'id':3,'name':'own installed evaluator','disposition':'partial',
                     'acceptedScope':'documented headless installed-app path',
                     'remaining':'console paste/download not personally exercised'},
                    {'id':4,'name':'know authority before request creation','disposition':'accepted'},
                    {'id':5,'name':'relevant console evaluation choice','disposition':'partial',
                     'remaining':'requires separately attributed root browser evidence'},
                    {'id':6,'name':'obtain coherent operator release','disposition':'accepted'}],
                  'assertions': assertions, 'bundleId':bundle, 'requestId':request['requestId'],
                  'comparisonId':authoritative['comparisonId'],
                  'consumedVersionIds':sorted({e['versionId'] for e in events}),
                  'consumedDigests':sorted({e['digest'] for e in events}),
                  'policy':policy_result, 'verification':verified,
                  'commands':commands, 'runtime':{'node':node_version,'python':sys.version.split()[0],
                    'postgres':f.h.pg('postgres','--version').stdout.strip()},
                  'installedReleaseProvenance':f.installation_proofs['support-routing'],
                  'releaseChecksumsSha256':f.release_checksums_sha256,
                  'releaseName':f.release.name,
                  'releaseSourceInventorySha256':f.manifest['source']['sha256'],
                  'binarySourceBuildAttested':False,
                  'releaseManifestSha256':hashlib.sha256((f.release/'manifest.json').read_bytes()).hexdigest(),
                  'serviceBinarySha256':hashlib.sha256((ROOT/'target/debug/acclimate-service').read_bytes()).hexdigest(),
                  'limits':['No browser session in this persona run; console acceptance needs separate browser evidence.',
                            'No model/native-provider quality claim; deterministic custom loop only.',
                            'Operator supplies release and evaluator credentials; no public registry or hosted onboarding exercised.']}
        # Keep only public results from CLI outputs; support logs contain private paths.
        report_path = args.report_dir/'first-time-adopter.json'
        if args.report_dir.resolve() == REPORT_DIR.resolve():
            add_shared_browser_evidence(public)
        add_continuous_console_evidence(public, args.report_dir)
        for value in (str(f.root), str(f.evaluator_config), f.h.tokens['evaluator'], f.h.tokens['viewer']):
            assert value not in json.dumps(public), 'Private value cannot enter the public report'
        report_path.write_text(json.dumps(public, indent=2)+'\n')
        print(json.dumps({'persona':'first-time-adopter','report':str(report_path),
                          'assertions':len(assertions),'requestId':request['requestId']}))
    public['cleanup'] = json.loads((f.root/'private/cleanup.json').read_text())
    public['cleanup'].pop('servicePid', None)
    report_path.write_text(json.dumps(public, indent=2)+'\n')

if __name__ == '__main__':
    main()
