"""Test-only TLS, OIDC issuer and reverse proxy. Never imported by production code.

Exercises real openid-client discovery, authorization code, client authentication,
PKCE, nonce and RS256 verification. Identities are selectable only on this disposable
fixture issuer. No production provider qualification is implied by these tests.
"""
import base64
import hashlib
import html
import http.client
import json
import secrets
import ssl
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def certificate(directory, host="localhost"):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    cert, key = directory / 'localhost.crt', directory / 'localhost.key'
    if not cert.exists():
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', str(key), '-out', str(cert), '-days', '2',
                        '-subj', '/CN=localhost', '-addext',
                        'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:'+host, '-addext',
                        'basicConstraints=critical,CA:TRUE'], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        key.chmod(0o600)
    return cert, key


class SecureServer:
    def _start(self, directory, handler, host="localhost", bind="127.0.0.1"):
        self.cert_path, self.key_path = certificate(directory, host)
        self.ca_path = self.cert_path
        self.server = ThreadingHTTPServer((bind, 0), handler)
        self.server.daemon_threads = True
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.cert_path, self.key_path)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.base = self.origin = self.url = 'https://'+host+':' + str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class IdentityFixture(SecureServer):
    def __init__(self, directory, host="localhost", bind="127.0.0.1"):
        self.client_id = 'acclimate-fixture-console'
        self.client_secret = secrets.token_hex(32)
        self.next_token_claims = {}
        self.next_token_bad_signature = False
        self.codes = {}
        self.redirects = set()
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass  # Requests contain authorization codes; never log them.

            def respond(self, status, value, content_type='application/json', headers=None):
                data = json.dumps(value).encode() if content_type == 'application/json' else value.encode()
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                for key, value in (headers or {}).items(): self.send_header(key, value)
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                request = urlsplit(self.path)
                owner.requests.append(request.path)
                if request.path == '/.well-known/openid-configuration':
                    self.respond(200, dict(issuer=owner.issuer, authorization_endpoint=owner.issuer+'/authorize',
                        token_endpoint=owner.issuer+'/token', jwks_uri=owner.issuer+'/jwks',
                        response_types_supported=['code'], subject_types_supported=['public'],
                        id_token_signing_alg_values_supported=['RS256'], scopes_supported=['openid'],
                        token_endpoint_auth_methods_supported=['client_secret_post', 'client_secret_basic'],
                        code_challenge_methods_supported=['S256']))
                elif request.path == '/jwks':
                    self.respond(200, dict(keys=[owner.jwk]))
                elif request.path == '/authorize':
                    values = {k: v[0] for k, v in parse_qs(request.query).items()}
                    if (values.get('client_id') != owner.client_id or values.get('redirect_uri') not in owner.redirects
                        or values.get('response_type') != 'code' or values.get('code_challenge_method') != 'S256'
                        or not values.get('code_challenge') or not values.get('state') or not values.get('nonce')):
                        self.respond(400, dict(error='invalid_request')); return
                    inputs = ''.join('<input type="hidden" name="'+html.escape(k, quote=True)+'" value="'+html.escape(v, quote=True)+'">' for k,v in values.items())
                    self.respond(200, '<!doctype html><title>Fixture identity</title><form method="post" action="/authorize">'+inputs+
                        '<label>Fixture subject<input name="subject" required value="operator"></label><button type="submit">Sign in to fixture</button></form>', 'text/html')
                else:
                    self.respond(404, dict(error='not_found'))

            def do_POST(self):
                owner.requests.append(urlsplit(self.path).path)
                values = {k: v[0] for k,v in parse_qs(self.rfile.read(int(self.headers.get('Content-Length','0'))).decode()).items()}
                if self.path == '/authorize':
                    if (values.get('redirect_uri') not in owner.redirects or values.get('client_id') != owner.client_id
                        or not values.get('subject') or len(values['subject']) > 512
                        or values.get('response_type') != 'code' or values.get('code_challenge_method') != 'S256'
                        or not all(values.get(name) for name in ('state','nonce','code_challenge'))):
                        self.respond(400, dict(error='invalid_request')); return
                    code = secrets.token_urlsafe(32)
                    owner.codes[code] = dict(values, expires=time.time()+60)
                    location = values['redirect_uri'] + '?' + urlencode(dict(code=code, state=values['state'], iss=owner.issuer))
                    self.respond(303, '', 'text/plain', {'Location': location})
                elif self.path == '/token':
                    client, secret = values.get('client_id'), values.get('client_secret')
                    if self.headers.get('Authorization','').startswith('Basic '):
                        try: client, secret = base64.b64decode(self.headers['Authorization'][6:]).decode().split(':', 1)
                        except (ValueError, UnicodeError): pass
                    code = owner.codes.pop(values.get('code',''), None)
                    valid = (client == owner.client_id and secrets.compare_digest(secret or '', owner.client_secret)
                        and code and code['expires'] > time.time() and values.get('grant_type') == 'authorization_code'
                        and values.get('redirect_uri') == code['redirect_uri']
                        and b64(hashlib.sha256(values.get('code_verifier','').encode()).digest()) == code['code_challenge'])
                    if not valid:
                        self.respond(400, dict(error='invalid_grant')); return
                    now = int(time.time())
                    claims = dict(iss=owner.issuer, sub=code['subject'], aud=owner.client_id,
                                  iat=now, exp=now+300, nonce=code['nonce'])
                    claims.update(owner.next_token_claims)
                    owner.next_token_claims = {}
                    token = owner.sign(claims)
                    if owner.next_token_bad_signature:
                        token = token.rsplit('.', 1)[0] + '.' + b64(b'invalid-signature')
                        owner.next_token_bad_signature = False
                    self.respond(200, dict(access_token=secrets.token_urlsafe(32), token_type='Bearer', expires_in=300, id_token=token))
                else:
                    self.respond(404, dict(error='not_found'))

        self._start(Path(directory)/'tls', Handler, host, bind)
        self.issuer = self.base
        # Reuse the disposable TLS RSA key only within this test issuer.
        modulus = subprocess.check_output(['openssl','rsa','-in',str(self.key_path),'-noout','-modulus'], stderr=subprocess.DEVNULL).decode().strip().split('=',1)[1]
        self.jwk = dict(kty='RSA', use='sig', alg='RS256', kid='fixture-rsa', n=b64(bytes.fromhex(modulus)), e=b64((65537).to_bytes(3,'big')))

    def register_client(self, origin):
        self.redirects.add(origin.rstrip('/')+'/auth/callback')

    def sign(self, claims):
        data = (b64(json.dumps(dict(alg='RS256',kid='fixture-rsa',typ='JWT')).encode())+'.'+b64(json.dumps(claims).encode())).encode()
        signed = subprocess.run(['openssl','dgst','-sha256','-sign',str(self.key_path)], input=data, check=True, capture_output=True).stdout
        return data.decode()+'.'+b64(signed)


