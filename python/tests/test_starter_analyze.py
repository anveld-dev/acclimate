import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

# The distributed starter's analysis recipe, exercised against the shared repo fixtures.
# This test lives outside the starter so the archive ships no checkout-only test.
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "examples/evaluation-starter"))
from analyze import main
INPUT = json.loads((ROOT / "contracts/fixtures/evaluation-analysis/vectors.json").read_text())["input"]


def run(*args):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        status = main([str(arg) for arg in args])
    return status, out.getvalue(), err.getvalue()


class AnalyzeScriptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        for name, value in (("comparison", INPUT["comparison"]), ("descriptor", INPUT["expectedDescriptor"]),
                            ("binding", INPUT["expectedBinding"])):
            (self.root / f"{name}.json").write_text(json.dumps(value))
        self.files = [self.root / f"{name}.json" for name in ("comparison", "descriptor", "binding")]

    def tearDown(self):
        self.directory.cleanup()

    def test_no_config_is_descriptive_not_an_invalid_config(self):
        status, out, _ = run(*self.files)
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(out)["metrics"][0]["status"], "descriptive")

    def test_missing_file_is_named(self):
        status, _, err = run(self.files[0], self.files[1], self.root / "absent.json")
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(err), {"code": "analysis.file_unreadable", "file": str(self.root / "absent.json")})

    def test_incomplete_binding_lists_missing_ids(self):
        binding = dict(INPUT["expectedBinding"])
        del binding["comparisonId"], binding["attemptId"]
        self.files[2].write_text(json.dumps(binding))
        status, _, err = run(*self.files)
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(err)["missingFields"], ["attemptId", "comparisonId"])

    def test_sampled_case_interval_is_labeled(self):
        config = self.root / "config.json"
        config.write_text(json.dumps({"uncertainty": {"method": "paired-t", "estimand": "sampled-cases",
                                                      "samplingProtocol": "demo", "confidenceLevel": 0.95}}))
        status, out, _ = run(*self.files, config)
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(out)["metrics"][0]["uncertainty"]["estimand"], "sampled-cases")

    def test_name_mode_needs_a_config(self):
        status, _, err = run("--name", "run")
        self.assertEqual(status, 1)
        self.assertIn("--name RUN_NAME --config", err)


if __name__ == "__main__":
    unittest.main()
