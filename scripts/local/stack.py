"""Provision the loopback-only Compose stack with real Keycloak identity."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from typing import NamedTuple
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener
from uuid import UUID, uuid4

from scripts.configure_dev_mail import mail_settings


ROOT = Path(__file__).resolve().parents[2]
# Stacks saved before automatic port selection used these defaults.
DEFAULT_PORT = 3443
DEFAULT_MAIL_PORT = 8025
# Automatic selection starts at a per-checkout block below the usual ephemeral ranges.
AUTO_PORTS = (10000, 30000)
AUTO_ATTEMPTS = 200


class Endpoints(NamedTuple):
    """Loopback ports. Each one is identical inside the proxy namespace and on the host."""

    port: int = DEFAULT_PORT
    mail_port: int = DEFAULT_MAIL_PORT

    def ports(self):
        return (self.port, self.port + 1, self.port + 2, self.mail_port)

    @property
    def console(self):
        return f'https://localhost:{self.port}'

    @property
    def api(self):
        return f'https://127.0.0.1:{self.port + 1}'

    @property
    def keycloak(self):
        return f'https://127.0.0.1:{self.port + 2}'

    @property
    def issuer(self):
        return self.keycloak + '/realms/acclimate'

    @property
    def mailpit(self):
        return f'http://localhost:{self.mail_port}'

    def environment(self):
        return dict(
            ACCLIMATE_LOCAL_CONSOLE_PORT=str(self.port),
            ACCLIMATE_LOCAL_API_PORT=str(self.port + 1),
            ACCLIMATE_LOCAL_KEYCLOAK_PORT=str(self.port + 2),
            ACCLIMATE_LOCAL_MAIL_PORT=str(self.mail_port),
        )


DEFAULT = Endpoints()
CONSOLE = DEFAULT.console
API = DEFAULT.api
KEYCLOAK = DEFAULT.keycloak
ISSUER = DEFAULT.issuer
ADMIN = 'bootstrap-admin'
OPERATOR = 'operator@acclimate.invalid'
CLIENT = 'acclimate-console'
PROJECT = 'local-demo'
PRINCIPAL = 'local-runtime'
ADOPTION_REASON = 'local stack bootstrap'
EXAMPLE_BUNDLE = 'Example agent'
EXAMPLE_CHANNEL = 'stable'
EXAMPLE_PAYLOAD = dict(schemaVersion=1, files=[dict(
    path='instructions.md', kind='instruction',
    text='You are a support agent for a small software company.\n\n'
         'Answer in two short paragraphs. Ask one clarifying question when the request is ambiguous.\n',
)])
RELEASE_IMAGES = dict(service='ghcr.io/anveld-dev/acclimate-service',
                      console='ghcr.io/anveld-dev/acclimate-console')
SECRET_NAMES = (
    'postgres', 'keycloak_postgres', 'keycloak_admin', 'operator',
    'oidc_client', 'login', 'console', 'runtime', 'provider_key',
)
# Learning needs a model endpoint for the optimizer, and an allowlist when the workspace
# provider is a local proxy. Both come from the shell that runs local:up and are then kept.
LEARNING_SETTINGS = (
    'ACCLIMATE_MODEL_ENDPOINT', 'ACCLIMATE_MODEL_TOKEN', 'ACCLIMATE_MODEL',
    'ACCLIMATE_MODEL_REASONING_EFFORT', 'ACCLIMATE_PROVIDER_HTTP_HOSTS',
)


def directory(path, private=False):
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError(f'Expected an owned directory at {path}')
    if private and info.st_mode & 0o077:
        raise ValueError(f'Set mode 0700 on {path}')


@contextmanager
def locked_state(root):
    local = root / '.local'
    directory(local)
    # Lock the parent so reset can remove stack/ without invalidating the lock.
    fd = os.open(local, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Another local stack command is running.') from None
        yield local / 'stack'
    finally:
        os.close(fd)


def existing_file(path, mode):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != mode):
        raise ValueError(f'Expected an owned regular file with mode {mode:04o} at {path}')
    return path.read_bytes()


def write_file(path, value, mode=0o600):
    if existing_file(path, mode) == value:
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temp_path = Path(temporary.name)
        try:
            os.fchmod(temporary.fileno(), mode)
            temporary.write(value)
            temporary.flush()
            os.replace(temp_path, path)
        finally:
            temp_path.unlink(missing_ok=True)


def write_env(path, values):
    write_file(path, ''.join(f'{key}={value}\n' for key, value in values.items()).encode())


def credentials(state):
    path = state / 'credentials.json'
    saved = existing_file(path, 0o600)
    if saved is None:
        values = {name: secrets.token_hex(32) for name in SECRET_NAMES}
    else:
        values = json.loads(saved)
    # Preserve the runtime credential in existing local installations.
    if isinstance(values, dict) and 'evaluator' in values and 'runtime' not in values:
        values['runtime'] = values.pop('evaluator')
        saved = None
    # Stacks created before learning ran on the service have no provider encryption key.
    if isinstance(values, dict) and 'provider_key' not in values:
        values['provider_key'] = secrets.token_hex(32)
        saved = None
    if (not isinstance(values, dict) or set(values) != set(SECRET_NAMES)
            or any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value)
                   for value in values.values())
            or len(set(values.values())) != len(SECRET_NAMES)):
        raise ValueError(f'Invalid local credentials in {path}')
    if saved is None:
        write_file(path, (json.dumps(values, indent=2) + '\n').encode())
    return values


def requested_port(environ, name):
    raw = environ.get(name)
    if raw is None or raw == '':
        return None
    if not re.fullmatch(r'[0-9]{4,5}', raw) or not 1024 <= int(raw) <= 65532:
        raise ValueError(f'{name} must be a port between 1024 and 65532')
    return int(raw)


def project_suffix(root):
    return hashlib.sha256(os.fsencode(root)).hexdigest()[:12]


def derived_port(root):
    """Start each checkout at its own block so parallel checkouts rarely collide."""
    low, high = AUTO_PORTS
    blocks = (high - low) // 10
    return low + int(project_suffix(root), 16) % blocks * 10


def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe_socket:
        try:
            probe_socket.bind(('127.0.0.1', port))
        except OSError:
            return False
    return True


def busy(candidate, is_free):
    return [port for port in candidate.ports() if not is_free(port)]


def describe_ports(ports):
    return ('port ' if len(ports) == 1 else 'ports ') + ', '.join(str(port) for port in ports)


def free_block(start, is_free, mail_port=None):
    low, high = AUTO_PORTS
    port = start
    for _ in range(AUTO_ATTEMPTS):
        candidate = Endpoints(port, port + 3 if mail_port is None else mail_port)
        if not busy(candidate, is_free):
            return candidate
        port = port + 10 if port + 13 <= high else low
    raise ValueError('Could not find four free loopback ports. '
                     'Set ACCLIMATE_LOCAL_PORT and ACCLIMATE_LOCAL_MAIL_PORT to free ports.')


def saved_endpoints(state):
    path = state / 'ports.json'
    saved = existing_file(path, 0o600) if state.exists() else None
    if saved is None:
        return None
    data = json.loads(saved)
    if (not isinstance(data, dict) or set(data) != set(Endpoints._fields)
            or any(type(value) is not int for value in data.values())):
        raise ValueError(f'Invalid local ports in {path}')
    return Endpoints(**data)


def current_endpoints(state):
    """Ports for down and reset. Compose finds containers by project, so defaults suffice."""
    return saved_endpoints(state) or DEFAULT


def select_endpoints(root, state, environ=os.environ, is_free=port_free, running=False):
    """Choose the stack's ports without saving them.

    Keycloak and the service record the console and issuer addresses after the first
    successful start, so saved ports cannot change without a reset. Before that,
    every start checks its ports and an explicit request always wins.
    """
    port = requested_port(environ, 'ACCLIMATE_LOCAL_PORT')
    mail_port = requested_port(environ, 'ACCLIMATE_LOCAL_MAIL_PORT')
    saved = saved_endpoints(state)
    if saved is not None:
        for name, field, value in (('ACCLIMATE_LOCAL_PORT', 'port', port),
                                   ('ACCLIMATE_LOCAL_MAIL_PORT', 'mail_port', mail_port)):
            if value is not None and value != getattr(saved, field):
                raise ValueError(
                    f'This stack was first started with {name}={getattr(saved, field)}, and Keycloak '
                    'recorded that address. Unset the variable to keep it, or run npm run local:reset '
                    'to start over with new ports.')
        taken = [] if running else busy(saved, is_free)
        if taken:
            raise ValueError(
                f'Another process is using {describe_ports(taken)}. This stack keeps the ports from its '
                f'first start ({saved.console}). Stop that process, or run npm run local:reset and start '
                'again to choose new ports.')
        return saved
    if port is not None:
        candidate = Endpoints(port, port + 3 if mail_port is None else mail_port)
        taken = busy(candidate, is_free)
        if taken:
            free = free_block(derived_port(root), is_free)
            raise ValueError(
                f'Another process is using {describe_ports(taken)}. Run '
                f'ACCLIMATE_LOCAL_PORT={free.port} ACCLIMATE_LOCAL_MAIL_PORT={free.mail_port} npm run local:up, '
                'or unset both variables to pick free ports automatically.')
        return candidate
    if mail_port is not None and not is_free(mail_port):
        free = free_block(derived_port(root), is_free)
        raise ValueError(
            f'Another process is using port {mail_port}. Run ACCLIMATE_LOCAL_MAIL_PORT={free.mail_port} '
            'npm run local:up, or unset it to pick a free port automatically.')
    return free_block(derived_port(root), is_free, mail_port)


def save_endpoints(state, ports):
    write_file(state / 'ports.json', (json.dumps(ports._asdict(), indent=2) + '\n').encode())


def write_infrastructure(state, values, ports=DEFAULT):
    for secret in ('postgres', 'keycloak_postgres'):
        write_file(state / (secret.replace('_', '-') + '-password'), values[secret].encode() + b'\n')
    write_env(state / 'keycloak.env', dict(
        KC_DB_PASSWORD=values['keycloak_postgres'],
        KC_BOOTSTRAP_ADMIN_USERNAME=ADMIN,
        KC_BOOTSTRAP_ADMIN_PASSWORD=values['keycloak_admin'],
        ACCLIMATE_CONSOLE_ORIGIN=ports.console,
        ACCLIMATE_OIDC_CLIENT_SECRET=values['oidc_client'],
    ))


def learning_settings(state, environ):
    """Optional learning settings from the shell, or the ones saved by an earlier start."""
    saved = existing_file(state / 'service.env', 0o600)
    kept = dict(line.split('=', 1) for line in saved.decode().splitlines()) if saved else {}
    chosen = {}
    for name in LEARNING_SETTINGS:
        # An exported empty value clears the saved one; an unset name keeps it.
        value = environ[name] if name in environ else kept.get(name)
        if value:
            if any(character in value for character in '\r\n'):
                raise ValueError(f'{name} must be a single line')
            chosen[name] = value
    return chosen


def write_application(state, values, subject, ports=DEFAULT, environ=os.environ):
    write_env(state / 'service.env', dict(
        DATABASE_URL=f"postgresql://acclimate:{values['postgres']}@postgres:5432/acclimate",
        ACCLIMATE_OIDC_ISSUER=ports.issuer,
        ACCLIMATE_LOGIN_TOKEN=values['login'],
        ACCLIMATE_CONSOLE_TOKEN=values['console'],
        ACCLIMATE_OPERATORS=json.dumps([dict(issuer=ports.issuer, subject=str(UUID(subject)))]),
        ACCLIMATE_AUTH=json.dumps([dict(token=values['runtime'], principalId=PRINCIPAL,
                                        workspaceId=PROJECT, rights=['read', 'write'])]),
        ACCLIMATE_CONSOLE_ORIGIN=ports.console,
        ACCLIMATE_SMTP_HOST='mailpit',
        ACCLIMATE_SMTP_PORT=1025,
        ACCLIMATE_SMTP_FROM='Acclimate <noreply@acclimate.local>',
        ACCLIMATE_SMTP_TLS='none',
        ACCLIMATE_PROVIDER_ENCRYPTION_KEY=values['provider_key'],
        **learning_settings(state, environ),
    ))
    write_env(state / 'console.env', dict(
        CONSOLE_ORIGIN=ports.console,
        CONSOLE_SERVICE_URL='http://127.0.0.1:3000',
        CONSOLE_PUBLIC_API_URL=ports.api,
        CONSOLE_OIDC_ISSUER=ports.issuer,
        CONSOLE_OIDC_CLIENT_ID=CLIENT,
        CONSOLE_OIDC_CLIENT_SECRET=values['oidc_client'],
        CONSOLE_LOGIN_TOKEN=values['login'],
        CONSOLE_SERVICE_TOKEN=values['console'],
        CONSOLE_ALLOW_EDITS='true',
    ))
    config = dict(schemaVersion=1, serviceUrl=ports.api, workspaceId=PROJECT,
                  scope=PRINCIPAL, token=values['runtime'],
                  cacheDir=str(state / 'pull-cache'))
    write_file(state / 'pull.json', (json.dumps(config, indent=2) + '\n').encode())


def release_version(root):
    metadata = json.loads((root / 'scripts' / 'packaging' / 'release-metadata.json').read_text())
    return metadata['version']


def image_environment(root, source):
    """Use published images, or tag source builds for this checkout only."""
    if source == 'release':
        version = release_version(root)
        return dict(ACCLIMATE_LOCAL_SERVICE_IMAGE=f"{RELEASE_IMAGES['service']}:{version}",
                    ACCLIMATE_LOCAL_CONSOLE_IMAGE=f"{RELEASE_IMAGES['console']}:{version}",
                    ACCLIMATE_LOCAL_PULL_POLICY='missing')
    name = f'acclimate-local-{project_suffix(root)}'
    return dict(ACCLIMATE_LOCAL_SERVICE_IMAGE=f'{name}-service:source',
                ACCLIMATE_LOCAL_CONSOLE_IMAGE=f'{name}-console:source',
                ACCLIMATE_LOCAL_PULL_POLICY='build')


def compose_command(root):
    return ['docker', 'compose', '--env-file', os.devnull, '--project-name',
            f'acclimate-local-{project_suffix(root)}', '-f', 'compose.local.yaml']


def compose(root, *args, capture=False, ports=DEFAULT, source='build', environment=None):
    return subprocess.run(
        [*compose_command(root), *args],
        cwd=root, check=True, stdout=subprocess.PIPE if capture else None,
        env={**os.environ, **ports.environment(), **image_environment(root, source),
             **(environment or {})},
    ).stdout


def saved_source(state):
    saved = existing_file(state / 'images.json', 0o600) if state.exists() else None
    if saved is None:
        return None
    source = json.loads(saved).get('source')
    if source not in ('release', 'build'):
        raise ValueError(f'Invalid image source in {state / "images.json"}')
    return source


def choose_source(requested, saved):
    if requested is not None:
        return requested
    return saved or 'release'


def prepare_images(root, ports, source, saved):
    """Pull released images, falling back to a source build when none is published."""
    if source == 'build':
        print('Building the service and console from this checkout. '
              'A cold build takes about 10-20 minutes.', flush=True)
        return 'build'
    if saved == 'build':
        print('Switching from source builds to released images. If this checkout added database '
              'migrations, run npm run local:up -- --build instead.', flush=True)
    version = release_version(root)
    try:
        compose(root, 'pull', 'service', 'console', ports=ports, source='release')
    except subprocess.CalledProcessError:
        print(f'Released images for {version} are not available. Building from source instead; '
              'a cold build takes about 10-20 minutes. Pass --build to skip the download attempt.',
              flush=True)
        return 'build'
    return 'release'


def keycloak_operator(opener, values, expected_subject=None, ports=DEFAULT):
    token_url = ports.keycloak + '/realms/master/protocol/openid-connect/token'
    form = urlencode(dict(client_id='admin-cli', grant_type='password',
                         username=ADMIN, password=values['keycloak_admin'])).encode()
    with opener.open(Request(token_url, data=form), timeout=15) as response:
        token = json.load(response)['access_token']
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    realm = ports.keycloak + '/admin/realms/acclimate'
    users = realm + '/users'
    exact_user = Request(users + '?' + urlencode(dict(username=OPERATOR, exact='true')), headers=headers)

    def lookup():
        with opener.open(exact_user, timeout=15) as response:
            return json.load(response)

    matches = lookup()
    if not matches and expected_subject is None:
        user = dict(username=OPERATOR, email=OPERATOR, emailVerified=True, enabled=True,
                    firstName='Local', lastName='Operator',
                    credentials=[dict(type='password', value=values['operator'], temporary=False)])
        with opener.open(Request(users, data=json.dumps(user).encode(), headers=headers), timeout=15):
            pass
        matches = lookup()
    if len(matches) != 1 or matches[0]['username'] != OPERATOR:
        raise ValueError('Could not identify the local Keycloak operator.')
    subject = str(UUID(matches[0]['id']))
    if expected_subject is not None and subject != expected_subject:
        raise ValueError('The local Keycloak operator subject changed. Restore the realm or reset the stack.')

    settings = mail_settings('mailpit')
    with opener.open(Request(realm, headers=headers), timeout=15) as response:
        current = json.load(response)
    if any(current.get(key) != value for key, value in settings.items()):
        update = Request(realm, data=json.dumps(settings).encode(), headers=headers, method='PUT')
        with opener.open(update, timeout=15):
            pass

    # Keycloak keeps the redirect from its first realm import. An earlier start that
    # failed before saving its ports may have imported a different console address.
    clients = Request(realm + '/clients?' + urlencode(dict(clientId=CLIENT)), headers=headers)
    with opener.open(clients, timeout=15) as response:
        found = json.load(response)
    if len(found) != 1 or found[0].get('clientId') != CLIENT:
        raise ValueError('Could not find the local console client in Keycloak.')
    redirect = [ports.console + '/auth/callback']
    if found[0].get('redirectUris') != redirect:
        client = {**found[0], 'redirectUris': redirect}
        update = Request(realm + '/clients/' + quote(found[0]['id'], safe=''),
                         data=json.dumps(client).encode(), headers=headers, method='PUT')
        with opener.open(update, timeout=15):
            pass
    return subject


def probe(opener, url, field, expected):
    # Caddy's health endpoint can come up before its TLS listeners are ready.
    deadline = time.monotonic() + 15
    while True:
        try:
            with opener.open(url, timeout=3) as response:
                result = json.load(response)
            break
        except URLError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.5)
    if result.get(field) != expected:
        raise ValueError(f'Unexpected {field} from {url}')


def api(opener, ports, method, route, token, session=None, body=None, mutation=False):
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json'}
    if session is not None:
        headers['X-Acclimate-Session'] = session
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    if mutation:
        headers['Idempotency-Key'] = str(uuid4())
    with opener.open(Request(ports.api + route, data=data, headers=headers, method=method),
                     timeout=30) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


def seed_example(call):
    """Publish a small example bundle to its default channel."""
    scope = f'/v1/workspaces/{PROJECT}/bundles'
    bundles = call('GET', scope + '?limit=100')['items']
    bundle = next((item for item in bundles if item['name'] == EXAMPLE_BUNDLE), None)
    if bundle is None:
        if bundles:
            return None
        bundle = call('POST', scope, body=dict(name=EXAMPLE_BUNDLE), mutation=True)
    bundle_scope = scope + '/' + quote(bundle['id'], safe='')
    channels = call('GET', bundle_scope + '/channels?limit=100')['items']
    if not any(channel['name'] == EXAMPLE_CHANNEL for channel in channels):
        version = call('POST', bundle_scope + '/versions', body=dict(payload=EXAMPLE_PAYLOAD), mutation=True)
        call('POST', f'{bundle_scope}/channels/{EXAMPLE_CHANNEL}/releases', mutation=True, body=dict(
            versionId=version['id'], expectedRevision='0',
            unevaluatedReason='Example bundle published by npm run local:up'))
    return bundle['id']


def bootstrap_workspace(opener, values, subject, ports):
    """Adopt local-demo for the bootstrap operator and publish an example bundle.

    This uses the console's own server path: a login-token session for the verified
    Keycloak operator, then the audited adoption route with a recorded reason.
    """
    session = api(opener, ports, 'POST', '/v1/auth/sessions', values['login'], body=dict(
        issuer=ports.issuer, subject=subject, email=OPERATOR, emailVerified=True,
        displayName='Local Operator'))['secret']

    def call(method, route, body=None, mutation=False):
        return api(opener, ports, method, route, values['console'], session, body, mutation)

    try:
        try:
            call('POST', '/v1/auth/workspace-adoptions', dict(workspaceId=PROJECT, reason=ADOPTION_REASON))
        except HTTPError as error:
            if error.code != 409:
                raise
            return dict(adopted=False, bundle=None)
        return dict(adopted=True, bundle=seed_example(call))
    finally:
        try:
            call('DELETE', '/v1/auth/session')
        except (HTTPError, URLError):
            pass


CA_BUNDLE_CANDIDATES = (
    '/etc/ssl/cert.pem',
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/ssl/ca-bundle.pem',
    '/opt/homebrew/etc/ca-certificates/cert.pem',
    '/usr/local/etc/ca-certificates/cert.pem',
)


def system_ca_bundle():
    paths = ssl.get_default_verify_paths()
    for candidate in (os.environ.get('SSL_CERT_FILE'), paths.cafile, paths.openssl_cafile,
                      *CA_BUNDLE_CANDIDATES):
        if not candidate:
            continue
        path = Path(candidate)
        try:
            text = path.read_bytes()
        except OSError:
            continue
        if b'BEGIN CERTIFICATE' in text:
            return path, text
    return None, b''


def write_client_files(state, ports, certificate, bundle):
    """Write a merged CA bundle and ready-to-source client variables."""
    source, system = system_ca_bundle()
    if source is not None and source.resolve() == (state / 'ca-bundle.pem').resolve():
        source, system = None, b''
    merged = system.rstrip(b'\n') + b'\n' + certificate if system else certificate
    write_file(state / 'ca-bundle.pem', merged, mode=0o644)
    lines = {
        'ACCLIMATE_PULL_CONFIG': state / 'pull.json',
        'NODE_EXTRA_CA_CERTS': state / 'root.crt',
        'SSL_CERT_FILE': state / 'ca-bundle.pem',
        'ACCLIMATE_API': ports.api,
        # The SDKs and the examples read these two.
        'ACCLIMATE_URL': ports.api,
        'ACCLIMATE_WORKSPACE': PROJECT,
    }
    if bundle:
        lines['BUNDLE_ID'] = bundle
    text = ''.join(f"export {key}='{value}'\n" for key, value in lines.items())
    write_file(state / 'env.sh', text.encode(), mode=0o600)
    return text, source


def start_executor(root, state, ports, source, environ=os.environ):
    """Give the executor a credential on first start, then run it beside the service."""
    path = state / 'executor-token'
    if existing_file(path, 0o600) is None:
        created = compose(root, 'exec', '-T', 'service', '/usr/local/bin/acclimate-service',
                          '--create-executor-token', capture=True, ports=ports, source=source)
        write_file(path, json.loads(created)['token'].encode() + b'\n')
    # The executor applies the same provider allowlist as the service.
    hosts = learning_settings(state, environ).get('ACCLIMATE_PROVIDER_HTTP_HOSTS', '')
    # The executor has no released image. A source start rebuilds it with the checkout.
    rebuild = ['--build'] if source == 'build' else []
    compose(root, 'up', '--detach', *rebuild, 'acclimate-executor', ports=ports, source=source,
            environment=dict(ACCLIMATE_PROVIDER_HTTP_HOSTS=hosts))
    logs = shlex.join([*compose_command(root), 'logs', 'acclimate-executor'])
    # Healthy means the service has answered the executor with its credential, after the
    # sandbox preflight passed. A running container alone can be between restarts.
    for _ in range(EXECUTOR_START_SECONDS):
        state, health = executor_status(root, ports, source)
        if state == 'running' and health == 'healthy':
            return
        if state in ('restarting', 'exited', 'dead'):
            raise ValueError(f'The executor stopped. To see why, run {logs} in {root}')
        time.sleep(1)
    raise ValueError(f'The executor did not become healthy within {EXECUTOR_START_SECONDS} '
                     f'seconds. To see why, run {logs} in {root}')


EXECUTOR_START_SECONDS = 90


def executor_status(root, ports, source):
    """The executor container's state and health, such as ('running', 'healthy')."""
    output = compose(root, 'ps', '--all', '--format', '{{.State}} {{.Health}}',
                     'acclimate-executor', capture=True, ports=ports, source=source)
    state, _, health = (output or b'').decode().strip().partition(' ')
    return state, health.strip()


