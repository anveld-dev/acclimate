#!/usr/bin/env python3
"""Verify evaluator/policy/artifact/CLI imports from an installed external wheel."""
if not __debug__:
    raise RuntimeError('Wheel verification requires Python assertions; remove -O/PYTHONOPTIMIZE')

import argparse
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import venv
import os

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--wheel', required=True, type=Path)
parser.add_argument('--starter', required=True, type=Path)
args = parser.parse_args()
clean_env = {key: value for key, value in os.environ.items()
             if key not in ('PYTHONPATH', 'PYTHONHOME') and not key.startswith(('ACCLIMATE_', 'CONSOLE_'))}
with tempfile.TemporaryDirectory(prefix='acclimate-wheel-dx-') as temporary:
    directory = Path(temporary).resolve()
    venv.EnvBuilder(with_pip=True).create(directory / 'venv')
    python = directory / 'venv' / 'bin' / 'python'
    subprocess.run([str(python), '-m', 'pip', 'install', '--no-index', '--no-deps', str(args.wheel.resolve())],
                   cwd=directory, check=True)
    app = directory / 'app'
    shutil.copytree(args.starter, app, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'node_modules'))
    subprocess.run([str(python), '-I', '-c',
                    'from acclimate.evaluation import define_evaluation,preflight_evaluation,run_evaluation; '
                    'from acclimate.evaluation_cli import evaluation_main; '
                    'from acclimate.evaluation_policy import check_comparison; '
                    'from acclimate.evaluation_artifacts import export_review_evidence,verify_review_export; '
                    'assert all(callable(x) for x in (define_evaluation,preflight_evaluation,run_evaluation,evaluation_main,check_comparison,export_review_evidence,verify_review_export))'],
                   cwd=directory, check=True)
    subprocess.run([str(python), 'trial.py'], cwd=app, env=clean_env, check=True)
    described = subprocess.run([str(python), 'acclimate_eval.py', 'describe'], cwd=app, check=True,
                              capture_output=True, text=True, env=clean_env)
    import json
    descriptor = json.loads(described.stdout)
    assert descriptor['runtime']['configId'] == 'installed-payment-starter'
    assert len(descriptor['expectedCases']) == 2
    assert '"expected"' not in described.stdout and 'evaluatorToken' not in described.stdout
    subprocess.run([str(python), '-m', 'unittest', 'discover', '-s', 'test', '-v'], cwd=app, env=clean_env, check=True)
    print('Installed Python evaluator/CLI/policy/artifact imports, trial and public descriptor passed.')
