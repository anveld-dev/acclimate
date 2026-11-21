#!/usr/bin/env python3
"""Run the learn CLI against a private PostgreSQL cluster and a scripted optimizer."""
import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / 'productization'))
from service_e2e import pg_bin
from qualify import Harness, ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--skip-build', action='store_true')
    args = parser.parse_args()
    if not args.skip_build:
        subprocess.run(['cargo', 'build', '--locked'], cwd=ROOT, check=True)
        subprocess.run(['npm', 'run', 'build:packages'], cwd=ROOT, check=True)
    harness = Harness(pg_bin(args.pg_bin))
    try:
        harness.start_database()
        subprocess.run(
            ['node', '--import', 'tsx', 'scripts/learn-cli-e2e.ts'],
            cwd=ROOT, env=harness.env, input=json.dumps({
                'workspace': 'learn-cli-fixture',
                'directory': str(harness.dir),
            }), text=True, check=True, timeout=120,
        )
    finally:
        harness.close()


if __name__ == '__main__':
    main()
