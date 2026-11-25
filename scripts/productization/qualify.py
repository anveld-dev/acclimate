#!/usr/bin/env python3
"""Model-free product gate against a private PostgreSQL cluster and real Rust service.

Never reads dotenv files or uses an existing DATABASE_URL. Cluster is deleted on exit.
"""
import argparse
import sys
import json
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Harness:
    def __init__(self, pg_bin):
        self.pg_bin = Path(pg_bin)
        self.temp = tempfile.TemporaryDirectory(prefix='acclimate-productization-')
        self.dir = Path(self.temp.name).resolve()
        self.pg_port, self.port = port(), port()
        while self.port == self.pg_port:
            self.port = port()
        self.base = f'http://127.0.0.1:{self.port}'
        self.project = 'product-gate'
        self.tokens = {p: secrets.token_hex(32) for p in ('operator', 'evaluator', 'other', 'outsider')}
        from scripts.testing.production import service_env
        self.login_token, self.console_token = secrets.token_hex(32), secrets.token_hex(32)
        self.issuer = 'https://identity.example.invalid'
        self._identity = None
        self.env = service_env(database_url=f'postgresql://qualification@127.0.0.1:{self.pg_port}/postgres',
            bind=f'127.0.0.1:{self.port}', project=self.project, tokens={},
            login_token=self.login_token, console_token=self.console_token, issuer=self.issuer)
        self.configure_grants()
        self.service = None
        self.log = open(self.dir / 'service.log', 'w+')

    def configure_grants(self, outsider_prefix='other-'):
        self.env['ACCLIMATE_AUTH'] = json.dumps([
            dict(
                token=token,
                principalId=principal,
                workspaceId=outsider_prefix + self.project if principal == 'outsider' else self.project,
                rights=['read'] if principal in ('viewer', 'outsider') else
                ['read', 'write'] if principal in ('evaluator', 'other') else
                ['read', 'write', 'promote'],
            )
            for principal, token in self.tokens.items()
        ])

    def pg(self, tool, *args):
        return subprocess.run([str(self.pg_bin / tool), *args], check=True, capture_output=True, text=True)

    def start_database(self):
        self.pg('initdb', '-D', str(self.dir / 'pg'), '-U', 'qualification', '-A', 'trust', '--no-locale')
        self.pg('pg_ctl', '-D', str(self.dir / 'pg'), '-l', str(self.dir / 'postgres.log'), '-o', f"-p {self.pg_port} -h 127.0.0.1 -c unix_socket_directories=''", '-w', 'start')

    def start(self):
        self.start_database()
        self.restart()

    def identity(self):
        if self._identity is None:
            from scripts.testing.identity import IdentityFixture
            self._identity = IdentityFixture(self.dir / 'identity')
        changed = self.env.get('ACCLIMATE_OIDC_ISSUER') != self._identity.issuer
        self.issuer = self._identity.issuer
        self.env['ACCLIMATE_OIDC_ISSUER'] = self.issuer
        self.env['ACCLIMATE_OPERATORS'] = json.dumps([dict(issuer=self.issuer, subject='operator')])
        if changed and self.service is not None:
            self.restart()
        return self._identity

    def restart(self):
        self.stop_service()
        self.service = subprocess.Popen([str(ROOT / 'target/debug/acclimate-service')], cwd=ROOT, env=self.env, stdout=self.log, stderr=self.log)
        for _ in range(200):
            try:
                if urlopen(self.base + '/ready', timeout=1).status == 200:
                    return
            except OSError:
                if self.service.poll() is not None:
                    self.log.seek(0)
                    raise RuntimeError('Private service stopped before readiness; inspect the private fixture service.log.')
                time.sleep(.1)
        raise RuntimeError('service startup timeout')

    def stop_service(self):
        if self.service and self.service.poll() is None:
            self.service.terminate()
            try:
                # Production shutdown may drain for 35 seconds and release its
                # database ownership guard for another bounded four seconds.
                self.service.wait(timeout=45)
            except subprocess.TimeoutExpired:
                self.service.kill()
                self.service.wait(timeout=10)
        self.service = None

    def sql(self, query):
        return self.pg('psql', self.env['DATABASE_URL'], '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', query).stdout.strip()

    def call(self, method, route, body=None, actor='operator', status=None, key=None, extra_headers=None):
        data = json.dumps(body, separators=(',', ':')).encode() if body is not None else None
        headers = {'Authorization': 'Bearer ' + self.tokens[actor], 'X-Acclimate-Scope': actor, 'Content-Type': 'application/json'}
        headers.update(extra_headers or {})
        if method == 'POST':
            headers['Idempotency-Key'] = key or secrets.token_hex(16)
        try:
            response = urlopen(Request(self.base + route, data=data, method=method, headers=headers), timeout=10)
        except HTTPError as error:
            response = error
        raw = response.read()
        value = json.loads(raw) if raw else None
        accepted = response.status == status if status is not None else 200 <= response.status < 300
        error = value.get('error') if isinstance(value, dict) else None
        code = error.get('code') if isinstance(error, dict) else None
        assert accepted, (method, route, response.status, code)
        return value

    def close(self):
        try:
            self.stop_service()
        finally:
            try:
                if (self.dir / 'pg/postmaster.pid').exists():
                    self.pg('pg_ctl', '-D', str(self.dir / 'pg'), '-m', 'immediate', '-w', 'stop')
            finally:
                try:
                    if self._identity is not None:
                        self._identity.close()
                finally:
                    self.log.close()
                    self.temp.cleanup()


