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
DELIBERATE_OMISSIONS = {
    # Deprecated alias of list_workspaces; the rename pass removes deprecated aliases.
    "list_projects",
}


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
            "integration": self.headers.get("X-Acclimate-Integration-Id"),
            "body": json.loads(body) if body else None,
        })
        data = json.dumps(Recorder.response).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = _record


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

    def test_listing_methods_use_the_workspace_routes(self):
        c = self.client
        cases = [
            (lambda: c.list_workspaces(limit=5), "/v1/workspaces?limit=5"),
            (lambda: c.list_bundles("w", cursor="x y"), "/v1/workspaces/w/bundles?limit=50&cursor=x+y"),
            (lambda: c.list_channels("w", "b"), "/v1/workspaces/w/bundles/b/channels?limit=50"),
            (lambda: c.list_proposals("w", "b"), "/v1/workspaces/w/bundles/b/proposals?limit=50"),
            (lambda: c.list_comparisons("w", "b"), "/v1/workspaces/w/bundles/b/comparisons?limit=50"),
            (
                lambda: c.list_drafts("w", "b", "stable", status="all"),
                "/v1/workspaces/w/bundles/b/channels/stable/drafts?limit=50&status=all",
            ),
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

    def test_learning_methods_match_the_typescript_routes_and_keys(self):
        c = self.client
        base = "/v1/workspaces/w/connections/c/learning"
        outcome = {"outcomeId": "o1", "versionId": "v", "digest": "d", "status": "completed"}
        audit = {
            "outcomeId": "o2", "startedReceiptId": "r", "versionId": "v", "digest": "d",
            "revision": "3", "parentVersionId": "p", "parentDigest": "pd", "verdict": "pass",
        }
        replay = {
            "versionId": "v", "digest": "d", "baselineRevision": "7", "outcomeId": "o3", "verdict": "pass",
        }
        cases = [
            (lambda: c.enroll_learning("w", "c", {"installationId": "i"}, "k1"), "PUT", "", "k1"),  # type: ignore[typeddict-item]
            (lambda: c.get_learning_enrollment("w", "c"), "GET", "", None),
            (lambda: c.stop_learning("w", "c", "k2"), "POST", "/stop", "k2"),
            (lambda: c.get_learning_outcome("w", "c", "o/1"), "GET", "/outcomes/o%2F1", None),
            (
                lambda: c.report_learning_incident_replay(
                    "w", "c", {"roundId": "r1", "outcomeId": "o", "versionId": "v", "digest": "d",
                               "baselineRevision": "1", "verdict": "pass"}),
                "POST", "/incident-replays", "r1",
            ),
            (lambda: c.report_learning_outcome("w", "c", outcome), "POST", "/outcomes", "o1"),
            (lambda: c.report_learning_outcome("w", "c", outcome, "custom"), "POST", "/outcomes", "custom"),
            (
                lambda: c.report_learning_correction("w", "c", {"correctionId": "c1", "outcomeId": "o"}),
                "POST", "/corrections", "c1",
            ),
            (
                lambda: c.report_learning_recheck(
                    "w", "c", {"correctionId": "c1", "versionId": "v", "digest": "d", "revision": "4",
                               "verdict": "resolved"}),
                "POST", "/rechecks", "c1:4",
            ),
            (lambda: c.get_learning_work("w", "c"), "GET", "/work", None),
            (
                lambda: c.get_learning_field_requalification("w", "c", "v1"),
                "GET", "/field-requalifications/v1", None,
            ),
            (lambda: c.report_learning_field_replay("w", "c", replay), "POST", "/field-requalifications", "o3:v:7"),
            (lambda: c.report_learning_field_audit("w", "c", audit), "POST", "/field-audits", "o2"),
            (lambda: c.review_learning_round("w", "c", "r1", True, "k3"), "POST", "/rounds/r1/review", "k3"),
            (
                lambda: c.renew_learning("w", "c", {"renewalId": "n1", "expectedRevision": 1,
                                                    "proposalAdmissions": 1, "audits": []}),
                "POST", "/renew", "n1",
            ),
            (
                lambda: c.restore_learning("w", "c", {"restoreId": "s1", "expectedRevision": "2", "reason": "x",
                                                      "target": {"kind": "source", "revision": "1",
                                                                 "versionId": "v"}}),
                "POST", "/restore", "s1",
            ),
        ]
        for call, method, suffix, key in cases:
            with self.subTest(suffix=suffix, method=method):
                call()
                got = self.last()
                self.assertEqual((got["method"], got["path"], got["key"]), (method, base + suffix, key))
        self.client.review_learning_round(
            "w", "c", "r1", False, "k4", policy_override={"reason": "ok", "receipts": []}
        )
        self.assertEqual(self.last()["body"], {"approve": False, "policyOverride": {"reason": "ok", "receipts": []}})
        self.client.review_learning_round("w", "c", "r1", True, "k5")
        self.assertEqual(self.last()["body"], {"approve": True})

    def test_integration_id_marks_delivery_reads_only(self):
        connection = "0D6B1E8C-0000-4000-8000-000000000001"
        client = AcclimateClient(self.url, "token", "scope", integration_id=connection)
        Recorder.response = json.loads((FIXTURES / "version-v1.json").read_text())
        client.get_version("w", "b", "v")
        self.assertEqual(self.last()["integration"], connection.lower())
        client.list_bundles("w")
        self.assertIsNone(self.last()["integration"])
        with self.assertRaisesRegex(ValueError, "integration_id must be a UUID"):
            AcclimateClient(self.url, "token", "scope", integration_id="not-a-uuid")

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


class NamespaceTest(unittest.TestCase):
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
    def test_handoff_and_descriptor_schemas_match_both_sdks(self):
        schemas = json.loads((ROOT / "contracts" / "openapi.json").read_text())["components"]["schemas"]
        ts_types = (ROOT / "packages" / "sdk" / "src" / "types.ts").read_text()
        for name, python_type in (("EvaluationHandoff", types.EvaluationHandoff),
                                  ("EvaluationDescriptor", types.EvaluationDescriptor)):
            with self.subTest(name=name):
                schema = schemas[name]
                self.assertEqual(set(schema["properties"]), set(python_type.__annotations__))
                self.assertEqual(set(schema["required"]), set(python_type.__required_keys__))
                body = re.search(r"export interface " + name + r" \{(.*?)\n\}", ts_types, re.S).group(1)
                self.assertEqual(set(schema["properties"]), set(re.findall(r"^\s+(\w+)\??:", body, re.M)))


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
