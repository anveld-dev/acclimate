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
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener
from uuid import UUID

from scripts.configure_dev_mail import mail_settings


ROOT = Path(__file__).resolve().parents[2]
CONSOLE = 'https://localhost:3443'
API = 'https://127.0.0.1:3444'
KEYCLOAK = 'https://127.0.0.1:3445'
ISSUER = KEYCLOAK + '/realms/acclimate'
DISCOVERY = ISSUER + '/.well-known/openid-configuration'
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


def write_infrastructure(state, values):
    for secret in ('postgres', 'keycloak_postgres'):
        write_file(state / (secret.replace('_', '-') + '-password'), values[secret].encode() + b'\n')
    write_env(state / 'keycloak.env', dict(
        KC_DB_PASSWORD=values['keycloak_postgres'],
        KC_BOOTSTRAP_ADMIN_USERNAME=ADMIN,
        KC_BOOTSTRAP_ADMIN_PASSWORD=values['keycloak_admin'],
        ACCLIMATE_CONSOLE_ORIGIN=CONSOLE,
        ACCLIMATE_OIDC_CLIENT_SECRET=values['oidc_client'],
    ))


def write_application(state, values, subject):
    write_env(state / 'service.env', dict(
        DATABASE_URL=f"postgresql://acclimate:{values['postgres']}@postgres:5432/acclimate",
        ACCLIMATE_OIDC_ISSUER=ISSUER,
        ACCLIMATE_LOGIN_TOKEN=values['login'],
        ACCLIMATE_CONSOLE_TOKEN=values['console'],
        ACCLIMATE_OPERATORS=json.dumps([dict(issuer=ISSUER, subject=str(UUID(subject)))]),
        ACCLIMATE_AUTH=json.dumps([dict(token=values['evaluator'], principalId=PRINCIPAL,
                                        projectId=PROJECT, rights=['read', 'write'])]),
        ACCLIMATE_CONSOLE_ORIGIN=CONSOLE,
        ACCLIMATE_SMTP_HOST='mailpit',
        ACCLIMATE_SMTP_PORT=1025,
        ACCLIMATE_SMTP_FROM='Acclimate <noreply@acclimate.local>',
        ACCLIMATE_SMTP_TLS='none',
    ))
    write_env(state / 'console.env', dict(
        CONSOLE_ORIGIN=CONSOLE,
        CONSOLE_SERVICE_URL='http://127.0.0.1:3000',
        CONSOLE_PUBLIC_API_URL=API,
        CONSOLE_OIDC_ISSUER=ISSUER,
        CONSOLE_OIDC_CLIENT_ID=CLIENT,
        CONSOLE_OIDC_CLIENT_SECRET=values['oidc_client'],
        CONSOLE_LOGIN_TOKEN=values['login'],
        CONSOLE_SERVICE_TOKEN=values['console'],
        CONSOLE_ALLOW_EDITS='true',
    ))
    config = dict(schemaVersion=1, serviceUrl=API, projectId=PROJECT,
                  evaluatorPrincipalId=PRINCIPAL, evaluatorToken=values['evaluator'],
                  journalRoot=str(state / 'evaluator-journal'))
    write_file(state / 'evaluator.json', (json.dumps(config, indent=2) + '\n').encode())


def compose(root, *args, capture=False):
    suffix = hashlib.sha256(os.fsencode(root)).hexdigest()[:12]
    return subprocess.run(
        ['docker', 'compose', '--env-file', os.devnull, '--project-name',
         f'acclimate-local-{suffix}', '-f', 'compose.local.yaml', *args],
        cwd=root, check=True, stdout=subprocess.PIPE if capture else None,
    ).stdout


def keycloak_operator(opener, values, expected_subject=None):
    token_url = KEYCLOAK + '/realms/master/protocol/openid-connect/token'
    form = urlencode(dict(client_id='admin-cli', grant_type='password',
                         username=ADMIN, password=values['keycloak_admin'])).encode()
    with opener.open(Request(token_url, data=form), timeout=15) as response:
        token = json.load(response)['access_token']
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    realm = KEYCLOAK + '/admin/realms/acclimate'
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
    values = credentials(state)
    write_infrastructure(state, values)
    # The service requires a nonempty operator list. Bring up identity first.
    compose(root, 'up', '--build', '--wait', '--wait-timeout', '300', 'proxy', 'mailpit', 'postgres')
    ca = state / 'root.crt'
    certificate = compose(root, 'exec', '-T', 'proxy', 'cat',
                          '/data/caddy/pki/authorities/local/root.crt', capture=True)
    context = ssl.create_default_context(cadata=certificate.decode())
    write_file(ca, certificate, mode=0o644)
    opener = build_opener(ProxyHandler({}), HTTPSHandler(context=context))
    probe(opener, DISCOVERY, 'issuer', ISSUER)
    marker = state / 'operator-subject'
    saved_subject = existing_file(marker, 0o600)
    previous_subject = saved_subject.decode() if saved_subject is not None else None
    subject = keycloak_operator(opener, values, previous_subject)
    write_application(state, values, subject)
    # Compose recreates the service when its effective environment changes.
    compose(root, 'up', '--build', '--wait', '--wait-timeout', '300', 'console')
    probe(opener, API + '/ready', 'ready', True)
    probe(opener, CONSOLE + '/ready', 'status', 'ready')
    with opener.open(CONSOLE + '/auth/login', timeout=15) as response:
        if not response.geturl().startswith(ISSUER + '/protocol/openid-connect/auth?'):
            raise ValueError('The console did not redirect sign-in to the local Keycloak issuer.')

    print(f'Console       {CONSOLE}\nLogin         {OPERATOR}\nAPI           {API}')
    print(f'Mailpit       http://localhost:8025\nEvaluator     {state / "evaluator.json"}\n'
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
                compose(ROOT, 'down')
            else:
                if input(f'Delete this checkout’s local stack volumes and {state}? Type reset: ') != 'reset':
                    print('Reset canceled.')
                    return
                compose(ROOT, 'down', '--volumes')
                if state.exists():
                    shutil.rmtree(state)
    except EOFError:
        raise SystemExit('Reset canceled. Run interactively to confirm.') from None
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'Local stack {command} failed: {error}') from None


if __name__ == '__main__':
    main()
