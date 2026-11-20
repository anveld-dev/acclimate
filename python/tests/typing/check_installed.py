"""Check an already installed wheel using a separate mypy developer environment."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--consumer-python", type=Path, required=True)
    parser.add_argument("--mypy-python", type=Path, required=True)
    args = parser.parse_args()
    # Preserve venv launcher paths rather than resolving their interpreter symlinks.
    consumer_python = args.consumer_python.absolute()
    mypy_python = args.mypy_python.absolute()
    fixture_root = Path(__file__).resolve().parent
    env = {key: value for key, value in os.environ.items()
           if key not in ("PYTHONPATH", "PYTHONHOME", "MYPYPATH")}
    with tempfile.TemporaryDirectory(prefix="acclimate-installed-typing-") as temporary:
        directory = Path(temporary)
        for name in ("positive.py", "negative.py"):
            shutil.copyfile(fixture_root / name, directory / name)
        probe = subprocess.run(
            [str(consumer_python), "-I", "-c", '''
import importlib.metadata
import json
from pathlib import Path
import sys
from typing import get_type_hints
import acclimate
from acclimate import AcclimateClient, CreateReleaseRequest, Release
from acclimate import types
from acclimate.evaluation import ExecuteInput, GradeInput
root = Path(acclimate.__file__).resolve().parent
assert Path(sys.prefix).resolve() in root.parents, "SDK is not installed in consumer venv"
assert (root / "py.typed").is_file()
assert not importlib.metadata.requires("acclimate-sdk"), "unexpected runtime dependency"
for name, value in vars(types).items():
    if isinstance(value, type) and value.__module__ == "acclimate.types" and not name.startswith("_"):
        assert getattr(acclimate, name) is value, name
        assert name in acclimate.__all__, name
for helper in ("Literal", "NotRequired", "TypedDict"):
    assert not hasattr(acclimate, helper), helper
for name in ("FileKind", "CompatibilityTarget", "Operation"):
    assert getattr(acclimate, name) is getattr(types, name), name
hints = get_type_hints(AcclimateClient.create_release)
assert hints["request"] is CreateReleaseRequest and hints["return"] is Release
assert CreateReleaseRequest.__required_keys__ == {"versionId", "expectedRevision", "unevaluatedReason"}
assert get_type_hints(ExecuteInput)["version"] is acclimate.VerifiedVersion
assert {"output", "expected"} <= get_type_hints(GradeInput).keys()
print(json.dumps({"sdkPath": str(root), "pep561Marker": True, "runtimeDependencies": []}))
'''], cwd=directory, env=env, check=True, text=True, capture_output=True,
        )
        print(probe.stdout.strip())
        checker = subprocess.run([str(mypy_python), "-m", "mypy", "--version"],
                                 cwd=directory, env=env, text=True,
                                 capture_output=True, check=True)
        print(checker.stdout.strip())
        flags = [str(mypy_python), "-m", "mypy", "--strict", "--no-incremental",
                 "--python-executable", str(consumer_python), "--show-error-codes",
                 "--no-error-summary", "--config-file", os.devnull]
        positive = subprocess.run([*flags, "positive.py"], cwd=directory, env=env,
                                  text=True, capture_output=True)
        if positive.returncode != 0:
            raise AssertionError(positive.stdout + positive.stderr)
        negative = subprocess.run([*flags, "negative.py"], cwd=directory, env=env,
                                  text=True, capture_output=True)
        if negative.returncode != 1:
            raise AssertionError("Negative fixtures must fail: " + negative.stdout + negative.stderr)
        expected = {
            (number, code)
            for number, line in enumerate((directory / "negative.py").read_text().splitlines(), 1)
            if (match := re.search(r"# reject: ([\w,-]+)", line))
            for code in match[1].split(",")
        }
        actual = {
            (int(match[1]), match[2]) for line in negative.stdout.splitlines()
            if (match := re.search(r"negative\.py:(\d+): error: .*  \[([^]]+)\]$", line))
        }
        error_lines = [line for line in negative.stdout.splitlines() if ": error:" in line]
        if len(error_lines) != len(actual):
            raise AssertionError("Unrecognized or duplicate diagnostics: " + negative.stdout)
        if not expected <= actual or any(code == "attr-defined" for _, code in actual):
            raise AssertionError("Missing expected diagnostics or invalid public import: " + negative.stdout)
        unexpected = actual - expected
        if unexpected:
            raise AssertionError("Unexpected negative-fixture diagnostics: " + negative.stdout)
        print(negative.stdout.strip())
        print(json.dumps({"strictPositiveExitCode": positive.returncode,
                          "negativeExitCode": negative.returncode,
                          "expectedRejectedCases": len(expected)}))


if __name__ == "__main__":
    main()
