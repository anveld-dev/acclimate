import hashlib
import http.server
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from acclimate import (
    AcclimateClient,
    ApiError,
    DeliveryError,
    prepare_files,
    resolve_and_cache,
    validate_payload,
)

FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"
PAYLOAD = (FIXTURES / "bundle-v1.json").read_bytes()
VERSION = json.loads((FIXTURES / "version-v1.json").read_bytes())
RESOLUTION = json.loads((FIXTURES / "resolve-v1.json").read_bytes())


class Handler(http.server.BaseHTTPRequestHandler):
    calls = []
    mode = "ok"

    def log_message(self, *args):
        pass

    def do_POST(self):
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.calls.append((data, self.headers.get("Idempotency-Key")))
        if len(self.calls) == 1:
            self.reply(503, b"{}")
            return
        self.reply(201, b'{"id":"b1"}')

    def do_GET(self):
        if "/promotions?" in self.path:
            Handler.last_history_path = self.path
            if "limit=0" in self.path:
                self.reply(400, b'{"error":{"code":"invalid_content","message":"bad"}}')
            elif "beforeRevision=denied" in self.path:
                self.reply(403, b'{"error":{"code":"denied","message":"no"}}')
            else:
                self.reply(200, b'{"items":[],"nextBeforeRevision":null}')
            return
        if self.mode == "deny":
            self.reply(
                403, b'{"error":{"code":"denied","message":"no","requestId":"r1"}}'
            )
            return
        if self.mode == "unavailable":
            self.reply(503, b"{}")
            return
        if self.mode == "redirect":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/")
            self.end_headers()
            return
        if self.path.endswith("/payload"):
            self.reply(200, PAYLOAD if self.mode != "bad" else b"{}")
            return
        if "/channels/" in self.path:
            if self.headers.get("If-None-Match") == '"1"':
                self.send_response(304)
                self.send_header("ETag", '"1"')
                self.end_headers()
                return
            self.reply(200, json.dumps(RESOLUTION).encode(), '"1"')
            return
        self.reply(200, json.dumps(VERSION).encode())

    def reply(self, status, body, etag=None):
        self.send_response(status)
        if etag:
            self.send_header("ETag", etag)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class SDKTest(unittest.TestCase):
    def test_promotion_history_query_and_errors(self):
        client = self.client
        page = client.list_promotions("p", "b", "stable", limit=100, before_revision="a&b")
        self.assertEqual(page, {"items": [], "nextBeforeRevision": None})
        self.assertTrue(Handler.last_history_path.endswith("limit=100&beforeRevision=a%26b"))
        for options, status, code in [({"limit": 0}, 400, "invalid_content"), ({"before_revision": "denied"}, 403, "denied")]:
            with self.assertRaises(ApiError) as caught:
                client.list_promotions("p", "b", "stable", **options)
            self.assertEqual((caught.exception.status, caught.exception.code), (status, code))

    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        Handler.calls = []
        Handler.mode = "ok"
        self.client = AcclimateClient(
            "http://127.0.0.1:%d" % self.server.server_port, "secret", "principal"
        )

    def test_retry_same_bytes_and_key(self):
        self.client.create_bundle("p", {"name": "café"}, "key")
        self.assertEqual(len(Handler.calls), 2)
        self.assertEqual(*Handler.calls)

    def test_fixture_cache_policy_and_files(self):
        self.assertEqual(
            "sha256:" + hashlib.sha256(PAYLOAD).hexdigest(), VERSION["digest"]
        )
        with tempfile.TemporaryDirectory() as tmp:
            tmp = os.path.realpath(tmp)
            kw = dict(cache_dir=tmp + "/cache", channel="stable")
            v = resolve_and_cache(self.client, "p", "b1", **kw)
            self.assertFalse(v["stale"])
            self.assertFalse(resolve_and_cache(self.client, "p", "b1", **kw)["stale"])
            Handler.mode = "unavailable"
            self.assertTrue(
                resolve_and_cache(self.client, "p", "b1", **kw, offline_max_age=60)[
                    "stale"
                ]
            )
            Handler.mode = "deny"
            with self.assertRaises(ApiError) as e:
                resolve_and_cache(self.client, "p", "b1", **kw, offline_max_age=60)
            self.assertEqual(
                (e.exception.code, e.exception.request_id), ("denied", "r1")
            )
            with prepare_files(v, tmp + "/out") as prepared:
                self.assertTrue(prepared.files)
                self.assertTrue(Path(prepared.files[0]["absolutePath"]).is_file())
            self.assertFalse(Path(prepared.files[0]["absolutePath"]).exists())

    def test_integrity_and_redirect(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = os.path.realpath(tmp)
            Handler.mode = "bad"
            with self.assertRaises(DeliveryError) as e:
                resolve_and_cache(
                    self.client, "p", "b1", cache_dir=tmp, version_id="v1"
                )
            self.assertEqual(e.exception.code, "digest_mismatch")
            Handler.mode = "redirect"
            with self.assertRaises(ApiError) as e:
                self.client.get_version("p", "b1", "v1")
            self.assertEqual(e.exception.status, 302)

    def test_existing_directory_permissions_are_not_changed(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = os.path.realpath(tmp)
            directory = tmp + "/existing"
            os.mkdir(directory)
            os.chmod(directory, 0o755)
            with self.assertRaises(DeliveryError):
                resolve_and_cache(
                    self.client, "p", "b1", cache_dir=directory, version_id="v1"
                )
            self.assertEqual(os.stat(directory).st_mode & 0o777, 0o755)
            bundle = {
                "version": VERSION,
                "payload": json.loads(PAYLOAD),
                "resolvedAt": 0,
                "stale": False,
            }
            with self.assertRaises(DeliveryError):
                prepare_files(bundle, directory)
            self.assertEqual(os.stat(directory).st_mode & 0o777, 0o755)

    def test_unsafe_paths_and_symlinks(self):
        for paths in [("a", "A"), ("a", "a/b"), ("../x",), ("CON.txt",)]:
            with self.subTest(paths=paths), self.assertRaises(DeliveryError):
                validate_payload(
                    {
                        "schemaVersion": 1,
                        "files": [
                            {"path": p, "kind": "skill", "text": ""} for p in paths
                        ],
                    }
                )
        with tempfile.TemporaryDirectory() as tmp:
            tmp = os.path.realpath(tmp)
            os.symlink(tmp, tmp + "/link")
            with self.assertRaises(DeliveryError):
                resolve_and_cache(
                    self.client,
                    "p",
                    "b1",
                    cache_dir=tmp + "/link/cache",
                    version_id="v1",
                )


if __name__ == "__main__":
    unittest.main()
