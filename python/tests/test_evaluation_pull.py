"""pull saves a published payload for compare --payload, without application code."""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import urlsplit

from acclimate.evaluation_app import main

BUNDLE = "11111111-1111-4111-8111-111111111111"
VERSION = "22222222-2222-4222-8222-222222222222"
PAYLOAD = {"schemaVersion": 1, "files": [{"path": "instructions.md", "kind": "instruction", "text": "Answer briefly.\n"}]}


class PullTests(unittest.TestCase):
    def setUp(self):
        body = (json.dumps(PAYLOAD, separators=(",", ":")) + "\n").encode()
        version = {"id": VERSION, "bundleId": BUNDLE, "parentVersionId": None,
                   "digest": "sha256:" + hashlib.sha256(body).hexdigest(), "createdAt": "2026-11-19T12:00:00Z"}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                route = urlsplit(self.path).path
                if route.endswith(f"/bundles/{BUNDLE}/channels/stable"):
                    data, status = json.dumps({"channel": "stable", "revision": "3", "version": version}).encode(), 200
                elif route.endswith(f"/versions/{VERSION}/payload"):
                    data, status = body, 200
                elif route.endswith(f"/versions/{VERSION}"):
                    data, status = json.dumps(version).encode(), 200
                else:
                    data, status = json.dumps({"error": {"code": "not_found", "message": "missing", "requestId": "x"}}).encode(), 404
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        configuration = self.root / "configuration"
        configuration.mkdir(mode=0o700)
        self.config = configuration / "evaluator.json"
        self.config.write_text(json.dumps({
            "schemaVersion": 1, "serviceUrl": f"http://127.0.0.1:{self.server.server_address[1]}",
            "workspaceId": "project", "evaluatorPrincipalId": "evaluator", "evaluatorToken": "PRIVATE_CANARY",
            "journalRoot": str(self.root / "journals")}))
        self.config.chmod(0o600)
        self.empty = self.root / "no-application"
        self.empty.mkdir()

    def invoke(self, args):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            status = main(args, directory=str(self.empty))
        return status, output.getvalue(), errors.getvalue()

    def test_pull_writes_a_new_private_payload_without_application_code(self):
        out = self.root / "candidate.json"
        status, output, _ = self.invoke(["pull", "--config", str(self.config), "--bundle", BUNDLE, "--out", str(out)])
        self.assertEqual(status, 0)
        result = json.loads(output)
        self.assertEqual((result["versionId"], result["revision"], result["files"]), (VERSION, "3", 1))
        self.assertEqual(json.loads(out.read_text()), PAYLOAD)
        self.assertEqual(out.stat().st_mode & 0o777, 0o600)
        status, _, errors = self.invoke(["pull", "--config", str(self.config), "--bundle", BUNDLE, "--out", str(out)])
        self.assertEqual(status, 1)
        self.assertIn("already exists", errors)
        self.assertEqual(json.loads(errors)["error"]["field"], "--out")

    def test_pull_explains_usage_and_service_refusals(self):
        status, _, errors = self.invoke(["pull", "--config", str(self.config), "--bundle", BUNDLE])
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(errors)["error"]["code"], "usage.missing_flag")
        self.assertEqual(json.loads(errors)["error"]["field"], "--out")
        status, _, errors = self.invoke(["pull", "--config", str(self.config), "--bundle", BUNDLE,
                                         "--channel", "beta", "--out", str(self.root / "beta.json")])
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(errors)["error"]["code"], "bundle.missing")
        self.assertNotIn("PRIVATE_CANARY", errors)


if __name__ == "__main__":
    unittest.main()
