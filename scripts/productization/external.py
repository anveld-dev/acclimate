#!/usr/bin/env python3
"""Opt-in external qualification. Default invocation performs no I/O or model calls."""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import time
from urllib.parse import urlsplit, quote
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[2]
GATES = ('https', 'oidc', 'remote-model', 'native-codex', 'native-claude', 'native-pi', 'native-cursor', 'container')


class Blocked(ValueError):
    """Only authored allowlisted diagnostics may be written to evidence."""


def native_process(command, config=None):
    process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    try:
        stdout, _ = process.communicate(json.dumps(config) if config else None, timeout=360)
        if process.returncode != 0:
            raise Blocked('Native session failed; verify the configured SDK authentication and Luna model support privately')
        if len(stdout) > 1024 * 1024:
            raise Blocked('Native evidence exceeded the size limit')
        return json.loads(stdout)
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        raise


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Authorization must never follow an endpoint-controlled redirect.
        raise Blocked('Redirect refused; configure the canonical HTTPS endpoint directly')


def https_url(value):
    parsed = urlsplit(value or '')
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise Blocked('Use an explicit HTTPS URL without credentials, query or fragment')
    return value.rstrip('/')


def matches_issuer(url, issuer):
    parsed, expected = urlsplit(url), urlsplit(issuer)
    return parsed.scheme == 'https' and parsed.netloc == expected.netloc


def returned_console(url, base):
    return url.startswith(base + '/') and urlsplit(url).path not in ('/auth/login', '/auth/callback')


