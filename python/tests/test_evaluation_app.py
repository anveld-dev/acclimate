import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from acclimate.evaluation_app import installed_application


class ApplicationRevisionTests(unittest.TestCase):
    def test_changing_a_declared_file_invalidates_the_saved_descriptor(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ):
            os.environ.pop("ACCLIMATE_EVALUATOR_CASES", None)
            directory = Path(temporary)
            (directory / "application.py").write_text(
                'from acclimate.evaluation import ExecutionResult, GradeResult\n'
                'cases = [{"caseId": "tool", "input": "task", "expected": "private answer"}]\n'
                'revision_files = ["dependency.lock"]\n'
                'def execute(run): return ExecutionResult(output=run.input)\n'
                'def grade(run): return GradeResult(reward=float(run.output == run.expected))\n'
            )
            lock = directory / "dependency.lock"
            lock.write_text("tool=1")
            with installed_application(directory) as app:
                before = app.descriptor
            lock.write_text("tool=2")
            with installed_application(directory) as app:
                after = app.descriptor
            self.assertEqual(after["datasetRevision"], before["datasetRevision"])
            self.assertNotEqual(after["graderRevision"], before["graderRevision"])
            self.assertNotEqual(after["runtime"]["configRevision"], before["runtime"]["configRevision"])
            self.assertNotIn("private answer", str(after))

    def test_package_imports_and_transitive_sources_use_the_fingerprinted_bytes(self):
        import json
        import subprocess
        import sys
        import acclimate
        from acclimate.evaluation_app import SetupError
        from types import SimpleNamespace

        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ):
            os.environ.pop("ACCLIMATE_EVALUATOR_CASES", None)
            root = Path(temporary)
            package = root / "incident_evals"
            package.mkdir()
            (package / "__init__.py").write_text("")
            rules = package / "rules.py"
            rules.write_text('QUEUE = "east"\n')
            (package / "agent.py").write_text("from .rules import QUEUE\ndef route(): return QUEUE\n")
            adapter = package / "adapter.py"
            adapter.write_text(
                "from .agent import route\nfrom acclimate.evaluation import ExecutionResult, GradeResult\n"
                "cases=[dict(caseId='route',input='x',expected='west')]\n"
                "async def execute(run): return ExecutionResult(output=route())\n"
                "def grade(run): return GradeResult(reward=float(run.output==run.expected))\n"
            )
            with patch.object(sys, "path", [str(root), *sys.path]):
                coverage = {}
                with installed_application(root, selection="incident_evals.adapter", coverage=coverage) as app:
                    before = app.descriptor
                    self.assertEqual(app._execute(SimpleNamespace()).output, "east")
                    self.assertEqual(set(coverage["importedFiles"]), {"__init__.py", "agent.py", "rules.py"})
                    self.assertNotIn("west", str(coverage))
                stat = rules.stat()
                rules.write_text('QUEUE = "west"\n')
                os.utime(rules, ns=(stat.st_atime_ns, stat.st_mtime_ns))
                with self.assertRaisesRegex(SetupError, "fresh evaluator process"):
                    with installed_application(root, selection=str(adapter)):
                        self.fail("A new fingerprint must never run previously cached code")
                after = json.loads(subprocess.check_output(
                    [sys.executable, "-m", "acclimate", "describe", "--app", str(adapter)],
                    cwd=root, env={**os.environ, "PYTHONPATH": str(Path(acclimate.__file__).resolve().parents[1])}))
                self.assertNotEqual(before["runtime"]["configRevision"], after["runtime"]["configRevision"])
                self.assertNotEqual(before["graderRevision"], after["graderRevision"])
                self.assertNotIn("rules.py", str(after))

    def test_reader_commands_start_without_loading_the_adapter(self):
        from acclimate.evaluation_app import main

        with patch("acclimate.evaluation_app.installed_application", side_effect=AssertionError("read command imported application")), \
             patch("acclimate.evaluation_cli.evaluation_main", return_value=0) as dispatch:
            args = ["pull", "--config", "config", "--bundle", "bundle", "--out", "bundle.json"]
            self.assertEqual(main(args), 0)
            dispatch.assert_called_once_with(None, args)
