#!/usr/bin/env python3
"""Build a wheel and verify an isolated install. Run with Python 3.11+."""

import argparse
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import venv

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--expected-version')
parser.add_argument('--output', type=Path, help='Retain the verified wheel in this directory')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
package_version = tomllib.loads((root / 'python/pyproject.toml').read_text())['project']['version']
if args.expected_version and package_version != args.expected_version:
    raise ValueError('Python and release package versions differ')
with tempfile.TemporaryDirectory(prefix="acclimate-python-package-") as temporary:
    directory = Path(temporary)
    wheels = directory / "wheels"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            "--no-deps",
            "--wheel-dir",
            str(wheels),
            str(root / "python"),
        ],
        check=True,
    )
    venv.EnvBuilder(with_pip=True).create(directory / "venv")
    python = (
        directory
        / "venv"
        / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    )
    (wheel,) = wheels.glob("acclimate_sdk-*.whl")
    subprocess.run(
        [str(python), "-m", "pip", "install", "--no-index", "--no-deps", str(wheel)],
        check=True,
        cwd=directory,
    )
    subprocess.run(
        [
            str(python),
            "-I",
            "-c",
            "from acclimate import AcclimateClient, resolve_and_cache, prepare_files; "
            "from importlib.metadata import version; from pathlib import Path; import tempfile, os; "
            f"assert version('acclimate-sdk') == {package_version!r}; "
            "bundle={'version':{'id':'v1','bundleId':'b','parentVersionId':None,'digest':'sha256:test','createdAt':'now'},'payload':{'schemaVersion':1,'files':[{'path':'instructions.md','kind':'instruction','text':'Installed wheel content.'}]},'stale':False,'resolvedAt':0}; "
            "temporary=tempfile.TemporaryDirectory(); destination=os.path.realpath(temporary.name)+'/prepared'; "
            "prepared=prepare_files(bundle,destination); assert Path(prepared.files[0]['absolutePath']).read_text()=='Installed wheel content.'; "
            "prepared.cleanup(); assert not Path(prepared.files[0]['absolutePath']).exists(); temporary.cleanup(); print('Isolated Python wheel import and preparation passed.')",
        ],
        check=True,
        cwd=directory,
    )

    if args.output:
        args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
        destination = args.output / wheel.name
        if destination.exists():
            raise FileExistsError('Retained wheel already exists')
        shutil.copyfile(wheel, destination)
