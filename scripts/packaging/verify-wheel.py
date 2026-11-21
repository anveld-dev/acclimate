#!/usr/bin/env python3
"""Verify the installed external wheel and its evaluator starter."""
if not __debug__:
    raise RuntimeError('Wheel verification requires Python assertions; remove -O/PYTHONOPTIMIZE')

import argparse
import json
from fixture_application import install_test_application
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
                    'from importlib.util import find_spec; '
                    'from acclimate.evaluation import define_evaluation,preflight_evaluation; '
                    'from acclimate.evaluation_cli import evaluation_main; '
                    'from acclimate.evaluation_manifest import create_evaluation_manifest,restore_evaluation_manifest; '
                    'assert all(callable(x) for x in (define_evaluation,preflight_evaluation,evaluation_main,create_evaluation_manifest,restore_evaluation_manifest)); '
                    'assert all(find_spec("acclimate." + name) is None for name in '
                    '("evaluation_policy", "evaluation_artifacts", "evaluation_analysis", "evaluation_plan", "evaluation_progress", "evaluation_async", "_student_t"))'],
                   cwd=directory, check=True)
    clean_env['ACCLIMATE_EVALUATOR_CASES'] = install_test_application(app, 'python')
    described = subprocess.run([str(python), 'acclimate_eval.py', 'describe'], cwd=app, check=True,
                              capture_output=True, text=True, env=clean_env)
    descriptor = json.loads(described.stdout)
    subprocess.run([str(python), '-m', 'acclimate', '--help'], cwd=directory, env=clean_env, check=True)
    module = subprocess.run([str(python), '-m', 'acclimate', 'describe'], cwd=app, env=clean_env,
                            check=True, capture_output=True, text=True)
    assert json.loads(module.stdout) == descriptor
    # The wheel's console script runs the same CLI as python -m acclimate.
    script = subprocess.run([str(directory / 'venv' / 'bin' / 'acclimate'), 'describe'], cwd=app, env=clean_env,
                            check=True, capture_output=True, text=True)
    assert json.loads(script.stdout) == descriptor

    assert descriptor['runtime']['configId'] == 'installed-qualification-worker'
    assert descriptor['runtime']['execution'] == 'live'
    assert len(descriptor['expectedCases']) == 2
    assert '"expected"' not in described.stdout and 'evaluatorToken' not in described.stdout
    print('Installed Python evaluator and CLI imports passed. Removed modules are absent.')
