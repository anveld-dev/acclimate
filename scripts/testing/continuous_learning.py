#!/usr/bin/env python3
"""Run recurring learner qualification against a disposable PostgreSQL/Rust service.

The default run is model-free. --live enables bounded Codex turns using the
configured Codex login. Both modes use synthetic payment incidents and private
disposable service credentials.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
if __name__ == '__main__' and sys.version_info < (3, 11):
    candidates = [ROOT / '.venv-bdd/bin/python', Path('/opt/homebrew/bin/python3')]
    explicit = os.environ.get('ACCLIMATE_TEST_PYTHON')
    if explicit:
        candidates.insert(0, Path(explicit))
    for python in candidates:
        if python.is_file() and python.resolve() != Path(sys.executable).resolve():
            os.execv(str(python), [str(python), __file__, *sys.argv[1:]])
    raise SystemExit('Use Python 3.11+ to run the recurring learner qualification')
sys.path.insert(0, str(ROOT))
from scripts.productization.qualify import Harness
from scripts.bdd.run import pg_bin


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pg-bin')
    parser.add_argument('--skip-build', action='store_true')
    parser.add_argument('--live', action='store_true', help='Explicitly enable bounded authenticated Codex model turns')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    os.chmod(output, 0o700)
    os.umask(0o077)
    harness = Harness(pg_bin(args.pg_bin))
    process = None
    try:
        if not args.skip_build:
            subprocess.run(['cargo', 'build', '--locked'], cwd=ROOT, check=True)
        harness.start()
        # Kept in the disposable harness directory, never copied into retained artifacts.
        config = harness.dir / 'continuous-learning-config.json'
        config.write_text(json.dumps(dict(
            schemaVersion=1, serviceUrl=harness.base, projectId=harness.project,
            learnerToken=harness.tokens['evaluator'], reviewerToken=harness.tokens['operator'],
            output=str(output), live=args.live,
        )))
        config.chmod(0o600)
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(('ACCLIMATE_', 'CONSOLE_')) and k not in
               ('DATABASE_URL', 'EVALUATION_TEST_DATABASE_URL', 'ACCLIMATE_TEST_DATABASE_URL')}
        env['ACCLIMATE_TEST_PYTHON'] = sys.executable
        with (output / 'run.log').open('w') as log:
            process = subprocess.Popen(
                ['node', '--import', 'tsx',
                 'examples/continuous-learning/live.ts' if args.live else 'examples/continuous-learning/run.ts',
                 '--config', str(config)], cwd=ROOT, env=env,
                stdout=log, stderr=log, start_new_session=True,
            )
            status = process.wait(timeout=5400 if args.live else 600)
        if status:
            raise RuntimeError('Recurring learner qualification failed; inspect private run.log')
        summary = json.loads((output / 'summary.json').read_text())
        if summary.get('status') != 'passed':
            raise RuntimeError(f'Recurring learner did not pass. Evidence: {output}')
        print('Recurring learner qualification passed. Evidence: ' + str(output))
    finally:
        if process and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        harness.close()


if __name__ == '__main__':
    main()
