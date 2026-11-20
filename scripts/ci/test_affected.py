import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from scripts.ci.affected import FULL, required_jobs

SELECTOR = Path(__file__).with_name("affected.py").resolve()


class AffectedTests(unittest.TestCase):
    def test_paths(self):
        cases = [
            (["docs/architecture/server.md", "docs/site/index.html", "docs/site/build-info.json",
              "docs/site/source/repository/src/main.rs"], set()),
            (["apps/docs/content/docs/reference/error-codes.mdx"], {"unit"}),
            (["features/identity.feature", "scripts/bdd/inventory.json"], {"bdd"}),
            (["apps/docs/content/docs/reference/meta.json", "features/access.feature"], {"unit", "bdd"}),
        ]
        for paths, expected in cases:
            with self.subTest(paths=paths):
                self.assertEqual(required_jobs(paths), expected)

    def test_shared_and_unknown_inputs_require_all_jobs(self):
        for path in ("src/main.rs", ".github/workflows/ci.yaml", "scripts/ci/affected.py",
                     "package-lock.json", "docs/acceptance/evidence.json", "features/steps/access.py",
                     "docs/research/experiment.cc", "unknown"):
            with self.subTest(path=path):
                self.assertEqual(required_jobs(["docs/development.md", path]), FULL)
        self.assertEqual(required_jobs([]), FULL)

    def test_workflow_entry_point(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, text=True).strip()

            def select(base, event="pull_request"):
                output = root / ".git" / "output"
                output.write_text("")
                subprocess.run([sys.executable, SELECTOR], cwd=root, check=True, capture_output=True,
                               env={**os.environ, "GITHUB_EVENT_NAME": event, "PR_BASE_SHA": base,
                                    "GITHUB_OUTPUT": str(output)})
                return {line.removesuffix("=true") for line in output.read_text().splitlines()
                        if line.endswith("=true")}

            def commit(message):
                git("add", "-A")
                git("-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "commit", "-qm", message)
                return git("rev-parse", "HEAD")

            git("init", "-q")
            source = root / "production.txt"
            source.write_text("tracked\n")
            base = commit("base")
            docs = root / "docs" / "research"
            docs.mkdir(parents=True)
            note = docs / "line\nbreak.md"
            note.write_text("note\n")
            docs_base = commit("add documentation")
            self.assertEqual(select(base), set())
            self.assertEqual(select(base, "push"), FULL)
            self.assertEqual(select("missing-base"), FULL)
            source.rename(docs / "moved.md")
            note.unlink()
            commit("move production file into docs and delete note")
            self.assertEqual(select(docs_base), FULL)
