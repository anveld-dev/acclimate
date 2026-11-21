#!/usr/bin/env python3
"""Installed JS/wheel evaluators against a disposable real PostgreSQL/Rust service.

No ambient database, user credential file, model provider or public deployment is used.
Only the generated private fixture config receives fixture machine credentials.
"""
if not __debug__:
    raise RuntimeError('Qualification requires Python assertions; remove -O/PYTHONOPTIMIZE')

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tarfile
import venv

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'scripts' / 'productization'))
from qualify import Harness
from scripts.packaging.fixture_application import FIXTURE, install_test_application


def private_json(filename, value):
    filename.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if filename.exists():
        raise FileExistsError('Private qualification output already exists')
    fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        output.write('\n')


def run(command, *, cwd, expected=0, env=None):
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True)
    if result.returncode != expected:
        # Callback/service text can be private. Keep failure output out of public logs.
        error = None
        try:
            parsed = json.loads(result.stderr or result.stdout)
            error = parsed.get('error', {}).get('code')
        except (ValueError, AttributeError):
            pass
        raise AssertionError(f'Installed consumer {Path(command[0]).name} command {command[2] if len(command) > 2 else "check"} returned {result.returncode}, expected {expected}; safe code={error}')
    if not result.stdout.strip():
        return None
    return json.loads(result.stdout)


