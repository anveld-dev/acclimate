"""Opt-in isolated full-stack qualification using the canonical deployment manifest.

Never imported by application runtime. Only external.py --execute --gate container
calls qualify(); source/manifest tests must not claim container execution evidence.
It also runs the documented backup, restore, upgrade and rollback commands verbatim.
"""
import json
import os
from pathlib import Path
import secrets
import ssl
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from testing.identity import IdentityFixture
from testing.production import service_env


OPERATE = ROOT / 'apps/docs/content/docs/operate'
# Shell blocks from the operate pages. qualify() runs each through sh against the
# disposable project, and test_deployment checks that each is still a block on its page.
DOCUMENTED = {
    'backup': ('backup-and-restore.mdx', """umask 077
mkdir -p ~/acclimate-backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T postgres pg_dump -U acclimate -Fc acclimate > ~/acclimate-backups/acclimate-$stamp.dump
docker compose exec -T keycloak-db pg_dump -U keycloak -Fc keycloak > ~/acclimate-backups/keycloak-$stamp.dump"""),
    'restore': ('backup-and-restore.mdx', """docker compose stop proxy console service
docker compose exec -T postgres createdb -U acclimate -T acclimate acclimate_before_restore
docker compose exec -T postgres dropdb -U acclimate acclimate
docker compose exec -T postgres createdb -U acclimate acclimate
docker compose exec -T postgres pg_restore -U acclimate -d acclimate --single-transaction --exit-on-error < ~/acclimate-backups/acclimate-<stamp>.dump
docker compose up -d --wait"""),
    'restore-keycloak': ('backup-and-restore.mdx', """docker compose stop keycloak
docker compose exec -T keycloak-db createdb -U keycloak -T keycloak keycloak_before_restore
docker compose exec -T keycloak-db dropdb -U keycloak keycloak
docker compose exec -T keycloak-db createdb -U keycloak keycloak
docker compose exec -T keycloak-db pg_restore -U keycloak -d keycloak --single-transaction --exit-on-error < ~/acclimate-backups/keycloak-<stamp>.dump
docker compose up -d --wait"""),
    'undo-restore': ('backup-and-restore.mdx', """docker compose stop proxy console service
docker compose exec -T postgres dropdb -U acclimate acclimate
docker compose exec -T postgres createdb -U acclimate -T acclimate_before_restore acclimate
docker compose up -d --wait"""),
    'drop-restore-copies': ('backup-and-restore.mdx', """docker compose exec -T postgres dropdb -U acclimate acclimate_before_restore
docker compose exec -T keycloak-db dropdb -U keycloak keycloak_before_restore"""),
    'reset-provider-keys': ('backup-and-restore.mdx', """docker compose run --rm service --reset-provider-keys --confirm"""),
    'upgrade-stop': ('upgrades-and-recovery.mdx', """docker compose stop proxy console service keycloak
docker compose exec -T postgres createdb -U acclimate -T acclimate acclimate_pre_upgrade
docker compose exec -T keycloak-db createdb -U keycloak -T keycloak keycloak_pre_upgrade"""),
    'start-release': ('upgrades-and-recovery.mdx', """docker compose pull
docker compose up -d --wait"""),
    'start-source': ('upgrades-and-recovery.mdx', """docker compose up -d --build --wait"""),
    'rollback': ('upgrades-and-recovery.mdx', """docker compose stop proxy console service keycloak
docker compose exec -T postgres dropdb -U acclimate acclimate
docker compose exec -T postgres createdb -U acclimate -T acclimate_pre_upgrade acclimate
docker compose exec -T keycloak-db dropdb -U keycloak keycloak
docker compose exec -T keycloak-db createdb -U keycloak -T keycloak_pre_upgrade keycloak"""),
    'drop-upgrade-copies': ('upgrades-and-recovery.mdx', """docker compose exec -T postgres dropdb -U acclimate acclimate_pre_upgrade
docker compose exec -T keycloak-db dropdb -U keycloak keycloak_pre_upgrade"""),
}


def require(condition, failure):
    # Not assert: python -O removes asserts, and the check would pass without checking.
    if not condition:
        raise RuntimeError(failure)


def private_write(path, text):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(text)


