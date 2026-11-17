"""Private, installed-consumer fixtures for developer persona acceptance.

Only the service harness is imported from the checkout. Consumer SDKs and starters
come from the checksummed release. This does not attest a binary-to-source build.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import tarfile
import zipfile
from urllib.parse import unquote, urlsplit

from scripts.packaging.qualify_dx import extract_starter, private_json, run as installed_run, verify_release
from scripts.productization.qualify import Harness, ROOT

DEFAULT_RELEASE = Path('/private/tmp/acclimate-dx-release-20261117-review-1')
DEFAULT_PG_BIN = '/opt/homebrew/opt/postgresql@16/bin'
SOURCE_FINGERPRINT = '15feab4b46cd8c4d52592fc318cd171a267daa1ec562d4447ae261a16db03f6b'


def _name(value: str) -> str:
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}', value) or value in ('.', '..'):
        raise ValueError('Fixture names must be short simple path components')
    return value


def _clean_environment():
    return {key: value for key, value in os.environ.items()
            if key not in ('PYTHONPATH', 'PYTHONHOME', 'NODE_OPTIONS', 'DATABASE_URL',
                           'EVALUATION_TEST_DATABASE_URL', 'ACCLIMATE_TEST_DATABASE_URL',
                           'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
                           'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGOPTIONS')
            and not key.startswith(('ACCLIMATE_', 'CONSOLE_', 'PG'))}


class PersonaFixture:
    def __init__(self, name: str, output: Path, release: Path | None = None,
                 pg_bin: str = DEFAULT_PG_BIN, *, source_sha256: str | None = None):
        # Select acceptance inputs before stripping ambient application settings.
        release = release if release is not None else os.environ.get('ACCLIMATE_PERSONA_RELEASE', DEFAULT_RELEASE)
        self.expected_source_sha256 = source_sha256 if source_sha256 is not None else os.environ.get('ACCLIMATE_PERSONA_SOURCE_SHA256', SOURCE_FINGERPRINT)
        if not re.fullmatch(r'[0-9a-f]{64}', self.expected_source_sha256):
            raise ValueError('Expected acceptance source fingerprint must be a lowercase SHA256')
        self.name = _name(name)
        self.output = Path(output).resolve()
        self.output.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root = Path(tempfile.mkdtemp(prefix=self.name + '-', dir=self.output)).resolve()
        self.root.chmod(0o700)
        if self.root.is_relative_to(ROOT.resolve()):
            # Retained evidence may be in the repository, but npm consumers must
            # live physically outside it to rule out workspace/parent fallback.
            self.consumer_root = Path(tempfile.mkdtemp(prefix=self.name + '-consumer-')).resolve()
            self.consumer_root.chmod(0o700)
        else:
            self.consumer_root = self.root
        (self.root / 'private').mkdir(mode=0o700)
        self.release = Path(release).resolve()
        self.manifest = verify_release(self.release)
        if self.manifest['source']['sha256'] != self.expected_source_sha256:
            raise ValueError('Unexpected acceptance release source inventory')
        self.release_manifest_sha256 = hashlib.sha256((self.release / 'manifest.json').read_bytes()).hexdigest()
        self.release_checksums_sha256 = hashlib.sha256((self.release / 'SHA256SUMS').read_bytes()).hexdigest()
        self.clean_env = _clean_environment()
        # Explicitly pass these only to an authorized live Codex SDK consumer.
        # The service and ordinary consumer subprocesses receive no ambient keys.
        self.sdk_env = {key: value for key, value in os.environ.items()
                        if key in ('CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_HOME',
                                   'HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG',
                                   'LC_ALL', 'LC_CTYPE', 'SHELL')}
        self.clean_env = {key: value for key, value in self.clean_env.items()
                          if not key.endswith(('_API_KEY', '_TOKEN', '_SECRET', '_PASSWORD'))
                          and key not in ('CODEX_HOME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS')}
        self.service_binary = ROOT / 'target/debug/acclimate-service'
        if self.service_binary.is_symlink() or not self.service_binary.is_file():
            raise ValueError('Service binary must be an existing regular file')
        self.service_sha256 = hashlib.sha256(self.service_binary.read_bytes()).hexdigest()
        self.h = Harness(pg_bin)
        # Retain only environment settings made by the harness itself.
        self.h.env = {key: value for key, value in self.h.env.items()
                      if key in self.clean_env or key.startswith(('ACCLIMATE_', 'CONSOLE_')) or key == 'DATABASE_URL'}
        self.h.tokens['viewer'] = secrets.token_hex(32)
        grants = json.loads(self.h.env['ACCLIMATE_AUTH'])
        grants.append(dict(token=self.h.tokens['viewer'], principalId='viewer',
                           projectId=self.h.project, rights=['read']))
        self.h.env['ACCLIMATE_AUTH'] = json.dumps(grants)
        self.project, self.base_url = self.h.project, self.h.base
        self.evaluator_config = self.root / 'private/config/evaluator.json'
        self.reader_config = self.root / 'private/config/reader.json'
        self._log_sequence = 0
        self.installation_proofs = {}
        self._closed = False
        self._entered = False

    def __enter__(self):
        try:
            self.verify_release_unchanged()
            if hashlib.sha256(self.service_binary.read_bytes()).hexdigest() != self.service_sha256:
                raise RuntimeError('Service binary changed before fixture startup')
            self.h.start()
            self._entered = True
            self.write_json(self.evaluator_config, dict(
                schemaVersion=1, serviceUrl=self.base_url, projectId=self.project,
                evaluatorPrincipalId='evaluator', evaluatorToken=self.h.tokens['evaluator'],
                journalRoot=str(self.root / 'private/journals')))
            self.write_json(self.reader_config, dict(
                schemaVersion=1, serviceUrl=self.base_url, projectId=self.project,
                readToken=self.h.tokens['viewer']))
            self.write_json(self.root / 'private/fixture.json', dict(
                schemaVersion=1, name=self.name, serviceBinarySha256=self.service_sha256,
                releaseSourceInventorySha256=self.manifest['source']['sha256'],
                releaseManifestSha256=self.release_manifest_sha256,
                releaseChecksumsSha256=self.release_checksums_sha256,
                consumerDirectory=str(self.consumer_root),
                binarySourceBuildAttested=False, baseUrl=self.base_url,
                project=self.project, databaseDirectory=str(self.h.dir)))
            return self
        except BaseException:
            self.close()
            raise

    def __exit__(self, *_):
        self.close()

    def close(self):
        if self._closed:
            return
        self._closed = True
        database_dir = self.h.dir
        service_pid = self.h.service.pid if self.h.service is not None else None
        try:
            # The harness deletes its private database and service logs. Retain
            # service output privately in the owned consumer work directory.
            self.h.stop_service()
            self.h.log.flush()
            source = self.h.dir / 'service.log'
            if source.exists():
                target = self.root / 'private/service.log'
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copyfile(source, target)
                target.chmod(0o600)
        finally:
            self.h.close()
        self.write_json(self.root / 'private/cleanup.json', dict(
            schemaVersion=1, databaseDirectoryRemoved=not database_dir.exists(),
            serviceStopped=self.h.service is None, servicePid=service_pid,
            consumerOutputsRetained=self.root.exists()))

    def write_json(self, path: Path, value):
        path = Path(path)
        if not path.is_absolute():
            path = self.root / path
        if not any(path.resolve().is_relative_to(root) for root in (self.root, self.consumer_root)):
            raise ValueError('Private fixture JSON must remain inside its work directory')
        self._private_directory(path.parent)
        private_json(path, value)
        return path

    def _private_directory(self, directory):
        anchor = next((root for root in (self.root, self.consumer_root) if directory.is_relative_to(root)), None)
        if anchor is None:
            raise ValueError('Fixture directories must remain inside owned private roots')
        relative = directory.relative_to(anchor)
        current = anchor
        for part in relative.parts:
            current = current / part
            if not current.exists():
                current.mkdir(mode=0o700)
            elif current.is_symlink() or not current.is_dir():
                raise ValueError('Fixture private directory is not an owned directory')

    def bootstrap(self, payload=None, name='Disposable developer persona fixture'):
        if payload is None:
            baseline = self.root / 'baseline-starter'
            if not baseline.exists():
                app = extract_starter(self.release, self._starter('evaluation'), baseline)
            else:
                app = baseline / self._starter('evaluation')['directory']
            payload = json.loads((app / 'baseline.json').read_text())
        return self.h.call('POST', '/v1/projects/' + self.project + '/bundle-setups', dict(
            name=name, origin='example', sourceLabel='Disposable model-free persona acceptance',
            channel='stable', payload=payload, reason='Explicit disposable seed fixture'))

    def _starter(self, name):
        return next(item for item in self.manifest['starters'] if item['name'] == name)

    def _package(self, package):
        return self.release / next(item['file'] for item in self.manifest['packages']
                                   if item['package'] == package)

    def verify_release_unchanged(self):
        current = verify_release(self.release)
        if (current != self.manifest
                or hashlib.sha256((self.release / 'manifest.json').read_bytes()).hexdigest() != self.release_manifest_sha256
                or hashlib.sha256((self.release / 'SHA256SUMS').read_bytes()).hexdigest() != self.release_checksums_sha256):
            raise AssertionError('Acceptance release changed during fixture execution')
        return current

    def _install(self, command, cwd):
        # Installers print prose, unlike JSON consumer CLIs; preserve it privately.
        self.verify_release_unchanged()
        if command[0] == 'npm':
            app = Path(cwd).resolve()
            if app.is_relative_to(ROOT.resolve()) or not (app / 'package.json').is_file():
                raise ValueError('npm consumers require an external physical app with its own manifest')
            if '--prefix' not in command or Path(command[command.index('--prefix') + 1]).resolve() != app:
                raise ValueError('npm installation must explicitly target its consumer app')
            command = [*command, '--workspaces=false']
        return self._execute(command, cwd, 0, parse_json=False)

    def install_js(self, name='app', starter='evaluation', plugin=None):
        self.verify_release_unchanged()
        app = extract_starter(self.release, self._starter(starter), self.consumer_root / _name(name))
        if not (app / 'package.json').exists():
            self.write_json(app / 'package.json', dict(private=True, type='module'))
        packages = [self._package('@acclimate/sdk')]
        if plugin:
            package = plugin if plugin.startswith('@acclimate/') else '@acclimate/' + plugin.removesuffix('-plugin') + '-plugin'
            packages.append(self._package(package))
        self._install(['npm', '--prefix', str(app), 'install', '--offline', '--ignore-scripts',
                       '--no-audit', '--no-fund', *map(str, packages)], app)
        resolved = self.run(['node', '--input-type=module', '-e',
                             'console.log(JSON.stringify({resolved:import.meta.resolve("@acclimate/sdk")}))'], cwd=app)
        parsed = urlsplit(resolved['resolved'])
        entry = Path(unquote(parsed.path)).resolve()
        sdk_root = (app / 'node_modules/@acclimate/sdk').resolve()
        if parsed.scheme != 'file' or not sdk_root.is_relative_to(app) or not entry.is_relative_to(sdk_root):
            raise AssertionError('Installed SDK resolution escaped the consumer package boundary')
        proof = dict(resolvedWithinConsumer=True, packages=[self._verify_npm_package(app, package) for package in packages])
        self.installation_proofs[name] = proof
        self.write_json(self.root / 'private/installations' / (name + '.json'), proof)
        return app

    def _verify_npm_package(self, app, archive):
        self.verify_release_unchanged()
        with tarfile.open(archive, 'r:gz') as source:
            metadata = json.load(source.extractfile('package/package.json'))
            package_root = app / 'node_modules' / metadata['name']
            if package_root.is_symlink() or not package_root.resolve().is_relative_to(app):
                raise AssertionError('Installed package escaped the consumer package boundary')
            verified = []
            for member in source.getmembers():
                relative = Path(member.name)
                if relative.is_absolute() or '..' in relative.parts or relative.parts[0] != 'package':
                    raise ValueError('Invalid npm package archive member')
                if member.isdir():
                    continue
                if not member.isfile():
                    raise ValueError('Unsupported npm package archive member')
                target = package_root.joinpath(*relative.parts[1:])
                if target.is_symlink() or not target.resolve().is_relative_to(package_root.resolve()):
                    raise AssertionError('Installed package file escaped the consumer package boundary')
                expected = hashlib.sha256(source.extractfile(member).read()).hexdigest()
                if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != expected:
                    raise AssertionError('Installed package bytes differ from verified release archive')
                verified.append((str(relative), expected))
            expected_files = {str(Path(name).relative_to('package')) for name, _ in verified}
            actual_files = {str(path.relative_to(package_root)) for path in package_root.rglob('*')
                            if path.is_file() or path.is_symlink()}
            if actual_files != expected_files:
                raise AssertionError('Installed package has unexpected or missing files')
        return dict(package=metadata['name'], releaseArchiveSha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
                    verifiedFiles=len(verified), contentSha256=hashlib.sha256(json.dumps(sorted(verified), separators=(',', ':')).encode()).hexdigest())

    def install_python(self, name='app', starter='evaluation'):
        self.verify_release_unchanged()
        directory = self.consumer_root / _name(name)
        app = extract_starter(self.release, self._starter(starter), directory)
        environment = directory / 'venv'
        # The running acceptance interpreter must be Python >=3.11.
        if sys.version_info < (3, 11):
            raise RuntimeError('Persona acceptance requires Python >=3.11')
        self._install([sys.executable, '-m', 'venv', str(environment)], app)
        python = environment / 'bin/python'
        self._install([str(python), '-m', 'pip', 'install', '--no-index', '--no-deps',
                       str(self._package('acclimate-sdk'))], app)
        proof = self._verify_python_package(python, app, self._package('acclimate-sdk'))
        self.installation_proofs[name] = proof
        self.write_json(self.root / 'private/installations' / (name + '.json'), proof)
        return app, python

    def _verify_python_package(self, python, app, archive):
        self.verify_release_unchanged()
        layout = self.run([str(python), '-I', '-c',
                           'import acclimate,json,sysconfig;print(json.dumps(dict(origin=acclimate.__file__,site=sysconfig.get_path("purelib"))))'], app)
        site = Path(layout['site']).resolve()
        package_root = site / 'acclimate'
        if (not site.is_relative_to(self.consumer_root) or package_root.is_symlink()
                or not Path(layout['origin']).resolve().is_relative_to(package_root)):
            raise AssertionError('Installed Python SDK escaped the consumer environment')
        verified = []
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                relative = Path(member.filename)
                if relative.is_absolute() or '..' in relative.parts:
                    raise ValueError('Invalid wheel archive member')
                if member.is_dir() or member.filename.endswith('.dist-info/RECORD'):
                    continue  # pip rewrites RECORD with its generated installer files.
                target = site / relative
                expected = hashlib.sha256(source.read(member)).hexdigest()
                if (target.is_symlink() or not target.resolve().is_relative_to(site)
                        or not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != expected):
                    raise AssertionError('Installed Python SDK bytes differ from verified release wheel')
                verified.append((member.filename, expected))
        expected_sdk_files = {name for name, _ in verified if Path(name).parts[0] == 'acclimate'}
        actual_sdk_files = {str(path.relative_to(site)) for path in package_root.rglob('*')
                            if (path.is_file() or path.is_symlink())
                            and '__pycache__' not in path.relative_to(package_root).parts}
        if actual_sdk_files != expected_sdk_files:
            raise AssertionError('Installed Python SDK has unexpected or missing source files')
        return dict(package='acclimate-sdk', resolvedWithinConsumer=True,
                    releaseArchiveSha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
                    verifiedFiles=len(verified), installerRewrittenFiles=['RECORD'],
                    contentSha256=hashlib.sha256(json.dumps(sorted(verified), separators=(',', ':')).encode()).hexdigest())

    def run(self, command, cwd, expected=0):
        return self._execute(command, cwd, expected, parse_json=True)

    def _execute(self, command, cwd, expected, parse_json):
        command = list(map(str, command))
        self._log_sequence += 1
        stem = self.root / 'private/commands' / f'{self._log_sequence:04d}'
        self._private_directory(stem.parent)
        # Reuse qualification execution semantics and safe error parsing while
        # capturing streams before JSON parsing, including failing commands.
        if parse_json:
            wrapper = self.root / 'private/consumer-wrapper.py'
            if not wrapper.exists():
                with os.fdopen(os.open(wrapper, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as script:
                    script.write(_CONSUMER_WRAPPER)
            specification = Path(str(stem) + '.invocation.json')
            self.write_json(specification, dict(command=command, cwd=str(cwd),
                                               stem=str(stem), expected=expected))
            # The shared installed-consumer helper validates exit status and JSON;
            # a tiny child shim preserves the streams it intentionally suppresses.
            return installed_run([sys.executable, str(wrapper), str(specification)],
                                 cwd=cwd, expected=expected, env=self.clean_env)
        result = subprocess.run(command, cwd=cwd, env=self.clean_env, capture_output=True, text=True)
        for suffix, content in (('stdout', result.stdout), ('stderr', result.stderr)):
            with os.fdopen(os.open(str(stem) + '.' + suffix, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as log:
                log.write(content)
        self.write_json(Path(str(stem) + '.json'), dict(
            executable=Path(command[0]).name, argumentCount=len(command) - 1,
            exitCode=result.returncode, expectedExitCode=expected))
        if result.returncode != expected:
            raise AssertionError(f'Installed consumer {Path(command[0]).name} returned {result.returncode}, expected {expected}; inspect private command {self._log_sequence:04d} logs')
        if not parse_json or not result.stdout.strip():
            return None
        return json.loads(result.stdout)


_CONSUMER_WRAPPER = r'''import json, os, subprocess, sys
from pathlib import Path
spec = json.loads(Path(sys.argv[1]).read_text())
result = subprocess.run(spec['command'], cwd=spec['cwd'], capture_output=True, text=True)
for suffix, content in (('stdout', result.stdout), ('stderr', result.stderr)):
    with os.fdopen(os.open(spec['stem'] + '.' + suffix, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as stream:
        stream.write(content)
summary = dict(executable=Path(spec['command'][0]).name, argumentCount=len(spec['command'])-1,
               exitCode=result.returncode, expectedExitCode=spec['expected'])
with os.fdopen(os.open(spec['stem'] + '.json', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as stream:
    json.dump(summary, stream)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
sys.exit(result.returncode)
'''
