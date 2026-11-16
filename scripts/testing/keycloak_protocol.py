#!/usr/bin/env python3
"""Real Keycloak/console OIDC check on disposable PostgreSQL, without Docker or models.

Requires an explicitly supplied Keycloak 26.8.2 distribution and Java21 home.
Checks built and Vite consoles by default, each with a fresh database and server.
Copies the distribution before building it; never changes a caller's installation.
Browser TLS exceptions are limited to this disposable context. Node verifies the
test CA. No credential or raw upstream diagnostic is written to the report.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import ssl
import subprocess
import sys
import time
import uuid
from urllib.request import urlopen
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT = Path(__file__).resolve().parents[2]
if sys.version_info < (3, 11) and (ROOT/'.venv-bdd/bin/python').exists():
    executable = ROOT/'.venv-bdd/bin/python'
    os.execv(str(executable), [str(executable), __file__, *sys.argv[1:]])
sys.path.insert(0, str(ROOT))
from scripts.productization.qualify import Harness, port
from scripts.testing.identity import TLSProxy


def stop(process):
    if process and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            process.wait(timeout=10)
            return
        try:
            process.wait(timeout=45)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=10)


def wait_url(url, process, timeout=180, ca=None):
    deadline = time.monotonic()+timeout
    context = ssl.create_default_context(cafile=str(ca)) if ca else None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('Owned process exited before readiness')
        try:
            with urlopen(url, timeout=2, context=context) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(.2)
    raise RuntimeError('Owned process readiness timed out')


def qualify(args):
    from playwright.sync_api import sync_playwright
    source = args.keycloak_home.resolve()
    java = args.java_home.resolve()
    if not (source/'bin/kc.sh').is_file() or not (java/'bin/java').is_file():
        raise RuntimeError('Explicit Keycloak distribution and Java home are required')
    h = Harness(args.pg_bin)
    kc = console = auth_proxy = console_proxy = mailpit = None
    logs = []
    stage = 'prepare'
    try:
        home = h.dir/'keycloak'
        shutil.copytree(source, home)
        theme = ROOT/'apps/keycloak-theme/dist_keycloak/acclimate-keycloak-theme.jar'
        if not theme.is_file():
            raise RuntimeError('Build the sign-in theme first: npm run build:theme')
        shutil.copyfile(theme, home/'providers/acclimate-keycloak-theme.jar')
        kc_port, management_port, console_port = port(), port(), port()
        auth_proxy = TLSProxy(h.dir/'auth-tls', f'http://127.0.0.1:{kc_port}', forwarded=True)
        console_proxy = TLSProxy(h.dir/'console-tls', f'http://127.0.0.1:{console_port}')
        issuer = auth_proxy.base+'/realms/acclimate'
        users = {name: str(uuid.uuid4()) for name in ('operator', 'viewer')}
        passwords = {name: secrets.token_urlsafe(32) for name in users}
        client_secret = secrets.token_urlsafe(32)
        h.env.update(ACCLIMATE_OIDC_ISSUER=issuer,
                     ACCLIMATE_OPERATORS=json.dumps([dict(issuer=issuer, subject=users['operator'])]))
        if getattr(args, 'email', False):
            from scripts.mailpit import binary
            smtp_port, inbox_port = port(), port()
            mail_log = open(h.dir/'mailpit.log', 'w'); logs.append(mail_log)
            mailpit = subprocess.Popen([str(binary()), '--smtp', f'127.0.0.1:{smtp_port}', '--listen', f'127.0.0.1:{inbox_port}', '--database', str(h.dir/'messages.db'), '--disable-version-check', '--quiet'],
                env={key:value for key,value in os.environ.items() if not key.startswith('MP_')}, stdout=mail_log, stderr=mail_log, start_new_session=True)
            wait_url(f'http://127.0.0.1:{inbox_port}/livez', mailpit)
            h.env.update(ACCLIMATE_SMTP_HOST='127.0.0.1', ACCLIMATE_SMTP_PORT=str(smtp_port), ACCLIMATE_SMTP_TLS='none', ACCLIMATE_SMTP_FROM='Acclimate <noreply@acclimate.local>', ACCLIMATE_CONSOLE_ORIGIN=console_proxy.base)
        h.start()
        h.sql('CREATE DATABASE keycloak')
        # The real Keycloak importer expands the production template's placeholders.
        realm = json.loads((ROOT/'deploy/keycloak/acclimate-realm.json').read_text())
        if getattr(args, 'email', False):
            realm.update(registrationAllowed=True, registrationEmailAsUsername=True, verifyEmail=True, resetPasswordAllowed=True,
                smtpServer=dict(host='127.0.0.1',port=str(smtp_port), **{'from':'noreply@acclimate.local'},fromDisplayName='Acclimate',ssl='false',starttls='false',auth='false'))
        realm['users'] = [dict(id=users[name], username=name, enabled=True,
                              email=name+'@fixture.invalid', emailVerified=True,
                              firstName=name, lastName='Qualification',
                              credentials=[dict(type='password', value=passwords[name], temporary=False)])
                          for name in users]
        imports = home/'data/import'
        imports.mkdir(parents=True, exist_ok=True, mode=0o700)
        realm_path = imports/'acclimate-realm.json'
        realm_path.write_text(json.dumps(realm))
        realm_path.chmod(0o600)
        env = {k: v for k, v in h.env.items()
               if not k.startswith(('KC_', 'KEYCLOAK_', 'JAVA_', 'JDK_', 'CONSOLE_'))}
        env.update(JAVA_HOME=str(java), KC_DB='postgres',
                   KC_DB_URL=f'jdbc:postgresql://127.0.0.1:{h.pg_port}/keycloak',
                   KC_DB_USERNAME='qualification', KC_DB_PASSWORD='', KC_HEALTH_ENABLED='true',
                   KC_METRICS_ENABLED='true', KC_HTTP_ENABLED='true', KC_HTTP_HOST='127.0.0.1',
                   KC_HTTP_PORT=str(kc_port), KC_HTTP_MANAGEMENT_HOST='127.0.0.1',
                   KC_HTTP_MANAGEMENT_PORT=str(management_port), KC_HTTP_MANAGEMENT_SCHEME='http',
                   KC_HOSTNAME=auth_proxy.base, KC_HOSTNAME_STRICT='true', KC_PROXY_HEADERS='xforwarded',
                   KC_BOOTSTRAP_ADMIN_USERNAME='fixture-bootstrap',
                   KC_BOOTSTRAP_ADMIN_PASSWORD=secrets.token_urlsafe(32),
                   ACCLIMATE_CONSOLE_ORIGIN=console_proxy.base,
                   ACCLIMATE_OIDC_CLIENT_SECRET=client_secret,
                   JAVA_OPTS='-Xms64m -Xmx768m -XX:MaxMetaspaceSize=384m')
        kc_log = open(h.dir/'keycloak.log', 'w')
        logs.append(kc_log)
        stage = 'build-keycloak'
        subprocess.run([str(home/'bin/kc.sh'), 'build'], env=env, stdout=kc_log,
                       stderr=kc_log, check=True, timeout=180)
        stage = 'verify-keycloak-version'
        version = subprocess.run([str(home/'bin/kc.sh'), '--version'], env=env,
                                 capture_output=True, text=True, check=True, timeout=30)
        reported_version = re.search(r'\bKeycloak\s+(\d+\.\d+\.\d+)\b', version.stdout)
        assert reported_version and reported_version.group(1) == '26.8.2'

        def start_kc():
            process = subprocess.Popen([str(home/'bin/kc.sh'), 'start', '--optimized',
                                        '--cache=local', '--import-realm'], env=env,
                                       stdout=kc_log, stderr=kc_log, start_new_session=True)
            try:
                wait_url(f'http://127.0.0.1:{management_port}/health/ready', process)
                wait_url(issuer+'/.well-known/openid-configuration', process, ca=auth_proxy.ca_path)
            except BaseException:
                stop(process)
                raise
            return process

        stage = 'start-keycloak'
        kc = start_kc()
        # Prove identity rows were written to PostgreSQL rather than a fallback database.
        keycloak_database = h.env['DATABASE_URL'].rsplit('/', 1)[0]+'/keycloak'
        stored_users = h.pg('psql', keycloak_database, '-XAt', '-v', 'ON_ERROR_STOP=1',
                           '-c', "SELECT count(*) FROM public.user_entity WHERE username IN ('operator','viewer')").stdout.strip()
        assert stored_users == '2'
        ca = h.dir/'console-trust.pem'
        ca.write_bytes(auth_proxy.ca_path.read_bytes()+console_proxy.ca_path.read_bytes())
        console_env = dict(h.env, HOST='127.0.0.1', PORT=str(console_port),
                           CONSOLE_ORIGIN=console_proxy.base, CONSOLE_SERVICE_URL=h.base,
                           CONSOLE_PUBLIC_API_URL=console_proxy.base,
                           CONSOLE_OIDC_ISSUER=issuer, CONSOLE_OIDC_CLIENT_ID='acclimate-console',
                           CONSOLE_OIDC_CLIENT_SECRET=client_secret,
                           CONSOLE_LOGIN_TOKEN=h.login_token, CONSOLE_SERVICE_TOKEN=h.console_token,
                           CONSOLE_ALLOW_EDITS='true', NODE_EXTRA_CA_CERTS=str(ca))
        console_log = open(h.dir/'console.log', 'w')
        logs.append(console_log)
        stage = 'start-console'
        command = (['node', str(ROOT/'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1',
                    '--port', str(console_port), '--strictPort'] if args.runtime == 'vite'
                   else ['node', '.output/server/index.mjs'])
        console = subprocess.Popen(command, cwd=ROOT/'apps/console',
                                   env=console_env, stdout=console_log, stderr=console_log,
                                   start_new_session=True)
        wait_url(console_proxy.base+'/health', console, ca=ca)
        checks = []
        def record_check(message):
            checks.append(message)
            print(args.runtime+': '+message, flush=True)
        stage = 'browser-login'
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                errors = []
                contexts = {}
                def login(name, context=None, credentials=True):
                    nonlocal stage
                    stage = 'login-'+name+'-credentials'
                    context = context or browser.new_context(ignore_https_errors=True)
                    contexts[name] = context
                    page = context.new_page()
                    page.on('pageerror', lambda error: errors.append(type(error).__name__))
                    callbacks = []
                    page.on('response', lambda response: callbacks.append(response.url)
                            if response.url.startswith(console_proxy.base+'/auth/callback?') else None)
                    page.goto(console_proxy.base+'/auth/login')
                    if credentials:
                        page.locator('input[name="username"]').fill(name)
                        page.locator('input[name="password"]').fill(passwords[name])
                        page.locator('#kc-login').click()
                    stage = 'login-'+name+'-callback'
                    page.wait_for_url(lambda url: url.startswith(console_proxy.base+'/') and
                                      '/auth/' not in url, timeout=30000)
                    page.wait_for_load_state('networkidle')
                    cookie = next(c for c in context.cookies(console_proxy.base)
                                  if c['name'] == 'acclimate_session')
                    assert cookie['secure'] and cookie['httpOnly'] and cookie['sameSite'] == 'Lax'
                    assert 0 < cookie['expires']-time.time() <= 28800
                    assert len(callbacks) == 1
                    assert context.request.get(callbacks[0], max_redirects=0).status == 400
                    page.close()
                    return cookie['value']

                def api(context, secret, method, route, body=None):
                    return context.request.fetch(h.base+route, method=method, data=body,
                        headers={'Authorization': 'Bearer '+h.console_token,
                                 'X-Acclimate-Session': secret})

                stage = 'rejected-credentials'
                denied_context = browser.new_context(ignore_https_errors=True)
                denied_page = denied_context.new_page()
                denied_page.goto(console_proxy.base+'/')
                denied_page.locator('[data-acclimate-theme="keycloakify"]').wait_for(state='visible')
                assert denied_page.get_by_role('heading',name='Sign in to Acclimate',exact=True).is_visible()
                assert denied_page.locator('input[name="username"]').get_attribute('autocomplete') == 'username'
                assert denied_page.locator('input[name="password"]').get_attribute('autocomplete') == 'current-password'
                record_check('packaged Keycloakify theme serves the branded sign-in form with native password-manager fields')
                denied_page.locator('input[name="username"]').fill('viewer')
                denied_page.locator('input[name="password"]').fill(secrets.token_urlsafe(32))
                denied_page.locator('#kc-login').click()
                denied_page.locator('input[name="username"][aria-invalid="true"]').wait_for(state='visible')
                assert not any(c['name'] == 'acclimate_session'
                               for c in denied_context.cookies(console_proxy.base))
                assert urlsplit(denied_page.url).netloc == urlsplit(auth_proxy.base).netloc
                denied_context.close()
                record_check('wrong Keycloak password cannot create an application session')

                operator = login('operator')
                stage = 'operator-session'
                admin_context = contexts['operator']
                session = api(admin_context, operator, 'GET', '/v1/auth/session')
                assert session.status == 200
                person = session.json()
                assert person['issuer'] == issuer and person['subject'] == users['operator']
                assert person['displayName'] == 'operator Qualification'
                assert person['canCreateWorkspace'] is True
                record_check('real Keycloak login, exact issuer/subject, bounded secure cookie and callback replay denial')
                stage = 'reauthentication'
                previous = operator
                operator = login('operator', admin_context, credentials=False)
                assert operator != previous
                assert api(admin_context, previous, 'GET', '/v1/auth/session').status == 401
                assert api(admin_context, operator, 'GET', '/v1/auth/session').json()['userId'] == person['userId']
                record_check('Keycloak SSO reauthentication rotates and revokes the prior Rust session')
                stage = 'client-policies'
                authorization = issuer+'/protocol/openid-connect/auth'
                missing_pkce = dict(client_id='acclimate-console',
                    redirect_uri=console_proxy.base+'/auth/callback', response_type='code',
                    scope='openid', state=secrets.token_urlsafe(24), nonce=secrets.token_urlsafe(24))
                denied = admin_context.request.get(authorization+'?'+urlencode(missing_pkce), max_redirects=0)
                if denied.status in (302, 303):
                    # OAuth errors may return to an already validated callback.
                    location = urlsplit(denied.headers['location'])
                    query = parse_qs(location.query)
                    assert location.scheme+'://'+location.netloc+location.path == console_proxy.base+'/auth/callback'
                    assert query.get('error') == ['invalid_request'] and 'code' not in query
                    assert query.get('state') == [missing_pkce['state']]
                else:
                    assert denied.status == 400
                wrong_redirect = dict(missing_pkce, redirect_uri='https://untrusted.invalid/auth/callback',
                                      code_challenge='a'*43, code_challenge_method='S256')
                denied = admin_context.request.get(authorization+'?'+urlencode(wrong_redirect), max_redirects=0)
                assert denied.status == 400
                record_check('production environment placeholders resolved; missing PKCE and unregistered callback rejected')
                token_endpoint = issuer+'/protocol/openid-connect/token'
                for grant, expected_status in (('password', 400), ('client_credentials', 401)):
                    stage = 'disabled-'+grant+'-grant'
                    denied = admin_context.request.post(token_endpoint, form=dict(
                        client_id='acclimate-console', client_secret=client_secret,
                        grant_type=grant, username='viewer', password=passwords['viewer']))
                    assert denied.status == expected_status
                    assert denied.json().get('error') == 'unauthorized_client'
                    assert 'access_token' not in denied.json()
                record_check('password and service-account grants rejected by the real confidential client')
                project = 'keycloak-'+uuid.uuid4().hex
                stage = 'operator-workspace'
                created = api(admin_context, operator, 'POST', '/v1/projects', dict(id=project, name='Keycloak qualification'))
                assert created.status in (200, 201)
                viewer = login('viewer')
                stage = 'viewer-membership'
                viewer_context = contexts['viewer']
                viewer_person = api(viewer_context, viewer, 'GET', '/v1/auth/session').json()
                assert viewer_person['subject'] == users['viewer']
                assert viewer_person['canCreateWorkspace'] is False
                assert api(viewer_context, viewer, 'GET', f'/v1/projects/{project}/bundles').status == 403
                membership = api(admin_context, operator, 'PUT',
                    f'/v1/projects/{project}/memberships/{viewer_person["userId"]}',
                    dict(role='viewer'))
                assert membership.status in (200, 201, 204)
                assert api(viewer_context, viewer, 'GET', f'/v1/projects/{project}/bundles').status == 200
                assert api(viewer_context, viewer, 'POST', '/v1/projects',
                           dict(id=project+'-denied', name='Denied')).status == 403
                record_check('ordinary verified user denied before membership, viewer read and creation denial')
                if getattr(args, 'email', False):
                    stage = 'email-invitation-and-verified-signup'
                    from scripts.testing.keycloak_email import check_email_join
                    check_email_join(browser=browser, admin_context=admin_context, console_origin=console_proxy.base,
                        issuer=issuer, project=project, inbox=f'http://127.0.0.1:{inbox_port}', api=api,
                        admin_secret=operator, record=record_check, output=args.report.parent/(args.runtime+'-emails'))
                stage = 'membership-removal'
                removed = api(admin_context, operator, 'DELETE',
                    f'/v1/projects/{project}/memberships/{viewer_person["userId"]}')
                assert removed.status == 204
                assert api(viewer_context, viewer, 'GET', f'/v1/projects/{project}/bundles').status == 403
                assert api(viewer_context, viewer, 'GET', '/v1/auth/session').status == 200
                record_check('membership removal denies workspace access immediately with the same valid Keycloak-backed session')
                stage = 'restart-keycloak'
                stop(kc)
                # A JVM can report the normal terminating signal as143/-15.
                # SIGKILL, a timeout fallback, or any other exit remains a failure.
                restart_exit = kc.returncode
                assert restart_exit in (0, -signal.SIGTERM, 128+signal.SIGTERM)
                # Initial import is not a live configuration/secret rotation mechanism.
                env['ACCLIMATE_OIDC_CLIENT_SECRET'] = secrets.token_urlsafe(32)
                env['ACCLIMATE_CONSOLE_ORIGIN'] = 'https://changed.invalid'
                kc = start_kc()
                # A fresh browser proves user/client persistence after PostgreSQL-backed restart.
                fresh = login('operator')
                fresh_context = contexts['operator']
                assert api(fresh_context, fresh, 'GET', '/v1/auth/session').json()['userId'] == person['userId']
                record_check('restart preserves PostgreSQL users/client/application identity and skips changed import values')
                stage = 'logout-csrf'
                rejected = fresh_context.request.post(console_proxy.base+'/auth/logout',
                    headers={'Origin': 'https://untrusted.invalid'}, max_redirects=0)
                assert rejected.status == 403
                assert next(c['value'] for c in fresh_context.cookies(console_proxy.base)
                            if c['name'] == 'acclimate_session') == fresh
                assert api(fresh_context, fresh, 'GET', '/v1/auth/session').status == 200
                record_check('cross-site logout rejected without revoking the application session')
                stage = 'logout'
                logout = fresh_context.request.post(console_proxy.base+'/auth/logout',
                    headers={'Origin': console_proxy.base}, max_redirects=0)
                assert logout.status == 303
                assert not any(c['name'] == 'acclimate_session' for c in fresh_context.cookies(console_proxy.base))
                assert api(fresh_context, fresh, 'GET', '/v1/auth/session').status == 401
                record_check('app logout clears secure cookie and revokes real Rust session')
                assert logout.headers['location'] == '/auth/login?prompt=login'
                signed_out = fresh_context.new_page()
                signed_out.goto(console_proxy.base + logout.headers['location'])
                signed_out.locator('input[name="password"]').wait_for(state='visible')
                assert urlsplit(signed_out.url).netloc == urlsplit(auth_proxy.base).netloc
                signed_out.close()
                record_check('logout returns to the branded credential form instead of automatically reopening the app')
                stage = 'sso-after-app-logout'
                signed_in_again = login('operator', fresh_context, credentials=False)
                assert signed_in_again != fresh
                assert api(fresh_context, signed_in_again, 'GET', '/v1/auth/session').json()['userId'] == person['userId']
                assert api(fresh_context, fresh, 'GET', '/v1/auth/session').status == 401
                record_check('app logout preserves Keycloak SSO; signing in again creates a new Rust session')
                required = {'/realms/acclimate/.well-known/openid-configuration',
                            '/realms/acclimate/protocol/openid-connect/auth',
                            '/realms/acclimate/protocol/openid-connect/token',
                            '/realms/acclimate/protocol/openid-connect/certs'}
                assert required.issubset(set(auth_proxy.requests))
                assert not errors
                record_check('real discovery/token/JWKS requests and no browser runtime errors')
            finally:
                browser.close()
        return dict(passed=True, executedAt=datetime.now(timezone.utc).isoformat(),
                    keycloakVersion=reported_version.group(1), runtime=args.runtime,
                    server='native copied distribution, Java21',
                    database='owned PostgreSQL', verifiedIdentityRows=2, issuerTLS='test-owned CA', checks=checks,
                    restartSigtermExitCode=restart_exit,
                    dockerExecuted=False, publicDeploymentQualified=False, modelCalls=0)
    except Exception as error:
        raise RuntimeError('Keycloak qualification failed at '+stage+' ('+type(error).__name__+'); no raw private diagnostics retained') from None
    finally:
        cleanup_failed = False
        # Every owned resource gets cleanup even if an earlier process already died.
        for cleanup in [lambda: stop(console), lambda: stop(kc), lambda: stop(mailpit),
                        lambda: console_proxy.close() if console_proxy else None,
                        lambda: auth_proxy.close() if auth_proxy else None,
                        h.close, *[log.close for log in logs]]:
            try:
                cleanup()
            except Exception:
                cleanup_failed = True
        if cleanup_failed:
            raise RuntimeError('Owned Keycloak fixture cleanup failed; no private diagnostics retained') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--keycloak-home', type=Path, required=True)
    parser.add_argument('--java-home', type=Path, required=True)
    parser.add_argument('--pg-bin', required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--email', action='store_true', help='Also check real Mailpit delivery, native email invite UI and Keycloak verified signup')
    parser.add_argument('--runtime', choices=['built', 'vite', 'both'], default='both')
    args = parser.parse_args()
    if args.report.exists():
        parser.error('Report already exists; use a fresh output path')
    results = {}
    for runtime in (['built', 'vite'] if args.runtime == 'both' else [args.runtime]):
        print('Checking real Keycloak with '+runtime+' console…', flush=True)
        results[runtime] = qualify(argparse.Namespace(**dict(vars(args), runtime=runtime)))
    evidence = dict(schemaVersion=2, passed=True, executedAt=datetime.now(timezone.utc).isoformat(),
                    runtimes=results, dockerExecuted=False, publicDeploymentQualified=False, modelCalls=0)
    args.report.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(args.report, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(evidence, stream, indent=2)
        stream.write('\n')
    print('Real Keycloak login, membership, restart and logout checks passed. No public deployment or models.')


if __name__ == '__main__':
    main()
