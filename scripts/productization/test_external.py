import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
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
            self.assertEqual(external.main(['--execute', '--gate', 'remote-model']), 1)
        self.assertNotIn('private-secret', out.getvalue())

    def test_https_rejects_credential_urls(self):
        for url in ['http://example.com', 'https://user:password@example.com', 'https://example.com?token=secret']:
            with self.assertRaises(ValueError): external.https_url(url)

    def test_authorization_never_follows_redirect(self):
        request = external.Request('https://first.example', headers={'Authorization': 'Bearer private-secret'})
        for target in ['https://second.example', 'http://first.example', 'https://first.example/moved']:
            with self.assertRaises(ValueError):
                external.NoRedirect().redirect_request(request, None, 302, 'Found', {}, target)

    def test_failed_check_fails_under_python_optimize(self):
        # python -O strips assert statements, so a check written as one would pass unchecked.
        driver = ('import json, sys\n'
                  'config = json.load(sys.stdin)\n'
                  'print(json.dumps(dict(provider=config["provider"], model=config["model"], marker=config["marker"],\n'
                  '    actualProviderSession=True, checks=dict(instruction=True, skill=False, memory=True,\n'
                  '    freshVersion=True, oldWorkspacePinned=True))))\n')
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'driver.py'
            path.write_text(driver)
            result = subprocess.run([sys.executable, '-O', str(Path(__file__).with_name('external.py')),
                                     '--execute', '--gate', 'native-pi', '--live', '--driver', sys.executable, str(path)],
                                    capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        gate = json.loads(result.stdout)['gates']['native-pi']
        self.assertEqual(gate, {'status': 'blocked', 'reason': 'Native evidence failed a prepared-file or pinning check'})


if __name__ == '__main__':
    unittest.main()
