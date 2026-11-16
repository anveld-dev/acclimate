"""Deterministic external model-API fixture; the Rust proposer stays real."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ProviderFixture:
    def __init__(self):
        self.mode = 'valid'
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['content-length'])))
                owner.requests.append(request)
                if owner.mode == 'unavailable':
                    self.send_response(503)
                    self.end_headers()
                    return
                prompt = json.loads(request['messages'][0]['content'])
                target = 'memory/team.md' if owner.mode == 'outside-paths' else prompt['request']['allowedPaths'][0]
                original = next(entry['text'] for entry in prompt['parent']['files'] if entry['path'] == target)
                edit = dict(path=target, oldText=original, newText='Review retries and duplicated effects.')
                response = json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(dict(schemaVersion=1, edits=[edit], rationale='Deterministic fixture edit; no quality claim.'))}}]}).encode()
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
