#!/usr/bin/env python3
"""Run executable user behaviors against disposable local services."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[2]
if __name__ == '__main__' and (sys.version_info < (3,11) or importlib.util.find_spec('behave') is None):
    python=ROOT/'.venv-bdd/bin/python'
    if python.exists() and Path(sys.executable)!=python:
        os.execv(str(python),[str(python),__file__,*sys.argv[1:]])
    sys.exit('Use Python 3.11+ to install BDD dependencies: python3 -m venv .venv-bdd && .venv-bdd/bin/pip install -r scripts/bdd/requirements.txt')
sys.path.insert(0,str(ROOT))
from scripts.bdd.coverage import write_report, catalog


def pg_bin(explicit):
    candidates=[Path(explicit)] if explicit else []
    executable=shutil.which('pg_config')
    if executable:
        candidates.append(Path(subprocess.check_output([executable,'--bindir'],text=True).strip()))
    candidates += list(Path('/opt/homebrew/opt').glob('postgresql*/bin'))+list(Path('/usr/lib/postgresql').glob('*/bin'))
    for candidate in candidates:
        if all((candidate/name).is_file() for name in ['postgres','initdb','pg_ctl','psql']):
            return str(candidate)
    sys.exit('PostgreSQL server binaries not found. Pass --pg-bin /path/to/postgresql/bin.')


def run_behave(command, out, parallel):
    formatter = ['--format', 'scripts.bdd.formatter:BehaviorJSONFormatter', '--outfile']
    results = out / 'results.json'
    if not parallel:
        return subprocess.run([*command, *formatter, str(results)]).returncode

    # console.feature takes about as long as the rest of the suite combined.
    # Each process owns its service and database. JUnit writes one file per feature.
    (out / 'junit').mkdir(exist_ok=True)
    pattern = r'(?:^|/)console\.feature$'
    with tempfile.TemporaryDirectory(dir=out) as temporary:
        def run_group(group):
            path = Path(temporary) / (group + '.json')
            result = subprocess.run([*command, '--' + group, pattern, *formatter, str(path)],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            print(result.stdout, end='', flush=True)
            try:
                return result.returncode, json.loads(path.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                print(f'Missing or incomplete Behave output for --{group} {pattern}', file=sys.stderr)
                return 1, []

        with ThreadPoolExecutor(max_workers=2) as pool:
            groups = list(pool.map(run_group, ['include', 'exclude']))
    combined = [feature for _, features in groups for feature in features]
    results.write_text(json.dumps(combined, indent=2) + '\n')
    return int(any(code for code, _ in groups))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--lane',choices=['all','service','sdk','browser','identity','runtime'],default='all')
    parser.add_argument('--output',type=Path,help='Private evidence directory (defaults to artifacts/bdd or artifacts/bdd-dev)')
    parser.add_argument('--name',help='Behave scenario-name regular expression')
    parser.add_argument('--tags',help='Additional Behave tag expression')
    parser.add_argument('--skip-build',action='store_true',help='Use existing Rust, SDK and console builds')
    parser.add_argument('--parallel', action='store_true', help='Run the console feature alongside the other features')
    parser.add_argument('--dev-console',action='store_true',help='Exercise Vite development modules instead of the production console')
    args=parser.parse_args()
    pg=pg_bin(args.pg_bin)
    os.chdir(ROOT)
    if catalog(ROOT)!=json.loads((ROOT/'scripts/bdd/inventory.json').read_text()):
        sys.exit('Feature stories differ from the reviewed behavior inventory. Review and update scripts/bdd/inventory.json.')
    out=args.output.resolve() if args.output else ROOT/'artifacts'/('bdd-dev' if args.dev_console else 'bdd')
    out.mkdir(parents=True,exist_ok=True)
    out.chmod(0o700)
    for filename in ['results.json','coverage.md','coverage.json']:
        (out/filename).unlink(missing_ok=True)
    for name in ['junit','failures']:
        if (out/name).exists(): shutil.rmtree(out/name)
    if not args.skip_build:
        for command in [['cargo','build','--locked'],['npm','run','build:packages']]+([['npm','run','build:console']] if args.lane in ['all','browser','runtime'] else []):
            subprocess.run(command,check=True)
    subprocess.run([sys.executable,'-m','unittest','scripts.bdd.test_coverage'],check=True)
    command=[sys.executable,'-m','behave','features','-D','pg_bin='+pg,'-D','artifact_dir='+str(out),'--format','progress','--outfile','-','--junit','--junit-directory',str(out/'junit')]
    if args.dev_console: command+=['-D','console_mode=dev']
    lanes={'service':'not @browser and not @sdk and not @adapter and not @runtime','sdk':'@sdk','browser':'@browser','identity':'@adapter','runtime':'@runtime'}
    if args.lane!='all': command+=['--tags',lanes[args.lane]]
    if args.tags: command+=['--tags',args.tags]
    if args.name: command+=['--name',args.name]
    code=run_behave(command, out, args.parallel)
    if not (out/'results.json').exists(): return code or 1
    complete=write_report(ROOT/'scripts/bdd/inventory.json',out/'results.json',out)
    print('Behavior report: '+str(out/'coverage.md'),flush=True)
    full=args.lane=='all' and not args.name and not args.tags
    if full and not complete:
        print('Full coverage failed: a behavior or variant is missing, skipped, undefined or failing.',file=sys.stderr)
        return 1
    if not full: print('Selected run only; see report for behaviors not exercised.')
    return code

if __name__=='__main__':
    raise SystemExit(main())
