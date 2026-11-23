"""Opt-in isolated full-stack qualification using the canonical deployment manifest.

Never imported by application runtime. Only external.py --execute --gate container
calls qualify(); source/manifest tests must not claim container execution evidence.
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
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from testing.identity import IdentityFixture
from testing.production import service_env


def private_write(path, text):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(text)


def full_stack_definition(definition, directory, public_port, issuer):
    """Use project-local application builds and disposable routing/trust inputs."""
    services = definition['services']
    if set(services) != {'postgres', 'service', 'console', 'proxy', 'acclimate-executor', 'acclimate-runner'}:
        raise ValueError('Canonical complete deployment changed; review container qualification')
    for name in ('postgres', 'service', 'console', 'acclimate-executor', 'acclimate-runner'):
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
        private_write(directory / 'password', password)
        private_write(directory / 'empty.env', '')
        # The executor is not started here. Compose still requires its credential file.
        private_write(directory / 'executor-token', '')
        # Fixture-only TLS certificate. Production Caddyfile always uses real public TLS.
        private_write(directory / 'Caddyfile', '''{
  auto_https off
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
        environment.update(ACCLIMATE_SERVICE_ENV=str(directory/'service.env'),
                           ACCLIMATE_CONSOLE_ENV=str(directory/'console.env'),
                           ACCLIMATE_POSTGRES_PASSWORD_FILE=str(directory/'password'),
                           ACCLIMATE_EXECUTOR_TOKEN_FILE=str(directory/'executor-token'),
                           CONSOLE_HOST='localhost', API_HOST='127.0.0.1', ACME_EMAIL='fixture@example.invalid')
        base_command = ['docker', 'compose', '--env-file', str(directory/'empty.env'), '-p', project]
        def execute(command, timeout=900):
            # Output may contain secrets; it is never retained in gate evidence or logs.
            return subprocess.run(command, env=environment, cwd=ROOT, check=True,
                                  capture_output=True, timeout=timeout)
        command = base_command + ['-f', str(directory/'compose.json')]
        def compose(*args): return execute(command + list(args))
        started = False
        try:
            resolved = json.loads(execute(base_command + ['-f', str(ROOT/'compose.yaml'), 'config', '--format', 'json']).stdout)
            definition = full_stack_definition(resolved, directory, public_port, issuer)
            private_write(directory/'compose.json', json.dumps(definition))
            context = ssl.create_default_context(cafile=str(issuer.ca_path))
            opener = build_opener(NoRedirect(), HTTPSHandler(context=context))
            def call(base, path, body=None, authenticated=True):
                headers = {'Content-Type':'application/json', 'Idempotency-Key': secrets.token_hex(16)}
                if authenticated: headers['Authorization'] = 'Bearer ' + token
                request = Request(base+path, headers=headers, data=json.dumps(body).encode() if body is not None else None)
                with opener.open(request, timeout=5) as response:
                    return response.read()
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
            compose('up', '-d', '--build', '--wait', 'proxy')
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
                    assert len(cookies)==1 and cookies[0]['secure'] and cookies[0]['httpOnly']
                    assert {'/.well-known/openid-configuration','/authorize','/token','/jwks'}.issubset(issuer.requests)
                    response = browser_context.request.post(origin+'/auth/logout', headers={'Origin':origin}, max_redirects=0)
                    assert response.status==303
                    assert not any(c['name']=='acclimate_session' for c in browser_context.cookies())
                finally: browser.close()
            setup = json.loads(call(api, '/v1/workspaces/'+project+'/bundle-setups', {
                'name':'Disposable full-stack release', 'origin':'created', 'channel':'stable',
                'payload':{'schemaVersion':1,'files':[{'path':'instructions.md','kind':'instruction','text':'Disposable lifecycle marker.'}]},
                'reason':'Container qualification only'}))
            path = '/v1/workspaces/'+project+'/bundles/'+setup['bundle']['id']+'/channels/stable'
            before = call(api, path)
            compose('restart', 'service', 'console')
            ready()
            assert call(api,path)==before
            compose('stop','-t','90','service')
            rows = compose('ps','--all','--format','json','service').stdout.decode().strip()
            try: status=json.loads(rows)
            except json.JSONDecodeError: status=json.loads(rows.splitlines()[0])
            if isinstance(status,list): status=status[0]
            assert status.get('ExitCode')==0
            compose('start','service')
            ready()
            assert call(api,path)==before
        finally:
            try:
                if started: compose('down','--volumes','--remove-orphans')
            finally: issuer.close()
    return ['built Rust and standalone Node deployment images', 'canonical complete stack with private backends',
            'fixture TLS proxy and real OIDC client discovery/code/JWKS login/logout',
            'API and console readiness', 'authenticated exact release persisted across restart',
            'SIGTERM exited zero within deployment grace', 'fresh start preserved release', 'owned random project/volume removed']
