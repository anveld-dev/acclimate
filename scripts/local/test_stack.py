"""Fast tests for local stack configuration and the Keycloak bootstrap sequence."""

import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from scripts.local import stack


SUBJECT = 'cd97b433-08d2-460d-ba9b-0a6d063be018'


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
                 'projectId': evaluator['projectId'], 'rights': ['read', 'write']},
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
        opener.open.side_effect = [io.BytesIO(json.dumps(value).encode()) for value in
                                   ({'access_token': 'admin'}, [], None, [user], {}, None)]
        self.assertEqual(stack.keycloak_operator(opener, {
            'keycloak_admin': 'admin-password', 'operator': 'operator-password',
        }), SUBJECT)
        token, lookup, create, recheck, realm, update = [call.args[0] for call in opener.open.call_args_list]
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

    def test_existing_operator_password_and_matching_realm_are_left_alone(self):
        opener = Mock()
        opener.open.side_effect = [io.BytesIO(json.dumps(value).encode()) for value in
                                   ({'access_token': 'admin'},
                                    [{'username': stack.OPERATOR, 'id': SUBJECT}],
                                    stack.mail_settings('mailpit'))]
        self.assertEqual(stack.keycloak_operator(opener, {'keycloak_admin': 'admin-password'}, SUBJECT), SUBJECT)
        self.assertEqual([call.args[0].get_method() for call in opener.open.call_args_list],
                         ['POST', 'GET', 'GET'])

    def test_ports_are_chosen_once_and_flow_into_every_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            ports = stack.endpoints(state, {'ACCLIMATE_LOCAL_PORT': '4443',
                                            'ACCLIMATE_LOCAL_MAIL_PORT': '18025'})
            self.assertEqual(ports, stack.Endpoints(4443, 18025))
            self.assertEqual(stat.S_IMODE((state / 'ports.json').stat().st_mode), 0o600)
            # Later runs reuse the saved ports without the variables.
            self.assertEqual(stack.endpoints(state, {}), ports)
            self.assertEqual(ports.environment(), {
                'ACCLIMATE_LOCAL_CONSOLE_PORT': '4443', 'ACCLIMATE_LOCAL_API_PORT': '4444',
                'ACCLIMATE_LOCAL_KEYCLOAK_PORT': '4445', 'ACCLIMATE_LOCAL_MAIL_PORT': '18025'})
            values = stack.credentials(state)
            stack.write_infrastructure(state, values, ports)
            stack.write_application(state, values, SUBJECT, ports)
            service = env_file(state / 'service.env')
            console = env_file(state / 'console.env')
            self.assertEqual(env_file(state / 'keycloak.env')['ACCLIMATE_CONSOLE_ORIGIN'],
                             'https://localhost:4443')
            self.assertEqual(console['CONSOLE_PUBLIC_API_URL'], 'https://127.0.0.1:4444')
            self.assertEqual(service['ACCLIMATE_OIDC_ISSUER'], 'https://127.0.0.1:4445/realms/acclimate')
            self.assertEqual(json.loads((state / 'evaluator.json').read_bytes())['serviceUrl'],
                             'https://127.0.0.1:4444')

    def test_ports_cannot_change_without_reset_and_are_validated(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            self.assertEqual(stack.endpoints(state, {}), stack.DEFAULT)
            with self.assertRaisesRegex(ValueError, 'local:reset'):
                stack.endpoints(state, {'ACCLIMATE_LOCAL_PORT': '4443'})
            self.assertEqual(stack.endpoints(state, {'ACCLIMATE_LOCAL_PORT': '3443'}), stack.DEFAULT)
        with tempfile.TemporaryDirectory() as temporary:
            for value in ('80', '65534', 'abc', '4443 '):
                with self.assertRaisesRegex(ValueError, 'must be a port'):
                    stack.endpoints(Path(temporary), {'ACCLIMATE_LOCAL_PORT': value}, save=False)
            # down and reset never fix ports for a stack that was never started.
            stack.endpoints(Path(temporary), {}, save=False)
            self.assertFalse((Path(temporary) / 'ports.json').exists())

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
