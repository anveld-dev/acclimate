import asyncio
import hashlib
import json
import os
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

from acclimate import (
    AsyncAcclimate,
    AsyncAcclimateClient,
    telemetry_attributes,
)


def _canonical_bytes(payload: dict) -> bytes:
    canonical = {
        "schemaVersion": payload["schemaVersion"],
        "files": [
            {"path": f["path"], "kind": f["kind"], "text": f["text"]}
            for f in payload["files"]
        ],
    }
    return (json.dumps(canonical, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


class AsyncClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.payload = {
            "schemaVersion": 1,
            "files": [
                {"path": "instructions.md", "kind": "instruction", "text": "Async agent policy."},
            ],
        }
        self.raw_payload = _canonical_bytes(self.payload)
        self.digest = "sha256:" + hashlib.sha256(self.raw_payload).hexdigest()
        self.version = {
            "id": "ver-async-1",
            "bundleId": "bun-async",
            "parentVersionId": None,
            "digest": self.digest,
            "createdAt": "2026-11-27T00:00:00Z",
        }
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                return

            def do_GET(self):
                path = self.path.split("?", 1)[0]
                if path.endswith("/bundles"):
                    body = json.dumps(
                        {
                            "items": [
                                {
                                    "id": "bun-async",
                                    "workspaceId": "ws-1",
                                    "name": "Support",
                                    "compatibilityTarget": "generic",
                                    "createdAt": "2026-11-27T00:00:00Z",
                                    "origin": "created",
                                    "sourceLabel": None,
                                }
                            ],
                            "nextCursor": None,
                        }
                    ).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                elif self.path.endswith("/channels/stable"):
                    body = json.dumps(
                        {"channel": "stable", "revision": "2", "version": parent.version}
                    ).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                elif self.path.endswith("/versions/ver-async-1/payload"):
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(parent.raw_payload)))
                    self.end_headers()
                    self.wfile.write(parent.raw_payload)
                else:
                    self.send_response(404)
                    self.end_headers()

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def test_async_client_prepare_and_cleanup(self) -> None:
        async def run() -> None:
            with tempfile.TemporaryDirectory() as tmp:
                cache_dir = os.path.join(os.path.realpath(tmp), "cache")
                client = AsyncAcclimateClient(f"http://127.0.0.1:{self.port}", "tok", "scope-async")
                bundles = await client.list_bundles("ws-1")
                self.assertEqual(bundles["items"][0]["id"], "bun-async")
                resolution, _etag, not_modified = await client.resolve_channel(
                    "ws-1", "bun-async", "stable"
                )
                self.assertIsNotNone(resolution)
                self.assertFalse(not_modified)
                raw = await client.get_payload("ws-1", "bun-async", "ver-async-1")
                self.assertEqual(raw, self.raw_payload)
                async with await client.prepare(
                    "ws-1", "bun-async", channel="stable", cache_dir=cache_dir
                ) as prepared:
                    self.assertIn("Async agent policy.", prepared.system_prompt)
                    attrs = telemetry_attributes(prepared)
                    self.assertEqual(attrs["acclimate.version_id"], "ver-async-1")
                    self.assertEqual(attrs["acclimate.channel"], "stable")
                    staged_dir = prepared.directory
                    self.assertTrue(os.path.isdir(staged_dir))
                self.assertFalse(os.path.exists(staged_dir))

        asyncio.run(run())

    def test_async_acclimate_job(self) -> None:
        async def run() -> None:
            with tempfile.TemporaryDirectory() as tmp:
                cache_dir = os.path.join(os.path.realpath(tmp), "cache")
                acclimate = AsyncAcclimate(
                    f"http://127.0.0.1:{self.port}", "ws-1", "tok", cache_dir=cache_dir
                )
                job = await acclimate.job("Support", channel="stable")
                self.assertEqual(job.version["version"]["id"], "ver-async-1")
                self.assertEqual(job.instructions, "Async agent policy.")
                self.assertIn("Async agent policy.", job.system_prompt)
                async with await job.prepare() as delivery:
                    self.assertIn("Async agent policy.", delivery.system_prompt)

        asyncio.run(run())

    def test_cancelled_prepare_cleans_up_orphaned_delivery(self) -> None:
        from acclimate.async_client import _run_prepare_cancellable
        import threading

        started = threading.Event()
        release = threading.Event()
        cleaned = threading.Event()

        class FakeDelivery:
            def cleanup(self) -> None:
                cleaned.set()

        def slow_stage():
            started.set()
            release.wait(timeout=2)
            return FakeDelivery()

        async def run() -> None:
            task = asyncio.create_task(_run_prepare_cancellable(slow_stage))
            await asyncio.to_thread(started.wait, 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            release.set()

        asyncio.run(run())
        self.assertTrue(cleaned.wait(timeout=2))


if __name__ == "__main__":
    unittest.main()
