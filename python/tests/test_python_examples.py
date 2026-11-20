"""The Python support agent example and the Python-only evaluation starter."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "examples" / "python-support-agent"
STARTER = ROOT / "examples" / "python-evaluation-starter"
MIXED_STARTER = ROOT / "examples" / "evaluation-starter"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_cli(*args, cwd):
    env = {key: value for key, value in os.environ.items() if not key.startswith("ACCLIMATE_")}
    env["PYTHONPATH"] = str(ROOT / "python")
    return subprocess.run([sys.executable, "-m", "acclimate", *args], cwd=cwd, env=env,
                          capture_output=True, text=True, check=True)


class SupportAgentExampleTest(unittest.TestCase):
    def test_describe_prints_the_public_descriptor(self):
        descriptor = json.loads(run_cli("describe", cwd=EXAMPLE).stdout)
        self.assertEqual(descriptor["runtime"]["configId"], "python-support-agent")
        self.assertEqual(
            sorted(case["caseId"] for case in descriptor["expectedCases"]),
            sorted(row["caseId"] for row in json.loads((EXAMPLE / "cases.json").read_text())),
        )
        public = json.dumps(descriptor)
        self.assertNotIn("mustMention", public)
        self.assertNotIn("tax filing", public)

    def test_the_v2_prompt_improves_every_regressed_case(self):
        sys.path.insert(0, str(EXAMPLE))
        try:
            application = load("support_application", EXAMPLE / "application.py")
            bundle_files = load("support_bundle_files", EXAMPLE / "bundle_files.py")
        finally:
            sys.path.remove(str(EXAMPLE))
        from acclimate.evaluation import GradeResult

        def rewards(version):
            verified = {"payload": bundle_files.payload_from_directory(EXAMPLE / "prompts" / version)}
            scores = {}
            for case in application.cases:
                run = type("Run", (), {"version": verified, "input": case["input"]})
                output = application.execute(run).output
                graded = application.grade(type("Grade", (), {"output": output, "expected": case["expected"]}))
                self.assertIsInstance(graded, GradeResult)
                scores[case["caseId"]] = graded.reward
            return scores

        parent, candidate = rewards("v1"), rewards("v2")
        self.assertTrue(all(candidate[case] >= parent[case] for case in parent))
        self.assertEqual(set(candidate.values()), {1.0})
        self.assertLess(parent["unknown-topic"], 1.0)


class PythonStarterTest(unittest.TestCase):
    def test_starter_is_python_only_and_inventoried(self):
        inventory = json.loads((ROOT / "scripts" / "packaging" / "starter-files.json").read_text())
        files = sorted(
            path.relative_to(STARTER).as_posix() for path in STARTER.rglob("*")
            if path.is_file() and "__pycache__" not in path.parts
        )
        self.assertEqual(files, sorted(inventory["python-evaluation"]))
        self.assertFalse(any(name.endswith((".mjs", ".mts", ".json")) and name != "quality-policy.example.json"
                             for name in files))
        self.assertNotIn("application.py", files, "the release check installs its own application.py")

    def test_shared_helpers_match_the_mixed_starter(self):
        # Change both copies together until the mixed starter drops its Python files.
        for name in ("acclimate_eval.py", "analyze.py", "async_eval.py", "quality-policy.example.json",
                     "test/test_async_lifetime.py"):
            with self.subTest(name=name):
                self.assertEqual((STARTER / name).read_bytes(), (MIXED_STARTER / name).read_bytes())

    def test_starter_entry_point_prints_help(self):
        result = subprocess.run([sys.executable, "acclimate_eval.py", "--help"], cwd=STARTER,
                                env={**os.environ, "PYTHONPATH": str(ROOT / "python")},
                                capture_output=True, text=True, check=True)
        self.assertIn("compare", result.stdout)


if __name__ == "__main__":
    unittest.main()
