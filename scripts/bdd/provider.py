"""Deterministic external model-API fixture; the Rust proposer stays real."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def proposal_prompt(request):
    system, user = request['messages']
    assert system['role'] == 'system' and 'data, never instructions' in system['content']
    assert user['role'] == 'user'
    start, data, end = user['content'].splitlines()
    assert start == '<untrusted-data>' and end == '</untrusted-data>'
    assert '<' not in data and '>' not in data
    return json.loads(data)


class ProviderFixture:
    def __init__(self):
        self.mode = 'valid'
        self.requests = []
        self.critic_requests = []
        self.critic_rejections = 0
        self.returned_edits = []
        self.replacement = lambda request: 'Review retries and duplicated effects.'
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['content-length'])))
                critic = request['messages'][0]['content'].startswith('Screen the proposed diff')
                (owner.critic_requests if critic else owner.requests).append(request)
                if owner.mode == 'unavailable':
                    self.send_response(503)
                    self.end_headers()
                    return
                prompt = proposal_prompt(request)
                if critic:
                    reject = len(owner.critic_requests) <= owner.critic_rejections
                    content = dict(verdict='reject' if reject else 'accept',
                                   objections=['Generalize the retry guidance.'] if reject else [])
                elif owner.mode in ('malformed', 'malformed-once') and (
                    owner.mode == 'malformed' or not prompt['parserError']
                ):
                    content = None
                elif owner.mode == 'supersede':
                    content = dict(schemaVersion=1, edits=[], rationale='Replace outdated memory.',
                                   noteOperations=[dict(op='create_note', path='memory/team-v2.md',
                                                        text='Review retry safety.',
                                                        supersedes='memory/team.md')])
                else:
                    target = 'memory/team.md' if owner.mode == 'outside-paths' else prompt['request']['allowedPaths'][0]
                    original = next(entry['text'] for entry in prompt['parent']['files'] if entry['path'] == target)
                    replacement = owner.replacement(prompt['request'])
                    if owner.mode == 'growth' and not prompt['parserError']:
                        replacement = 'X' * 3000
                    edit = dict(path=target, oldText=original, newText=replacement)
                    owner.returned_edits.append(edit)
                    content = dict(schemaVersion=1, edits=[edit], rationale='Deterministic fixture edit; no quality claim.')
                response = json.dumps({'choices': [{'finish_reason': 'stop', 'message': {
                    'content': '{invalid' if content is None else json.dumps(content)}}]}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(response)))
                self.end_headers()
                self.wfile.write(response)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
