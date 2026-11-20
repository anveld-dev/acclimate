import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from acclimate._evaluation_shared import EVALUATOR_TOKEN_ENV, read_evaluator_config
from acclimate.evaluation import EvaluationError


class EvaluatorTokenSources(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.root = Path(os.path.realpath(self._temp.name))
        self.root.chmod(0o700)
        self.base = {"schemaVersion": 1, "serviceUrl": "https://acclimate.example", "workspaceId": "workspace",
                     "evaluatorPrincipalId": "machine:ci", "journalRoot": str(self.root / "journal")}
        self.secrets = self.root / "secrets"
        self.secrets.mkdir(mode=0o700)
        self.token_file = self.secrets / "evaluator-token"
        self.token_file.write_text("acm_TOKEN_CANARY\n")
        self.token_file.chmod(0o600)

    def tearDown(self):
        self._temp.cleanup()

    def write(self, value):
        path = self.root / "evaluator.json"
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        return path

    def assert_code(self, path, code):
        with self.assertRaises(EvaluationError) as caught:
            read_evaluator_config(path)
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn("TOKEN_CANARY", repr(caught.exception))

    def test_token_file_gets_config_file_privacy_checks(self):
        path = self.write({**self.base, "evaluatorTokenFile": str(self.token_file)})
        with mock.patch.dict(os.environ, {EVALUATOR_TOKEN_ENV: "acm_ENV_IGNORED"}):
            config = read_evaluator_config(path)
        self.assertEqual(config["evaluatorToken"], "acm_TOKEN_CANARY")
        self.assertNotIn("evaluatorTokenFile", config)
        self.token_file.chmod(0o644)
        self.assert_code(path, "config.permissions")
        self.token_file.chmod(0o600)
        self.secrets.chmod(0o755)
        self.assert_code(path, "config.permissions")
        self.secrets.chmod(0o700)
        alias = self.root / "alias-token"
        alias.symlink_to(self.token_file)
        self.assert_code(self.write({**self.base, "evaluatorTokenFile": str(alias)}), "config.permissions")
        self.assert_code(self.write({**self.base, "evaluatorTokenFile": "relative/token"}), "config.schema")
        self.token_file.write_text("acm_TOKEN_CANARY\nsecond\n")
        self.assert_code(self.write({**self.base, "evaluatorTokenFile": str(self.token_file)}), "config.schema")
        self.token_file.unlink()
        self.assert_code(path, "config.missing")

    def test_environment_token_applies_only_when_config_names_none(self):
        path = self.write(self.base)
        with mock.patch.dict(os.environ, {EVALUATOR_TOKEN_ENV: "acm_TOKEN_CANARY"}):
            self.assertEqual(read_evaluator_config(path)["evaluatorToken"], "acm_TOKEN_CANARY")
            inline = self.write({**self.base, "evaluatorToken": "acm_INLINE"})
            self.assertEqual(read_evaluator_config(inline)["evaluatorToken"], "acm_INLINE")
        path = self.write(self.base)
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(EVALUATOR_TOKEN_ENV, None)
            self.assert_code(path, "config.schema")
        with mock.patch.dict(os.environ, {EVALUATOR_TOKEN_ENV: " padded "}):
            self.assert_code(path, "config.schema")
        both = self.write({**self.base, "evaluatorToken": "acm_INLINE", "evaluatorTokenFile": str(self.token_file)})
        self.assert_code(both, "config.schema")


if __name__ == "__main__":
    unittest.main()