def request(url, token=None, body=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    with build_opener(NoRedirect()).open(Request(url, headers=headers, data=json.dumps(body).encode() if body else None), timeout=30) as response:
        if urlsplit(response.url).scheme != 'https':
            raise Blocked('HTTPS downgrade')
        data = response.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise Blocked('Response too large')
        return data


def run(args):
    gate = args.gate
    if gate == 'https':
        base = https_url(args.url)
        token = os.environ.get(args.token_env) if args.token_env else None
        if not token or not args.project:
            raise Blocked('Requires --token-env and --project for authenticated readiness')
        assert request(base + '/health') == b'ok'
        assert json.loads(request(base + '/ready')) == {'ready': True}
        data = json.loads(request(base + '/v1/projects/' + quote(args.project, safe='') + '/bundles', token))
        assert isinstance(data.get('items'), list)
        return ['verified certificate/hostname', 'process liveness', 'database/owner/worker readiness', 'authenticated scoped bundle read']
    if gate == 'remote-model':
        if not args.live:
            raise Blocked('Paid gate requires --live')
        url = https_url(args.url)
        token = os.environ.get(args.token_env) if args.token_env else None
        if not token:
            raise Blocked('Requires --token-env')
        marker = secrets.token_hex(12)
        data = json.loads(request(url, token, dict(model='gpt-6-luna', max_tokens=128,
                    messages=[dict(role='user', content='Return exactly: ' + marker)])))
        choice = data['choices'][0]
        assert choice['finish_reason'] == 'stop' and marker in choice['message']['content']
        return ['direct remote TLS request', 'one bounded gpt-6-luna completion', 'successful finish and random marker']
    if gate == 'oidc':
        if not args.interactive:
            raise Blocked('OIDC requires --interactive and a test account to complete sign-in')
        from playwright.sync_api import sync_playwright
        base = https_url(args.url)
        https_url(args.issuer)
        issuer = args.issuer
        discovery = json.loads(request(issuer.rstrip('/') + '/.well-known/openid-configuration'))
        if discovery.get('issuer') != issuer:
            raise Blocked('OIDC discovery issuer differs from the explicitly configured issuer')
        authorization = https_url(discovery.get('authorization_endpoint'))
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            try:
                context = browser.new_context()
                page = context.new_page()
                observed_authorization = []
                page.on('request', lambda request: observed_authorization.append(True)
                        if request.is_navigation_request() and matches_issuer(request.url, authorization) else None)
                page.goto(base + '/auth/login')
                if not observed_authorization:
                    raise Blocked('Console did not navigate to the discovered HTTPS authorization endpoint')
                print('Complete the provider sign-in using the disposable qualification account.', flush=True)
                page.wait_for_url(lambda url: returned_console(url, base), timeout=180000)
                cookies = [c for c in context.cookies() if c['name'] == 'acclimate_session']
                assert len(cookies) == 1 and cookies[0]['secure'] and cookies[0]['httpOnly'] and cookies[0]['sameSite'] == 'Lax'
                response = context.request.post(base + '/auth/logout', headers={'Origin': base}, max_redirects=0)
                assert response.status == 303
                assert not any(c['name'] == 'acclimate_session' for c in context.cookies())
            finally:
                browser.close()
        return ['real provider redirect and callback', 'secure session cookie', 'logout cleared cookie']
    if gate.startswith('native-'):
        if not args.live:
            raise Blocked('Native provider gate requires --live; only gpt-6-luna is permitted')
        if gate == 'native-codex':
            evidence = native_process(['node', '--import', 'tsx', 'examples/codex-session-check.ts'])
            assert evidence['model'] == 'gpt-6-luna' and len(evidence['observations']) == 3
            for row in evidence['observations']:
                assert all(row['expectedMarkersPresent'].values()) and not any(row['otherVersionMarkersPresent'].values())
            return ['actual Codex SDK', 'three Luna turns', 'prepared instruction/skill/memory markers', 'resumed old workspace stayed pinned']
        driver = args.driver or ['node', '--import', 'tsx', 'scripts/productization/native-driver.mjs', '--live']
        # Explicit installed driver owns provider credentials/session APIs. No shell,
        # downloads or request-selected executable. It must exercise all resources
        # and pinning; a mocked driver cannot qualify a live provider.
        config = {'schemaVersion': 1, 'provider': gate.removeprefix('native-'), 'model': 'gpt-6-luna',
                  'maxTurns': 3, 'marker': secrets.token_hex(16)}
        evidence = native_process(driver, config)
        assert evidence['provider'] == config['provider'] and evidence['model'] == config['model'] and evidence['marker'] == config['marker']
        assert evidence['actualProviderSession'] is True
        assert all(evidence['checks'].get(k) is True for k in ('instruction', 'skill', 'memory', 'freshVersion', 'oldWorkspacePinned'))
        return ['actual installed native SDK session driver', 'Luna only; three sessions, at most three assistant turns each', 'instruction/skill/memory', 'fresh version and old workspace pin']
    if gate == 'container':
        from container_check import qualify
        return qualify()
    raise Blocked('Unknown gate')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gate', choices=GATES)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--interactive', action='store_true')
    for flag in ('url', 'issuer', 'project', 'token-env'):
        parser.add_argument('--' + flag)
    parser.add_argument('--driver', nargs='+')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    result = {'schemaVersion': 1, 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'gates': {gate: {'status': 'not run', 'reason': 'Requires explicit --execute and configured external resources'} for gate in GATES},
              'publication': {'status': 'not run', 'reason': 'Separate explicit release action'}}
    if args.execute:
        if not args.gate:
            parser.error('--execute requires --gate')
        try:
            checks = run(args)
            result['gates'][args.gate] = {'status': 'passed', 'checks': checks}
        except Exception as error:
            # Do not retain provider output, endpoint responses, cookies or tokens.
            reason = str(error) if isinstance(error, Blocked) else type(error).__name__ + ': inspect the configured resource privately'
            result['gates'][args.gate] = {'status': 'blocked', 'reason': reason}
    text = json.dumps(result, indent=2) + '\n'
    if args.output:
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(text)
    print(text, end='')
    return int(args.execute and result['gates'][args.gate]['status'] != 'passed')


if __name__ == '__main__':
    raise SystemExit(main())
