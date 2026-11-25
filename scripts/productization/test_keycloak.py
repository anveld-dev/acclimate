"""Keycloak deployment contracts; no daemon startup. Secrets are generated only in temporary directories."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]


class KeycloakDeployment(unittest.TestCase):
    def test_fetch_authenticates_only_release_metadata_and_still_verifies_archive(self):
        with patch.object(sys, 'version_info', (3, 12)):
            fetch = runpy.run_path(str(ROOT/'scripts/testing/fetch_keycloak.py'))['fetch']
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w:gz') as tar:
            entry = tarfile.TarInfo('keycloak-26.8.2/version.txt')
            entry.size = len(b'26.8.2')
            tar.addfile(entry, io.BytesIO(b'26.8.2'))
        content = archive.getvalue()
        url = 'https://github.com/keycloak/keycloak/releases/download/26.8.2/keycloak-26.8.2.tar.gz'
        digest = 'sha256:'+hashlib.sha256(content).hexdigest()
        release = json.dumps({'assets': [{'name': 'keycloak-26.8.2.tar.gz',
            'digest': digest, 'browser_download_url': url}]}).encode()
        for token in ('fixture-token', ''):
            with self.subTest(authenticated=bool(token)), tempfile.TemporaryDirectory() as directory:
                def open_url(request, *, timeout):
                    if isinstance(request, str):
                        self.assertEqual(request, url)
                        return io.BytesIO(content)
                    self.assertEqual(request.full_url,
                        'https://api.github.com/repos/keycloak/keycloak/releases/tags/26.8.2')
                    self.assertEqual(request.get_header('Authorization'),
                        f'Bearer {token}' if token else None)
                    return io.BytesIO(release)
                output = Path(directory)/'download'
                with patch.dict(os.environ, {'GITHUB_TOKEN': token}), \
                     patch.dict(fetch.__globals__, {'urlopen': open_url}):
                    home = fetch(output)
                self.assertEqual((home/'version.txt').read_text(), '26.8.2')
                self.assertEqual(json.loads((output/'verified-release.json').read_text())['sha256'], digest)

    def test_fetch_rejects_an_old_virtualenv_without_reexecuting_itself(self):
        # A Python 3.11 .venv-bdd must fail once, rather than exec itself forever.
        with patch.object(sys, 'version_info', (3, 11)), \
             patch.object(sys, 'executable', str(ROOT/'.venv-bdd/bin/python')), \
             patch.object(Path, 'exists', return_value=True), \
             patch.object(os, 'execv', side_effect=AssertionError('recursive exec')):
            with self.assertRaisesRegex(SystemExit, r'Python 3\.12\+'):
                runpy.run_path(str(ROOT/'scripts/testing/fetch_keycloak.py'), run_name='__main__')

    def resolve(self, directory, missing=None):
        # The file names deploy/init.sh writes in the private directory.
        for name in ('service.env', 'console.env', 'keycloak.env', 'postgres-password',
                     'keycloak-postgres-password', 'empty.env', 'executor-token'):
            path = directory/name
            path.write_text('')
            path.chmod(0o600)
        env = dict(PATH=os.environ['PATH'], ACCLIMATE_CONFIG_DIR=str(directory),
                   COMPOSE_PROFILES='learning',
                   CONSOLE_HOST='console.fixture.invalid', API_HOST='api.fixture.invalid',
                   KEYCLOAK_HOST='auth.fixture.invalid', ACME_EMAIL='fixture@example.invalid')
        if missing:
            env.pop(missing)
        command = ['docker', 'compose', '--env-file', str(directory/'empty.env'),
                   '-f', str(ROOT/'compose.yaml'), '-f', str(ROOT/'compose.keycloak.yaml'),
                   'config', '--format', 'json']
        return json.loads(subprocess.check_output(command, env=env, stderr=subprocess.PIPE, timeout=15))

    def test_missing_identity_config_cannot_resolve_a_deployment(self):
        for missing in ('KEYCLOAK_HOST', 'ACCLIMATE_CONFIG_DIR'):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises(subprocess.CalledProcessError) as failure:
                    self.resolve(Path(temporary), missing=missing)
                self.assertIn(missing.encode(), failure.exception.stderr)

    def test_cohosted_stack_keeps_all_backends_private_and_separates_postgres_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = self.resolve(Path(temporary))
        services = config['services']
        self.assertEqual(set(services), {'postgres', 'service', 'console', 'proxy', 'keycloak', 'keycloak-db', 'acclimate-executor', 'acclimate-runner'})
        # The runner service only builds the sandbox image; it exits at once and has no network.
        runner = services.pop('acclimate-runner')
        self.assertEqual(runner['network_mode'], 'none')
        self.assertFalse(runner.get('ports'))
        for name, service in services.items():
            self.assertIn('healthcheck', service)
            if name != 'acclimate-executor':
                self.assertEqual(service['stop_grace_period'], '1m30s')
            self.assertEqual(service['restart'], 'unless-stopped')
            if name == 'keycloak':
                # The admin console's private route: loopback on the host only.
                self.assertEqual([(p['host_ip'], p['target']) for p in service['ports']], [('127.0.0.1', 8080)])
            elif name != 'proxy':
                self.assertFalse(service.get('ports'))
            self.assertEqual(service['logging'], dict(driver='json-file', options={'max-size': '10m', 'max-file': '5'}))
        self.assertNotEqual(services['postgres']['volumes'][0]['source'], services['keycloak-db']['volumes'][0]['source'])
        self.assertTrue(config['networks']['backend']['internal'])
        self.assertEqual(services['keycloak']['environment']['KC_DB'], 'postgres')
        self.assertEqual(services['keycloak']['environment']['KC_DB_URL'], 'jdbc:postgresql://keycloak-db:5432/keycloak')
        self.assertEqual(services['keycloak-db']['environment']['POSTGRES_PASSWORD_FILE'], '/run/secrets/keycloak_postgres_password')
        self.assertEqual(services['keycloak']['environment']['KC_HOSTNAME'], 'https://auth.fixture.invalid')
        self.assertEqual(services['keycloak']['environment']['KC_HOSTNAME_ADMIN'], 'http://127.0.0.1:8180')
        self.assertNotIn('KC_BOOTSTRAP_ADMIN_USERNAME', services['keycloak']['environment'])
        imports = {v['target']: Path(v['source']) for v in services['keycloak']['volumes']}
        self.assertEqual(imports, {
            '/opt/keycloak/data/import/acclimate-realm.json': ROOT/'deploy/keycloak/acclimate-realm.json',
            '/opt/keycloak/data/import/acclimate-users-0.json': ROOT/'deploy/keycloak/acclimate-users-0.json'})
        self.assertEqual(services['keycloak']['environment']['KC_CACHE'], 'local')
        self.assertIn('auth.fixture.invalid', services['proxy']['networks']['backend']['aliases'])
        self.assertEqual(services['keycloak']['command'], ['start', '--optimized', '--import-realm'])
        # An upgrade's plain up rebuilds Keycloak from the new checkout, and pull skips it.
        self.assertEqual(services['keycloak']['pull_policy'], 'build')
        self.assertIn('keycloak', services['proxy']['depends_on'])
        caddy = next(v for v in services['proxy']['volumes'] if v['target'] == '/etc/caddy/Caddyfile')
        self.assertEqual(Path(caddy['source']), ROOT/'deploy/keycloak/Caddyfile')

    def test_confidential_client_requires_exact_callback_pkce_and_no_password_grant(self):
        realm = json.loads((ROOT/'deploy/keycloak/acclimate-realm.json').read_text())
        self.assertFalse(realm['registrationAllowed'])
        self.assertNotIn('users', realm)
        client, = realm['clients']
        self.assertEqual(client['clientId'], 'acclimate-console')
        self.assertFalse(client['publicClient'])
        self.assertTrue(client['standardFlowEnabled'])
        self.assertFalse(client['directAccessGrantsEnabled'])
        self.assertFalse(client['implicitFlowEnabled'])
        self.assertFalse(client['serviceAccountsEnabled'])
        self.assertEqual(client['secret'], '${ACCLIMATE_OIDC_CLIENT_SECRET}')
        self.assertEqual(client['redirectUris'], ['${ACCLIMATE_CONSOLE_ORIGIN}/auth/callback'])
        self.assertEqual(client['attributes']['pkce.code.challenge.method'], 'S256')
        self.assertEqual(client['attributes']['id.token.signed.response.alg'], 'RS256')

    def test_first_person_template_forces_a_password_change_and_manages_only_this_realm(self):
        template = json.loads((ROOT/'deploy/keycloak/acclimate-users-0.json').read_text())
        self.assertEqual(template['realm'], 'acclimate')
        person, = template['users']
        self.assertEqual(person['id'], '${ACCLIMATE_FIRST_USER_ID}')
        self.assertEqual(person['username'], '${ACCLIMATE_FIRST_USER_EMAIL}')
        self.assertEqual(person['email'], '${ACCLIMATE_FIRST_USER_EMAIL}')
        self.assertIs(person['emailVerified'], True)
        self.assertEqual(person['requiredActions'], ['UPDATE_PASSWORD'])
        self.assertEqual(person['credentials'], [dict(type='password', value='${ACCLIMATE_FIRST_USER_PASSWORD}', temporary=True)])
        self.assertEqual(person['clientRoles'], {'realm-management': ['realm-admin']})
        self.assertEqual(person['realmRoles'], ['default-roles-acclimate'])
        # The local stack imports the realm without this person and creates its own.
        self.assertNotIn('acclimate-users-0.json', (ROOT/'compose.local.yaml').read_text())

    def test_init_writes_every_import_value_and_a_resolvable_deployment(self):
        with tempfile.TemporaryDirectory() as temporary:
            checkout, home = Path(temporary)/'checkout', Path(temporary)/'home'
            for name in ('compose.yaml', 'compose.keycloak.yaml'):
                (checkout/name).parent.mkdir(parents=True, exist_ok=True)
                (checkout/name).write_bytes((ROOT/name).read_bytes())
            subprocess.run(['cp', '-R', str(ROOT/'deploy'), str(checkout/'deploy')], check=True)
            env = dict(PATH=os.environ['PATH'], HOME=str(home))
            init = ['sh', str(checkout/'deploy/init.sh'), '--domain', 'fixture.invalid', '--email', 'owner@fixture.invalid']
            result = subprocess.run(init, cwd=temporary, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            private = home/'.config/acclimate'
            self.assertEqual(private.stat().st_mode & 0o777, 0o700)
            names = {'service.env', 'console.env', 'keycloak.env', 'postgres-password',
                     'keycloak-postgres-password', 'executor-token'}
            self.assertEqual({path.name for path in private.iterdir()}, names)
            for name in names:
                self.assertEqual((private/name).stat().st_mode & 0o777, 0o600)
            def values(path):
                return dict(line.split('=', 1) for line in path.read_text().splitlines()
                            if line and not line.startswith('#'))
            service, console, keycloak = (values(private/name) for name in ('service.env', 'console.env', 'keycloak.env'))
            dotenv = values(checkout/'.env')
            # Every realm import placeholder has a value, and nothing else is left to fill in.
            templates = ''.join((ROOT/'deploy/keycloak'/name).read_text()
                                for name in ('acclimate-realm.json', 'acclimate-users-0.json'))
            self.assertLessEqual(set(re.findall(r'\$\{([A-Z_]+)\}', templates)), set(keycloak))
            self.assertNotIn('KC_BOOTSTRAP_ADMIN_USERNAME', keycloak)
            self.assertNotIn('REPLACE', ''.join((private/name).read_text() for name in names))
            self.assertIn(keycloak['ACCLIMATE_FIRST_USER_PASSWORD'], result.stdout)
            self.assertEqual(keycloak['ACCLIMATE_FIRST_USER_EMAIL'], 'owner@fixture.invalid')
            self.assertEqual(str(uuid.UUID(keycloak['ACCLIMATE_FIRST_USER_ID'])), keycloak['ACCLIMATE_FIRST_USER_ID'])
            self.assertEqual(uuid.UUID(keycloak['ACCLIMATE_FIRST_USER_ID']).version, 4)
            issuer = 'https://auth.fixture.invalid/realms/acclimate'
            self.assertEqual(json.loads(service['ACCLIMATE_OPERATORS']),
                             [dict(issuer=issuer, subject=keycloak['ACCLIMATE_FIRST_USER_ID'])])
            self.assertEqual(service['ACCLIMATE_OIDC_ISSUER'], console['CONSOLE_OIDC_ISSUER'])
            self.assertEqual(console['CONSOLE_OIDC_ISSUER'], issuer)
            self.assertEqual(console['CONSOLE_OIDC_CLIENT_SECRET'], keycloak['ACCLIMATE_OIDC_CLIENT_SECRET'])
            self.assertEqual(console['CONSOLE_ORIGIN'], keycloak['ACCLIMATE_CONSOLE_ORIGIN'])
            self.assertEqual(console['CONSOLE_LOGIN_TOKEN'], service['ACCLIMATE_LOGIN_TOKEN'])
            self.assertEqual(console['CONSOLE_SERVICE_TOKEN'], service['ACCLIMATE_CONSOLE_TOKEN'])
            self.assertNotEqual(service['ACCLIMATE_LOGIN_TOKEN'], service['ACCLIMATE_CONSOLE_TOKEN'])
            self.assertEqual(service['DATABASE_URL'], 'postgresql://acclimate:%s@postgres:5432/acclimate'
                             % (private/'postgres-password').read_text().strip())
            self.assertEqual(keycloak['KC_DB_PASSWORD'], (private/'keycloak-postgres-password').read_text().strip())
            self.assertRegex(service['ACCLIMATE_PROVIDER_ENCRYPTION_KEY'], r'^[0-9a-f]{64}$')
            self.assertEqual((private/'executor-token').read_text(), '')
            self.assertEqual(dotenv, dict(COMPOSE_FILE='compose.yaml:compose.keycloak.yaml',
                CONSOLE_HOST='console.fixture.invalid', API_HOST='api.fixture.invalid',
                KEYCLOAK_HOST='auth.fixture.invalid', ACME_EMAIL='owner@fixture.invalid',
                ACCLIMATE_CONFIG_DIR=str(private), ACCLIMATE_VERSION='local'))
            # Compose reads .env itself: no other variable is needed.
            for profiles, expected in (('', set()), ('learning', {'acclimate-executor', 'acclimate-runner'})):
                config = json.loads(subprocess.check_output(['docker', 'compose', 'config', '--format', 'json'],
                    cwd=checkout, env=dict(env, COMPOSE_PROFILES=profiles), stderr=subprocess.PIPE, timeout=15))
                self.assertEqual(set(config['services']), {'postgres', 'service', 'console', 'proxy',
                                                           'keycloak', 'keycloak-db'} | expected)
                self.assertEqual(config['services']['service']['image'], 'ghcr.io/anveld-dev/acclimate-service:local')
            # A second run never replaces existing secrets.
            again = subprocess.run(init, cwd=temporary, env=env, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(again.returncode, 0)
            self.assertIn('already exists', again.stderr)
            self.assertEqual(values(private/'keycloak.env'), keycloak)

    def test_templates_pin_same_realm_issuer_and_separate_authority_credentials(self):
        def env(path):
            return dict(line.split('=', 1) for line in path.read_text().splitlines()
                        if line and not line.startswith('#'))
        service = env(ROOT/'deploy/service.env.example')
        console = env(ROOT/'apps/console/.env.example')
        self.assertEqual(service['ACCLIMATE_OIDC_ISSUER'], console['CONSOLE_OIDC_ISSUER'])
        self.assertTrue(console['CONSOLE_OIDC_ISSUER'].endswith('/realms/acclimate'))
        self.assertEqual(console['CONSOLE_OIDC_CLIENT_ID'], 'acclimate-console')
        self.assertEqual(json.loads(service['ACCLIMATE_OPERATORS'])[0]['issuer'], console['CONSOLE_OIDC_ISSUER'])
        self.assertNotEqual(console['CONSOLE_OIDC_CLIENT_SECRET'], console['CONSOLE_LOGIN_TOKEN'])
        self.assertNotEqual(console['CONSOLE_LOGIN_TOKEN'], console['CONSOLE_SERVICE_TOKEN'])

    def test_keycloak_image_is_pinned_postgres_built_and_does_not_embed_secrets(self):
        text = (ROOT/'deploy/keycloak/Dockerfile').read_text()
        self.assertEqual(text.count('quay.io/keycloak/keycloak:26.8.2'), 2)
        self.assertNotIn(':latest', text)
        self.assertIn('KC_DB=postgres', text)
        self.assertIn('KC_HEALTH_ENABLED=true', text)
        self.assertIn('KC_METRICS_ENABLED=true', text)
        for secret in ('PASSWORD', 'CLIENT_SECRET', '.env', 'acclimate-realm.json'):
            self.assertNotIn(secret, text)
        ignore = (ROOT/'.dockerignore').read_text()
        for allowed in ('!deploy/keycloak/', '!deploy/keycloak/Dockerfile', '!deploy/keycloak/health.sh'):
            self.assertIn(allowed, ignore)

    def test_identity_proxy_keeps_admin_master_and_management_endpoints_unpublished(self):
        base = (ROOT/'deploy/Caddyfile').read_text()
        proxy = (ROOT/'deploy/keycloak/Caddyfile').read_text()
        # Application proxy behavior is unchanged by the identity overlay.
        self.assertTrue(proxy.startswith(base.rstrip()+'\n'))
        self.assertIn('@public path /realms/acclimate /realms/acclimate/* /resources/* /robots.txt', proxy)
        self.assertIn('respond "Not found" 404', proxy)
        self.assertNotIn('keycloak:9000', proxy)
        self.assertIn('header_up -Forwarded', proxy)
        self.assertIn('header_up -X-Forwarded-*', proxy)

    def test_ready_probe_rejects_non200_even_with_a_success_body(self):
        for status in (200, 503, 404):
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_): pass
                def do_HEAD(self):
                    self.send_response(status)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                result = subprocess.run(['bash', str(ROOT/'deploy/keycloak/health.sh'),
                                         str(server.server_port)], capture_output=True, timeout=3)
                self.assertEqual(result.returncode == 0, status == 200)
                self.assertEqual(result.stdout, b'')
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)


if __name__ == '__main__':
    unittest.main()
