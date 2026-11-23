"""Client parity with the TypeScript SDK, public namespace hygiene and the interpreter guard."""

import http.server
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import unittest

import acclimate
from acclimate import AcclimateClient, ApiError, resolve_and_cache, types
from acclimate._python_version import require_supported_python

ROOT = Path(__file__).resolve().parents[2]
TS_CLIENT = ROOT / "packages" / "sdk" / "src" / "client.ts"
FIXTURES = ROOT / "contracts" / "fixtures"

# TypeScript methods with no Python counterpart, and why. Keep this list in sync
# with the parity table in apps/docs/content/docs/reference/python-sdk.mdx.
DELIBERATE_OMISSIONS: set[str] = set()


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def typescript_client_methods() -> set[str]:
    source = TS_CLIENT.read_text()
    body = source[source.index("export class AcclimateClient") :]
    return {
        snake(match)
        for match in re.findall(r"^  (?:async )?([a-z][A-Za-z]*)\(", body, flags=re.M)
        if match != "constructor"
    }


class Recorder(http.server.BaseHTTPRequestHandler):
    calls: list = []
    response: object = {}

    def log_message(self, *args):
        pass

    def _record(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        Recorder.calls.append({
            "method": self.command,
            "path": self.path,
            "key": self.headers.get("Idempotency-Key"),
            "connection": self.headers.get("X-Acclimate-Connection-Id"),
            "body": json.loads(body) if body and self.headers.get_content_type() == "application/json" else body or None,
            "media": self.headers.get_content_type(),
            "session": self.headers.get("X-Acclimate-Session"),
        })
        data = json.dumps(Recorder.response).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _record


class ParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = "http://127.0.0.1:%d" % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        Recorder.calls = []
        Recorder.response = {"items": [], "nextCursor": None}
        self.client = AcclimateClient(self.url, "token", "scope")

    def last(self):
        return Recorder.calls[-1]

    def test_every_typescript_client_method_has_a_python_counterpart(self):
        missing = sorted(
            name for name in typescript_client_methods() - DELIBERATE_OMISSIONS
            if not callable(getattr(AcclimateClient, name, None))
        )
        self.assertEqual(missing, [], "Add these methods or document the omission")

    def test_task_changes_and_imports_preserve_wire_shapes(self):
        client = AcclimateClient(self.url, "token", "scope", session_token="session")
        prefix = "/v1/workspaces/w/bundles/b/learning"
        client.list_learning_tasks("w", "b", split="evolve", flagged=False)
        self.assertEqual(self.last()["path"], prefix + "/tasks?split=evolve&flagged=false")
        client.list_blocked_learning_versions("w", "b")
        self.assertEqual(self.last()["path"], prefix + "/blocked-versions")
        client.unblock_learning_version("w", "b", "a/b")
        self.assertEqual((self.last()["method"], self.last()["path"]),
                         ("DELETE", prefix + "/blocked-versions/a%2Fb"))
        patch = {"confirm": True}
        client.edit_learning_task("w", "b", "a/b", patch)
        self.assertEqual((self.last()["method"], self.last()["path"], self.last()["body"]),
                         ("PATCH", prefix + "/tasks/a%2Fb", patch))
        material = b"input,expected\nhello,hi\n"
        client.import_learning_tasks("w", "b", material, "text/csv", "support tickets.csv")
        self.assertEqual(self.last()["path"], prefix + "/tasks/import?filename=support+tickets.csv")
        self.assertEqual((self.last()["body"], self.last()["media"]), (material, "text/csv"))
        client.export_held_out_tasks("w", "b")
        self.assertEqual(self.last()["path"], prefix + "/held-out-tasks/export")
        self.assertEqual(self.last()["session"], "session")

    def test_listing_methods_use_the_workspace_routes(self):
        c = self.client
        cases = [
            (lambda: c.list_workspaces(limit=5), "/v1/workspaces?limit=5"),
            (lambda: c.list_bundles("w", cursor="x y"), "/v1/workspaces/w/bundles?limit=50&cursor=x+y"),
            (lambda: c.list_channels("w", "b"), "/v1/workspaces/w/bundles/b/channels?limit=50"),
        ]
        for call, path in cases:
            with self.subTest(path=path):
                self.assertEqual(call(), {"items": [], "nextCursor": None})
                self.assertEqual((self.last()["method"], self.last()["path"]), ("GET", path))

    def test_bundle_setup_posts_one_keyed_write(self):
        request = {
            "name": "Support",
            "origin": "created",
            "channel": "stable",
            "payload": {"schemaVersion": 1, "files": []},
            "reason": "Initial release",
        }
        self.client.create_bundle_setup("w", request, "setup-1")
        call = self.last()
        self.assertEqual(
            (call["method"], call["path"], call["key"], call["body"]),
            ("POST", "/v1/workspaces/w/bundle-setups", "setup-1", request),
        )

    def test_connection_id_marks_delivery_reads_only(self):
        connection = "0D6B1E8C-0000-4000-8000-000000000001"
        client = AcclimateClient(self.url, "token", "scope", connection_id=connection)
        Recorder.response = json.loads((FIXTURES / "version-v1.json").read_text())
        client.get_version("w", "b", "v")
        self.assertEqual(self.last()["connection"], connection.lower())
        client.list_bundles("w")
        self.assertIsNone(self.last()["connection"])
        with self.assertRaisesRegex(ValueError, "connection_id must be a UUID"):
            AcclimateClient(self.url, "token", "scope", connection_id="not-a-uuid")

    def test_learning_inspection_preserves_candidate_and_memory_records(self):
        candidate: types.LearningCandidate = {
            "sample": 1, "status": "dropped", "dropReason": "scanner-rejected",
            "rationale": None, "changes": None,
            "scan": {"clean": False, "findings": [{"rule": "email", "field": "rationale", "path": None}]},
            "diagnosis": {"problem": {"id": "P1"}, "predicted": ["case-a"]},
            "screen": None, "versionId": None, "evaluationId": None, "evolveScore": None,
        }
        selection: types.LearningSelection = {
            "decision": "keep", "sample": None, "versionId": None, "digest": None,
            "reason": "Keep the incumbent", "model": "optimizer", "inputDigest": "sha256:input",
        }
        Recorder.response = {"candidates": [candidate], "selection": selection}
        actual = self.client.get_learning_round("w", "b", "r")
        self.assertEqual(actual["candidates"], [candidate])
        self.assertEqual(actual["selection"], selection)
        provenance: types._LearningMemoryProvenance = {
            "domain": "support", "benchmark": "tickets", "policyModel": "policy", "round": 1,
        }
        memory: types.LearningMemory = {
            "currentRevision": 2, "memoryRevision": 1, "memoryDigest": "sha256:memory",
            "improvementMemory": {
                "schemaVersion": 1, "memoryRevision": 1,
                "problems": [{"id": "P1", "rootCause": "Stops early", "openedRound": 1, "attempts": [{
                    "round": 1, "sample": 2, "accepted": True, "backfilled": False,
                    "what": {"rationale": "Retry", "changes": {"edits": [], "files": []}},
                    "files": ["AGENTS.md"], "predicted": ["case-a"], "fixed": ["case-a"],
                    "missed": [], "passed": 5, "total": 5, "domain": "support",
                    "provenance": provenance,
                }]}],
            },
            "records": [{
                "revision": 1, "problemId": "P1", "roundId": "r", "round": 1, "versionId": "v",
                "provenance": {**provenance, "evolveRevision": 2,
                               "optimizerModel": "optimizer"},
            }],
        }
        Recorder.response = memory
        self.assertEqual(self.client.get_learning_memory("w", "b", revision=1), memory)

    def test_offline_policy_matches_the_typescript_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            for offline in (
                {"max_age_ms": -1},
                {"max_age_ms": 31 * 86400 * 1000},
                {"max_age_ms": True},
                {"pinned_version_id": ""},
                {"max_age_ms": 1, "pinned_version_id": "v"},
                {"maxAgeMs": 1},
                60,
            ):
                with self.subTest(offline=offline), self.assertRaises(ValueError):
                    resolve_and_cache(
                        self.client, "w", "b", channel="stable", cache_dir=tmp + "/cache",
                        offline=offline,  # type: ignore[arg-type]
                    )
            self.assertEqual(Recorder.calls, [], "invalid policies must fail before any request")


class ReferenceDocsTest(unittest.TestCase):
    def test_python_reference_lists_every_client_method(self):
        reference = (ROOT / "apps" / "docs" / "content" / "docs" / "reference" / "python-sdk.mdx").read_text()
        documented = set(re.findall(r"`([a-z_]+)`", reference))
        aliases = {
            name for name, value in vars(AcclimateClient).items()
            if callable(value) and value.__name__ != name
        }
        public = {
            name for name, value in vars(AcclimateClient).items()
            if callable(value) and not name.startswith("_")
        }
        self.assertEqual(sorted(public - documented), [])
        self.assertEqual(sorted(aliases), [], "the deprecated method aliases are gone")


class NamespaceTest(unittest.TestCase):
    def test_removed_workflow_exports_are_absent(self):
        for name in ("Proposal", "Comparison", "Draft", "EvaluationHandoff",
                     "EvaluationProgressReporter"):
            self.assertFalse(hasattr(acclimate, name), name)
        for name in ("create_proposal", "create_draft", "create_comparison", "start_evaluation",
                     "report_comparison_policy_receipt"):
            self.assertFalse(hasattr(AcclimateClient, name), name)

    def test_root_exports_only_public_sdk_names(self):
        for helper in ("Literal", "TypedDict", "NotRequired", "Any", "Generic", "TypeVar"):
            self.assertNotIn(helper, dir(acclimate))
            self.assertNotIn(helper, acclimate.__all__)
        self.assertEqual(len(acclimate.__all__), len(set(acclimate.__all__)))
        for name in acclimate.__all__:
            self.assertTrue(hasattr(acclimate, name), name)
        self.assertLessEqual(set(types.__all__), set(acclimate.__all__))

    def test_every_public_wire_type_is_listed(self):
        defined = {
            name for name, value in vars(types).items()
            if not name.startswith("_") and getattr(value, "__module__", None) == "acclimate.types"
        }
        self.assertLessEqual(defined, set(types.__all__))

    def test_api_error_uses_snake_case_only(self):
        error = ApiError(409, "conflict", "message", "req-1")
        self.assertEqual(error.request_id, "req-1")
        self.assertFalse(hasattr(error, "requestId"))


class OpenApiContractTest(unittest.TestCase):
    def test_release_request_schema_matches_both_sdks(self):
        schemas = json.loads((ROOT / "contracts" / "openapi.json").read_text())["components"]["schemas"]
        schema = schemas["PromoteRequest"]
        fields = {"versionId", "expectedRevision", "unevaluatedReason"}
        self.assertEqual(set(schema["properties"]), fields)
        self.assertEqual(set(types.CreateReleaseRequest.__required_keys__), fields)
        ts_types = (ROOT / "packages" / "sdk" / "src" / "types.ts").read_text()
        body = re.search(r"export interface CreateReleaseRequest \{(.*?)\n\}", ts_types, re.S).group(1)
        self.assertEqual(set(re.findall(r"^\s+(\w+):", body, re.M)), fields)


class PythonVersionGuardTest(unittest.TestCase):
    def test_old_interpreters_get_a_readable_error(self):
        with self.assertRaises(ImportError) as caught:
            require_supported_python((3, 9, 5, "final", 0))
        self.assertIn("acclimate-sdk requires Python 3.11+, found 3.9.5", str(caught.exception))
        require_supported_python((3, 11, 0, "final", 0))

    def test_guard_runs_before_typing_imports_on_a_real_old_interpreter(self):
        old = next((path for path in map(shutil.which, ("python3.9", "python3.10")) if path), None)
        if old is None:
            self.skipTest("no Python 3.9 or 3.10 interpreter on PATH")
        result = subprocess.run(
            [old, "-c", "import acclimate"], cwd=ROOT / "python", capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("acclimate-sdk requires Python 3.11+", result.stderr)
        self.assertNotIn("NotRequired", result.stderr)


if __name__ == "__main__":
    unittest.main()
