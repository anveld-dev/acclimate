#!/usr/bin/env python3
"""Run the full roadmap against an owned disposable cluster, never an ambient database."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
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


def run(args):
    output = args.output.resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    output.chmod(0o700)
    h = Harness(pg_bin(args.pg_bin))
    process = None
    try:
        if not args.skip_build:
            subprocess.run(['cargo', 'build', '--locked'], cwd=ROOT, check=True)
        h.pg('initdb', '-D', str(h.dir / 'pg'), '-U', 'qualification', '-A', 'trust', '--no-locale')
        h.pg('pg_ctl', '-D', str(h.dir / 'pg'), '-l', str(h.dir / 'postgres.log'),
             '-o', f"-p {h.pg_port} -h 127.0.0.1 -c unix_socket_directories=''", '-w', 'start')
        command = ['node', '--import', 'tsx', 'scripts/full-roadmap/run.ts'] + (['--live'] if args.live else [])
        env = {key: value for key, value in h.env.items() if not key.startswith('PG')}
        env['EVALUATION_TEST_DATABASE_URL'] = h.env['DATABASE_URL']
        with (output / 'run.log').open('w') as log:
            process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=log, stderr=log, start_new_session=True)
            try:
                code = process.wait(timeout=600 if args.live else 180)
            except subprocess.TimeoutExpired:
                raise RuntimeError('Bounded full-roadmap deadline exceeded')
        if code:
            raise RuntimeError('Full-roadmap check failed; inspect its private run.log')
        # The runner owns this fresh evidence directory; model output cannot select it.
        raw = (output / 'run.log').read_text()
        result = json.loads(raw[raw.index('{'):])
        source = Path(result['artifacts'])
        if source.is_symlink() or source.parent.resolve() != Path(tempfile.gettempdir()).resolve() or not source.name.startswith('acclimate-roadmap-'):
            raise RuntimeError('Runner returned an unexpected evidence directory')
        evidence = output / 'evidence'
        shutil.copytree(source, evidence)
        shutil.rmtree(source)
        for field in ('summaryPath', 'artifacts'):
            if field in result:
                result[field] = str(evidence / Path(result[field]).name) if field == 'summaryPath' else str(evidence)
        (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'status': 'passed', 'live': args.live, 'evidence': str(output),
                          'draftCalls': result['draftCalls'], 'reviewCalls': result['reviewCalls'],
                          'sdkVersion': result['sdkVersion']}, indent=2))
    finally:
        if process and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            if process.poll() is None:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
        h.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/full-roadmap-latest')
    parser.add_argument('--skip-build', action='store_true')
    parser.add_argument('--live', action='store_true', help='Authorize up to five bounded Luna turns')
    run(parser.parse_args())


if __name__ == '__main__':
    main()
