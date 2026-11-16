#!/usr/bin/env python3
"""Real built/Vite OIDC/TLS regression gate against one owned private PostgreSQL.

Uses the default production openid-client and browser authorization flow. Browser
contexts use a context-wide TLS exception for the generated localhost test
issuer and proxy; Node discovery/JWKS/token HTTPS verifies the explicit fixture CA.
Fixture success does not qualify any external identity provider or deployment.
"""
import argparse
from datetime import datetime, timezone
import json
import os
import ssl
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, build_opener, HTTPSHandler, HTTPRedirectHandler

ROOT = Path(__file__).resolve().parents[2]
if sys.version_info < (3,11) and (ROOT/'.venv-bdd/bin/python').exists():
    executable=ROOT/'.venv-bdd/bin/python'
    os.execv(str(executable),[str(executable),__file__,*sys.argv[1:]])
if str(ROOT) not in sys.path: sys.path.insert(0,str(ROOT))
from scripts.bdd.world import World
from scripts.bdd.browser import BrowserFixture


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_): return None


def checks(browser):
    context=browser.context
    issuer=browser.identity
    def cookie():
        return next((c for c in context.cookies(browser.base) if c['name']=='acclimate_session'),None)
    assert cookie(), 'Normal OIDC browser login must create a session'
    assert all(path in issuer.requests for path in ['/.well-known/openid-configuration','/authorize','/token','/jwks']), 'Actual provider must discover, exchange code and verify JWKS'
    original=cookie()['value']
    browser.sign_in(context)
    assert cookie()['value'] != original, 'Normal reauthentication must rotate session'
    # Read former and current sessions through the dedicated console transport.
    def session(secret):
        return context.request.get(browser.world.h.base+'/v1/auth/session',headers={
            'Authorization':'Bearer '+browser.world.console_token,'X-Acclimate-Session':secret})
    assert session(original).status == 401
    assert session(cookie()['value']).status == 200
    assert context.request.post(browser.base+'/auth/logout',headers={'Origin':'https://untrusted.invalid'}).status == 403
    assert cookie()
    logged_out = cookie()['value']
    assert context.request.post(browser.base+'/auth/logout',headers={'Origin':browser.origin},max_redirects=0).status == 303
    assert cookie() is None
    assert session(logged_out).status == 401, 'Logout must revoke the actual Rust session'
    for invalid in ['nonce','issuer','signature','state']:
        context.clear_cookies()
        page=context.new_page()
        assert page.goto(browser.base+'/auth/login').status == 200
        if invalid == 'nonce': issuer.next_token_claims={'nonce':'wrong-nonce'}
        elif invalid == 'issuer': issuer.next_token_claims={'iss':'https://untrusted.invalid'}
        elif invalid == 'signature': issuer.next_token_bad_signature=True
        else: page.locator('input[name="state"]').evaluate('(element) => element.value = "wrong-state"')
        exchanges_before = issuer.requests.count('/token')
        with page.expect_response(lambda response:'/auth/callback?' in response.url) as callback:
            page.get_by_role('button',name='Sign in to fixture').click()
        assert issuer.requests.count('/token') == exchanges_before + (0 if invalid == 'state' else 1), 'Invalid '+invalid+' must fail at its intended verification stage'
        assert not issuer.next_token_claims and not issuer.next_token_bad_signature, 'Token verification fault must actually reach the real OIDC client'
        assert callback.value.status in (400,503), 'Invalid '+invalid+' must fail closed'
        assert cookie() is None, 'Invalid '+invalid+' must not create a session'
        page.close()
    # Successful transaction callback is single use.
    page=context.new_page()
    page.goto(browser.base+'/auth/login')
    with page.expect_response(lambda response:'/auth/callback?' in response.url) as callback:
        page.get_by_role('button',name='Sign in to fixture').click()
    assert callback.value.status == 303
    assert context.request.get(callback.value.url,max_redirects=0).status == 400
    page.close()
    opener=build_opener(NoRedirect(),HTTPSHandler(context=ssl.create_default_context(cafile=str(browser.ca_path))))
    def raw(headers):
        try: return opener.open(Request(browser.base+'/auth/login',headers=headers))
        except HTTPError as response: return response
    spoof=raw({'Forwarded':'host=evil.invalid;proto=http','X-Forwarded-Host':'evil.invalid','X-Forwarded-Proto':'http'})
    assert spoof.status == 303
    redirect=parse_qs(urlsplit(spoof.headers['Location']).query)['redirect_uri'][0]
    assert redirect == browser.origin+'/auth/callback', 'Proxy header spoof must not change callback origin'
    rejected = raw({'Host':'evil.invalid'})
    assert rejected.status in (400,403), 'Noncanonical Host must be rejected: status '+str(rejected.status)
    assert not browser.errors, 'Browser runtime errors during production identity gate'
    return ['real discovery/code/JWKS/signature/PKCE/state/nonce','secure session','reauthentication rotation',
            'CSRF logout','logout revocation','invalid nonce/issuer/signature/state rejection','callback replay rejection','canonical Host and spoofed forwarding headers']


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin',required=True)
    parser.add_argument('--report',type=Path,help='Write sanitized successful protocol evidence JSON')
    parser.add_argument('--runtime',choices=['built','vite','both'],default='both')
    args=parser.parse_args()
    if args.report: args.report.unlink(missing_ok=True)
    world=World(args.pg_bin)
    results={}
    try:
        world.start()
        for runtime in (['built','vite'] if args.runtime=='both' else [args.runtime]):
            world.dev_console=runtime=='vite'
            browser=BrowserFixture(world)
            try: results[runtime]=checks(browser)
            finally: browser.close()
        evidence=dict(executedAt=datetime.now(timezone.utc).isoformat(), fixtureOnly=True,externalProviderQualified=False,checks=results)
        if args.report:
            args.report.parent.mkdir(parents=True,exist_ok=True)
            args.report.write_text(json.dumps(evidence,indent=2)+'\n')
        print(json.dumps(evidence,indent=2))
    finally: world.close()


if __name__ == '__main__': main()