def verify_release(release):
    manifest = json.loads((release / 'manifest.json').read_text())
    names = set()
    for artifact in manifest['artifacts']:
        name = artifact['name']
        if Path(name).name != name or name in ('.', '..') or name in names:
            raise ValueError('Unsafe release artifact name')
        names.add(name)
        if (release / name).is_symlink() or not (release / name).is_file():
            raise ValueError('Release artifact is not a regular file')
        data = (release / name).read_bytes()
        assert len(data) == artifact['bytes']
        assert hashlib.sha256(data).hexdigest() == artifact['sha256']
    required = {'SOURCE.json', 'release-metadata.json'}
    required.update(item['file'] for item in manifest['packages'])
    required.update(item['file'] for item in manifest['starters'])
    if required != names:
        raise ValueError('Release manifest does not cover exactly the declared artifacts')
    source = json.loads((release / 'SOURCE.json').read_text())
    digest = hashlib.sha256(json.dumps(source['files'], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    if source['sha256'] != digest or manifest['source']['file'] != 'SOURCE.json' or manifest['source']['sha256'] != digest:
        raise ValueError('Release source fingerprint does not match its verified source inventory')
    checksums = ''.join(f"{item['sha256']}  {item['name']}\n" for item in manifest['artifacts'])
    if (release / 'SHA256SUMS').read_text() != checksums:
        raise ValueError('Release checksums do not match its verified manifest')
    return manifest


def extract_starter(release, metadata, destination):
    """Read the actual distributed archive, never current checkout starter code."""
    archive = release / metadata['file']
    prefix = metadata['directory']
    if Path(prefix).name != prefix or prefix in ('.', '..'):
        raise ValueError('Invalid starter archive root')
    destination.mkdir(mode=0o700)
    seen, total = set(), 0
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        if len(members) > 2000:
            raise ValueError('Starter archive exceeds entry limit')
        for member in members:
            relative = Path(member.name)
            if (relative.is_absolute() or any(part in ('.', '..') for part in relative.parts)
                    or not relative.parts or relative.parts[0] != prefix
                    or not (member.isdir() or member.isfile())):
                raise ValueError('Unsupported starter archive member')
            identity = str(relative).casefold()
            if identity in seen:
                raise ValueError('Duplicate starter archive member')
            seen.add(identity)
            if member.isfile():
                if member.size > 1048576:
                    raise ValueError('Starter archive member too large')
                total += member.size
            if total > 16 * 1048576:
                raise ValueError('Starter archive exceeds byte limit')
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'wb') as output, source.extractfile(member) as content:
                    shutil.copyfileobj(content, output)
    return destination / prefix


def qualify(release, pg_bin):
    manifest = verify_release(release)
    service_binary = ROOT / 'target/debug/acclimate-service'
    service_digest = hashlib.sha256(service_binary.read_bytes()).hexdigest()
    h = Harness(pg_bin)
    try:
        h.start()
        payload = json.loads((FIXTURE / 'baseline.json').read_text())
        setup = h.call('POST', f'/v1/workspaces/{h.project}/bundle-setups', {
            'name': 'Installed evaluator qualification', 'origin': 'example',
            'sourceLabel': 'Installed application fixture', 'channel': 'stable',
            'payload': payload, 'reason': 'Seed the delivery fixture',
        })
        bundle = setup['bundle']['id']
        env = {key: value for key, value in os.environ.items()
               if key not in ('PYTHONPATH', 'PYTHONHOME', 'DATABASE_URL', 'NODE_OPTIONS')
               and not key.startswith(('ACCLIMATE_', 'CONSOLE_'))}
        artifacts = [release / item['name'] for item in manifest['artifacts']]
        sdk = next(path for path in artifacts if path.name.startswith('acclimate-sdk-') and path.suffix == '.tgz')
        wheel = next(path for path in artifacts if path.suffix == '.whl')
        checks = []
        for language, name in [('javascript', 'evaluation'), ('python', 'python-evaluation')]:
            starter = next(item for item in manifest['starters'] if item['name'] == name)
            app = extract_starter(release, starter, h.dir / name)
            if language == 'javascript':
                subprocess.run(['npm', 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', str(sdk)],
                               cwd=app, check=True, env=env)
                command = ['node', 'acclimate-eval.mjs']
            else:
                venv.EnvBuilder(with_pip=True).create(h.dir / 'venv')
                python = str(h.dir / 'venv/bin/python')
                subprocess.run([python, '-m', 'pip', 'install', '--no-index', '--no-deps', str(wheel)],
                               cwd=app, check=True, env=env)
                command = [python, 'acclimate_eval.py']
            cases = install_test_application(app, language)
            app_env = dict(env, ACCLIMATE_EVALUATOR_CASES=cases)
            journal = h.dir / (name + '-journal')
            journal.mkdir(mode=0o700)
            config = app / 'evaluator.json'
            private_json(config, {'schemaVersion': 1, 'serviceUrl': h.base, 'workspaceId': h.project,
                                  'evaluatorPrincipalId': 'operator', 'evaluatorToken': h.tokens['operator'],
                                  'journalRoot': str(journal)})
            target = ['--config', str(config), '--bundle', bundle]
            descriptor = run(command + ['describe'], cwd=app, env=app_env)
            assert descriptor['expectedCases']
            doctor = run(command + ['doctor', *target], cwd=app, env=app_env)
            assert doctor['status'] == 'ready'
            out = app / 'released.json'
            run(command + ['pull', *target, '--out', str(out)], cwd=app, env=app_env)
            assert json.loads(out.read_text()) == payload
            result = run(command + ['try', '--live', '--payload', str(out), '--json'], cwd=app, env=app_env)
            assert result['ok']
            checks.append({'language': language, 'commands': ['describe', 'doctor', 'pull', 'try']})
        if hashlib.sha256(service_binary.read_bytes()).hexdigest() != service_digest:
            raise ValueError('Service binary changed during qualification')
        return {'schemaVersion': 1, 'kind': 'acclimate-installed-dx-qualification',
                'version': manifest['version'], 'checks': checks, 'serviceBinary': {'sha256': service_digest}}
    finally:
        h.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin', required=True)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--output', type=Path)
    arguments = parser.parse_args()
    report = qualify(arguments.release.resolve(), arguments.pg_bin)
    if arguments.output:
        private_json(arguments.output.resolve(), report)
    print(json.dumps(report, separators=(',', ':')))
