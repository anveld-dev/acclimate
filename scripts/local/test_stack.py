"""Fast tests for local stack configuration and the Keycloak bootstrap sequence."""

from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import socket
import stat
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from scripts.local import stack


SUBJECT = 'cd97b433-08d2-460d-ba9b-0a6d063be018'
ROOT = stack.ROOT


def FREE(port):
    return True


class Response(io.BytesIO):
    def __init__(self, value):
        super().__init__(b'' if value is None else json.dumps(value).encode())


def env_file(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines())


class StackTests(unittest.TestCase):
    def test_secrets_are_distinct_private_and_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / 'stack'
            stack.directory(state, private=True)
            values = stack.credentials(state)
            self.assertEqual(len(set(values.values())), len(stack.SECRET_NAMES))
            self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o700)
            path = state / 'credentials.json'
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with patch.object(stack.secrets, 'token_hex', side_effect=AssertionError('regenerated')):
                self.assertEqual(stack.credentials(state), values)

    def test_writes_consistent_production_configuration_and_scoped_grant(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            values = stack.credentials(state)
            stack.write_infrastructure(state, values)
            stack.write_application(state, values, SUBJECT)
            service = env_file(state / 'service.env')
            console = env_file(state / 'console.env')
            keycloak = env_file(state / 'keycloak.env')
            evaluator = json.loads((state / 'evaluator.json').read_bytes())
            self.assertEqual(service['ACCLIMATE_OIDC_ISSUER'], console['CONSOLE_OIDC_ISSUER'])
            self.assertEqual(console['CONSOLE_ORIGIN'], keycloak['ACCLIMATE_CONSOLE_ORIGIN'])
            self.assertEqual(console['CONSOLE_OIDC_CLIENT_SECRET'], keycloak['ACCLIMATE_OIDC_CLIENT_SECRET'])
            self.assertEqual(console['CONSOLE_LOGIN_TOKEN'], service['ACCLIMATE_LOGIN_TOKEN'])
            self.assertEqual(console['CONSOLE_SERVICE_TOKEN'], service['ACCLIMATE_CONSOLE_TOKEN'])
            for env in (service, console):
                self.assertNotIn('ACCLIMATE_MODE', env)
                self.assertNotIn('CONSOLE_MODE', env)
            self.assertEqual(json.loads(service['ACCLIMATE_OPERATORS']),
                             [{'issuer': stack.ISSUER, 'subject': SUBJECT}])
            self.assertEqual(json.loads(service['ACCLIMATE_AUTH']), [
                {'token': evaluator['evaluatorToken'], 'principalId': evaluator['evaluatorPrincipalId'],
                 'workspaceId': evaluator['workspaceId'], 'rights': ['read', 'write']},
            ])
            self.assertEqual(console['CONSOLE_PUBLIC_API_URL'], evaluator['serviceUrl'])
            self.assertEqual((state / 'postgres-password').read_text().strip(), values['postgres'])
            self.assertEqual((state / 'keycloak-postgres-password').read_text().strip(),
                             keycloak['KC_DB_PASSWORD'])
            self.assertTrue(all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in state.iterdir()))

    def test_refuses_symlink_or_exposed_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            path = state / 'credentials.json'
            path.symlink_to(state / 'missing')
            with self.assertRaises(ValueError):
                stack.credentials(state)
            path.unlink()
            path.touch(mode=0o600)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                stack.credentials(state)

    def test_stack_commands_serialize_per_checkout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with stack.locked_state(root) as state:
                self.assertEqual(state, root / '.local' / 'stack')
                with self.assertRaisesRegex(ValueError, 'Another local stack command'):
                    with stack.locked_state(root):
                        self.fail('second lock unexpectedly acquired')

    def test_compose_uses_unique_explicit_project_and_no_repository_dotenv(self):
        first, second = Path('/work/first'), Path('/work/second')
        with patch.object(stack.subprocess, 'run') as run:
            stack.compose(first, 'down', '--volumes')
            stack.compose(second, 'down')
        commands = [call.args[0] for call in run.call_args_list]
        self.assertTrue(all(command[:4] == ['docker', 'compose', '--env-file', '/dev/null']
                            for command in commands))
        self.assertTrue(all(command[6:8] == ['-f', 'compose.local.yaml'] for command in commands))
        self.assertNotEqual(commands[0][5], commands[1][5])

    def test_keycloak_creates_operator_and_reads_exact_subject(self):
        user = {'username': stack.OPERATOR, 'id': SUBJECT}
        opener = Mock()
        client = {'id': 'client-uuid', 'clientId': stack.CLIENT,
                  'redirectUris': ['https://localhost:9999/auth/callback'], 'secret': 'kept'}
        opener.open.side_effect = [io.BytesIO(json.dumps(value).encode()) for value in
                                   ({'access_token': 'admin'}, [], None, [user], {}, None, [client], None)]
        self.assertEqual(stack.keycloak_operator(opener, {
            'keycloak_admin': 'admin-password', 'operator': 'operator-password',
        }), SUBJECT)
        (token, lookup, create, recheck, realm, update,
         clients, client_update) = [call.args[0] for call in opener.open.call_args_list]
        self.assertEqual(urlsplit(token.full_url).path, '/realms/master/protocol/openid-connect/token')
        self.assertEqual(parse_qs(urlsplit(lookup.full_url).query),
                         {'username': [stack.OPERATOR], 'exact': ['true']})
        self.assertEqual(lookup.full_url, recheck.full_url)
        self.assertEqual(create.get_method(), 'POST')
        created = json.loads(create.data)
        self.assertEqual(created['email'], stack.OPERATOR)
        self.assertTrue(created['emailVerified'])
        self.assertEqual(created['credentials'][0]['value'], 'operator-password')
        self.assertEqual(realm.full_url, update.full_url)
        self.assertEqual(update.get_method(), 'PUT')
        self.assertEqual(json.loads(update.data)['smtpServer']['host'], 'mailpit')
        # A failed earlier start may have imported another console address.
        self.assertEqual(parse_qs(urlsplit(clients.full_url).query), {'clientId': [stack.CLIENT]})
        self.assertEqual(client_update.get_method(), 'PUT')
        self.assertTrue(client_update.full_url.endswith('/admin/realms/acclimate/clients/client-uuid'))
        self.assertEqual(json.loads(client_update.data), {
            **client, 'redirectUris': [stack.CONSOLE + '/auth/callback']})

    def test_existing_operator_password_and_matching_realm_are_left_alone(self):
        opener = Mock()
        opener.open.side_effect = [io.BytesIO(json.dumps(value).encode()) for value in
                                   ({'access_token': 'admin'},
                                    [{'username': stack.OPERATOR, 'id': SUBJECT}],
                                    stack.mail_settings('mailpit'),
                                    [{'id': 'client-uuid', 'clientId': stack.CLIENT,
                                      'redirectUris': [stack.CONSOLE + '/auth/callback']}])]
        self.assertEqual(stack.keycloak_operator(opener, {'keycloak_admin': 'admin-password'}, SUBJECT), SUBJECT)
        self.assertEqual([call.args[0].get_method() for call in opener.open.call_args_list],
                         ['POST', 'GET', 'GET', 'GET'])

    def test_requested_ports_flow_into_every_file_and_are_saved_only_on_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            ports = stack.select_endpoints(ROOT, state, {'ACCLIMATE_LOCAL_PORT': '6443',
                                                         'ACCLIMATE_LOCAL_MAIL_PORT': '38025'}, FREE)
            self.assertEqual(ports, stack.Endpoints(6443, 38025))
            # Selection never fixes ports. A failed first start can choose others.
            self.assertFalse((state / 'ports.json').exists())
            self.assertEqual(stack.select_endpoints(ROOT, state, {'ACCLIMATE_LOCAL_PORT': '7443'}, FREE),
                             stack.Endpoints(7443, 7446))
            stack.save_endpoints(state, ports)
            self.assertEqual(stat.S_IMODE((state / 'ports.json').stat().st_mode), 0o600)
            # Later runs reuse the saved ports without the variables.
            self.assertEqual(stack.select_endpoints(ROOT, state, {}, FREE), ports)
            self.assertEqual(ports.environment(), {
                'ACCLIMATE_LOCAL_CONSOLE_PORT': '6443', 'ACCLIMATE_LOCAL_API_PORT': '6444',
                'ACCLIMATE_LOCAL_KEYCLOAK_PORT': '6445', 'ACCLIMATE_LOCAL_MAIL_PORT': '38025'})
            values = stack.credentials(state)
            stack.write_infrastructure(state, values, ports)
            stack.write_application(state, values, SUBJECT, ports)
            service = env_file(state / 'service.env')
            console = env_file(state / 'console.env')
            self.assertEqual(env_file(state / 'keycloak.env')['ACCLIMATE_CONSOLE_ORIGIN'],
                             'https://localhost:6443')
            self.assertEqual(console['CONSOLE_PUBLIC_API_URL'], 'https://127.0.0.1:6444')
            self.assertEqual(service['ACCLIMATE_OIDC_ISSUER'], 'https://127.0.0.1:6445/realms/acclimate')
            self.assertEqual(json.loads((state / 'evaluator.json').read_bytes())['serviceUrl'],
                             'https://127.0.0.1:6444')

    def test_saved_ports_cannot_change_without_reset_and_are_validated(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            stack.save_endpoints(state, stack.DEFAULT)
            self.assertEqual(stack.select_endpoints(ROOT, state, {}, FREE), stack.DEFAULT)
            with self.assertRaisesRegex(ValueError, 'ACCLIMATE_LOCAL_PORT=3443.*local:reset'):
                stack.select_endpoints(ROOT, state, {'ACCLIMATE_LOCAL_PORT': '4443'}, FREE)
            self.assertEqual(stack.select_endpoints(ROOT, state, {'ACCLIMATE_LOCAL_PORT': '3443'}, FREE),
                             stack.DEFAULT)
        with tempfile.TemporaryDirectory() as temporary:
            for value in ('80', '65533', 'abc', '4443 '):
                with self.assertRaisesRegex(ValueError, 'must be a port'):
                    stack.select_endpoints(ROOT, Path(temporary), {'ACCLIMATE_LOCAL_PORT': value}, FREE)
            # down and reset never fix ports for a stack that was never started.
            self.assertEqual(stack.current_endpoints(Path(temporary)), stack.DEFAULT)
            self.assertFalse((Path(temporary) / 'ports.json').exists())

    def test_default_ports_are_free_and_differ_per_checkout(self):
        first, second = Path('/work/first'), Path('/work/second')
        self.assertNotEqual(stack.derived_port(first), stack.derived_port(second))
        for root in (first, second):
            port = stack.derived_port(root)
            self.assertTrue(stack.AUTO_PORTS[0] <= port and port + 3 <= stack.AUTO_PORTS[1])
            self.assertEqual(port % 10, 0)
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            base = stack.derived_port(first)
            self.assertEqual(stack.select_endpoints(first, state, {}, FREE), stack.Endpoints(base, base + 3))
            # A busy port moves the whole block to the next free one.
            taken = {base + 1}
            self.assertEqual(stack.select_endpoints(first, state, {}, lambda port: port not in taken),
                             stack.Endpoints(base + 10, base + 13))
            self.assertEqual(stack.select_endpoints(first, state, {'ACCLIMATE_LOCAL_MAIL_PORT': '38025'}, FREE),
                             stack.Endpoints(base, 38025))

    def test_busy_requested_port_fails_before_docker_with_a_free_override(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            base = stack.derived_port(ROOT)
            taken = {4443}
            with self.assertRaises(ValueError) as raised:
                stack.select_endpoints(ROOT, state, {'ACCLIMATE_LOCAL_PORT': '4443'},
                                       lambda port: port not in taken)
            message = str(raised.exception)
            self.assertIn('Another process is using port 4443', message)
            self.assertIn(f'ACCLIMATE_LOCAL_PORT={base} ACCLIMATE_LOCAL_MAIL_PORT={base + 3} npm run local:up',
                          message)
            self.assertFalse((state / 'ports.json').exists())
            with self.assertRaisesRegex(ValueError, 'using port 38025.*ACCLIMATE_LOCAL_MAIL_PORT='):
                stack.select_endpoints(ROOT, state, {'ACCLIMATE_LOCAL_MAIL_PORT': '38025'},
                                       lambda port: port != 38025)

    def test_saved_ports_in_use_by_another_process_explain_the_reset(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            stack.save_endpoints(state, stack.Endpoints(6443, 38025))
            with self.assertRaisesRegex(ValueError, 'using port 6444.*local:reset'):
                stack.select_endpoints(ROOT, state, {}, lambda port: port != 6444)
            # The running stack holds its own ports.
            self.assertEqual(stack.select_endpoints(ROOT, state, {}, lambda port: False, running=True),
                             stack.Endpoints(6443, 38025))

    def test_port_probe_detects_a_listener(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            self.assertFalse(stack.port_free(listener.getsockname()[1]))

    def test_images_default_to_the_release_and_fall_back_to_source(self):
        version = stack.release_version(ROOT)
        release = stack.image_environment(ROOT, 'release')
        self.assertEqual(release['ACCLIMATE_LOCAL_SERVICE_IMAGE'],
                         f'ghcr.io/anveld-dev/acclimate-service:{version}')
        self.assertEqual(release['ACCLIMATE_LOCAL_PULL_POLICY'], 'missing')
        build = stack.image_environment(ROOT, 'build')
        self.assertEqual(build['ACCLIMATE_LOCAL_PULL_POLICY'], 'build')
        self.assertIn(stack.project_suffix(ROOT), build['ACCLIMATE_LOCAL_CONSOLE_IMAGE'])
        self.assertEqual(stack.choose_source(None, None), 'release')
        self.assertEqual(stack.choose_source(None, 'build'), 'build')
        self.assertEqual(stack.choose_source('release', 'build'), 'release')
        output = io.StringIO()
        with patch.object(stack, 'compose', side_effect=stack.subprocess.CalledProcessError(1, 'pull')) as pull, \
                redirect_stdout(output):
            self.assertEqual(stack.prepare_images(ROOT, stack.DEFAULT, 'release', None), 'build')
        self.assertEqual(pull.call_args.args[1:], ('pull', 'service', 'console'))
        self.assertEqual(pull.call_args.kwargs['source'], 'release')
        self.assertIn('Building from source instead', output.getvalue())
        with patch.object(stack, 'compose') as pull, redirect_stdout(io.StringIO()):
            self.assertEqual(stack.prepare_images(ROOT, stack.DEFAULT, 'release', None), 'release')
            self.assertEqual(stack.prepare_images(ROOT, stack.DEFAULT, 'build', None), 'build')
        self.assertEqual(pull.call_count, 1)

    def test_compose_selects_image_source(self):
        with patch.object(stack.subprocess, 'run') as run:
            stack.compose(ROOT, 'up', source='release')
        self.assertEqual(run.call_args.kwargs['env']['ACCLIMATE_LOCAL_PULL_POLICY'], 'missing')

    def test_bootstrap_adopts_local_demo_with_reason_and_publishes_an_example(self):
        opener = Mock()
        responses = [
            {'secret': 'session-secret', 'sessionId': 's', 'userId': 'u'},
            {'workspaceId': stack.PROJECT, 'alreadyAdopted': False},
            {'items': []},
            {'id': 'bundle-1', 'name': stack.EXAMPLE_BUNDLE},
            {'items': []},
            {'id': 'version-1'},
            {'id': 'promotion-1'},
            None,
        ]
        opener.open.side_effect = [Response(value) for value in responses]
        values = {'login': 'login-token', 'console': 'console-token'}
        self.assertEqual(stack.bootstrap_workspace(opener, values, SUBJECT, stack.DEFAULT),
                         {'adopted': True, 'bundle': 'bundle-1'})
        requests = [call.args[0] for call in opener.open.call_args_list]
        login, adopt, bundles, create, channels, version, promote, logout = requests
        self.assertEqual(login.full_url, stack.API + '/v1/auth/sessions')
        self.assertEqual(login.get_header('Authorization'), 'Bearer login-token')
        self.assertEqual(json.loads(login.data), {
            'issuer': stack.ISSUER, 'subject': SUBJECT, 'email': stack.OPERATOR,
            'emailVerified': True, 'displayName': 'Local Operator'})
        for request in requests[1:]:
            self.assertEqual(request.get_header('Authorization'), 'Bearer console-token')
            self.assertEqual(request.get_header('X-acclimate-session'), 'session-secret')
        self.assertEqual(adopt.full_url, stack.API + '/v1/auth/workspace-adoptions')
        self.assertEqual(json.loads(adopt.data), {'workspaceId': 'local-demo', 'reason': 'local stack bootstrap'})
        self.assertEqual(json.loads(create.data), {'name': stack.EXAMPLE_BUNDLE})
        self.assertEqual(json.loads(version.data), {'payload': stack.EXAMPLE_PAYLOAD})
        self.assertTrue(promote.full_url.endswith('/bundles/bundle-1/channels/stable/releases'))
        self.assertEqual(json.loads(promote.data)['versionId'], 'version-1')
        self.assertEqual(json.loads(promote.data)['expectedRevision'], '0')
        for request in (create, version, promote):
            self.assertTrue(request.get_header('Idempotency-key'))
        self.assertEqual(logout.get_method(), 'DELETE')

    def test_bootstrap_leaves_a_workspace_adopted_by_someone_else(self):
        opener = Mock()
        conflict = stack.HTTPError(stack.API, 409, 'Conflict', {}, io.BytesIO(b'{}'))
        opener.open.side_effect = [Response({'secret': 'session-secret'}), conflict, Response(None)]
        self.assertEqual(stack.bootstrap_workspace(opener, {'login': 'l', 'console': 'c'}, SUBJECT, stack.DEFAULT),
                         {'adopted': False, 'bundle': None})
        self.assertEqual(opener.open.call_args_list[-1].args[0].get_method(), 'DELETE')

    def test_existing_bundles_are_not_joined_by_an_example(self):
        calls = []

        def call(method, route, body=None, mutation=False):
            calls.append((method, route))
            return {'items': [{'id': 'mine', 'name': 'Support agent'}]}

        self.assertIsNone(stack.seed_example(call))
        self.assertEqual(calls, [('GET', '/v1/workspaces/local-demo/bundles?limit=100')])

    def test_client_files_merge_the_system_bundle_and_export_settings(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            system = state / 'system.pem'
            system.write_bytes(b'-----BEGIN CERTIFICATE-----\nsystem\n-----END CERTIFICATE-----\n')
            local = b'-----BEGIN CERTIFICATE-----\nlocal\n-----END CERTIFICATE-----\n'
            with patch.object(stack, 'system_ca_bundle', return_value=(system, system.read_bytes())):
                text, source = stack.write_client_files(state, stack.DEFAULT, local, 'bundle-1')
            self.assertEqual(source, system)
            merged = (state / 'ca-bundle.pem').read_bytes()
            self.assertTrue(merged.startswith(system.read_bytes()) and merged.endswith(local))
            self.assertEqual(stat.S_IMODE((state / 'env.sh').stat().st_mode), 0o600)
            self.assertEqual((state / 'env.sh').read_text(), text)
            self.assertIn(f"export EVALUATOR_CONFIG='{state / 'evaluator.json'}'", text)
            self.assertIn(f"export NODE_EXTRA_CA_CERTS='{state / 'root.crt'}'", text)
            self.assertIn(f"export SSL_CERT_FILE='{state / 'ca-bundle.pem'}'", text)
            self.assertIn("export BUNDLE_ID='bundle-1'", text)

    def test_keycloak_rejects_replacement_operator_with_same_email(self):
        opener = Mock()
        opener.open.side_effect = [io.BytesIO(json.dumps(value).encode()) for value in
                                   ({'access_token': 'admin'},
                                    [{'username': stack.OPERATOR, 'id': SUBJECT}])]
        with self.assertRaisesRegex(ValueError, 'operator subject changed'):
            stack.keycloak_operator(opener, {'keycloak_admin': 'admin-password'},
                                    '43078181-f680-45bf-900e-2bd49ddb3a95')


if __name__ == '__main__':
    unittest.main()
