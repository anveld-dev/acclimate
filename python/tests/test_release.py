"""Acclimate.release and Acclimate.rollback against an in-memory service."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit
import uuid

from acclimate import Acclimate, ApiError, UsageError
from acclimate._jobs import payload_digest

BUNDLE = "11111111-1111-4111-8111-111111111111"


def payload(text):
    return {"schemaVersion": 1, "files": [{"path": "AGENTS.md", "kind": "instruction", "text": text}]}


class FakeService:
    """The bundle, version and release routes, with the service's payload encoding."""

    def __init__(self):
        self.versions, self.releases, self.writes = {}, {}, []
        self.move_during_release = False
        service = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, status, value):
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                url = urlsplit(self.path)
                if url.path.endswith("/bundles"):
                    return self.reply(200, {"items": [{"id": BUNDLE, "name": "support"}], "nextCursor": None})
                channel = url.path.split("/channels/")[1].split("/")[0]
                limit = int(parse_qs(url.query).get("limit", ["20"])[0])
                return self.reply(200, {"items": service.history(channel)[:limit], "nextBeforeRevision": None})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                service.writes.append((self.path, self.headers["Idempotency-Key"], body))
                if self.path.endswith("/versions"):
                    version = service.add_version(body["payload"], body["parentVersionId"])
                    if service.move_during_release:
                        service.release("stable", service.history("stable")[-1]["version"]["id"], "Someone else")
                    return self.reply(201, version)
                channel = self.path.split("/channels/")[1].split("/")[0]
                history = service.history(channel)
                if body["expectedRevision"] != (history[0]["revision"] if history else "0"):
                    return self.reply(409, {"error": {"code": "revision_conflict", "message": "Channel revision changed",
                                                      "requestId": "fake"}})
                return self.reply(201, service.release(channel, body["versionId"], body["unevaluatedReason"]))

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def history(self, channel):
        return self.releases.setdefault(channel, [])

    def add_version(self, body, parent):
        encoded = json.dumps({"schemaVersion": body["schemaVersion"], "files": [
            {"path": f["path"], "kind": f["kind"], "text": f["text"]} for f in body["files"]]},
            separators=(",", ":"), ensure_ascii=False) + "\n"
        version = {"id": str(uuid.uuid4()), "bundleId": BUNDLE, "parentVersionId": parent,
                   "digest": "sha256:" + hashlib.sha256(encoded.encode()).hexdigest(), "createdAt": "now"}
        self.versions[version["id"]] = version
        return version

    def release(self, channel, version_id, reason):
        history = self.history(channel)
        item = {"id": str(uuid.uuid4()), "channel": channel, "revision": str(len(history) + 1),
                "version": self.versions[version_id],
                "previousVersionId": history[0]["version"]["id"] if history else None,
                "unevaluatedReason": reason, "reviewer": "machine", "createdAt": "now"}
        history.insert(0, item)
        return item


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.service = FakeService()
        self.addCleanup(self.service.server.server_close)
        self.addCleanup(self.service.server.shutdown)
        first = self.service.add_version(payload("One.\n"), None)
        self.first = self.service.release("stable", first["id"], "First version")
        cache = tempfile.TemporaryDirectory()
        self.addCleanup(cache.cleanup)
        self.acclimate = Acclimate(self.service.url, "project", "token", cache_dir=cache.name)

    def test_release_uploads_a_child_version_and_skips_an_identical_payload(self):
        self.assertEqual(payload_digest(payload("One.\n")), self.first["version"]["digest"])
        with self.assertRaises(UsageError):
            self.acclimate.release("support", payload("Two.\n"), reason=" ")
        same = self.acclimate.release("support", payload("One.\n"), reason="Same")
        self.assertEqual((same["changed"], same["revision"]), (False, "1"))
        self.assertEqual(self.service.writes, [])
        released = self.acclimate.release("support", payload("Two.\n"), reason="Second")
        self.assertEqual((released["changed"], released["revision"], released["bundleId"]), (True, "2", BUNDLE))
        self.assertEqual(released["version"]["parentVersionId"], self.first["version"]["id"])
        (_, version_key, _), (_, release_key, release_body) = self.service.writes
        self.assertNotEqual(version_key, release_key)
        self.assertEqual((release_body["expectedRevision"], release_body["unevaluatedReason"]), ("1", "Second"))
        beta = self.acclimate.release("support", payload("Two.\n"), channel="beta", reason="Try it")
        self.assertEqual((beta["revision"], beta["version"]["parentVersionId"]), ("1", None))

    def test_a_moved_channel_is_a_revision_conflict_and_rollback_releases_the_previous_version(self):
        second = self.acclimate.release("support", payload("Two.\n"), reason="Second")
        self.service.move_during_release = True
        with self.assertRaises(ApiError) as caught:
            self.acclimate.release("support", payload("Three.\n"), reason="Third")
        self.assertEqual((caught.exception.code, caught.exception.status), ("revision_conflict", 409))
        self.service.move_during_release = False
        back = self.acclimate.rollback("support", reason="Undo")
        self.assertEqual((back["version"]["id"], back["revision"]), (second["version"]["id"], "4"))
        with self.assertRaises(UsageError):
            self.acclimate.rollback("support", channel="canary", reason="Undo")


if __name__ == "__main__":
    unittest.main()
