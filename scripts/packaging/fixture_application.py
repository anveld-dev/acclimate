"""Adopter-owned input used only by installed consumer and acceptance tests."""
from pathlib import Path
import shutil

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "evaluator"

def install_test_application(app, language):
    extension = {"javascript": "mjs", "python": "py"}[language]
    files = ["application." + extension, "agent." + extension, "cases.json",
             "baseline.json"]
    for name in files:
        with (app / name).open("xb") as target, (FIXTURE / name).open("rb") as contents:
            shutil.copyfileobj(contents, target)
        (app / name).chmod(0o600)
    return str((app / "cases.json").resolve())
