"""Static production manifest contracts; never starts Docker or accesses private config."""
import importlib.util
import json
import os
import re
import shlex
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('container_check', Path(__file__).with_name('container_check.py'))
container = importlib.util.module_from_spec(spec)
spec.loader.exec_module(container)


class DeploymentTests(unittest.TestCase):
    def resolve(self, directory, missing=None):
        for filename in ('service.env','console.env','password','empty.env'):
            container.private_write(directory/filename, '')
        environment = dict(PATH=os.environ['PATH'],
            ACCLIMATE_SERVICE_ENV=str(directory/'service.env'),
            ACCLIMATE_CONSOLE_ENV=str(directory/'console.env'),
            ACCLIMATE_POSTGRES_PASSWORD_FILE=str(directory/'password'),
            CONSOLE_HOST='console.fixture.invalid', API_HOST='api.fixture.invalid', ACME_EMAIL='fixture@example.invalid')
        if missing:
            environment.pop(missing)
        result = subprocess.run(['docker','compose','--env-file',str(directory/'empty.env'),
            '-p','acclimate-manifest-test','-f',str(ROOT/'compose.yaml'),'config','--format','json'],
            env=environment, check=True, capture_output=True, timeout=15)
        return json.loads(result.stdout)

    def test_manifest_full_stack_has_only_proxy_public_ports_and_required_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = self.resolve(Path(temporary))
        services = config['services']
        self.assertEqual(set(services), {'postgres','service','console','proxy'})
        self.assertEqual(services['postgres']['image'],'postgres:16-alpine')
        self.assertIn('postgres-data', config['volumes'])
        for name, service in services.items():
            self.assertEqual(service['restart'],'unless-stopped')
            self.assertEqual(service['stop_grace_period'],'1m30s')
            self.assertIn('healthcheck', service)
            if name != 'proxy': self.assertFalse(service.get('ports'))
        self.assertEqual({port['target'] for port in services['proxy']['ports']}, {80,443})
        self.assertEqual(services['service']['build']['dockerfile'],'deploy/Dockerfile')
        self.assertEqual(services['console']['build']['dockerfile'],'deploy/console.Dockerfile')
        self.assertEqual(services['postgres']['environment']['POSTGRES_PASSWORD_FILE'],'/run/secrets/postgres_password')
        self.assertNotIn('POSTGRES_PASSWORD',services['postgres']['environment'])
        self.assertIn('/ready', ' '.join(services['service']['healthcheck']['test']))

    def test_manifest_missing_config_is_error_without_reading_dotenv(self):
        # Compose may validate services in any order. Remove one required input
        # at a time so a public-hostname error cannot mask the config-file gate.
        for missing in ('ACCLIMATE_SERVICE_ENV', 'ACCLIMATE_CONSOLE_ENV',
                        'ACCLIMATE_POSTGRES_PASSWORD_FILE'):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises(subprocess.CalledProcessError) as failure:
                    self.resolve(Path(temporary), missing=missing)
                self.assertIn(missing.encode(), failure.exception.stderr)

    def test_qualification_retains_canonical_artifacts_and_private_ports(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)
            canonical=self.resolve(directory)
            fixture=SimpleNamespace(cert_path=directory/'cert',key_path=directory/'key',ca_path=directory/'cert')
            result=container.full_stack_definition(canonical,directory,14567,fixture)
        self.assertEqual(result['services']['proxy']['ports'][0]['published'],'14567')
        self.assertEqual(result['services']['console']['environment']['NODE_EXTRA_CA_CERTS'],'/run/fixture/issuer.crt')
        for name in ('service','console'):
            self.assertIn('build',result['services'][name])
            self.assertFalse(result['services'][name].get('ports'))
        result['services']['service']['ports']=[dict(target=3000,published='3000')]
        with self.assertRaises(ValueError):
            container.full_stack_definition(result,Path('/unused'),14567,fixture)

    def test_qualification_never_starts_daemon_when_unavailable(self):
        with patch.object(container.subprocess,'run',side_effect=subprocess.CalledProcessError(1,['docker','info'])) as run:
            with self.assertRaises(subprocess.CalledProcessError): container.qualify()
        self.assertEqual(run.call_count,1)
        self.assertEqual(run.call_args.args[0][:2],['docker','info'])

    def test_console_builder_copies_the_recursive_local_source_dependencies(self):
        # Follow source imports across package boundaries. Bare installed packages
        # are supplied by npm ci; routeTree.gen is regenerated by the Vite compiler.
        dockerfile=(ROOT/'deploy/console.Dockerfile').read_text()
        sources=[]
        stage=0
        for line in dockerfile.splitlines():
            if line.startswith('FROM '): stage+=1
            if stage==1 and line.startswith('COPY '):
                for pattern in shlex.split(line)[1:-1]:
                    sources.extend(ROOT.glob(pattern))
        def copied(path):
            return any(path==source or source.is_dir() and source in path.parents for source in sources)
        pending=list((ROOT/'packages').glob('*/src/**/*.ts'))+list((ROOT/'apps/console/src').rglob('*.ts'))+list((ROOT/'apps/console/src').rglob('*.tsx'))+[ROOT/'apps/console/vite.config.ts', ROOT/'scripts/build-packages.mjs', ROOT/'python/pyproject.toml']
        visited=set()
        while pending:
            source=pending.pop().resolve()
            if source in visited or source.name=='routeTree.gen.ts': continue
            visited.add(source)
            self.assertTrue(copied(source), 'Builder does not COPY '+str(source.relative_to(ROOT)))
            if source.suffix not in ('.ts','.tsx','.js','.mjs'): continue
            text=source.read_text()
            for name in re.findall(r"(?:from\s*|import\s*\()\s*['\"]([^'\"]+)['\"]",text):
                name=name.split('?',1)[0]
                if name.startswith('.'):
                    target=source.parent/name
                elif name.startswith('@/'):
                    target=ROOT/'apps/console/src'/name[2:]
                elif name=='@acclimate/sdk' or name.startswith('@acclimate/sdk/'):
                    target=ROOT/'packages/sdk/src'/('index' if name=='@acclimate/sdk' else name[len('@acclimate/sdk/'):])
                else: continue
                candidates=[target]
                if target.suffix in ('.js','.mjs'): candidates.extend([target.with_suffix('.ts'),target.with_suffix('.tsx')])
                else: candidates.extend([Path(str(target)+'.ts'),Path(str(target)+'.tsx'),target/'index.ts'])
                target=next((candidate.resolve() for candidate in candidates if candidate.is_file()),None)
                self.assertIsNotNone(target, 'Unresolved local builder import from '+str(source.relative_to(ROOT))+': '+name)
                pending.append(target)
        # The context's positive allowlist must admit the new cross-root files;
        # its final secret exclusions still apply independently.
        ignore=(ROOT/'.dockerignore').read_text().splitlines()
        for name in ('examples/','examples/evaluation/','examples/evaluation/descriptor.ts','examples/evaluation/adapter.ts',
                     'scripts/', 'scripts/build-packages.mjs', 'scripts/packaging/',
                     'scripts/packaging/release-metadata.mjs', 'scripts/packaging/release-metadata.json',
                     'scripts/packaging/build-receipt.mjs', 'python/', 'python/pyproject.toml'):
            self.assertIn('!'+name,ignore)

    def test_context_excludes_credentials_and_images_do_not_embed_runtime_config(self):
        ignore=(ROOT/'.dockerignore').read_text()
        for pattern in ('**/.env','**/.env.*','**/*.env','**/.local','**/*.key'):
            self.assertIn(pattern,ignore)
        for filename in ('Dockerfile','console.Dockerfile'):
            source=(ROOT/'deploy'/filename).read_text()
            self.assertNotIn('LOGIN_TOKEN',source)
            self.assertNotIn('CLIENT_SECRET',source)
        self.assertIn('COPY --from=build', (ROOT/'deploy/console.Dockerfile').read_text())


if __name__=='__main__': unittest.main()
