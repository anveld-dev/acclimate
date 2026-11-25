"""Static production manifest contracts; never starts Docker or accesses private config."""
import importlib.util
import json
import os
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
    def resolve(self, directory, missing=None, **overrides):
        # The file names deploy/init.sh writes. The executor credential is empty until learning is set up.
        for filename in ('service.env','console.env','postgres-password','empty.env','executor-token'):
            container.private_write(directory/filename, '')
        environment = dict(PATH=os.environ['PATH'], ACCLIMATE_CONFIG_DIR=str(directory),
            COMPOSE_PROFILES='learning',
            CONSOLE_HOST='console.fixture.invalid', API_HOST='api.fixture.invalid', ACME_EMAIL='fixture@example.invalid')
        environment.update(overrides)
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
        self.assertEqual(set(services), {'postgres','service','console','proxy','acclimate-executor','acclimate-runner'})
        self.assertEqual(services['postgres']['image'],'postgres:16-alpine')
        self.assertIn('postgres-data', config['volumes'])
        # The runner service only builds the sandbox image; it exits at once and has no network.
        runner = services.pop('acclimate-runner')
        self.assertEqual(runner['network_mode'],'none')
        self.assertFalse(runner.get('ports'))
        for name, service in services.items():
            self.assertEqual(service['restart'],'unless-stopped')
            self.assertIn('healthcheck', service)
            if name != 'acclimate-executor':
                self.assertEqual(service['stop_grace_period'],'1m30s')
            if name != 'proxy': self.assertFalse(service.get('ports'))
        # Every container rotates its own logs, so the host needs no Docker daemon setting.
        for name, service in config['services'].items():
            self.assertEqual(service['logging'], dict(driver='json-file', options={'max-size': '10m', 'max-file': '5'}), name)
        # The executor drains leased rollouts, and reports health from its own service contact.
        self.assertEqual(services['acclimate-executor']['stop_grace_period'],'1h0m0s')
        self.assertEqual(services['acclimate-executor']['healthcheck']['test'],
                         ['CMD','acclimate-executor','--health'])
        self.assertEqual({port['target'] for port in services['proxy']['ports']}, {80,443})
        self.assertEqual(services['service']['build']['dockerfile'],'deploy/Dockerfile')
        self.assertEqual(services['console']['build']['dockerfile'],'deploy/console.Dockerfile')
        self.assertEqual(services['service']['image'],'ghcr.io/anveld-dev/acclimate-service:local')
        self.assertEqual(services['console']['image'],'ghcr.io/anveld-dev/acclimate-console:local')
        self.assertEqual(services['postgres']['environment']['POSTGRES_PASSWORD_FILE'],'/run/secrets/postgres_password')
        self.assertNotIn('POSTGRES_PASSWORD',services['postgres']['environment'])
        self.assertIn('/ready', ' '.join(services['service']['healthcheck']['test']))
        # The executor credential lives where the operator says, never in the checkout.
        self.assertNotIn(str(ROOT), config['secrets']['executor_token']['file'])

    def test_executor_listener_uses_only_the_executor_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            production = self.resolve(Path(temporary))
            local = json.loads(subprocess.check_output([
                'docker', 'compose', '--env-file', os.devnull, '-f', str(ROOT/'compose.local.yaml'),
                'config', '--no-env-resolution', '--format', 'json',
            ]))
        for config, owner in ((production, 'service'), (local, 'proxy')):
            services = config['services']
            hostname, port = services['service']['environment']['ACCLIMATE_INTERNAL_BIND'].split(':')
            self.assertIn(hostname, services[owner]['networks']['executor']['aliases'])
            self.assertEqual({name for name, s in services.items() if 'executor' in s.get('networks', {})},
                             {owner, 'acclimate-executor'})
            self.assertTrue(config['networks']['executor']['internal'])
            worker = services['acclimate-executor']
            self.assertEqual(worker['environment']['ACCLIMATE_EXECUTOR_SERVICE'], f'http://{owner}:{port}')
            for service in services.values():
                self.assertNotIn(int(port), [p['target'] for p in service.get('ports', [])])
        self.assertEqual(local['services']['service']['network_mode'], 'service:proxy')

    def test_learning_containers_start_only_with_the_learning_profile(self):
        with tempfile.TemporaryDirectory() as temporary:
            services = self.resolve(Path(temporary), COMPOSE_PROFILES='')['services']
        self.assertEqual(set(services), {'postgres','service','console','proxy'})
        compose = (ROOT/'compose.yaml').read_text()
        self.assertEqual(compose.count('profiles: [learning]'), 2)

    def test_manifest_missing_config_is_error_without_reading_dotenv(self):
        # Compose may validate services in any order. Remove one required input
        # at a time so a public-hostname error cannot mask the config-file gate.
        for missing in ('ACCLIMATE_CONFIG_DIR', 'CONSOLE_HOST', 'API_HOST', 'ACME_EMAIL'):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises(subprocess.CalledProcessError) as failure:
                    self.resolve(Path(temporary), missing=missing)
                self.assertIn(missing.encode(), failure.exception.stderr)

    def test_each_private_file_can_be_named_on_its_own(self):
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as elsewhere:
            files = {variable: Path(elsewhere)/name for variable, name in (
                ('ACCLIMATE_SERVICE_ENV', 'a.env'), ('ACCLIMATE_CONSOLE_ENV', 'b.env'),
                ('ACCLIMATE_POSTGRES_PASSWORD_FILE', 'c'), ('ACCLIMATE_EXECUTOR_TOKEN_FILE', 'd'))}
            for path in files.values():
                container.private_write(path, 'FILE_MARKER=' + path.name + '\n')
            config = self.resolve(Path(temporary), **{name: str(path) for name, path in files.items()})
        self.assertEqual(config['secrets']['postgres_password']['file'], str(files['ACCLIMATE_POSTGRES_PASSWORD_FILE']))
        self.assertEqual(config['secrets']['executor_token']['file'], str(files['ACCLIMATE_EXECUTOR_TOKEN_FILE']))
        self.assertEqual(config['services']['service']['environment']['FILE_MARKER'], 'a.env')
        self.assertEqual(config['services']['console']['environment']['FILE_MARKER'], 'b.env')

    def test_manifest_supports_a_shared_release_version_and_individual_image_overrides(self):
        published = 'ghcr.io/anveld-dev/acclimate-{}:{}'
        for overrides, expected in (
            ({}, {name: published.format(name, 'local')
                  for name in ('service', 'console', 'executor', 'runner')}),
            ({'ACCLIMATE_VERSION': '0.1.0'}, {name: published.format(name, '0.1.0')
                                              for name in ('service', 'console', 'executor', 'runner')}),
            ({'ACCLIMATE_VERSION': '0.1.0', 'ACCLIMATE_SERVICE_IMAGE': 'local/acclimate-service:test',
              'ACCLIMATE_CONSOLE_IMAGE': 'local/acclimate-console:test',
              'ACCLIMATE_EXECUTOR_IMAGE': 'local/acclimate-executor:test',
              'ACCLIMATE_RUNNER_IMAGE': 'local/acclimate-runner:test'},
             {name: f'local/acclimate-{name}:test' for name in ('service', 'console', 'executor', 'runner')}),
        ):
            with self.subTest(overrides=overrides), tempfile.TemporaryDirectory() as temporary:
                services = self.resolve(Path(temporary), **overrides)['services']
                self.assertEqual(services['service']['image'], expected['service'])
                self.assertEqual(services['console']['image'], expected['console'])
                self.assertEqual(services['acclimate-executor']['image'], expected['executor'])
                self.assertEqual(services['acclimate-runner']['image'], expected['runner'])
                # The executor inspects the runner by the name the runner service is pulled or built as.
                self.assertEqual(services['acclimate-executor']['environment']['ACCLIMATE_RUNNER_IMAGE'],
                                 expected['runner'])
                # A checkout can still build every application image.
                self.assertEqual(services['acclimate-executor']['build']['dockerfile'], 'executor/Dockerfile')
                self.assertEqual(Path(services['acclimate-runner']['build']['context']), ROOT/'executor/runner')

    def test_release_publishes_every_compose_application_image(self):
        workflow = (ROOT/'.github/workflows/release.yaml').read_text()
        # Each image has a build entry naming its Dockerfile.
        for name, dockerfile in (('acclimate-service', 'deploy/Dockerfile'),
                                 ('acclimate-console', 'deploy/console.Dockerfile'),
                                 ('acclimate-executor', 'executor/Dockerfile'),
                                 ('acclimate-runner', 'executor/runner/Dockerfile')):
            self.assertRegex(workflow, rf'- image: {name}\n +context: \S+\n +dockerfile: {dockerfile}\n')
        self.assertEqual(workflow.count(
            'image: [acclimate-service, acclimate-console, acclimate-executor, acclimate-runner]'), 2)

    def test_qualification_uses_project_local_builds_and_private_ports(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)
            canonical=self.resolve(directory, COMPOSE_PROFILES='')
            fixture=SimpleNamespace(cert_path=directory/'cert',key_path=directory/'key',ca_path=directory/'cert')
            result=container.full_stack_definition(canonical,directory,14567,fixture)
        self.assertEqual(result['services']['proxy']['ports'][0]['published'],'14567')
        self.assertEqual(result['services']['console']['environment']['NODE_EXTRA_CA_CERTS'],'/run/fixture/issuer.crt')
        for name in ('service','console'):
            self.assertIn('build',result['services'][name])
            self.assertNotIn('image',result['services'][name])
            self.assertFalse(result['services'][name].get('ports'))
        result['services']['service']['ports']=[dict(target=3000,published='3000')]
        with self.assertRaises(ValueError):
            container.full_stack_definition(result,Path('/unused'),14567,fixture)

    def test_qualification_runs_the_operate_pages_commands(self):
        # The container check runs these blocks verbatim, so a page edit must change both.
        # A block inside a list item is indented on the page.
        for name, (page, block) in container.DOCUMENTED.items():
            with self.subTest(name=name):
                text = '\n'.join(line.lstrip() for line in (container.OPERATE/page).read_text().splitlines())
                self.assertIn('```sh\n' + block + '\n```', text)

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
                    matches = list(ROOT.glob(pattern))
                    self.assertTrue(matches, "Missing console builder COPY source: " + pattern)
                    sources.extend(matches)
        def copied(path):
            return any(path==source or source.is_dir() and source in path.parents for source in sources)
        pending=list((ROOT/'packages').glob('*/src/**/*.ts'))+list((ROOT/'apps/console/src').rglob('*.ts'))+list((ROOT/'apps/console/src').rglob('*.tsx'))+[ROOT/'apps/console/vite.config.ts', ROOT/'scripts/build-packages.mjs', ROOT/'python/pyproject.toml']
        # The console renders application import examples inside template literals.
        # Ask TypeScript which imports belong to the builder itself.
        parse_imports = """
            const ts = require('typescript');
            const fs = require('node:fs');
            const input = require('node:readline').createInterface({input: process.stdin});
            input.on('line', line => {
                const source = fs.readFileSync(JSON.parse(line), 'utf8');
                const imports = ts.preProcessFile(source, true, true).importedFiles;
                console.log(JSON.stringify(imports.map(entry => entry.fileName)));
            });
        """
        with subprocess.Popen(['node', '-e', parse_imports], cwd=ROOT,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as scanner:
            try:
                visited=set()
                while pending:
                    source=pending.pop().resolve()
                    if source in visited or source.name=='routeTree.gen.ts': continue
                    visited.add(source)
                    self.assertTrue(copied(source), 'Builder does not COPY '+str(source.relative_to(ROOT)))
                    if source.suffix not in ('.ts','.tsx','.js','.mjs'): continue
                    scanner.stdin.write(json.dumps(str(source)) + '\n')
                    scanner.stdin.flush()
                    for name in json.loads(scanner.stdout.readline()):
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
            finally:
                scanner.stdin.close()
        # The context's positive allowlist must admit the new cross-root files;
        # its final secret exclusions still apply independently.
        ignore=(ROOT/'.dockerignore').read_text().splitlines()
        for name in ('scripts/', 'scripts/build-packages.mjs', 'scripts/packaging/',
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