def full_stack_definition(definition, directory, public_port, issuer):
    """Use project-local application builds and disposable routing/trust inputs."""
    services = definition['services']
    # The learning profile is off, as in a deployment before Enable learning.
    if set(services) != {'postgres', 'service', 'console', 'proxy'}:
        raise ValueError('Canonical complete deployment changed; review container qualification')
    for name in ('postgres', 'service', 'console'):
        if services[name].get('ports'):
            raise ValueError('Backend host ports are forbidden')
    for name in ('service', 'console'):
        # Compose tags these builds with the unique qualification project name.
        services[name].pop('image', None)
    services['proxy']['ports'] = [dict(target=443, published=str(public_port), host_ip='127.0.0.1', protocol='tcp')]
    services['proxy']['volumes'] = [volume for volume in services['proxy']['volumes']
                                   if volume['target'] != '/etc/caddy/Caddyfile'] + [
        dict(type='bind', source=str(directory / 'Caddyfile'), target='/etc/caddy/Caddyfile', read_only=True),
        dict(type='bind', source=str(issuer.cert_path), target='/run/fixture/tls.crt', read_only=True),
        dict(type='bind', source=str(issuer.key_path), target='/run/fixture/tls.key', read_only=True)]
    if sys.platform.startswith('linux'):
        services['console'].setdefault('extra_hosts', {})['host.docker.internal'] = 'host-gateway'
    # Docker Desktop already supplies its host.docker.internal DNS route.
    services['console']['environment']['NODE_EXTRA_CA_CERTS'] = '/run/fixture/issuer.crt'
    services['console'].setdefault('volumes', []).append(dict(
        type='bind', source=str(issuer.ca_path), target='/run/fixture/issuer.crt', read_only=True))
    return definition


def with_identity_database(definition, cohosted):
    """Add the co-hosted Keycloak database, and a stand-in Keycloak that the documented commands stop."""
    definition['services']['keycloak-db'] = cohosted['services']['keycloak-db']
    definition['volumes']['keycloak-postgres-data'] = cohosted['volumes']['keycloak-postgres-data']
    definition['secrets']['keycloak_postgres_password'] = cohosted['secrets']['keycloak_postgres_password']
    definition['services']['keycloak'] = dict(image=cohosted['services']['keycloak-db']['image'],
                                              entrypoint=['sleep', 'infinity'], init=True, network_mode='none')
    return definition


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Fixture redirect refused')