def docker_running():
    try:
        return subprocess.run(['docker', 'info'], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, check=False).returncode == 0
    except OSError:
        return False


def stack_running(root):
    return bool(compose(root, 'ps', '--status', 'running', '--quiet', capture=True).strip())


def up(root, state, requested_source=None):
    directory(state, private=True)
    saved_ports = saved_endpoints(state)
    running = stack_running(root)
    if running and saved_ports is None:
        # Containers from a start that never finished may hold ports this run would choose.
        print('Stopping containers left by an earlier incomplete start.', flush=True)
        compose(root, 'down')
        running = False
    ports = select_endpoints(root, state, running=running)
    values = credentials(state)
    previous_source = saved_source(state)
    source = prepare_images(root, ports, choose_source(requested_source, previous_source), previous_source)
    write_infrastructure(state, values, ports)
    # The service requires a nonempty operator list. Bring up identity first.
    compose(root, 'up', '--wait', '--wait-timeout', '600', 'proxy', 'mailpit', 'postgres',
            ports=ports, source=source)
    # The Caddyfile is bind-mounted, so Compose keeps a running proxy after it changes.
    compose(root, 'exec', '-T', 'proxy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile',
            '--adapter', 'caddyfile', ports=ports, source=source)
    ca = state / 'root.crt'
    certificate = compose(root, 'exec', '-T', 'proxy', 'cat',
                          '/data/caddy/pki/authorities/local/root.crt', capture=True, ports=ports,
                          source=source)
    context = ssl.create_default_context(cadata=certificate.decode())
    write_file(ca, certificate, mode=0o644)
    opener = build_opener(ProxyHandler({}), HTTPSHandler(context=context))
    probe(opener, ports.issuer + '/.well-known/openid-configuration', 'issuer', ports.issuer)
    marker = state / 'operator-subject'
    saved_subject = existing_file(marker, 0o600)
    previous_subject = saved_subject.decode() if saved_subject is not None else None
    subject = keycloak_operator(opener, values, previous_subject, ports)
    write_application(state, values, subject, ports)
    # Compose recreates the service when its effective environment changes.
    compose(root, 'up', '--wait', '--wait-timeout', '600', 'console', ports=ports, source=source)
    probe(opener, ports.api + '/ready', 'ready', True)
    probe(opener, ports.console + '/ready', 'status', 'ready')
    with opener.open(ports.console + '/auth/login', timeout=15) as response:
        if not response.geturl().startswith(ports.issuer + '/protocol/openid-connect/auth?'):
            raise ValueError('The console did not redirect sign-in to the local Keycloak issuer.')
    print('Starting the executor. Its first build takes a few minutes.', flush=True)
    start_executor(root, state, ports, source)
    save_endpoints(state, ports)
    write_file(state / 'images.json', (json.dumps(dict(source=source)) + '\n').encode())

    saved_workspace = existing_file(state / 'workspace.json', 0o600)
    workspace = json.loads(saved_workspace) if saved_workspace is not None else None
    bootstrap_error = None
    if workspace is None:
        try:
            workspace = bootstrap_workspace(opener, values, subject, ports)
        except (OSError, ValueError, KeyError, TypeError) as error:
            workspace, bootstrap_error = dict(adopted=False, bundle=None), error
        if workspace['adopted']:
            write_file(state / 'workspace.json', (json.dumps(workspace) + '\n').encode())
    env, ca_source = write_client_files(state, ports, certificate, workspace.get('bundle'))

    print(f'\nConsole       {ports.console}\nLogin         {OPERATOR}\nAPI           {ports.api}')
    print(f'Mailpit       {ports.mailpit}\nPull config   {state / "pull.json"}\n'
          f'Local CA      {ca}')
    learning = learning_settings(state, os.environ)
    if 'ACCLIMATE_MODEL_ENDPOINT' in learning:
        print(f'Optimizer     {learning.get("ACCLIMATE_MODEL", "model not set")} at '
              f'{learning["ACCLIMATE_MODEL_ENDPOINT"]}')
    else:
        print('Optimizer     Not configured. To run learning rounds, set ACCLIMATE_MODEL_ENDPOINT, '
              'ACCLIMATE_MODEL_TOKEN and ACCLIMATE_MODEL, then run npm run local:up again.')
    if workspace['adopted']:
        print(f'Workspace     {PROJECT}, adopted for {OPERATOR} ("{ADOPTION_REASON}")')
        if workspace.get('bundle'):
            print(f'Example       bundle {workspace["bundle"]} on channel {EXAMPLE_CHANNEL}')
    elif bootstrap_error is not None:
        print(f'Workspace     Could not adopt {PROJECT} automatically ({bootstrap_error}). '
              'Run npm run local:up again, or adopt it in the console under Operator tools.')
    else:
        print(f'Workspace     {PROJECT} already belongs to another account. Adopt it from Operator tools.')
    if previous_subject is None:
        print(f'Initial login password (printed once)  {values["operator"]}', flush=True)
        write_file(marker, subject.encode())
    print(f'Initial password is stored as "operator" in {state / "credentials.json"}.')
    print(f'\nClient settings for this shell, also saved in {state / "env.sh"}:\n')
    print(env.rstrip())
    if ca_source is None:
        print('\nNo system CA bundle was found, so ca-bundle.pem trusts only the local CA. '
              'Point SSL_CERT_FILE at a merged bundle before calling an external model provider.')
    print('\nTo trust the local CA in your browser, run npm run local:trust.')


