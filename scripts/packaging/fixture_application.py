"""Adopter-owned input used only by installed consumer and acceptance tests."""
from pathlib import Path
import shutil
import subprocess

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "evaluator"

def install_test_application(app, language):
    extension = {"javascript": "mjs", "python": "py"}[language]
    files = ["application." + extension, "agent." + extension, "cases.json",
             "baseline.json", "candidate.json", "quality-policy.json", "share-selection.json"]
    for name in files:
        with (app / name).open("xb") as target, (FIXTURE / name).open("rb") as contents:
            shutil.copyfileobj(contents, target)
        (app / name).chmod(0o600)
    return str((app / "cases.json").resolve())


def commit_candidate(repository, source):
    """Create a local Git commit for the production CI runner to evaluate."""
    repository.mkdir(mode=0o700)
    def git(*args):
        return subprocess.check_output(
            ["git", "-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid",
             "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", *args],
            cwd=repository, text=True).strip()
    git("init", "--quiet")
    shutil.copyfile(source, repository / "candidate.json")
    git("add", "--", "candidate.json")
    git("commit", "--quiet", "-m", "Evaluate committed application content")
    return git("rev-parse", "HEAD")
