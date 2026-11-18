"""Platform engineer's installed-consumer journey against owned Rust/PostgreSQL.

Run with Python >=3.11. Captures private logs through PersonaFixture; emits only
explicit IDs, safe codes, scalars and hashes. No build/model/ambient credential use.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid

from scripts.acceptance.dx_personas.support import PersonaFixture
from scripts.packaging.fixture_application import install_test_application
from scripts.packaging.qualify_dx import replace_private_json


class SubmissionGate:
    """Owned same-host hop: reject submissions until operator reopens it."""
    def __init__(self, upstream):
        self.block = False
        self.blocked = 0
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_):
                pass

            def do_GET(self):
                self.forward()

            def do_POST(self):
                self.forward()

            def forward(self):
                data = self.rfile.read(int(self.headers.get('Content-Length', '0'))) if self.command == 'POST' else None
                if owner.block and self.command == 'POST' and self.path.endswith('/comparisons'):
                    owner.blocked += 1
                    status, body = 503, b'{"error":{"code":"fixture_submission_gate"}}'
                else:
                    headers = {k: v for k, v in self.headers.items() if k.lower() not in ('host', 'connection', 'content-length')}
                    try:
                        response = urlopen(Request(upstream + self.path, data=data, headers=headers, method=self.command), timeout=20)
                    except HTTPError as error:
                        response = error
                    with response:
                        status, body = response.status, response.read()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(body)
                self.close_connection = True

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.base = 'http://127.0.0.1:' + str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


CRITERIA = {
    'authority': 'Separate exact grants, truthful capabilities, denied writes do not mutate',
    'installed_execution': 'Distributed wheel/starter paired execution and separate quality decision',
    'diagnostics': 'Secret-safe distinct local/access/descriptor/missing-resource diagnostics without execution',
    'uncertainty': 'Uncertain owned execution refuses replay and allows explicit interruption after local exit',
    'rotation_recovery': 'Saved report survives same-principal overlap/revoke restarts at fixed journal root without callbacks',
    'reader_delivery': 'Reader sees minimal unknown/coherent latest activity while admin stays denied',
    'progress': 'Installed opt-in reporter, persistent app sequences, coherent reader activity and nonfatal reporting denial',
}


PROGRESS_CONSUMER = r'''import json, os, sys
from pathlib import Path
from acclimate import AcclimateClient, EvaluationProgressReporter
spec = json.loads(Path(sys.argv[1]).read_text())
config = json.loads(Path(spec['config']).read_text())
state_path = Path(spec['state'])
state = json.loads(state_path.read_text()) if state_path.exists() else {
    'requestId': spec['requestId'], 'attemptId': spec['attemptId'], 'sequence': 0}
assert (state['requestId'], state['attemptId']) == (spec['requestId'], spec['attemptId'])
if spec.get('replay'):
    report = state['lastReport']
else:
    state['sequence'] += 1
    report = dict(sequence=state['sequence'], phase='submitting', completed=4, total=4)
    state['lastReport'] = report
# App-owned sequence is persisted before this explicit call. No timer or worker.
with os.fdopen(os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
    json.dump(state, stream)
client = AcclimateClient(config['serviceUrl'], config['evaluatorToken'], 'evaluator', retries=0, timeout=2)
reporter = EvaluationProgressReporter(client, project_id=config['projectId'],
    bundle_id=spec['bundleId'], request_id=spec['requestId'], attempt_id=spec['attemptId'])
ok = reporter.report(**report)
print(json.dumps(dict(ok=ok, report=report, sequencePersisted=True)))
'''

CALLBACK_PROGRESS = r'''def report_owned_callback_progress(run, phase, completed_increment):
    import json, os
    from pathlib import Path
    from acclimate import AcclimateClient, EvaluationProgressReporter
    here = Path(__file__).parent
    binding = json.loads((here / 'progress-binding.json').read_text())
    config = json.loads(Path(binding['config']).read_text())
    state_path = here / ('owned-progress-state-' + run.context.request_id + '.json')
    state = json.loads(state_path.read_text()) if state_path.exists() else {
        'requestId': run.context.request_id, 'attemptId': run.context.attempt_id,
        'sequence': 0, 'completed': 0}
    assert state['attemptId'] == run.context.attempt_id
    state['sequence'] += 1
    state['completed'] += completed_increment
    report = dict(sequence=state['sequence'], phase=phase,
        completed=state['completed'], total=4,
        case={'caseId': run.case_id, 'repetition': run.repetition})
    state['lastReport'] = report
    with os.fdopen(os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        json.dump(state, stream)
    client = AcclimateClient(config['serviceUrl'], config['evaluatorToken'], 'evaluator', retries=0, timeout=2)
    reporter = EvaluationProgressReporter(client, project_id=config['projectId'],
        bundle_id=binding['bundleId'], request_id=run.context.request_id, attempt_id=run.context.attempt_id)
    ok = reporter.report(**report)
    with os.fdopen(os.open(here / 'callback-progress.jsonl', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), 'a') as log:
        log.write(json.dumps(dict(ok=ok, sequence=state['sequence'], completed=state['completed'])) + '\n')


def execute(run):
    report_owned_callback_progress(run, 'executing', 0)
    result = original_execute(run)
    report_owned_callback_progress(run, 'grading', 1)
    return result


'''


def journey(output):
    evidence = {'schemaVersion': 1, 'persona': 'platform-engineer', 'criteria': CRITERIA,
                'results': {}, 'limits': ['No JWT/SSO', 'No container/deployed worker replacement',
                'No provider/model execution or provider termination test', 'No network filesystem or distributed locking',
                'Service binary to source build is not independently attested',
                'Browser activity rendering is separately tested by the council browser fixture']}
    with PersonaFixture('platform-engineer', output) as f:
        h = f.h
        (f.root / 'private').chmod(0o700)
        base = '/v1/projects/' + f.project
        gate = SubmissionGate(f.base_url)
        try:
            config = json.loads(f.evaluator_config.read_text())
            config['serviceUrl'] = gate.base
            replace_private_json(f.evaluator_config, config)
            app, python = f.install_python()
            f.clean_env['ACCLIMATE_EVALUATOR_CASES'] = install_test_application(app, 'python')
            cli = [python, app / 'acclimate_eval.py']
            # Instrument only this installed application's callback, preserving
            # its real model-free agent implementation and public descriptor.
            agent = app / 'agent.py'
            original = agent.read_text().replace('def run_existing_agent(', 'def original_agent(')
            agent.write_text(original + '\n\ndef run_existing_agent(**kwargs):\n'
                '    from pathlib import Path\n'
                '    from acclimate.evaluation import ExecutionUncertainError\n'
                '    here = Path(__file__).parent\n'
                '    (here / "callback-count.txt").touch(mode=0o600, exist_ok=True)\n'
                '    with (here / "callback-count.txt").open("a") as log:\n'
                '        log.write("callback\\n")\n'
                '    if (here / "uncertain.flag").exists():\n'
                '        raise ExecutionUncertainError()\n'
                '    return original_agent(**kwargs)\n')
            agent.chmod(0o600)
            entrypoint = app / 'application.py'
            entrypoint.write_text(entrypoint.read_text().replace('def execute(run):', 'def original_execute(run):')
                .replace('def grade(run):', CALLBACK_PROGRESS + 'def grade(run):'))
            entrypoint.chmod(0o600)

            def callbacks():
                p = app / 'callback-count.txt'
                return len(p.read_text().splitlines()) if p.exists() else 0

            def invoke(command, *args, expected=0):
                value = f.run([*cli, command, *args], app, expected)
                stem = f.root / 'private/commands' / f'{f._log_sequence:04d}'
                stderr = Path(str(stem) + '.stderr').read_text()
                stdout = Path(str(stem) + '.stdout').read_text()
                for secret in (*h.tokens.values(), str(f.root)):
                    assert secret not in stdout + stderr, 'Private values leaked into command diagnostic'
                return value if value is not None else json.loads(stderr)

            setup = f.bootstrap(name='Platform-owned isolated onboarding')
            bundle = setup['bundle']['id']
            f.write_json(app / 'progress-binding.json', dict(config=str(f.evaluator_config), bundleId=bundle))
            b = base + '/bundles/' + bundle
            grants = json.loads(h.env['ACCLIMATE_AUTH'])

            def counts():
                return json.loads(h.sql("SELECT json_build_object("
                    "'requests',(SELECT count(*) FROM evaluation_requests),"
                    "'attempts',(SELECT count(*) FROM evaluation_requests WHERE attempt_id IS NOT NULL),"
                    "'comparisons',(SELECT count(*) FROM comparisons),"
                    "'bundles',(SELECT count(*) FROM bundles),"
                    "'versions',(SELECT count(*) FROM versions),"
                    "'operations',(SELECT count(*) FROM operation_records),"
                    "'commands',(SELECT count(*) FROM command_results),"
                    "'audit',(SELECT count(*) FROM mutation_audit))"))

            def validate(value):
                result = subprocess.run([f.service_binary, '--check-grants'], input=json.dumps(value),
                    capture_output=True, text=True, env=f.clean_env)
                assert result.returncode == 0
                parsed = json.loads(result.stdout)
                for secret in h.tokens.values():
                    assert secret not in result.stdout + result.stderr
                return parsed

            valid_grants = validate(grants)
            caps = {actor: h.call('GET', base + '/evaluation-capabilities', actor=actor)
                    for actor in ('evaluator', 'viewer')}
            assert caps['evaluator']['writeEvaluation'] is True
            assert caps['viewer']['writeEvaluation'] is False
            assert next(g for g in grants if g['principalId'] == 'evaluator')['rights'] == ['read', 'write']
            connection = h.call('POST', base + '/integrations', dict(displayName='Platform fixture delivery', bundleId=bundle, channel='stable'))
            integration = base + '/integrations/' + connection['id']
            content = h.call('POST', integration + '/credentials', {'kind': 'content-read'})
            receipt = h.call('POST', integration + '/credentials', {'kind': 'receipt-write'})
            h.tokens['content'], h.tokens['receipt'] = content['secret'], receipt['secret']
            observations = h.call('GET', base + '/integration-observations', actor='viewer')
            assert observations['items'][0]['latestObservation'] is None
            assert 'credentials' not in observations['items'][0]
            reader_admin = h.call('GET', base + '/integrations', actor='viewer', status=403)
            h.call('GET', base + '/evaluation-capabilities', actor='content', status=401)
            h.call('GET', b + '/channels/stable', actor='content')

            # Nonexecuting doctor snapshot and local safe diagnostic categories.
            before_doctor = counts()
            ready = invoke('doctor', '--config', f.evaluator_config, '--bundle', bundle)
            assert ready['status'] == 'ready' and callbacks() == 0
            diagnostic_results = {}
            variants = {
                'url': (dict(config, serviceUrl='http://public.example.invalid'), 'config.url'),
                'schema': (dict(config, unexpected='private-canary'), 'config.schema'),
                'denied': (dict(config, evaluatorToken=h.tokens['viewer'], evaluatorPrincipalId='viewer'), 'auth.denied'),
            }
            for name, (value, code) in variants.items():
                filename = f.write_json('private/config/' + name + '.json', value)
                result = invoke('doctor', '--config', filename, '--bundle', bundle, expected=2 if name == 'denied' else 1)
                assert result['checks'][-1]['code'] == code
                diagnostic_results[name] = code
            malformed = f.root / 'private/config/malformed.json'
            malformed.write_text('{bad private JSON')
            malformed.chmod(0o600)
            result = invoke('doctor', '--config', malformed, '--bundle', bundle, expected=1)
            diagnostic_results['malformed'] = result['checks'][-1]['code']
            assert diagnostic_results['malformed'] == 'config.schema'
            permissions = f.write_json('private/config/permissions.json', config)
            permissions.chmod(0o644)
            result = invoke('doctor', '--config', permissions, '--bundle', bundle, expected=1)
            diagnostic_results['permissions'] = result['checks'][-1]['code']
            assert diagnostic_results['permissions'] == 'config.permissions'
            permissions.chmod(0o600)
            assert counts() == before_doctor and callbacks() == 0

            def create(name):
                handoff = f.root / 'private' / (name + '-handoff.json')
                invoke('request', '--config', f.evaluator_config, '--bundle', bundle, '--channel', 'stable',
                    '--payload', app / 'candidate.json', '--intent', f.root / 'private' / (name + '-intent.json'), '--out', handoff)
                value = json.loads(handoff.read_text())
                return handoff, value, b + '/evaluation-requests/' + value['requestId']

            handoff, frozen, route = create('paired')
            target = ['--config', f.evaluator_config, '--handoff', handoff]
            current = h.call('GET', route, actor='evaluator')
            h.call('GET', b + '/versions/' + current['candidateVersionId'] + '/payload', actor='content', status=403)
            state_before_denial = h.sql('SELECT count(*) FROM evaluation_requests')
            denied = h.call('POST', route + '/start', {'attemptId': str(uuid.uuid4())}, actor='viewer', status=403)
            assert h.call('GET', route, actor='evaluator')['status'] == 'requested'
            assert h.sql('SELECT count(*) FROM evaluation_requests') == state_before_denial
            evidence['results']['authority'] = dict(status='accepted', grantValidator=valid_grants,
                principalId=caps['evaluator']['principalId'], evaluatorRights=['read', 'write'],
                evaluatorWriteCapability=True, readerWriteCapability=False, readerStartDenied=denied['error']['code'],
                contentCannotReadUnpublished=True, deniedWriteLeftRequestRequested=True)

            mismatch = dict(frozen, configuration={**frozen['configuration'], 'datasetRevision': 'wrong-installed-revision'})
            target_doctor_before = counts()
            mismatch_file = f.write_json('private/mismatch-handoff.json', mismatch)
            result = invoke('doctor', '--config', f.evaluator_config, '--handoff', mismatch_file, expected=2)
            diagnostic_results['descriptor'] = result['checks'][-1]['code']
            assert diagnostic_results['descriptor'] == 'descriptor.mismatch'
            missing = dict(frozen, requestId=str(uuid.uuid4()))
            missing_file = f.write_json('private/missing-handoff.json', missing)
            result = invoke('doctor', '--config', f.evaluator_config, '--handoff', missing_file, expected=2)
            diagnostic_results['missingRequest'] = result['checks'][-1]['code']
            diagnostic_results['missingRequestNextAction'] = result['nextAction']
            assert diagnostic_results['missingRequest'] == 'request.missing'
            assert result['nextAction'] == 'fix_config'
            missing_bundle = invoke('doctor', '--config', f.evaluator_config, '--bundle', str(uuid.uuid4()), expected=2)
            diagnostic_results['missingBundleStatus'] = missing_bundle['status']
            diagnostic_results['missingBundle'] = missing_bundle['checks'][-1]['code']
            diagnostic_results['missingBundleNextAction'] = missing_bundle['nextAction']
            assert diagnostic_results['missingBundle'] == 'bundle.missing'
            assert missing_bundle['nextAction'] == 'fix_config'
            assert callbacks() == 0 and h.call('GET', route, actor='evaluator')['status'] == 'requested'
            assert counts() == target_doctor_before
            evidence['results']['diagnostics'] = dict(status='accepted', codes=diagnostic_results,
                missingRequestExit=2, missingBundleExit=2, knownBundleStatus=ready['status'],
                initialCountsBefore=before_doctor, initialCountsAfter=before_doctor,
                targetCountsBefore=target_doctor_before, targetCountsAfter=counts(),
                doctorCallbacks=0, doctorAttemptStarted=False,
                doctorMutations=0)

            # Seal a real paired report, with submission unavailable, then recover
            # across coordinated static-grant restarts with the original root.
            progress_route = route + '/progress'
            initial_progress = h.call('GET', progress_route, actor='viewer')
            assert initial_progress['activity'] == 'absent' and initial_progress['observation'] is None
            gate.block = True
            blocked = invoke('run', '--live', *target, expected=3)
            assert blocked['error']['code'] == 'submission.unconfirmed' and callbacks() == 4
            running = h.call('GET', route, actor='evaluator')
            assert running['status'] == 'running'
            progress_script = app / 'report_owned_progress.py'
            progress_script.write_text(PROGRESS_CONSUMER)
            progress_script.chmod(0o600)
            progress_state = app / ('owned-progress-state-' + frozen['requestId'] + '.json')
            original_config = f.write_json('private/config/original-evaluator.json', config)

            def report_progress(*, replay=False, config_file=None):
                spec = f.write_json('private/progress-invocation-' + str(f._log_sequence) + '.json', dict(
                    config=str(config_file or f.evaluator_config), state=str(progress_state),
                    bundleId=bundle, requestId=frozen['requestId'], attemptId=running['attemptId'], replay=replay))
                return f.run([python, '-I', progress_script, spec], app)

            progress_counts = counts()
            callback_progress = [json.loads(line) for line in (app / 'callback-progress.jsonl').read_text().splitlines()]
            assert len(callback_progress) == 8 and all(row['ok'] for row in callback_progress)
            assert [row['sequence'] for row in callback_progress] == list(range(1, 9))
            first_report = report_progress(replay=True)
            assert first_report['ok'] is True and first_report['report']['sequence'] == 8
            fresh_progress = h.call('GET', progress_route, actor='viewer')
            assert fresh_progress['activity'] == 'fresh' and fresh_progress['status'] == 'running'
            assert fresh_progress['observation']['evaluatorPrincipal'] == 'evaluator'
            assert fresh_progress['observation']['attemptId'] == running['attemptId']
            assert first_report['report'].keys() <= fresh_progress['observation'].keys()
            assert report_progress(replay=True)['ok'] is True
            exact_progress = h.call('GET', progress_route, actor='viewer')
            assert exact_progress['observation'] == fresh_progress['observation']
            body = dict(first_report['report'], attemptId=running['attemptId'])
            foreign = h.call('POST', progress_route, dict(body, sequence=9), actor='other', status=409)
            wrong_attempt = h.call('POST', progress_route, dict(body, sequence=9, attemptId=str(uuid.uuid4())), actor='evaluator', status=409)
            reader_report = h.call('POST', progress_route, dict(body, sequence=9), actor='viewer', status=403)
            assert h.call('GET', progress_route, actor='viewer')['observation'] == fresh_progress['observation']
            h.sql("UPDATE evaluation_progress SET received_at=now()-interval '61 seconds' WHERE request_id='" + frozen['requestId'] + "'")
            stale_progress = h.call('GET', progress_route, actor='viewer')
            assert stale_progress['activity'] == 'stale' and stale_progress['status'] == 'running'
            assert report_progress(replay=True)['ok'] is True
            assert h.call('GET', progress_route, actor='viewer')['observation'] == stale_progress['observation']
            h.sql("UPDATE evaluation_progress SET expires_at=now()-interval '1 second' WHERE request_id='" + frozen['requestId'] + "'")
            expired_progress = h.call('GET', progress_route, actor='viewer')
            assert expired_progress['activity'] == 'absent' and expired_progress['observation'] is None
            assert report_progress(replay=True)['ok'] is True
            assert h.call('GET', progress_route, actor='viewer')['activity'] == 'absent'
            assert report_progress()['ok'] is True
            failed_config = f.write_json('private/config/progress-reader.json', dict(config, evaluatorToken=h.tokens['viewer']))
            failed_report = report_progress(config_file=failed_config)
            assert failed_report['ok'] is False
            assert counts() == progress_counts and callbacks() == 4
            assert h.call('GET', route, actor='evaluator')['status'] == 'running'
            evidence['results']['progress'] = dict(status='accepted', requestId=frozen['requestId'],
                attemptId=running['attemptId'], installedReporter='acclimate.EvaluationProgressReporter.report',
                reportingLocation='Actual installed execute callback before/after each owned simulator execution; explicit fresh processes retry held running attempt',
                callbackReports=callback_progress, callbackReportCount=8,
                sequencePersistence='Private app-owned request/attempt state written before each report; fresh installed processes reopen it',
                explicitOptIn=True, backgroundTimer=False, absent=initial_progress, fresh=fresh_progress,
                stale=stale_progress, expired=expired_progress, sameSequencePreservedReceipt=True,
                exactRetryAfterExpiryDidNotRefresh=True, foreignPrincipalDenied=foreign['error']['code'],
                wrongAttemptDenied=wrong_attempt['error']['code'], readerWriteDenied=reader_report['error']['code'],
                reportingFailureReturnedFalse=True, failedReportLeftRunRunning=True,
                countsBefore=progress_counts, countsAfter=counts(), callbacksStill=callbacks(),
                fixtureAging='Only owned PostgreSQL receipt/expiry timestamps changed explicitly',
                semantics='Server-received app assertion; fresh is not provider liveness, stale/absent is not stopped or takeover permission')
            journal_files = list(Path(config['journalRoot']).glob('*/attempt.python.json'))
            assert len(journal_files) == 1
            state_file = journal_files[0]
            saved = json.loads(state_file.read_text())
            assert saved['report'] and saved['executionStarted']
            root_info = Path(config['journalRoot']).stat()
            report_hash = hashlib.sha256((state_file.parent / 'submit-body.json').read_bytes()).hexdigest()
            replacement = secrets.token_hex(32)
            h.tokens['replacement'] = replacement
            overlapping = grants + [dict(token=replacement, principalId='evaluator', projectId=f.project, rights=['read', 'write'])]
            validate(overlapping)
            h.env['ACCLIMATE_AUTH'] = json.dumps(overlapping)
            h.restart()
            for actor in ('evaluator', 'replacement'):
                assert h.call('GET', base + '/evaluation-capabilities', actor=actor)['principalId'] == 'evaluator'
            replace_private_json(f.evaluator_config, dict(config, evaluatorToken=replacement))
            invoke('doctor', *target)
            gate.block = False
            recovered = invoke('run', '--live', *target)
            assert recovered['status'] == 'completed' and callbacks() == 4
            completed = h.call('GET', route, actor='replacement')
            after = json.loads(state_file.read_text())
            assert completed['attemptId'] == saved['attemptId'] and after['keys'] == saved['keys']
            assert hashlib.sha256((state_file.parent / 'submit-body.json').read_bytes()).hexdigest() == report_hash
            revoked = [grant for grant in overlapping if grant['token'] != h.tokens['evaluator']]
            validate(revoked)
            h.env['ACCLIMATE_AUTH'] = json.dumps(revoked)
            h.restart()
            old_denial = h.call('GET', route, actor='evaluator', status=401)
            revoked_progress = h.call('POST', progress_route, dict(body, sequence=11), actor='evaluator', status=401)
            assert report_progress(config_file=original_config)['ok'] is False
            late_progress = h.call('POST', progress_route, dict(body, sequence=12), actor='replacement', status=409)
            terminal_progress = h.call('GET', progress_route, actor='viewer')
            assert terminal_progress['status'] == 'completed' and terminal_progress['activity'] == 'stale'
            evidence['results']['progress'].update(revokedCredentialDenied=revoked_progress['error']['code'],
                revokedReporterReturnedFalse=True, lateTerminalReportDenied=late_progress['error']['code'],
                completedObservation=terminal_progress)
            final_replay = invoke('run', '--live', *target)
            final_root = Path(config['journalRoot']).stat()
            assert final_replay['comparisonId'] == completed['comparisonId'] and callbacks() == 4
            assert (root_info.st_dev, root_info.st_ino) == (final_root.st_dev, final_root.st_ino)
            comparison = h.call('GET', b + '/comparisons/' + completed['comparisonId'], actor='viewer')
            paired_rewards = [{key: row[key]['reward'] for key in ('parent', 'candidate')} for row in comparison['results']]
            parent_mean = sum(row['parent'] for row in paired_rewards) / len(paired_rewards)
            candidate_mean = sum(row['candidate'] for row in paired_rewards) / len(paired_rewards)
            assert parent_mean == 0.5 and candidate_mean == 1
            policy = invoke('check', *target, '--policy', app / 'quality-policy.json')
            assert policy['verdict'] == 'pass'
            evidence['results']['installed_execution'] = dict(status='accepted', language='python', requestId=frozen['requestId'],
                attemptId=completed['attemptId'], comparisonId=completed['comparisonId'], callbackCount=4,
                cases=len(comparison['results']), pairedRewards=paired_rewards, parentMean=parent_mean,
                candidateMean=candidate_mean, qualityVerdict=policy['verdict'],
                channelStillBaseline=h.call('GET', b + '/channels/stable', actor='viewer')['version']['id'] == setup['version']['id'])
            evidence['results']['rotation_recovery'] = dict(status='accepted', blockedSubmissions=gate.blocked,
                initialSafeCode=blocked['error']['code'], originalCredentialRevoked=old_denial['error']['code'],
                principalPreserved=True, requestPreserved=True, attemptPreserved=True, operationKeysPreserved=True,
                physicalJournalRootPreserved=True, sealedReportSha256=report_hash, callbackCountAfterRecovery=callbacks(),
                comparisonId=completed['comparisonId'], serviceRestarts=2)

            # A real installed app callback explicitly leaves execution uncertain.
            uncertain_handoff, uncertain_frozen, uncertain_route = create('uncertain')
            uncertain_target = ['--config', f.evaluator_config, '--handoff', uncertain_handoff]
            (app / 'uncertain.flag').touch(mode=0o600)
            uncertain = invoke('run', '--live', *uncertain_target, expected=3)
            assert uncertain['error']['code'] == 'execution.uncertain' and callbacks() == 5
            repeated = invoke('run', '--live', *uncertain_target, expected=3)
            assert repeated['error']['code'] == 'execution.uncertain' and callbacks() == 5
            unknown = invoke('status', *uncertain_target)
            assert unknown['status'] == 'running'
            uncertain_progress = h.call('GET', uncertain_route + '/progress', actor='viewer')
            assert uncertain_progress['status'] == 'running' and uncertain_progress['activity'] == 'fresh'
            assert uncertain_progress['attemptId'] == unknown['attemptId']
            interruption = invoke('interrupt', *uncertain_target, '--reason', 'Owned model-free callback process exited; preserve uncertainty and do not replay')
            assert interruption['status'] == 'interrupted' and interruption['attemptId'] == unknown['attemptId']
            no_replay = invoke('run', '--live', *uncertain_target, expected=3)
            assert no_replay['status'] == 'interrupted' and callbacks() == 5
            interrupted_progress = h.call('GET', uncertain_route + '/progress', actor='viewer')
            assert interrupted_progress['status'] == 'interrupted' and interrupted_progress['activity'] == 'stale'
            assert interrupted_progress['observation'] == uncertain_progress['observation']
            late_uncertain = h.call('POST', uncertain_route + '/progress', dict(
                attemptId=unknown['attemptId'], sequence=1, phase='executing', completed=0, total=4,
                case=uncertain_progress['observation']['case']), actor='replacement', status=409)
            evidence['results']['uncertainty'] = dict(status='accepted', requestId=uncertain_frozen['requestId'],
                attemptId=unknown['attemptId'], safeCode=uncertain['error']['code'], refusedReplay=True,
                callbackCountBefore=4, callbackCountAfter=5, stateBeforeIntent=unknown['status'], finalState=interruption['status'],
                runningProgress=uncertain_progress, interruptedProgress=interrupted_progress,
                exactProgressRetryAfterInterruptDenied=late_uncertain['error']['code'],
                liveness='Unknown remotely; owned synchronous app process had exited; no provider job was launched')

            # Receipt ordering is server receipt order. Delayed occurredAt fields
            # must stay bound to the same latest event rather than mixed maxima.
            now = datetime.now(timezone.utc)
            def observation(stage, when):
                return dict(eventId=str(uuid.uuid4()), integrationId=connection['id'], projectId=f.project,
                    bundleId=bundle, channel='stable', revision='1', versionId=setup['version']['id'],
                    digest=setup['version']['digest'], stage=stage, occurredAt=when.isoformat(),
                    source='network', resolvedAt=when.isoformat(), stale=False)
            fresh = observation('resolved', now)
            h.call('POST', integration + '/receipts', fresh, actor='receipt')
            older = observation('verified', now - timedelta(hours=2))
            old_receipt = h.call('POST', integration + '/receipts', older, actor='receipt')
            latest = h.call('GET', base + '/integration-observations', actor='viewer')['items'][0]
            assert latest['latestObservation']['eventId'] == older['eventId']
            assert latest['latestObservation']['stage'] == older['stage']
            assert datetime.fromisoformat(latest['latestObservation']['occurredAt'].replace('Z', '+00:00')) == now - timedelta(hours=2)
            assert set(latest) == {'id', 'displayName', 'bundleId', 'channel', 'enabled', 'latestObservation'}
            # Advance only this owned fixture's receive-time facts to exercise
            # retention and old activity without claiming a real elapsed wait.
            h.sql("UPDATE integration_receipts SET received_at=now()-interval '2 hours' WHERE integration_id='" + connection['id'] + "'")
            aged = h.call('GET', base + '/integration-observations', actor='viewer')['items'][0]['latestObservation']
            assert aged is not None
            age = datetime.now(timezone.utc) - datetime.fromisoformat(aged['receivedAt'].replace('Z', '+00:00'))
            assert age > timedelta(minutes=119)
            h.sql("UPDATE integration_receipts SET received_at=now()-interval '31 days' WHERE integration_id='" + connection['id'] + "'")
            expired = h.call('GET', base + '/integration-observations', actor='viewer')['items'][0]
            assert expired['latestObservation'] is None
            before_admin = h.sql('SELECT count(*) FROM integration_credentials')
            admin_denied = h.call('POST', integration + '/credentials', {'kind': 'content-read'}, actor='viewer', status=403)
            assert h.sql('SELECT count(*) FROM integration_credentials') == before_admin
            evidence['results']['reader_delivery'] = dict(status='accepted', integrationId=connection['id'],
                initiallyUnknown=True, latestEventId=older['eventId'], latestStage=older['stage'],
                delayedReceipt=old_receipt['delayed'], latestFieldsCoherent=True, credentialMetadataAbsent=True,
                agedActivityVisible=True, agedReceiveTimeFixtureHours=2, expiredAfterFixtureDays=31,
                expiredActivityBecomesUnknown=True, fixtureAging='Owned PostgreSQL receive timestamps advanced explicitly; no real elapsed-wait claim',
                adminDenied=admin_denied['error']['code'], noCredentialCreatedOnDeniedRequest=True,
                semantics='Application observation only; delayed event time is visible; no consumption or evaluator liveness claim')
            evidence['releaseSourceInventorySha256'] = f.manifest['source']['sha256']
            evidence['releaseManifestSha256'] = f.release_manifest_sha256
            evidence['releaseChecksumsSha256'] = f.release_checksums_sha256
            evidence['installationProofs'] = f.installation_proofs
            evidence['serviceBinarySha256'] = f.service_sha256
            evidence['sourceCommit'] = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True,
                text=True, check=True, env=f.clean_env).stdout.strip()
            evidence['sourceWorktreeMayBeDirty'] = True
            evidence['overall'] = 'accepted_within_tested_scope'
            evidence['remainingFriction'] = ['Static grant changes require two coordinated restarts; write right is broader than evaluation',
                'Progress is optional app-owned reporting; local uncertainty remains an operator responsibility',
                'Human browser activity rendering remains a separate council acceptance gate']
            evidence['finalDatabaseCounts'] = counts()
            command_summaries = [json.loads(path.read_text()) for path in sorted((f.root / 'private/commands').glob('*.json'))
                if not path.name.endswith('.invocation.json')]
            assert all(row['exitCode'] == row['expectedExitCode'] for row in command_summaries)
            evidence['commandExitCounts'] = {str(code): sum(row['exitCode'] == code for row in command_summaries)
                for code in sorted({row['exitCode'] for row in command_summaries})}
            evidence['commandCount'] = len(command_summaries)
            evidence['allCommandExitsExpected'] = True
            f.verify_release_unchanged()
        finally:
            gate.close()
    evidence['cleanup'] = json.loads((f.root / 'private/cleanup.json').read_text())
    evidence['cleanup'].pop('servicePid', None)
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = journey(args.output)
    destination = args.output / 'platform-engineer.json'
    destination.write_text(json.dumps(result, indent=2) + '\n')
    destination.chmod(0o600)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
