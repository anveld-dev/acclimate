#!/usr/bin/env python3
"""Opt-in live Luna qualification on a disposable PostgreSQL cluster."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
if __name__ == '__main__' and sys.version_info < (3, 11):
    python = ROOT / '.venv-bdd/bin/python'
    if python.exists():
        os.execv(str(python), [str(python), __file__, *sys.argv[1:]])
    raise SystemExit('Use Python 3.11+ to run the live learning qualification')
sys.path.insert(0, str(ROOT))
from scripts.productization.qualify import Harness
from scripts.bdd.run import pg_bin


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--live', action='store_true',
        help='Authorize paid SDK turns: up to 48 normally, 128 for twenty rounds, 24 for helper repair, or 20 for the large audit',
    )
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pg-bin')
    parser.add_argument('--skip-build', action='store_true')
    modes=parser.add_mutually_exclusive_group()
    modes.add_argument('--twenty-rounds', action='store_true', help='20 search rounds, at most 128 SDK turns, 90-minute deadline')
    modes.add_argument('--large', action='store_true', help='Large frozen audit, at most 20 SDK turns, 60-minute deadline')
    modes.add_argument('--repair-helper', action='store_true', help='Up to five model-authored skill-helper repairs and development checks, at most 24 SDK turns')
    parser.add_argument('--source-run',type=Path)
    parser.add_argument('--frozen-dataset',type=Path)
    parser.add_argument('--verify-delivery',action='store_true',help='Only for a large audit with a frozen future batch: qualify and test a disposable release')
    args = parser.parse_args()
    if not args.live:
        parser.error('--live is required; this test makes paid Luna calls')
    if args.large and (not args.source_run or not args.frozen_dataset):
        parser.error('--large requires --source-run and --frozen-dataset')
    if args.repair_helper and not args.source_run:
        parser.error('--repair-helper requires --source-run')
    if args.verify_delivery and not args.large:
        parser.error('--verify-delivery requires --large')
    output = args.output.resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    os.umask(0o077)
    harness = Harness(pg_bin(args.pg_bin))
    process = None
    try:
        if not args.skip_build:
            subprocess.run(['cargo', 'build', '--locked'], cwd=ROOT, check=True)
        harness.pg(
            'initdb', '-D', str(harness.dir / 'pg'), '-U', 'qualification',
            '-A', 'trust', '--no-locale',
        )
        harness.pg(
            'pg_ctl', '-D', str(harness.dir / 'pg'),
            '-l', str(harness.dir / 'postgres.log'),
            '-o', f"-p {harness.pg_port} -h 127.0.0.1 -c unix_socket_directories=''",
            '-w', 'start',
        )
        env = dict(
            harness.env,
            EVALUATION_TEST_DATABASE_URL=harness.env['DATABASE_URL'],
            ACCLIMATE_TEST_PYTHON=sys.executable,
        )
        with (output / 'run.log').open('w') as log:
            entry = 'examples/self-improvement/repair/run.ts' if args.repair_helper else 'examples/self-improvement/large/run.ts' if args.large else 'examples/self-improvement/twenty/run.ts' if args.twenty_rounds else 'examples/self-improvement/run.ts'
            extra = ['--source-run',str(args.source_run.resolve())] if args.large or args.repair_helper else []
            if args.large: extra += ['--frozen-dataset',str(args.frozen_dataset.resolve())]
            if args.verify_delivery: extra += ['--verify-delivery']
            process = subprocess.Popen(
                ['node', '--import', 'tsx', entry,
                 '--live', '--output', str(output), *extra],
                cwd=ROOT, env=env, stdout=log, stderr=log, start_new_session=True,
            )
            status = process.wait(timeout=(60 if args.large or args.repair_helper else 90 if args.twenty_rounds else 25) * 60)
        if status:
            raise RuntimeError(
                'Live learning qualification failed; inspect the private failure.json and run.log'
            )
        print('Live learning qualification passed. Evidence: ' + str(output))
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
