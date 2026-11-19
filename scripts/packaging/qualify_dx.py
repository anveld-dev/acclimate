#!/usr/bin/env python3
"""Installed JS/wheel evaluators against a disposable real PostgreSQL/Rust service.

No ambient database, user credential file, model provider or public deployment is used.
Only the generated private fixture config receives fixture machine credentials.
"""
if not __debug__:
    raise RuntimeError('Qualification requires Python assertions; remove -O/PYTHONOPTIMIZE')

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import socket
import sys
import tempfile
import tarfile
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import venv

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'scripts' / 'productization'))
from qualify import Harness
from scripts.packaging.fixture_application import FIXTURE, commit_candidate, install_test_application


class ResponseLossProxy:
    """Lose actual committed fixture responses after expiring transient dedup."""

    def __init__(self, harness):
        self.harness = harness
        self.lock = threading.Lock()
        self.lost = {}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass  # Never log Authorization, private body, or request paths.

            def do_GET(self):
                self.forward()

            def do_POST(self):
                self.forward()

            def forward(self):
                data = self.rfile.read(int(self.headers.get('Content-Length', '0'))) if self.command == 'POST' else None
                headers = {key: value for key, value in self.headers.items()
                           if key.lower() not in ('host', 'connection', 'content-length')}
                headers['Connection'] = 'close'
                try:
                    upstream = urlopen(Request(owner.harness.base + self.path, data=data,
                                               headers=headers, method=self.command), timeout=30)
                except HTTPError as error:
                    upstream = error
                with upstream:
                    content = upstream.read(4 * 1048576 + 1)
                    if len(content) > 4 * 1048576:
                        raise ValueError('Fixture proxy response exceeded budget')
                    phase = None
                    if self.command == 'POST' and 200 <= upstream.status < 300:
                        if self.path.endswith('/drafts'):
                            phase = 'draft'
                        elif self.path.endswith('/evaluation-requests'):
                            phase = 'request'
                        elif self.path.endswith('/start'):
                            phase = 'start'
                        elif self.path.endswith('/comparisons'):
                            phase = 'submit'
                        elif self.path.endswith('/finish'):
                            phase = 'finish'
                    should_drop = False
                    if phase:
                        with owner.lock:
                            if phase not in owner.lost:
                                value = json.loads(content)
                                owner.lost[phase] = {'id': value['id']}
                                should_drop = True
                    if should_drop:
                        # The service committed before this query and before the
                        # transport failure. Retry must use retained state.
                        owner.harness.sql("UPDATE idempotency SET expires_at=now()-interval '25 hours'")
                        self.close_connection = True
                        try:
                            self.connection.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                        self.connection.close()
                        return
                    self.send_response(upstream.status)
                    self.send_header('Content-Type', upstream.headers.get('Content-Type', 'application/json'))
                    self.send_header('Content-Length', str(len(content)))
                    self.send_header('Connection', 'close')
                    for name in ('Cache-Control', 'X-Request-Id'):
                        if upstream.headers.get(name):
                            self.send_header(name, upstream.headers[name])
                    self.end_headers()
                    self.wfile.write(content)
                    self.close_connection = True

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.base = 'http://127.0.0.1:' + str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def reset(self):
        with self.lock:
            self.lost = {}

    def snapshot(self):
        with self.lock:
            return dict(self.lost)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def private_json(filename, value):
    filename.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if filename.exists():
        raise FileExistsError('Private qualification output already exists')
    fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        output.write('\n')


def replace_private_json(filename, value):
    """Operator rotation of this harness's own generated config, preserving its scope."""
    temporary = filename.with_name('.rotation-' + secrets.token_hex(12) + '.tmp')
    private_json(temporary, value)
    with temporary.open('rb') as source:
        os.fsync(source.fileno())
    os.replace(temporary, filename)
    parent = os.open(filename.parent, os.O_RDONLY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def run(command, *, cwd, expected=0, env=None):
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True)
    if result.returncode != expected:
        # Callback/service text can be private. Keep failure output out of public logs.
        error = None
        try:
            parsed = json.loads(result.stderr or result.stdout)
            error = parsed.get('error', {}).get('code')
        except (ValueError, AttributeError):
            pass
        raise AssertionError(f'Installed consumer {Path(command[0]).name} command {command[2] if len(command) > 2 else "check"} returned {result.returncode}, expected {expected}; safe code={error}')
    if not result.stdout.strip():
        return None
    return json.loads(result.stdout)