def payload(text):
    return dict(schemaVersion=1, files=[dict(path='AGENTS.md', kind='instruction', text=text)])


def qualify(h):
    root = '/v1/workspaces/' + h.project
    assert h.call('GET', root + '/bundles')['items'] == []
    h.call('GET', root + '/bundles', actor='outsider', status=403)
    assert h.call('GET', '/v1/workspaces/other-product-gate/bundles', actor='outsider')['items'] == []
    setup_body = dict(name='Disposable product qualification', origin='example', sourceLabel='Explicit model-free demo', channel='stable', payload=payload('Review code.'), reason='Explicit initial fixture review')
    setup = h.call('POST', root + '/bundle-setups', setup_body)
    b = root + '/bundles/' + setup['bundle']['id']
    channel = b + '/channels/stable'
    versions = b + '/versions'
    body = dict(parentVersionId=setup['version']['id'], payload=payload('Review duplicate retries.'))
    lost_key = secrets.token_hex(16)
    headers = {'X-Acclimate-Durable-Operation': 'true'}
    h.call('POST', versions, body, key=lost_key, extra_headers=headers)
    h.sql("UPDATE idempotency SET expires_at=now()-interval '1 second'")
    h.restart()
    lookup = root + '/operations/' + lost_key + '?' + urlencode({'operationPath': versions})
    operation = h.call('GET', lookup)
    assert operation['status'] == 'committed'
    candidate = operation['result']
    assert h.call('GET', lookup, actor='other')['status'] == 'not_observed'
    assert h.call('POST', versions, body, key=lost_key) == candidate
    h.call('POST', versions, dict(body, payload=payload('Different bytes.')), key=lost_key, status=409)
    assert h.call('GET', versions + '/' + candidate['id'] + '/payload') == body['payload']
    release = dict(versionId=candidate['id'], expectedRevision='1', unevaluatedReason='Reviewed fixture')
    h.call('POST', channel + '/releases', dict(release, expectedRevision='0'), status=409)
    published = h.call('POST', channel + '/releases', release)
    assert published['revision'] == '2'
    assert h.call('GET', channel)['version'] == candidate
    return dict(bundleId=setup['bundle']['id'], version=candidate, flows=[
        'workspace scope', 'immutable version upload', 'restart and operation recovery',
        'same-key replay and changed-body denial', 'release revision conflict', 'channel release',
    ])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin', required=True)
    args = parser.parse_args()
    subprocess.run(['cargo', 'build', '--bin', 'acclimate-service'], cwd=ROOT, check=True)
    h = Harness(args.pg_bin)
    try:
        h.start()
        result = qualify(h)
        consumer = h.dir / 'consumer'
        consumer.mkdir()
        (consumer / 'package.json').write_text('{"private":true,"type":"module"}')
        subprocess.run(['npm', 'run', 'build:packages'], cwd=ROOT, check=True)
        subprocess.run(['npm', 'pack', '--offline', '--pack-destination', str(consumer), '--workspace', '@acclimate/sdk'], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['npm', 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', str(consumer / 'acclimate-sdk-0.1.0.tgz')], cwd=consumer, check=True)
        shutil.copy(ROOT / 'scripts/productization/consumer.mjs', consumer / 'consumer.mjs')
        config = consumer / 'config.json'
        config.write_text(json.dumps(dict(baseUrl=h.base, token=h.tokens['operator'], project=h.project, **result)))
        config.chmod(0o600)
        subprocess.run(['node', str(consumer / 'consumer.mjs'), str(config)], cwd=consumer, check=True)
        result['flows'].append('clean packed SDK resolve/pin/prepare')
        print(json.dumps(result, indent=2))
    finally:
        h.close()


if __name__ == '__main__':
    main()
