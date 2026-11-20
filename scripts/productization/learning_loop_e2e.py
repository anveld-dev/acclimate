#!/usr/bin/env python3
"""Run the real learning service and SDK runner against a private PostgreSQL cluster."""
import argparse
import json
import subprocess
from qualify import Harness, ROOT
from service_e2e import pg_bin


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
        # The Node process owns the service and runner so it can restart both at a
        # precise journal checkpoint. Supply only the disposable cluster environment.
        subprocess.run(
            ['node', '--import', 'tsx', 'scripts/learning-loop-e2e.ts'],
            cwd=ROOT, env=harness.env, input=json.dumps({
                'workspace': 'learning-process-fixture',
                'directory': str(harness.dir),
            }), text=True, check=True,
        )
    finally:
        harness.close()


if __name__ == '__main__':
    main()
