"""pull saves a published payload for local evaluation, without application code.

Set ACCLIMATE_TEST_PULL_BIN to a command, such as the TypeScript ``acclimate`` executable or
``python -I -m acclimate``, to run the same checks against it.
"""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import os
import shlex
import subprocess
import tempfile
import threading
import unittest
from urllib.parse import urlsplit

from acclimate.pull import main

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
                if self.headers.get("Authorization") != "Bearer PRIVATE_CANARY":
                    data, status = json.dumps({"error": {"code": "unauthenticated", "message": "no", "requestId": "x"}}).encode(), 401
                elif route.endswith("/workspaces/project/bundles"):
                    items = [{"id": BUNDLE, "name": "Support agent"}]
                    data, status = json.dumps({"items": items, "nextCursor": None}).encode(), 200
                elif route.endswith(f"/bundles/{BUNDLE}/channels/stable/releases"):
                    data, status = json.dumps({"items": [{"channel": "stable", "revision": "3", "version": version}]}).encode(), 200
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
        token = configuration / "read-token"
        token.write_text("PRIVATE_CANARY\n")
        token.chmod(0o600)
        self.config = configuration / "pull.json"
        self.config.write_text(json.dumps({
            "schemaVersion": 1, "serviceUrl": f"http://127.0.0.1:{self.server.server_address[1]}",
            "workspaceId": "project", "scope": "evaluator", "tokenFile": str(token),
            "cacheDir": str(self.root / "journals")}))
        self.config.chmod(0o600)
        self.empty = self.root / "no-application"
        self.empty.mkdir()

    def invoke(self, args, env=None):
        environ = {**os.environ, **(env or {})}
        if command := os.environ.get("ACCLIMATE_TEST_PULL_BIN"):
            environ["HOME"] = str(self.root)
            run = subprocess.run([*shlex.split(command), *args], cwd=self.empty, text=True,
                                 capture_output=True, env=environ)
            return run.returncode, run.stdout, run.stderr
        output, errors = io.StringIO(), io.StringIO()
        saved = dict(os.environ)
        os.environ.clear()
        os.environ.update(environ, HOME=str(self.root))
        try:
            with redirect_stdout(output), redirect_stderr(errors):
                status = main(args)
        finally:
            os.environ.clear()
            os.environ.update(saved)
        return status, output.getvalue(), errors.getvalue()

    def test_pull_writes_a_new_private_payload_without_application_code(self):
        out = self.root / "candidate.json"
        status, output, errors = self.invoke(["pull", "--config", str(self.config), "--bundle", BUNDLE, "--out", str(out)])
        self.assertEqual(status, 0, output)
        result = json.loads(output)
        self.assertEqual((result["versionId"], result["revision"], result["files"]), (VERSION, "3", 1))
        self.assertTrue(errors.startswith("Saved stable (version "), errors)
        self.assertEqual(json.loads(out.read_text()), PAYLOAD)
        self.assertEqual(out.stat().st_mode & 0o777, 0o600)
        status, output, errors = self.invoke(["pull", "--config", str(self.config), "--bundle", BUNDLE, "--out", str(out)])
        self.assertEqual(status, 2)
        self.assertIn("already exists", errors)
        self.assertEqual(json.loads(output)["error"]["field"], "--out")

    def test_pull_reads_the_environment_and_finds_the_bundle_by_name(self):
        out = self.root / "named.json"
        env = {"ACCLIMATE_URL": f"http://127.0.0.1:{self.server.server_address[1]}",
               "ACCLIMATE_WORKSPACE": "project", "ACCLIMATE_TOKEN": "PRIVATE_CANARY"}
        status, output, errors = self.invoke(["pull", "--bundle", "Support agent", "--out", str(out)], env)
        self.assertEqual(status, 0, output + errors)
        self.assertEqual(json.loads(output)["bundleId"], BUNDLE)
        self.assertEqual(json.loads(out.read_text()), PAYLOAD)
        status, output, _ = self.invoke(["pull", "--bundle", "Nobody", "--out", str(self.root / "none.json")], env)
        self.assertEqual((status, json.loads(output)["error"]["code"]), (1, "bundle.missing"))
        status, output, _ = self.invoke(["pull", "--bundle", "Support agent", "--out", str(self.root / "unset.json")],
                                        {**env, "ACCLIMATE_TOKEN": ""})
        self.assertEqual((status, json.loads(output)["error"]["code"]), (1, "config.missing"))

    def test_pull_explains_usage_and_service_refusals(self):
        status, output, _ = self.invoke(["pull", "--config", str(self.config), "--bundle", BUNDLE])
        self.assertEqual(status, 2)
        self.assertEqual(json.loads(output)["error"]["code"], "usage.missing_flag")
        self.assertEqual(json.loads(output)["error"]["field"], "--out")
        status, output, errors = self.invoke(["pull", "--config", str(self.config), "--bundle", BUNDLE,
                                              "--channel", "beta", "--out", str(self.root / "beta.json")])
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(output)["error"]["code"], "bundle.missing")
        self.assertTrue(errors.startswith("acclimate: "), errors)
        self.assertNotIn("PRIVATE_CANARY", output + errors)

if __name__ == "__main__":
    unittest.main()
