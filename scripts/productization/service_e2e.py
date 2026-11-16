#!/usr/bin/env python3
"""Run the SDK/service contract on an owned private PostgreSQL cluster."""
import argparse
import subprocess
from qualify import Harness, ROOT
from full_roadmap import pg_bin


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--skip-build',action='store_true')
    args=parser.parse_args()
    h=Harness(pg_bin(args.pg_bin))
    try:
        if not args.skip_build:
            subprocess.run(['cargo','build','--locked'],cwd=ROOT,check=True)
        h.start_database()
        env=dict(h.env,EVALUATION_TEST_DATABASE_URL=h.env['DATABASE_URL'])
        subprocess.run(['node','--import','tsx','scripts/service-e2e.ts'],cwd=ROOT,
                       env=env,check=True,timeout=120)
    finally:
        h.close()


if __name__=='__main__':
    main()
