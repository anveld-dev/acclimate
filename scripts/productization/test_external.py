import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('external', Path(__file__).with_name('external.py'))
external = importlib.util.module_from_spec(spec)
spec.loader.exec_module(external)


class ExternalGateTests(unittest.TestCase):
    def test_default_never_calls_network_process_or_environment(self):
        with patch.object(external, 'run', side_effect=AssertionError('must not execute')), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(external.main([]), 0)
        statuses = {gate: row['status'] for gate, row in json.loads(out.getvalue())['gates'].items()}
        self.assertEqual(statuses, dict.fromkeys(external.GATES, 'not run'))

    def test_model_gate_requires_explicit_live_before_credentials_or_network(self):
        args = ['--execute', '--gate', 'remote-model', '--url', 'https://model.example',
                '--token-env', 'FIXTURE_TOKEN']
        with patch.object(external, 'request') as request, patch.dict(external.os.environ, {'FIXTURE_TOKEN': 'fixture'}), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(external.main(args), 1)
        request.assert_not_called()
        gate = json.loads(out.getvalue())['gates']['remote-model']
        self.assertEqual(gate['status'], 'blocked')
        self.assertIn('--live', gate['reason'])

    def test_failure_does_not_print_endpoint_secret(self):
        with patch.object(external, 'run', side_effect=RuntimeError('Bearer private-secret')), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(external.main(['--execute', '--gate', 'https']), 1)
        self.assertNotIn('private-secret', out.getvalue())

    def test_https_rejects_credential_urls(self):
        for url in ['http://example.com', 'https://user:password@example.com', 'https://example.com?token=secret']:
            with self.assertRaises(ValueError): external.https_url(url)

    def test_authorization_never_follows_redirect(self):
        request = external.Request('https://first.example', headers={'Authorization': 'Bearer private-secret'})
        for target in ['https://second.example', 'http://first.example', 'https://first.example/moved']:
            with self.assertRaises(ValueError):
                external.NoRedirect().redirect_request(request, None, 302, 'Found', {}, target)

    def test_https_gate_checks_readiness_in_addition_to_liveness(self):
        def response(url, token=None, body=None):
            if url.endswith('/health'): return b'ok'
            if url.endswith('/ready'): return b'{"ready":true}'
            self.assertEqual(token, 'private-fixture')
            return b'{"items":[]}'
        with patch.dict(external.os.environ, {'FIXTURE_TOKEN':'private-fixture'}), \
             patch.object(external, 'request', side_effect=response) as request, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(external.main(['--execute','--gate','https','--url','https://api.example',
                '--project','fixture','--token-env','FIXTURE_TOKEN']), 0)
        self.assertEqual([row.args[0] for row in request.call_args_list], [
            'https://api.example/health','https://api.example/ready','https://api.example/v1/projects/fixture/bundles'])
        self.assertNotIn('private-fixture', output.getvalue())

    def test_oidc_predicates_accept_actual_playwright_string_urls(self):
        self.assertTrue(external.matches_issuer('https://identity.example/authorize?state=private', 'https://identity.example/tenant'))
        self.assertFalse(external.matches_issuer('http://identity.example/authorize', 'https://identity.example'))
        self.assertFalse(external.matches_issuer('https://attacker.example/authorize', 'https://identity.example'))
        self.assertTrue(external.returned_console('https://console.example/setup', 'https://console.example'))
        self.assertFalse(external.returned_console('https://console.example/auth/callback?code=private', 'https://console.example'))
        self.assertFalse(external.returned_console('https://console.example.attacker/setup', 'https://console.example'))


if __name__ == '__main__':
    unittest.main()
