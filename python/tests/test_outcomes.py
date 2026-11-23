import hashlib
import http.server
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit
from uuid import UUID, uuid4
from acclimate import Acclimate


class LearningService:
    def __init__(self):
        self.bundle = str(uuid4())
        self.payload = (
            Path(__file__).resolve().parents[2] / "contracts/fixtures/bundle-v1.json"
        ).read_bytes()
        self.version = {
            "id": str(uuid4()),
            "bundleId": self.bundle,
            "parentVersionId": None,
            "digest": "sha256:" + hashlib.sha256(self.payload).hexdigest(),
            "createdAt": "2026-11-20T00:00:00Z",
        }
        self.outcomes = []

    def respond(self, path, method, body, key, authorization):
        if path.endswith("/bundles"):
            return {
                "items": [{"id": self.bundle, "name": "support"}],
                "nextCursor": None,
            }
        if path.endswith("/channels/stable"):
            return {"channel": "stable", "revision": "1", "version": self.version}
        if path.endswith("/payload"):
            return self.payload
        if path.endswith(self.version["id"]):
            return self.version
        if path.endswith("/outcomes"):
            self.outcomes.append((key, body))
            return {
                "outcomeId": body["outcomeId"],
                "taskId": "outcome:" + body["outcomeId"],
                "taskRevision": 2,
            }
        return {"error": {"code": "not_found"}}, 404


class ProtocolTest(unittest.TestCase):
    def setUp(self):
        self.service = service = LearningService()

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def handle_request(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                result = service.respond(
                    urlsplit(self.path).path,
                    self.command,
                    json.loads(raw) if raw else None,
                    self.headers.get("Idempotency-Key"),
                    self.headers.get("Authorization"),
                )
                result, status = result if isinstance(result, tuple) else (result, 200)
                data = (
                    result if isinstance(result, bytes) else json.dumps(result).encode()
                )
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = handle_request

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        self.url = f"http://127.0.0.1:{server.server_port}"
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()

    def test_job_pins_version_and_replays_the_same_outcome(self):
        self.enterContext(
            patch.dict(
                os.environ,
                {
                    "ACCLIMATE_URL": self.url,
                    "ACCLIMATE_WORKSPACE": "w",
                    "ACCLIMATE_TOKEN": "token",
                },
            )
        )
        input = {"text": "original"}
        job = Acclimate.from_env(cache_dir=self.tmp / "delivery").job(
            "support", channel="stable", input=input
        )
        original_version = self.service.version["id"]
        self.service.version["id"] = str(uuid4())
        input["text"] = "modified"
        with job.prepare() as prepared:
            self.assertEqual(prepared.version["version"]["id"], original_version)
        self.assertEqual(job.expect(1, output=None), job.expect(1, output=None))
        self.assertEqual(
            self.service.outcomes,
            [
                (
                    job.outcome_id,
                    {
                        "outcomeId": job.outcome_id,
                        "versionId": original_version,
                        "digest": job.version["version"]["digest"],
                        "input": {"text": "original"},
                        "output": None,
                        "expected": 1,
                    },
                )
            ]
            * 2,
        )
        UUID(job.outcome_id)
