#!/usr/bin/env python3
"""Run Rust tests against an isolated PostgreSQL cluster, never the demo database."""
import argparse
import subprocess
from qualify import Harness, ROOT

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--pg-bin',required=True)
args=parser.parse_args()
h=Harness(args.pg_bin)
try:
    h.pg('initdb','-D',str(h.dir/'pg'),'-U','qualification','-A','trust','--no-locale')
    h.pg('pg_ctl','-D',str(h.dir/'pg'),'-l',str(h.dir/'postgres.log'),'-o',f"-p {h.pg_port} -h 127.0.0.1 -c unix_socket_directories=''",'-w','start')
    env=dict(h.env,ACCLIMATE_TEST_DATABASE_URL=h.env['DATABASE_URL'],EVALUATION_TEST_DATABASE_URL=h.env['DATABASE_URL'],TEST_DATABASE_URL=h.env['DATABASE_URL'])
    subprocess.run(['cargo','test','--all-targets','--','--test-threads=1'],cwd=ROOT,env=env,check=True)
finally:
    h.close()
