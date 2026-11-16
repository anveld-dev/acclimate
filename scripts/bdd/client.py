"""Public HTTP calls with fixture-only identities; reports never dump bearer tokens."""
import json
import secrets
from urllib.request import Request, urlopen
from urllib.error import HTTPError


def request(world, method, path, body=None, actor=None, key=None, expected=None):
    actor = actor or world.actor
    token = world.h.tokens.get(actor)
    headers = {'Content-Type': 'application/json'}
    if actor in world.sessions:
        token = world.console_token
        headers['X-Acclimate-Session'] = world.sessions[actor]['secret']
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if method not in ('GET', 'HEAD'):
        headers['Idempotency-Key'] = key or secrets.token_hex(16)
    data = json.dumps(body, separators=(',', ':')).encode() if body is not None else None
    try:
        response = urlopen(Request(world.h.base + path, method=method, data=data, headers=headers), timeout=10)
    except HTTPError as error:
        response = error
    raw = response.read()
    result = json.loads(raw) if raw else None
    world.last_status, world.last = response.status, result
    allowed = expected if isinstance(expected, tuple) else (expected,) if expected is not None else tuple(range(200, 300))
    assert response.status in allowed, f'{method} {path}: status {response.status}; expected {allowed}; code {(result or {}).get("error", {}).get("code")}'
    return result
