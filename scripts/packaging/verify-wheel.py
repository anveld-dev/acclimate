#!/usr/bin/env python3
"""Verify evaluator/policy/artifact/CLI imports from an installed external wheel."""
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
parser.add_argument('--analysis-fixtures', type=Path)
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
                    'from acclimate.evaluation_analysis import analyze_comparison; '
                    'from acclimate.evaluation_manifest import create_evaluation_manifest,restore_evaluation_manifest; '
                    'from acclimate import EvaluationProgressReporter; '
                    'assert all(callable(x) for x in (define_evaluation,preflight_evaluation,run_evaluation,evaluation_main,check_comparison,export_review_evidence,verify_review_export,analyze_comparison,create_evaluation_manifest,restore_evaluation_manifest,EvaluationProgressReporter))'],
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
    subprocess.run([str(python), '-m', 'unittest', 'discover', '-s', 'test', '-v'], cwd=app, env=clean_env, check=True)
    if args.analysis_fixtures:
        fixture = json.loads(args.analysis_fixtures.read_text())
        paths = []
        for key in ('comparison', 'expectedDescriptor', 'expectedBinding'):
            filename = directory / (key + '.json')
            filename.write_text(json.dumps(fixture['input'][key]))
            paths.append(str(filename))
        config = directory / 'analysis-config.json'
        config.write_text(json.dumps({key:fixture['input'][key] for key in ('metrics','observations','uncertainty')}))
        paths.append(str(config))
        checked = subprocess.run([str(python),str(app/'analyze.py'),*paths],cwd=directory,env=clean_env,check=True,capture_output=True,text=True)
        assert json.loads(checked.stdout) == fixture['vectors'][0]['expected']['result']
    print('Installed Python evaluator/CLI/policy/artifact imports, and app-owned public descriptor passed.')