def qualify():
    # No daemon start, registry push, global prune, or inspection of other projects.
    subprocess.run(['docker', 'info', '--format', '{{.ServerVersion}}'], check=True,
                   capture_output=True, timeout=15)
    from qualify import port
    from playwright.sync_api import sync_playwright
    project = 'acclimate-qual-' + secrets.token_hex(6)
    public_port = port()
    token, login, transport, password = (secrets.token_hex(32) for _ in range(4))
    with tempfile.TemporaryDirectory(prefix='acclimate-container-') as temporary:
        directory = Path(temporary)
        issuer = IdentityFixture(directory / 'identity', host='host.docker.internal', bind='0.0.0.0')
        origin = f'https://localhost:{public_port}'
        api = f'https://127.0.0.1:{public_port}'
        issuer.register_client(origin)
        service = service_env(database_url=f'postgresql://acclimate:{password}@postgres:5432/acclimate',
                              bind='0.0.0.0:3000', tokens={'container-fixture': token},
                              login_token=login, console_token=transport, project=project,
                              issuer=issuer.issuer, base_env={})
        console = dict(CONSOLE_ORIGIN=origin, CONSOLE_SERVICE_URL='http://service:3000',
                       CONSOLE_PUBLIC_API_URL=api, CONSOLE_LOGIN_TOKEN=login, CONSOLE_SERVICE_TOKEN=transport,
                       CONSOLE_OIDC_ISSUER=issuer.issuer, CONSOLE_OIDC_CLIENT_ID=issuer.client_id,
                       CONSOLE_OIDC_CLIENT_SECRET=issuer.client_secret)
        private_write(directory / 'service.env', ''.join(k+'='+v+'\n' for k,v in service.items()))
        private_write(directory / 'console.env', ''.join(k+'='+v+'\n' for k,v in console.items()))
        # The file names deploy/init.sh writes in the private directory.
        private_write(directory / 'postgres-password', password)
        private_write(directory / 'keycloak-postgres-password', secrets.token_hex(32))
        private_write(directory / 'keycloak.env', '')
        private_write(directory / 'empty.env', '')
        # Fixture-only TLS certificate. Production Caddyfile always uses real public TLS.
        # A client sends no SNI for an IP address, so name the certificate for those requests.
        private_write(directory / 'Caddyfile', '''{
  auto_https off
  default_sni 127.0.0.1
}
https://localhost {
  tls /run/fixture/tls.crt /run/fixture/tls.key
  reverse_proxy console:3100 {
    header_up Host localhost:'''+str(public_port)+'''
    header_up -Forwarded
    header_up -X-Forwarded-*
  }
}
https://127.0.0.1 {
  tls /run/fixture/tls.crt /run/fixture/tls.key
  reverse_proxy service:3000
}
''')
        environment = {k:v for k,v in os.environ.items() if k in ('PATH','HOME','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG')}
        environment.update(ACCLIMATE_CONFIG_DIR=str(directory), COMPOSE_PROFILES='',
                           CONSOLE_HOST='localhost', API_HOST='127.0.0.1', KEYCLOAK_HOST='auth.fixture.invalid',
                           ACME_EMAIL='fixture@example.invalid')
        base_command = ['docker', 'compose', '--env-file', str(directory/'empty.env'), '-p', project]
        def execute(command, timeout=900):
            # Output may contain secrets; it is never retained in gate evidence or logs.
            return subprocess.run(command, env=environment, cwd=ROOT, check=True,
                                  capture_output=True, timeout=timeout)
        command = base_command + ['-f', str(directory/'compose.json')]
        def compose(*args): return execute(command + list(args))
        # The documented commands run as written, with Compose pointed at this project.
        home = directory / 'home'
        home.mkdir()
        shell_environment = dict(environment, HOME=str(home), COMPOSE_PROJECT_NAME=project,
                                 COMPOSE_FILE=str(directory/'compose.json'),
                                 DOCKER_CONFIG=os.environ.get('DOCKER_CONFIG') or str(Path.home()/'.docker'))
        def documented(name, **placeholders):
            text = DOCUMENTED[name][1]
            for placeholder, value in placeholders.items():
                text = text.replace('<' + placeholder + '>', value)
            return subprocess.run(['sh', '-ec', text], env=shell_environment, cwd=home, check=True,
                                  capture_output=True, timeout=900)
        def sql(database, query):
            user = 'acclimate' if database.startswith('acclimate') else 'keycloak'
            service = 'postgres' if user == 'acclimate' else 'keycloak-db'
            return compose('exec', '-T', service, 'psql', '-U', user, '-d', database, '-XtAq',
                           '-v', 'ON_ERROR_STOP=1', '-c', query).stdout.decode().strip()
        def databases(service, user):
            return set(compose('exec', '-T', service, 'psql', '-U', user, '-d', 'postgres', '-XtAc',
                               'SELECT datname FROM pg_database').stdout.decode().split())
        started = False
        try:
            resolved = json.loads(execute(base_command + ['-f', str(ROOT/'compose.yaml'), 'config', '--format', 'json']).stdout)
            cohosted = json.loads(execute(base_command + ['-f', str(ROOT/'compose.yaml'), '-f', str(ROOT/'compose.keycloak.yaml'),
                                                          'config', '--format', 'json']).stdout)
            definition = with_identity_database(full_stack_definition(resolved, directory, public_port, issuer), cohosted)
            private_write(directory/'compose.json', json.dumps(definition))
            context = ssl.create_default_context(cafile=str(issuer.ca_path))
            opener = build_opener(NoRedirect(), HTTPSHandler(context=context))
            def call(base, path, body=None, authenticated=True):
                headers = {'Content-Type':'application/json', 'Idempotency-Key': secrets.token_hex(16)}
                if authenticated: headers['Authorization'] = 'Bearer ' + token
                request = Request(base+path, headers=headers, data=json.dumps(body).encode() if body is not None else None)
                with opener.open(request, timeout=5) as response:
                    return response.read()
            def missing(path):
                try:
                    call(api, path)
                except HTTPError as error:
                    return error.code == 404
                return False
            def release(name):
                setup = json.loads(call(api, '/v1/workspaces/'+project+'/bundle-setups', {
                    'name':name, 'origin':'created', 'channel':'stable',
                    'payload':{'schemaVersion':1,'files':[{'path':'instructions.md','kind':'instruction','text':name+' marker.'}]},
                    'reason':'Container qualification only'}))
                return '/v1/workspaces/'+project+'/bundles/'+setup['bundle']['id']+'/channels/stable'
            def ready():
                for _ in range(150):
                    try:
                        if json.loads(call(api, '/ready', authenticated=False)) == {'ready':True}:
                            # Console probe contract may include additional diagnostic fields.
                            if json.loads(call(origin, '/ready', authenticated=False)).get('status') == 'ready':
                                return
                    except (OSError, ValueError): pass
                    time.sleep(.2)
                raise RuntimeError('Full-stack readiness timeout')
            started = True  # Cleanup also owns a partially created stack.
            compose('up', '-d', '--build', '--wait')
            ready()
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True, args=['--host-resolver-rules=MAP host.docker.internal 127.0.0.1'])
                try:
                    # Explicit fixture certificate trust, confined to this disposable context.
                    browser_context = browser.new_context(ignore_https_errors=True)
                    page = browser_context.new_page()
                    page.goto(origin+'/auth/login')
                    page.get_by_label('Fixture subject').fill('operator')
                    page.get_by_role('button', name='Sign in to fixture').click()
                    page.wait_for_url(lambda url: url.startswith(origin+'/') and '/auth/' not in url, timeout=30000)
                    cookies = [c for c in browser_context.cookies() if c['name']=='acclimate_session']
                    require(len(cookies)==1 and cookies[0]['secure'] and cookies[0]['httpOnly'], 'Session cookie is not secure')
                    require({'/.well-known/openid-configuration','/authorize','/token','/jwks'}.issubset(issuer.requests),
                            'Sign-in skipped an issuer endpoint')
                    response = browser_context.request.post(origin+'/auth/logout', headers={'Origin':origin}, max_redirects=0)
                    require(response.status==303, 'Sign-out did not redirect')
                    require(not any(c['name']=='acclimate_session' for c in browser_context.cookies()), 'Sign-out kept the session cookie')
                finally: browser.close()
            path = release('Disposable full-stack release')
            before = call(api, path)
            compose('restart', 'service', 'console')
            ready()
            require(call(api,path)==before, 'Release changed across a restart')
            compose('stop','-t','90','service')
            rows = compose('ps','--all','--format','json','service').stdout.decode().strip()
            try: status=json.loads(rows)
            except json.JSONDecodeError: status=json.loads(rows.splitlines()[0])
            if isinstance(status,list): status=status[0]
            require(status.get('ExitCode')==0, 'Service did not exit zero on SIGTERM')
            compose('start','service')
            ready()
            require(call(api,path)==before, 'Release changed across a stop and start')
            # Back up, then write what a restore must discard.
            sql('keycloak', "CREATE TABLE fixture_marker (value text); INSERT INTO fixture_marker VALUES ('backed up')")
            documented('backup')
            backups = home/'acclimate-backups'
            dumps = sorted(backups.glob('acclimate-*.dump'))
            require(len(dumps)==1 and (backups/dumps[0].name.replace('acclimate-','keycloak-',1)).stat().st_size > 0,
                    'Backup did not write both archives')
            require(all(dump.stat().st_mode & 0o077 == 0 for dump in backups.iterdir()), 'Backup archives are readable by others')
            stamp = dumps[0].name[len('acclimate-'):-len('.dump')]
            later = release('Written after the backup')
            sql('keycloak', "UPDATE fixture_marker SET value = 'after the backup'")
            documented('restore', stamp=stamp)
            ready()
            require(call(api,path)==before and missing(later), 'Restore did not return the backed-up data')
            require('acclimate_before_restore' in databases('postgres','acclimate'), 'Restore kept no copy')
            documented('restore-keycloak', stamp=stamp)
            require(sql('keycloak', 'SELECT value FROM fixture_marker')=='backed up', 'Keycloak restore did not return the backed-up data')
            require('keycloak_before_restore' in databases('keycloak-db','keycloak'), 'Keycloak restore kept no copy')
            documented('undo-restore')
            ready()
            require(not missing(later), 'Undo did not return the data from before the restore')
            documented('drop-restore-copies')
            require(not {'acclimate_before_restore','keycloak_before_restore'} & (databases('postgres','acclimate') | databases('keycloak-db','keycloak')),
                    'Restore copies remain')
            # Upgrade in place, write new data, then roll back to the copies.
            documented('upgrade-stop')
            documented('backup')
            require(len(list(backups.glob('acclimate-*.dump'))) == 2, 'Upgrade backup did not write a new archive')
            documented('start-release')
            documented('start-source')
            ready()
            upgraded = release('Written after the upgrade')
            sql('keycloak', "UPDATE fixture_marker SET value = 'after the upgrade'")
            documented('rollback')
            documented('start-source')
            ready()
            require(call(api,path)==before and not missing(later) and missing(upgraded), 'Rollback did not return the pre-upgrade data')
            require(sql('keycloak', 'SELECT value FROM fixture_marker')=='backed up', 'Rollback did not return the pre-upgrade Keycloak data')
            documented('drop-upgrade-copies')
            reset = documented('reset-provider-keys').stdout.decode().strip()
            require(json.loads(reset)=={'removedProviders':0}, 'Provider key reset did not report its count')
        finally:
            try:
                if started: compose('down','--volumes','--remove-orphans','--rmi','local')
            finally: issuer.close()
    return ['built Rust and standalone Node deployment images', 'canonical complete stack with private backends',
            'fixture TLS proxy and real OIDC client discovery/code/JWKS login/logout',
            'API and console readiness', 'authenticated exact release persisted across restart',
            'SIGTERM exited zero within deployment grace', 'fresh start preserved release',
            'documented backup, restore, undo, upgrade and rollback commands kept the right data',
            'owned random project/volume removed']
