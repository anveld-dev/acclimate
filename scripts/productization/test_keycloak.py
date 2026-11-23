"""Keycloak deployment contracts; no daemon startup, identity provisioning or secrets."""
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
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
        for name in ('service.env', 'console.env', 'keycloak.env', 'password', 'kc-password', 'empty.env'):
            path = directory/name
            path.write_text('')
            path.chmod(0o600)
        env = dict(PATH=os.environ['PATH'],
                   ACCLIMATE_SERVICE_ENV=str(directory/'service.env'),
                   ACCLIMATE_CONSOLE_ENV=str(directory/'console.env'),
                   ACCLIMATE_KEYCLOAK_ENV=str(directory/'keycloak.env'),
                   ACCLIMATE_POSTGRES_PASSWORD_FILE=str(directory/'password'),
                   ACCLIMATE_KEYCLOAK_POSTGRES_PASSWORD_FILE=str(directory/'kc-password'),
                   CONSOLE_HOST='console.fixture.invalid', API_HOST='api.fixture.invalid',
                   KEYCLOAK_HOST='auth.fixture.invalid', ACME_EMAIL='fixture@example.invalid')
        if missing:
            env.pop(missing)
        command = ['docker', 'compose', '--env-file', str(directory/'empty.env'),
                   '-f', str(ROOT/'compose.yaml'), '-f', str(ROOT/'compose.keycloak.yaml'),
                   'config', '--format', 'json']
        return json.loads(subprocess.check_output(command, env=env, stderr=subprocess.PIPE, timeout=15))

    def test_missing_identity_config_cannot_resolve_a_deployment(self):
        for missing in ('KEYCLOAK_HOST', 'ACCLIMATE_KEYCLOAK_ENV',
                        'ACCLIMATE_KEYCLOAK_POSTGRES_PASSWORD_FILE'):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises(subprocess.CalledProcessError) as failure:
                    self.resolve(Path(temporary), missing=missing)
                self.assertIn(missing.encode(), failure.exception.stderr)

    def test_cohosted_stack_keeps_all_backends_private_and_separates_postgres_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = self.resolve(Path(temporary))
        services = config['services']
        self.assertEqual(set(services), {'postgres', 'service', 'console', 'proxy', 'keycloak', 'keycloak-db', 'acclimate-executor'})
        for name, service in services.items():
            if name != 'acclimate-executor':
                self.assertIn('healthcheck', service)
                self.assertEqual(service['stop_grace_period'], '1m30s')
            self.assertEqual(service['restart'], 'unless-stopped')
            if name != 'proxy':
                self.assertFalse(service.get('ports'))
        self.assertNotEqual(services['postgres']['volumes'][0]['source'], services['keycloak-db']['volumes'][0]['source'])
        self.assertTrue(config['networks']['backend']['internal'])
        self.assertEqual(services['keycloak']['environment']['KC_DB'], 'postgres')
        self.assertEqual(services['keycloak']['environment']['KC_DB_URL'], 'jdbc:postgresql://keycloak-db:5432/keycloak')
        self.assertEqual(services['keycloak-db']['environment']['POSTGRES_PASSWORD_FILE'], '/run/secrets/keycloak_postgres_password')
        self.assertEqual(services['keycloak']['environment']['KC_HOSTNAME'], 'https://auth.fixture.invalid')
        self.assertEqual(services['keycloak']['environment']['KC_CACHE'], 'local')
        self.assertIn('auth.fixture.invalid', services['proxy']['networks']['backend']['aliases'])
        self.assertEqual(services['keycloak']['command'], ['start', '--optimized', '--import-realm'])
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
