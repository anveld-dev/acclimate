import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread
import time
import unittest


class RecipeTests(unittest.TestCase):
    def test_delivery_check_and_optional_receipt_failure(self):
        payload = json.dumps(dict(schemaVersion=1, files=[dict(path='AGENTS.md', kind='instruction', text='Pinned guidance')])).encode()
        version = dict(id='v', bundleId='b', parentVersionId=None, digest='sha256:' + hashlib.sha256(payload).hexdigest(), createdAt='2026-11-14')
        root = Path(__file__).resolve().parents[2]
        for reporting in ('disabled', 'healthy', 'denied', 'stalled'):
            with self.subTest(reporting=reporting):
                events, identities = [], []
                class Handler(BaseHTTPRequestHandler):
                    def log_message(self, *args):
                        pass
                    def do_GET(self):
                        identities.append(self.headers['Authorization'])
                        self.send_response(200)
                        self.end_headers()
                        self.wfile.write(payload if self.path.endswith('/payload') else json.dumps(dict(channel='stable', revision='1', version=version)).encode())
                    def do_POST(self):
                        identities.append(self.headers['Authorization'])
                        body = self.rfile.read(int(self.headers['Content-Length']))
                        if reporting == 'stalled':
                            time.sleep(1.5)
                            return
                        self.send_response(403 if reporting == 'denied' else 200)
                        self.end_headers()
                        if reporting == 'healthy':
                            events.append(json.loads(body))
                        self.wfile.write(b'{}')
                server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
                Thread(target=server.serve_forever, daemon=True).start()
                try:
                    with tempfile.TemporaryDirectory(prefix='acclimate-python-recipe-') as directory:
                        env = dict(os.environ, PYTHONPATH=str(root / 'python'),
                                   ACCLIMATE_URL='http://127.0.0.1:' + str(server.server_port),
                                   ACCLIMATE_TOKEN='read-only', ACCLIMATE_PROJECT='p', ACCLIMATE_BUNDLE='b',
                                   ACCLIMATE_CHANNEL='stable', ACCLIMATE_SCOPE='test-app',
                                   ACCLIMATE_CACHE=directory + '/cache', ACCLIMATE_JOB_DIR=directory + '/job',
                                   ACCLIMATE_RECEIPT_TOKEN='', ACCLIMATE_INTEGRATION='')
                        if reporting != 'disabled':
                            env.update(ACCLIMATE_RECEIPT_TOKEN='receipt-only', ACCLIMATE_INTEGRATION='i')
                        result = subprocess.run([sys.executable, str(root / 'python/examples/delivery_check.py')],
                                                env=env, capture_output=True, text=True, timeout=5)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        output = json.loads(result.stdout)
                        self.assertEqual(output['checkedFiles'], 1)
                        self.assertNotIn('started', output)
                        self.assertEqual(output['digest'], version['digest'])
                        self.assertEqual(list(Path(directory + '/job').iterdir()), [])
                        if reporting == 'healthy':
                            self.assertEqual([e['stage'] for e in events], ['resolved', 'downloaded', 'verified', 'prepared'])
                            self.assertTrue(all(e['versionId'] == 'v' and 'content' not in e for e in events))
                        else:
                            self.assertEqual(events, [])
                        self.assertEqual(identities[:2], ['Bearer read-only'] * 2)
                        self.assertTrue(all(i == 'Bearer receipt-only' for i in identities[2:]))
                finally:
                    server.shutdown()
                    server.server_close()
