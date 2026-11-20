#!/usr/bin/env python3
"""Run the SDK/service contract on an owned private PostgreSQL cluster."""
import argparse
from pathlib import Path
import shutil
import subprocess
from qualify import Harness, ROOT


def pg_bin(explicit):
    candidates = [Path(explicit)] if explicit else []
    config = shutil.which('pg_config')
    if config:
        candidates.append(Path(subprocess.check_output([config, '--bindir'], text=True).strip()))
    candidates += list(Path('/opt/homebrew/opt').glob('postgresql*/bin'))
    candidates += list(Path('/usr/lib/postgresql').glob('*/bin'))
    for candidate in candidates:
        if all((candidate / name).is_file() for name in ('postgres', 'initdb', 'pg_ctl', 'psql')):
            return str(candidate)
    raise SystemExit('PostgreSQL binaries required; pass --pg-bin /path/to/bin')


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
