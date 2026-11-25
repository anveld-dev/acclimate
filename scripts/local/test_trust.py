"""Tests for the opt-in local CA trust helper. No command touches a real trust store."""

from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts.local import stack, trust


# A throwaway self-signed certificate. It is never installed.
CERTIFICATE = b'''-----BEGIN CERTIFICATE-----
MIIBeTCCAR+gAwIBAgIUGsJJueZMuLZ+Svowf2htGkhA8NgwCgYIKoZIzj0EAwIw
EjEQMA4GA1UEAwwHdGVzdC1jYTAeFw0yNjExMTkxOTAwMDRaFw0zNjExMTYxOTAw
MDRaMBIxEDAOBgNVBAMMB3Rlc3QtY2EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AARPDdh3+DjTaDMwk8upqvS0xEXYfPI51Tqai5pnbPnLS1hdgjlZu2Huf2Tm7+X1
t2s3RGld1scTQF/VHMhCHCSeo1MwUTAdBgNVHQ4EFgQUGw0fLDwPL0JyWuCmh/by
9LkI9p4wHwYDVR0jBBgwFoAUGw0fLDwPL0JyWuCmh/by9LkI9p4wDwYDVR0TAQH/
BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEAtmTkfVYeS0CHk/g5SJpWx6vwPMV5
CZi6jRV0h6rLDesCICRv8TKrovcIUiFvQ27uzWwbBucckDCjjEmaJ6/g6ps+
-----END CERTIFICATE-----
'''


class TrustTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / 'home'
        self.home.mkdir()
        self.state = self.root / '.local' / 'stack'
        self.state.mkdir(parents=True)
        (self.state / 'root.crt').write_bytes(CERTIFICATE)
        (self.state / 'root.crt').chmod(0o644)
        patcher = patch.object(trust, 'ROOT', self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_main(self, argv, answer, system='Darwin'):
        run = Mock()
        output = io.StringIO()
        with patch('builtins.input', return_value=answer), redirect_stdout(output):
            status = trust.main(argv, system=system, run=run, home=self.home)
        return status, run, output.getvalue()

    def test_macos_trust_requires_confirmation_and_records_the_fingerprint(self):
        status, run, output = self.run_main([], 'no')
        self.assertEqual(status, 1)
        run.assert_not_called()
        self.assertIn('Nothing changed', output)
        self.assertFalse((self.state / 'trust.json').exists())

        status, run, output = self.run_main([], 'trust')
        self.assertEqual(status, 0)
        command = run.call_args.args[0]
        self.assertEqual(command[:5], ['security', 'add-trusted-cert', '-r', 'trustRoot', '-k'])
        self.assertTrue(command[5].endswith('Library/Keychains/login.keychain-db'))
        self.assertEqual(command[6], str(self.state / 'root.crt'))
        record = json.loads((self.state / 'trust.json').read_text())
        self.assertEqual(record['sha256'], trust.fingerprints(CERTIFICATE)[1])
        self.assertEqual(record['name'], trust.nickname(self.root))
        self.assertIn('SHA-256', output)

    def test_remove_undoes_the_recorded_trust(self):
        status, run, output = self.run_main(['--remove'], 'remove')
        self.assertEqual(status, 0)
        run.assert_not_called()
        self.assertIn('Nothing to remove', output)
        self.run_main([], 'trust')
        status, run, _ = self.run_main(['--remove'], 'remove')
        self.assertEqual(status, 0)
        sha1 = trust.fingerprints(CERTIFICATE)[0]
        self.assertEqual([call.args[0][:2] for call in run.call_args_list],
                         [['security', 'remove-trusted-cert'], ['security', 'delete-certificate']])
        self.assertEqual(run.call_args_list[1].args[0][3], sha1)
        self.assertFalse((self.state / 'trust.json').exists())

    def test_linux_plan_uses_the_system_store_and_browser_databases(self):
        nss = self.home / '.pki' / 'nssdb'
        nss.mkdir(parents=True)
        (nss / 'cert9.db').touch()
        firefox = self.home / '.mozilla' / 'firefox' / 'abc.default'
        firefox.mkdir(parents=True)
        (firefox / 'cert9.db').touch()
        tools = {'update-ca-certificates', 'certutil'}
        steps = trust.plan('Linux', self.root, self.state / 'root.crt', 'AB', self.home,
                           which=lambda name: name in tools and '/usr/bin/' + name, isdir=lambda path: True)
        add = [command for _, command in steps['add']]
        self.assertEqual(add[0][:3], ['sudo', 'install', '-m'])
        self.assertTrue(add[0][-1].startswith('/usr/local/share/ca-certificates/acclimate-local-'))
        self.assertEqual(add[1], ['sudo', 'update-ca-certificates'])
        self.assertEqual([command[2] for command in add[2:]], ['sql:' + str(nss), 'sql:' + str(firefox)])
        self.assertIn(trust.nickname(self.root), add[2])
        remove = [command for _, command in steps['remove']]
        self.assertEqual(remove[1], ['sudo', 'update-ca-certificates', '--fresh'])

        steps = trust.plan('Linux', self.root, self.state / 'root.crt', 'AB', self.home,
                           which=lambda name: name == 'trust' and '/usr/bin/trust')
        self.assertEqual(steps['add'][0][1][:4], ['sudo', 'trust', 'anchor', '--store'])

    def test_unsupported_platform_and_missing_stack_fail_clearly(self):
        with self.assertRaisesRegex(ValueError, 'macOS and Linux'):
            trust.plan('Windows', self.root, self.state / 'root.crt', 'AB', self.home)
        (self.state / 'root.crt').unlink()
        with self.assertRaisesRegex(SystemExit, 'npm run local:up'):
            self.run_main([], 'trust')

    def test_nickname_is_per_checkout(self):
        self.assertIn(stack.project_suffix(self.root), trust.nickname(self.root))


if __name__ == '__main__':
    unittest.main()
