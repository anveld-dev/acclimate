#!/usr/bin/env python3
"""Supervise built-console acceptance with separate logs and durable exit markers."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[2]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--phase',choices=['focused','all','capture'],required=True)
    parser.add_argument('--tags',help='Override the focused Behave selection')
    args=parser.parse_args()
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=True,mode=0o700)
    python=str(ROOT/'.venv-bdd/bin/python')
    if args.phase=='capture':
        command=[python,'scripts/testing/compact_console.py','--output',str(output/'screenshots')]
    else:
        command=[python,'scripts/bdd/run.py','--skip-build','--output',str(output/'bdd')]
        if args.phase=='focused':
            command+=['--lane','browser','--tags',args.tags or '@UI-CONTENT-02 or @UI-CONTENT-03 or @UI-RELEASE-02 or @UI-KEYBOARD-01 or @UX-01 or @UX-02 or @NAV-01 or @NAV-02 or @UI-RECOVERY-05 or @UI-NAV-01']
    started=time.time()
    (output/'running.json').write_text(json.dumps(dict(phase=args.phase,startedAt=started,command=command),indent=2)+'\n')
    with (output/'run.log').open('w') as log:
        result=subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
    (output/'exit.json').write_text(json.dumps(dict(phase=args.phase,exitCode=result.returncode,elapsedSeconds=round(time.time()-started,2)),indent=2)+'\n')
    return result.returncode


if __name__=='__main__':raise SystemExit(main())
