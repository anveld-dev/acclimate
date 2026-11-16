"""Protocol unit checks for the disposable HTTPS issuer, without an API or browser."""
import hashlib
import json
import ssl
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit, parse_qs
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler, HTTPSHandler
from scripts.testing.identity import IdentityFixture, TLSProxy, b64
from scripts.testing.production import service_env


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_): return None


class FixtureProtocol(unittest.TestCase):
    def test_keycloak_proxy_replaces_spoofed_forwarding_headers_without_recording_queries(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                received.append({key.lower(): value for key, value in self.headers.items()})
                self.send_response(204)
                self.end_headers()
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix='acclimate-proxy-test-') as directory:
                proxy = TLSProxy(directory, f'http://127.0.0.1:{upstream.server_port}', forwarded=True)
                try:
                    tls = ssl.create_default_context(cafile=str(proxy.ca_path))
                    response = urlopen(Request(proxy.base+'/realm?code=private-fixture-code', headers={
                        'Forwarded': 'host=evil.invalid;proto=http',
                        'X-Forwarded-Host': 'evil.invalid', 'X-Forwarded-Proto': 'http',
                        'X-Forwarded-Port': '80', 'X-Forwarded-For': '192.0.2.1',
                        'X-Forwarded-Untrusted': 'injected'}), context=tls, timeout=5)
                    self.assertEqual(response.status, 204)
                    headers, = received
                    public = urlsplit(proxy.base)
                    self.assertEqual(headers['x-forwarded-host'], public.netloc)
                    self.assertEqual(headers['x-forwarded-proto'], 'https')
                    self.assertEqual(headers['x-forwarded-port'], str(public.port))
                    self.assertEqual(headers['x-forwarded-for'], '127.0.0.1')
                    self.assertNotIn('forwarded', headers)
                    self.assertNotIn('x-forwarded-untrusted', headers)
                    self.assertEqual(proxy.requests, ['/realm'])
                finally:
                    proxy.close()
        finally:
            upstream.shutdown()
            upstream.server_close()
            thread.join(timeout=5)

    def test_required_production_environment_is_isolated(self):
        env = service_env(database_url='postgresql://private-fixture/postgres', bind='127.0.0.1:1',
            tokens={'operator':'machine'}, login_token='login', console_token='console',
            base_env={'DATABASE_URL':'never-use', 'ACCLIMATE_MODE':'local','CONSOLE_MODE':'local','PATH':'/bin'})
        self.assertNotIn('ACCLIMATE_MODE',env)
        self.assertNotIn('CONSOLE_MODE',env)
        self.assertEqual(env['ACCLIMATE_LOGIN_TOKEN'],'login')
        self.assertEqual(env['DATABASE_URL'],'postgresql://private-fixture/postgres')
        self.assertEqual(json.loads(env['ACCLIMATE_OPERATORS'])[0]['subject'],'operator')

    def test_https_discovery_pkce_one_time_code_and_signed_token(self):
        with tempfile.TemporaryDirectory(prefix='acclimate-issuer-test-') as directory:
            issuer = IdentityFixture(directory)
            try:
                context = ssl.create_default_context(cafile=str(issuer.ca_path))
                client = build_opener(NoRedirect(), HTTPSHandler(context=context))
                discovery = json.load(client.open(issuer.issuer+'/.well-known/openid-configuration'))
                self.assertEqual(discovery['issuer'], issuer.issuer)
                self.assertEqual(discovery['code_challenge_methods_supported'], ['S256'])
                issuer.register_client('https://localhost:23456')
                verifier='v'*64
                values=dict(client_id=issuer.client_id,redirect_uri='https://localhost:23456/auth/callback',
                    response_type='code',state='bound-state',nonce='bound-nonce',subject='operator',
                    code_challenge_method='S256',code_challenge=b64(hashlib.sha256(verifier.encode()).digest()))
                def code():
                    try: client.open(Request(issuer.issuer+'/authorize', data=urlencode(values).encode()))
                    except HTTPError as response:
                        self.assertEqual(response.code,303)
                        return parse_qs(urlsplit(response.headers['Location']).query)['code'][0]
                def exchange(value, proof):
                    return client.open(Request(issuer.issuer+'/token',data=urlencode(dict(client_id=issuer.client_id,
                        client_secret=issuer.client_secret,code=value,grant_type='authorization_code',
                        redirect_uri=values['redirect_uri'],code_verifier=proof)).encode()))
                bad=code()
                with self.assertRaises(HTTPError): exchange(bad,'wrong')
                with self.assertRaises(HTTPError): exchange(bad,verifier)
                good=code()
                token=json.load(exchange(good,verifier))['id_token']
                claims=json.loads(__import__('base64').urlsafe_b64decode(token.split('.')[1]+'==='))
                self.assertEqual((claims['iss'],claims['sub'],claims['nonce']), (issuer.issuer,'operator','bound-nonce'))
                self.assertEqual(len(token.split('.')),3)
                with self.assertRaises(HTTPError): exchange(good,verifier)
                self.assertEqual(json.load(client.open(issuer.issuer+'/jwks'))['keys'][0]['kid'],'fixture-rsa')
            finally: issuer.close()


if __name__ == '__main__': unittest.main()
