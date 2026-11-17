#!/usr/bin/env python3
"""Qualify continuous connection learning against a disposable PostgreSQL cluster."""
import argparse
import subprocess

from full_roadmap import pg_bin
from qualify import Harness, ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--skip-build', action='store_true')
    args = parser.parse_args()
    if not args.skip_build:
        subprocess.run(['cargo', 'build', '--locked'], cwd=ROOT, check=True)
    harness = Harness(pg_bin(args.pg_bin))
    try:
        harness.start_database()
        subprocess.run(
            ['node', '--import', 'tsx', 'scripts/connected-learning-e2e.ts'],
            env=dict(harness.env, EVALUATION_TEST_DATABASE_URL=harness.env['DATABASE_URL']),
            cwd=ROOT, check=True, timeout=240,
        )
    finally:
        harness.close()


if __name__ == '__main__':
    main()
