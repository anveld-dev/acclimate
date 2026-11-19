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
import shutil
import ssl
import stat
import subprocess
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlencode
from typing import NamedTuple
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener
from uuid import UUID

from scripts.configure_dev_mail import mail_settings


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PORT = 3443
DEFAULT_MAIL_PORT = 8025


class Endpoints(NamedTuple):
    """Loopback ports. Each one is identical inside the proxy namespace and on the host."""

    port: int = DEFAULT_PORT
    mail_port: int = DEFAULT_MAIL_PORT

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
PRINCIPAL = 'local-evaluator'
SECRET_NAMES = (
    'postgres', 'keycloak_postgres', 'keycloak_admin', 'operator',
    'oidc_client', 'login', 'console', 'evaluator',
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
    if (not isinstance(values, dict) or set(values) != set(SECRET_NAMES)
            or any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value)
                   for value in values.values())
            or len(set(values.values())) != len(SECRET_NAMES)):
        raise ValueError(f'Invalid local credentials in {path}')
    if saved is None:
        write_file(path, (json.dumps(values, indent=2) + '\n').encode())
    return values


def requested_port(environ, name, default):
    raw = environ.get(name)
    if raw is None or raw == '':
        return None
    if not re.fullmatch(r'[0-9]{4,5}', raw) or not 1024 <= int(raw) <= 65533:
        raise ValueError(f'{name} must be a port between 1024 and 65533')
    return int(raw)


def endpoints(state, environ=os.environ, save=True):
    """Return the stack's ports, fixing them on first use.

    Keycloak stores the console redirect when it first imports the realm, so the
    ports cannot change without a reset.
    """
    requested = Endpoints(
        requested_port(environ, 'ACCLIMATE_LOCAL_PORT', DEFAULT_PORT) or DEFAULT_PORT,
        requested_port(environ, 'ACCLIMATE_LOCAL_MAIL_PORT', DEFAULT_MAIL_PORT) or DEFAULT_MAIL_PORT,
    )
    path = state / 'ports.json'
    saved = existing_file(path, 0o600) if state.exists() else None
    if saved is None:
        if save:
            write_file(path, (json.dumps(requested._asdict(), indent=2) + '\n').encode())
        return requested
    data = json.loads(saved)
    if (not isinstance(data, dict) or set(data) != set(Endpoints._fields)
            or any(type(value) is not int for value in data.values())):
        raise ValueError(f'Invalid local ports in {path}')
    current = Endpoints(**data)
    for name, field in (('ACCLIMATE_LOCAL_PORT', 'port'), ('ACCLIMATE_LOCAL_MAIL_PORT', 'mail_port')):
        value = environ.get(name)
        if value and int(value) != getattr(current, field):
            raise ValueError(f'This stack uses {name}={getattr(current, field)}. '
                             'Run npm run local:reset to change it.')
    return current


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


def write_application(state, values, subject, ports=DEFAULT):
    write_env(state / 'service.env', dict(
        DATABASE_URL=f"postgresql://acclimate:{values['postgres']}@postgres:5432/acclimate",
        ACCLIMATE_OIDC_ISSUER=ports.issuer,
        ACCLIMATE_LOGIN_TOKEN=values['login'],
        ACCLIMATE_CONSOLE_TOKEN=values['console'],
        ACCLIMATE_OPERATORS=json.dumps([dict(issuer=ports.issuer, subject=str(UUID(subject)))]),
        ACCLIMATE_AUTH=json.dumps([dict(token=values['evaluator'], principalId=PRINCIPAL,
                                        projectId=PROJECT, rights=['read', 'write'])]),
        ACCLIMATE_CONSOLE_ORIGIN=ports.console,
        ACCLIMATE_SMTP_HOST='mailpit',
        ACCLIMATE_SMTP_PORT=1025,
        ACCLIMATE_SMTP_FROM='Acclimate <noreply@acclimate.local>',
        ACCLIMATE_SMTP_TLS='none',
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
    config = dict(schemaVersion=1, serviceUrl=ports.api, projectId=PROJECT,
                  evaluatorPrincipalId=PRINCIPAL, evaluatorToken=values['evaluator'],
                  journalRoot=str(state / 'evaluator-journal'))
    write_file(state / 'evaluator.json', (json.dumps(config, indent=2) + '\n').encode())


def compose(root, *args, capture=False, ports=DEFAULT):
    suffix = hashlib.sha256(os.fsencode(root)).hexdigest()[:12]
    return subprocess.run(
        ['docker', 'compose', '--env-file', os.devnull, '--project-name',
         f'acclimate-local-{suffix}', '-f', 'compose.local.yaml', *args],
        cwd=root, check=True, stdout=subprocess.PIPE if capture else None,
        env={**os.environ, **ports.environment()},
    ).stdout


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


def up(root, state):
    directory(state, private=True)
    ports = endpoints(state)
    values = credentials(state)
    write_infrastructure(state, values, ports)
    # The service requires a nonempty operator list. Bring up identity first.
    compose(root, 'up', '--build', '--wait', '--wait-timeout', '300', 'proxy', 'mailpit', 'postgres',
            ports=ports)
    # The Caddyfile is bind-mounted, so Compose keeps a running proxy after it changes.
    compose(root, 'exec', '-T', 'proxy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile',
            '--adapter', 'caddyfile', ports=ports)
    ca = state / 'root.crt'
    certificate = compose(root, 'exec', '-T', 'proxy', 'cat',
                          '/data/caddy/pki/authorities/local/root.crt', capture=True, ports=ports)
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
    compose(root, 'up', '--build', '--wait', '--wait-timeout', '300', 'console', ports=ports)
    probe(opener, ports.api + '/ready', 'ready', True)
    probe(opener, ports.console + '/ready', 'status', 'ready')
    with opener.open(ports.console + '/auth/login', timeout=15) as response:
        if not response.geturl().startswith(ports.issuer + '/protocol/openid-connect/auth?'):
            raise ValueError('The console did not redirect sign-in to the local Keycloak issuer.')

    print(f'Console       {ports.console}\nLogin         {OPERATOR}\nAPI           {ports.api}')
    print(f'Mailpit       {ports.mailpit}\nEvaluator     {state / "evaluator.json"}\n'
          f'Local CA      {ca}')
    if previous_subject is None:
        print(f'Initial login password (printed once)  {values["operator"]}', flush=True)
        write_file(marker, subject.encode())
    print(f'Initial password is stored as "operator" in {state / "credentials.json"}.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('up', 'down', 'reset'))
    command = parser.parse_args().command
    try:
        with locked_state(ROOT) as state:
            if command == 'up':
                up(ROOT, state)
            elif command == 'down':
                compose(ROOT, 'down', ports=endpoints(state, save=False))
            else:
                if input(f'Delete this checkout’s local stack volumes and {state}? Type reset: ') != 'reset':
                    print('Reset canceled.')
                    return
                compose(ROOT, 'down', '--volumes', ports=endpoints(state, save=False))
                if state.exists():
                    shutil.rmtree(state)
    except EOFError:
        raise SystemExit('Reset canceled. Run interactively to confirm.') from None
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'Local stack {command} failed: {error}') from None


if __name__ == '__main__':
    main()