class TLSProxy(SecureServer):
    def __init__(self, directory, target, api_target=None, *, forwarded=False):
        owner = self
        self.target, self.api_target = target, api_target
        self.requests = []

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *_): pass
            def forward(self):
                owner.requests.append(urlsplit(self.path).path)
                destination = owner.api_target if owner.api_target and urlsplit(self.path).path.startswith(('/v1/', '/health', '/ready')) else owner.target
                remote = urlsplit(destination)
                connection = http.client.HTTPConnection(remote.hostname, remote.port, timeout=15)
                body = self.rfile.read(int(self.headers.get('Content-Length','0'))) or None
                headers = {key: value for key,value in self.headers.items()
                           if key.lower() not in ('host','connection','transfer-encoding') and not key.lower().startswith(('forwarded','x-forwarded-'))}
                # Preserve the incoming Host: the application itself rejects noncanonical Hosts.
                headers['Host'] = self.headers.get('Host','')
                if forwarded:
                    public = urlsplit(owner.base)
                    headers.update({'X-Forwarded-Proto': 'https',
                                    'X-Forwarded-Host': public.netloc,
                                    'X-Forwarded-Port': str(public.port or 443),
                                    'X-Forwarded-For': self.client_address[0]})
                try:
                    connection.request(self.command, self.path, body, headers)
                    response = connection.getresponse()
                    data = response.read()
                    self.send_response(response.status)
                    for key,value in response.getheaders():
                        if key.lower() not in ('connection','transfer-encoding','content-length'): self.send_header(key,value)
                    self.send_header('Content-Length',str(len(data)))
                    self.end_headers()
                    if self.command != 'HEAD': self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                    self.close_connection = True
                except (OSError, http.client.HTTPException):
                    try: self.send_error(502, 'Private fixture upstream unavailable')
                    except OSError: self.close_connection = True
                finally: connection.close()
            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = forward

        self._start(Path(directory)/'tls', Handler)