def down(root, state):
    compose(root, 'down', ports=current_endpoints(state))


def reset(root, state):
    if (state / 'trust.json').exists():
        print('Your system trusts this checkout’s local CA. Run npm run local:trust -- --remove '
              'first to remove it.')
    if input(f'Delete this checkout’s local stack volumes and {state}? Type reset: ') != 'reset':
        print('Reset canceled.')
        return
    compose(root, 'down', '--volumes', ports=current_endpoints(state))
    if state.exists():
        shutil.rmtree(state)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('up', 'down', 'reset'))
    images = parser.add_mutually_exclusive_group()
    images.add_argument('--build', dest='source', action='store_const', const='build',
                        help='build the service and console images from this checkout')
    images.add_argument('--release', dest='source', action='store_const', const='release',
                        help='use the published images for this checkout’s release version')
    arguments = parser.parse_args(argv)
    command = arguments.command
    if arguments.source and command != 'up':
        parser.error('--build and --release apply only to up')
    try:
        if not docker_running():
            raise SystemExit(f'Local stack {command} failed: Docker is not running. '
                             'Start Docker Desktop or the Docker daemon and run the command again.')
        with locked_state(ROOT) as state:
            if command == 'up':
                up(ROOT, state, arguments.source)
            elif command == 'down':
                down(ROOT, state)
            else:
                reset(ROOT, state)
    except EOFError:
        raise SystemExit('Reset canceled. Run interactively to confirm.') from None
    except subprocess.CalledProcessError as error:
        hint = ''
        if command == 'up':
            hint = (' If Docker reported a port that is already allocated, run '
                    'ACCLIMATE_LOCAL_PORT=<free port> npm run local:up, or stop the other process.')
        raise SystemExit(f'Local stack {command} failed: {error}.{hint}') from None
    except (OSError, ValueError) as error:
        raise SystemExit(f'Local stack {command} failed: {error}') from None


if __name__ == '__main__':
    main(sys.argv[1:])