def verify_release(release):
    manifest = json.loads((release / 'manifest.json').read_text())
    names = set()
    for artifact in manifest['artifacts']:
        name = artifact['name']
        if Path(name).name != name or name in ('.', '..') or name in names:
            raise ValueError('Unsafe release artifact name')
        names.add(name)
        if (release / name).is_symlink() or not (release / name).is_file():
            raise ValueError('Release artifact is not a regular file')
        data = (release / name).read_bytes()
        assert len(data) == artifact['bytes']
        assert hashlib.sha256(data).hexdigest() == artifact['sha256']
    required = {'SOURCE.json', 'release-metadata.json'}
    required.update(item['file'] for item in manifest['packages'])
    required.update(item['file'] for item in manifest['starters'])
    if required != names:
        raise ValueError('Release manifest does not cover exactly the declared artifacts')
    source = json.loads((release / 'SOURCE.json').read_text())
    digest = hashlib.sha256(json.dumps(source['files'], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    if source['sha256'] != digest or manifest['source']['file'] != 'SOURCE.json' or manifest['source']['sha256'] != digest:
        raise ValueError('Release source fingerprint does not match its verified source inventory')
    checksums = ''.join(f"{item['sha256']}  {item['name']}\n" for item in manifest['artifacts'])
    if (release / 'SHA256SUMS').read_text() != checksums:
        raise ValueError('Release checksums do not match its verified manifest')
    return manifest


def extract_starter(release, metadata, destination):
    """Read the actual distributed archive, never current checkout starter code."""
    archive = release / metadata['file']
    prefix = metadata['directory']
    if Path(prefix).name != prefix or prefix in ('.', '..'):
        raise ValueError('Invalid starter archive root')
    destination.mkdir(mode=0o700)
    seen, total = set(), 0
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        if len(members) > 2000:
            raise ValueError('Starter archive exceeds entry limit')
        for member in members:
            relative = Path(member.name)
            if (relative.is_absolute() or any(part in ('.', '..') for part in relative.parts)
                    or not relative.parts or relative.parts[0] != prefix
                    or not (member.isdir() or member.isfile())):
                raise ValueError('Unsupported starter archive member')
            identity = str(relative).casefold()
            if identity in seen:
                raise ValueError('Duplicate starter archive member')
            seen.add(identity)
            if member.isfile():
                if member.size > 1048576:
                    raise ValueError('Starter archive member too large')
                total += member.size
            if total > 16 * 1048576:
                raise ValueError('Starter archive exceeds byte limit')
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'wb') as output, source.extractfile(member) as content:
                    shutil.copyfileobj(content, output)
    return destination / prefix


def qualify(release, pg_bin):
    manifest = verify_release(release)
    service_binary = ROOT / 'target/debug/acclimate-service'
    service_digest = hashlib.sha256(service_binary.read_bytes()).hexdigest()
    h = Harness(pg_bin)
    checks = []
    consumers = []
    proxy = None
    try:
        # Add a real project-read-only machine principal for second-reader verification.
        h.tokens['viewer'] = secrets.token_hex(32)
        grants = json.loads(h.env['ACCLIMATE_AUTH'])
        grants.append({'token': h.tokens['viewer'], 'principalId': 'viewer', 'projectId': h.project, 'rights': ['read']})
        h.env['ACCLIMATE_AUTH'] = json.dumps(grants)
        h.start()
        proxy = ResponseLossProxy(h)
        base = '/v1/projects/' + h.project
        payload = json.loads((FIXTURE / 'baseline.json').read_text())
        setup = h.call('POST', base + '/bundle-setups', {
            'name': 'Installed evaluator qualification', 'origin': 'example',
            'sourceLabel': 'Disposable model-free installed application', 'channel': 'stable',
            'payload': payload, 'reason': 'Explicit disposable seed fixture',
        })
        bundle = setup['bundle']['id']
        clean_env = {key: value for key, value in os.environ.items()
                     if key not in ('PYTHONPATH', 'PYTHONHOME', 'DATABASE_URL', 'NODE_OPTIONS')
                     and not key.startswith(('ACCLIMATE_', 'CONSOLE_'))}
        node = shutil.which('node')
        if node is None:
            raise RuntimeError('Node >=22.22 is required')
        sdk = next(release / item['name'] for item in manifest['artifacts'] if item['name'].startswith('acclimate-sdk-') and item['name'].endswith('.tgz'))
        wheel = next(release / item['name'] for item in manifest['artifacts'] if item['name'].endswith('.whl'))
        starter = next(item for item in manifest['starters'] if item['name'] == 'evaluation')
        default_policy = extract_starter(release, starter, h.dir / 'evaluation-starter') / 'quality-policy.example.json'
        for language in ('javascript', 'python'):
            proxy.reset()
            app = h.dir / language / 'app'
            app.mkdir(parents=True, mode=0o700)
            if language == 'javascript':
                private_json(app / 'package.json', {'private': True, 'type': 'module'})
                subprocess.run(['npm', 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', str(sdk)],
                               cwd=app, env=clean_env, check=True, stdout=subprocess.DEVNULL)
                command = [str(app / 'node_modules/.bin/acclimate-eval')]
            else:
                environment = h.dir / language / 'venv'
                venv.EnvBuilder(with_pip=True).create(environment)
                python = environment / 'bin' / 'python'
                subprocess.run([str(python), '-m', 'pip', 'install', '--no-index', '--no-deps', str(wheel)],
                               cwd=app, env=clean_env, check=True, stdout=subprocess.DEVNULL)
                command = [str(python), '-m', 'acclimate']
            app_env = dict(clean_env, ACCLIMATE_EVALUATOR_CASES=install_test_application(app, language))
            descriptor = run(command + ['describe'], cwd=app, env=app_env)
            assert descriptor['runtime']['execution'] == 'live'
            assert len(descriptor['expectedCases']) == 2
            private = h.dir / language / 'private'
            private.mkdir(mode=0o700)
            config, reader, intent, handoff = private / 'config' / 'evaluator.json', private / 'config' / 'reader.json', private / 'intent.json', app / 'evaluation-request.json'
            private_json(config, {'schemaVersion': 1, 'serviceUrl': proxy.base, 'projectId': h.project,
                                 'evaluatorPrincipalId': 'evaluator', 'evaluatorToken': h.tokens['evaluator'],
                                 'journalRoot': str(private / 'journals')})
            private_json(reader, {'schemaVersion': 1, 'serviceUrl': proxy.base, 'projectId': h.project, 'readToken': h.tokens['viewer']})
            run(command + ['doctor', '--config', str(config), '--bundle', bundle, '--policy', str(app / 'quality-policy.json')], cwd=app, env=app_env)
            creation = ['request', '--config', str(config), '--bundle', bundle, '--channel', 'stable',
                        '--payload', str(app / 'candidate.json'), '--intent', str(intent), '--out', str(handoff)]
            run(command + creation, cwd=app, env=app_env)
            first_handoff = handoff.read_bytes()
            frozen = json.loads(first_handoff)
            h.sql("UPDATE idempotency SET expires_at=now()-interval '25 hours'")
            run(command + creation, cwd=app, env=app_env)
            assert handoff.read_bytes() == first_handoff
            target = ['--config', str(config), '--handoff', str(handoff)]
            run(command + ['run', '--live', *target], cwd=app, env=app_env)
            evaluation_route = base + '/bundles/' + bundle + '/evaluation-requests/' + frozen['requestId']
            first_request = h.call('GET', evaluation_route, actor='evaluator')
            assert first_request['status'] == 'completed' and first_request['comparisonId']
            losses = proxy.snapshot()
            assert set(losses) == {'draft', 'request', 'start', 'submit', 'finish'}
            assert losses['request']['id'] == frozen['requestId']
            assert losses['start']['id'] == frozen['requestId']
            assert losses['finish']['id'] == frozen['requestId']
            assert losses['submit']['id'] == first_request['comparisonId']
            index_files = list((private / 'journals').glob('*/artifact-index.json'))
            assert len(index_files) == 1
            index = json.loads(index_files[0].read_text())
            assert len([entry for entry in index['entries'] if entry['role'] == 'output']) == 4
            assert len([entry for entry in index['entries'] if entry['role'] == 'grader-explanation']) == 4
            run(command + ['check', *target, '--policy', str(app / 'quality-policy.json')], cwd=app, env=app_env)
            executed = (app / 'executions.log').read_bytes()
            assert len(executed.splitlines()) == 4
            summary = run(command + ['compare', *target, '--live', '--policy', str(app / 'quality-policy.json')],
                          cwd=app, env=app_env)
            assert summary['requestId'] == frozen['requestId'] and summary['comparisonId'] == first_request['comparisonId']
            assert summary['scores']['summary']['parentMean'] == 0.5
            assert summary['scores']['summary']['candidateMean'] == 1
            assert {case['caseId']: (case['parentMean'], case['candidateMean']) for case in summary['scores']['cases']} == {
                'clean': (1, 1), 'lost-response': (0, 1)}
            assert summary['policy']['verdict'] == 'pass' and summary['policyReceipt']['status'] == 'recorded'
            receipt_path = f"{base}/bundles/{bundle}/comparisons/{first_request['comparisonId']}/policy-receipts"
            receipts = h.call('GET', receipt_path, actor='viewer')['items']
            assert len(receipts) == 1
            assert receipts[0]['requestId'] == frozen['requestId']
            assert receipts[0]['policy'] == summary['policy']['policy'] and receipts[0]['verdict'] == 'pass'
            assert (app / 'executions.log').read_bytes() == executed

            failing = json.loads((app / 'quality-policy.json').read_text())
            failing['minimumMeanImprovement'] = 2
            private_json(private / 'failing-policy.json', failing)
            run(command + ['check', *target, '--policy', str(private / 'failing-policy.json')], cwd=app, expected=2, env=app_env)
            incompatible = dict(failing, requiredCases=['undeclared-critical-task'])
            private_json(private / 'incompatible-policy.json', incompatible)
            run(command + ['check', *target, '--policy', str(private / 'incompatible-policy.json')], cwd=app, expected=1, env=app_env)
            h.sql("UPDATE idempotency SET expires_at=now()-interval '25 hours'")
            run(command + ['run', '--live', *target], cwd=app, env=app_env)
            recovered = h.call('GET', evaluation_route, actor='evaluator')
            assert recovered['comparisonId'] == first_request['comparisonId']
            scalar_export, selected_export = private / 'scalar-export', private / 'selected-export'
            run(command + ['export', *target, '--out', str(scalar_export)], cwd=app, env=app_env)
            run(command + ['verify-export', '--manifest', str(scalar_export / 'manifest.json')], cwd=app, env=app_env)
            run(command + ['export', *target, '--selection', str(app / 'share-selection.json'), '--out', str(selected_export)], cwd=app, env=app_env)
            run(command + ['verify-export', '--manifest', str(selected_export / 'manifest.json'), '--read-config', str(reader), '--handoff', str(handoff)], cwd=app, env=app_env)
            for export in (scalar_export, selected_export):
                for file in export.rglob('*'):
                    if file.is_file():
                        data = file.read_bytes()
                        for secret in (h.tokens['evaluator'], h.tokens['viewer'], str(config), str(private / 'journals')):
                            assert secret.encode() not in data
            consumers.append({'command': command, 'cwd': app, 'env': app_env, 'reader': reader, 'config': config,
                              'handoff': handoff, 'export': selected_export,
                              'evaluationRoute': evaluation_route,
                              'comparisonId': first_request['comparisonId']})
            checks.append({'language': language, 'installedImports': 'passed', 'installedApplicationDescriptor': 'passed',
                           'headlessCandidateAndRequest': 'passed', 'creationReplayBeyond24h': 'passed',
                           'lostCommittedResponseBeyond24h': 'passed: draft/request/start/submit/finish',
                           'pairedRun': 'passed', 'policyPassFailInvalid': 'passed', 'terminalReplay': 'passed',
                           'selectedReviewArtifacts': 'passed', 'independentReadOnlyVerification': 'passed',
                           'exportSecretCanaries': 'passed'})
        for verifier, source in ((consumers[0], consumers[1]), (consumers[1], consumers[0])):
            verified = run(verifier['command'] + ['verify-export', '--manifest', str(source['export'] / 'manifest.json'),
                                                 '--read-config', str(verifier['reader']), '--handoff', str(source['handoff'])],
                           cwd=verifier['cwd'], env=verifier['env'])
            assert verified['provenance'] == 'online_scalar_binding'
            assert verified['executionAttested'] is False
        # Rehearse the documented static-grant overlap rotation on this private
        # service, preserving one principal and physical journal root.
        replacement_token = secrets.token_hex(32)
        h.tokens['replacement'] = replacement_token
        replacement_grant = {'token': replacement_token, 'principalId': 'evaluator',
                             'projectId': h.project, 'rights': ['read', 'write']}
        overlapping = grants + [replacement_grant]

        def validate_grants(value):
            checked = subprocess.run([str(ROOT / 'target/debug/acclimate-service'), '--check-grants'],
                                     input=json.dumps(value), text=True, capture_output=True,
                                     env=clean_env, cwd=ROOT)
            assert checked.returncode == 0, 'Fixture grant validator rejected a valid overlap'

        validate_grants(overlapping)
        h.env['ACCLIMATE_AUTH'] = json.dumps(overlapping)
        h.restart()
        for consumer in consumers:
            target = ['--config', str(consumer['config']), '--handoff', str(consumer['handoff'])]
            run(consumer['command'] + ['status', *target], cwd=consumer['cwd'], env=consumer['env'])
            run(consumer['command'] + ['run', '--live', *target], cwd=consumer['cwd'], env=consumer['env'])
            original_config = json.loads(consumer['config'].read_text())
            rotated_config = dict(original_config, evaluatorToken=replacement_token)
            assert {key: value for key, value in original_config.items() if key != 'evaluatorToken'} == {
                key: value for key, value in rotated_config.items() if key != 'evaluatorToken'}
            replace_private_json(consumer['config'], rotated_config)
            run(consumer['command'] + ['doctor', *target], cwd=consumer['cwd'], env=consumer['env'])
            run(consumer['command'] + ['status', *target], cwd=consumer['cwd'], env=consumer['env'])
            run(consumer['command'] + ['run', '--live', *target], cwd=consumer['cwd'], env=consumer['env'])
            assert h.call('GET', consumer['evaluationRoute'], actor='replacement')['comparisonId'] == consumer['comparisonId']
        revoked = [grant for grant in overlapping if grant['token'] != h.tokens['evaluator']]
        validate_grants(revoked)
        h.env['ACCLIMATE_AUTH'] = json.dumps(revoked)
        h.restart()
        for consumer in consumers:
            h.call('GET', consumer['evaluationRoute'], actor='evaluator', status=401)
            target = ['--config', str(consumer['config']), '--handoff', str(consumer['handoff'])]
            run(consumer['command'] + ['run', '--live', *target], cwd=consumer['cwd'], env=consumer['env'])
            assert h.call('GET', consumer['evaluationRoute'], actor='replacement')['comparisonId'] == consumer['comparisonId']
            journal = json.loads(consumer['config'].read_text())['journalRoot']
            index = json.loads(next(Path(journal).glob('*/artifact-index.json')).read_text())
            assert len([entry for entry in index['entries'] if entry['role'] == 'output']) == 4
        for consumer in consumers:
            app = consumer['cwd']
            comparison = [*consumer['command'], 'compare', '--config', str(consumer['config']),
                          '--bundle', bundle, '--channel', 'stable', '--payload', str(app / 'candidate.json'),
                          '--name', 'qualification-comparison', '--live', '--policy', str(app / 'quality-policy.json')]
            first = run(comparison, cwd=app, env=consumer['env'])
            assert first['status'] == 'completed' and first['policy']['verdict'] == 'pass'
            executed = (app / 'executions.log').read_bytes()
            assert len(executed.splitlines()) == 8
            replay = run(comparison, cwd=app, env=consumer['env'])
            assert replay['requestId'] == first['requestId'] and replay['comparisonId'] == first['comparisonId']
            assert replay['scores'] == first['scores']
            assert (app / 'executions.log').read_bytes() == executed
            assert first['runName'] == 'qualification-comparison'
            assert first['invocation'] == {'callbacksStarted': 4, 'reusedEvidence': False}
            assert replay['invocation'] == {'callbacksStarted': 0, 'reusedEvidence': True}
            handle = ['--config', str(consumer['config']), '--name', first['runName']]
            def followup(command, *args, expected=0):
                return run([*consumer['command'], command, *args], cwd=app, env=consumer['env'], expected=expected)
            assert followup('status', *handle)['requestId'] == first['requestId']
            # The starter's statistical example policy needs at least 10 cases; two are insufficient.
            gate = followup('check', *handle, '--policy', str(default_policy), expected=3)
            assert gate['verdict'] == 'indeterminate' and gate['code'] == 'inference.insufficient_data'
            assert gate['policyReceipt']['status'] == 'recorded'
            journal = Path(json.loads(consumer['config'].read_bytes())['journalRoot'])
            reviewed = followup('check', '--read-config', str(consumer['reader']), '--handoff',
                                str(journal / 'comparisons' / first['runName'] / 'request.json'),
                                '--policy', str(default_policy), expected=3)
            assert reviewed['verdict'] == 'indeterminate' and reviewed['policyReceipt']['status'] == 'read_only'
            destination = app / 'named-review'
            followup('export', *handle, '--out', str(destination))
            followup('verify-export', '--manifest', str(destination / 'manifest.json'))
            assert (app / 'executions.log').read_bytes() == executed
            source = app / ('application.py' if consumer['command'][-1] == 'acclimate' else 'application.mjs')
            old_source = source.read_bytes()
            try:
                # A corrected application is eligible only through explicit creation of a fresh attempt.
                source.write_bytes(old_source + b'\n')
                run(comparison, cwd=app, env=consumer['env'], expected=1)
                successor = comparison.copy()
                successor[successor.index('--name')] = '--retry-after'
                fresh = run(successor, cwd=app, env=consumer['env'])
                assert fresh['requestId'] != first['requestId'] and fresh['runName'] == 'after-' + first['requestId']
                assert fresh['invocation'] == {'callbacksStarted': 4, 'reusedEvidence': False}
                repeated = run(successor, cwd=app, env=consumer['env'])
                assert repeated['requestId'] == fresh['requestId'] and repeated['comparisonId'] == fresh['comparisonId']
                assert repeated['invocation'] == {'callbacksStarted': 0, 'reusedEvidence': True}
            finally:
                source.write_bytes(old_source)
            assert len((app / 'executions.log').read_bytes().splitlines()) == 12
        # Exercise the actual provider-neutral CI archive, not a reconstructed
        # sequence alone, with both installed runtimes and rotated credentials.
        ci_metadata = next(item for item in manifest['starters'] if item['name'] == 'ci')
        ci = extract_starter(release, ci_metadata, h.dir / 'distributed-ci')
        ci_intents = h.dir / 'ci-intents'
        ci_intents.mkdir(mode=0o700)
        for language, consumer in zip(('javascript', 'python'), consumers):
            ci_output = h.dir / 'ci-results' / language
            app = consumer['cwd']
            repo = h.dir / ('ci-checkout-' + language)
            commit = commit_candidate(repo, app / 'candidate.json')
            ci_env = dict(consumer['env'], ACCLIMATE_CI_PYTHON=consumers[1]['command'][0])
            retained_request = (['--language', language, '--intent', str(ci_intents / 'javascript.json')]
                                if language == 'javascript' else [])
            executed = subprocess.run(['sh', str(ci / 'ci.sh'), *retained_request,
                                       '--app', str(app), '--config', str(consumer['config']),
                                       '--bundle', bundle, '--channel', 'stable', '--repo', str(repo),
                                       '--commit', commit, '--payload', 'candidate.json', '--live',
                                       '--policy', str(app / 'quality-policy.json'),
                                       '--selection', str(app / 'share-selection.json'),
                                       '--output-dir', str(ci_output)],
                                      cwd=ci, env=ci_env, capture_output=True, text=True)
            summary = json.loads(executed.stdout)
            assert executed.returncode == 0, ('CI qualification failed', summary.get('result'), summary.get('phaseExitCodes'))
            assert summary['commit'] == commit and summary['qualityVerdict'] == 'pass'
            assert all(status == 0 for status in summary['phaseExitCodes'].values())
            handoff = ci_output / summary['handoff']
            assert json.loads(handoff.read_bytes())['requestId'] == summary['requestId']
            if language == 'python':
                assert handoff.is_relative_to(ci_output / 'requests')
                assert (handoff.parent / 'request-intent.json').is_file()

            committed = list(ci_output.glob('review-*/manifest.json'))
            assert len(committed) == 1
            run(consumer['command'] + ['verify-export', '--manifest', str(committed[0])],
                cwd=consumer['cwd'], env=consumer['env'])
        downloads = h.dir / 'review-downloads'
        downloads.mkdir(mode=0o700)
        for index, consumer in enumerate(consumers):
            consumer['download'] = downloads / str(index)
            shutil.copytree(consumer['export'], consumer['download'])
        # Every run above is confirmed terminal and every app process exited.
        # Remove only this disposable fixture's worker journals, then prove the
        # reviewer path does not depend on them or recreate them. Never rerun.
        removed_roots = []
        for consumer in consumers:
            journal_root = Path(json.loads(consumer['config'].read_text())['journalRoot'])
            shutil.rmtree(journal_root)
            removed_roots.append(journal_root)
        for verifier, source in ((consumers[0], consumers[1]), (consumers[1], consumers[0])):
            run(verifier['command'] + ['verify-export', '--manifest', str(source['download'] / 'manifest.json'),
                                       '--read-config', str(verifier['reader']), '--handoff', str(source['handoff'])],
                cwd=verifier['cwd'], env=verifier['env'])
        assert all(not journal.exists() for journal in removed_roots)
        if hashlib.sha256(service_binary.read_bytes()).hexdigest() != service_digest:
            raise ValueError('Service binary changed during qualification')
        return {'schemaVersion': 1, 'kind': 'acclimate-installed-dx-qualification',
                'version': manifest['version'], 'checks': checks,
                'sourceFingerprint': manifest.get('source', {}).get('sha256'),
                'sourceFingerprintScope': 'Verified release artifact inventory; does not attest the separately built service binary source',
                'serviceBinary': {'sha256': service_digest, 'sourceAttestation': 'not claimed'},
                'crossLanguageReviewVerification': 'passed in both directions',
                'compare': 'JS and Python verified named status, policy receipt and export, callback counts on replay, and a single fresh successor after a changed build',
                'operatorGrantValidation': 'passed: stdin validator, no listener/runtime config',
                'samePrincipalOverlapRotation': 'passed: old+new overlap, original token then401, new token retained original comparison',
                'fixedRootWorkerRecovery': 'passed: fresh CLI/service processes and same local physical journal roots; containers not tested',
                'distributedCiScript': 'passed: actual archived shell entrypoint with installed JavaScript and Python runtimes',
                'downloadedReviewAfterWorkerStateRemoval': 'passed: cross-language read-only verification with all terminal fixture journals removed, no recreation/reexecution',
                'service': 'disposable real Rust/PostgreSQL', 'models': 'not run',
                'liveNativeQualification': 'not run', 'publicDeployment': 'not run',
                'limits': 'Focused installed-consumer evidence; does not claim every G01-G22 gate.'}
    finally:
        if proxy is not None:
            proxy.close()
        h.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin', required=True)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--output', type=Path)
    arguments = parser.parse_args()
    report = qualify(arguments.release.resolve(), arguments.pg_bin)
    if arguments.output:
        private_json(arguments.output.resolve(), report)
    print(json.dumps(report, separators=(',', ':')))
