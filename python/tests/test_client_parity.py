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
from acclimate.learning import held_out_digest

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
        ]
        for call, path in cases:
            with self.subTest(path=path):
                self.assertEqual(call(), {"items": [], "nextCursor": None})
                self.assertEqual((self.last()["method"], self.last()["path"]), ("GET", path))

    def test_get_principal_uses_the_workspace_route(self):
        Recorder.response = {"principalId": "machine:app", "kind": "machine", "rights": ["evaluate"]}
        self.assertEqual(self.client.get_principal("w"), Recorder.response)
        self.assertEqual((self.last()["method"], self.last()["path"]), ("GET", "/v1/workspaces/w/principal"))

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

    def test_learning_loop_routes_and_idempotency_keys(self):
        c = self.client
        prefix = "/v1/workspaces/w/bundles/b/learning"
        enroll = {"channel": "stable", "appPrincipalId": "machine:app",
                  "setting": {"domain": "support", "benchmark": "tickets", "policyModel": "model"},
                  "heldOut": {"digest": "sha256:" + "a" * 64, "cases": 2}}
        evolve = {"cases": [{"caseId": "a", "input": None, "expected": 1}], "retire": ["b"]}
        outcome = {"outcomeId": "outcome-id", "versionId": "version-id", "digest": "digest",
                   "input": None, "expected": 1}
        start = {"attemptId": "attempt"}
        report = {"attemptId": "attempt", "error": "learning.held_out_mismatch"}
        routes = [
            (lambda: c.enroll_learning_loop("w", "b", enroll), "PUT", "", None, enroll),
            (lambda: c.get_learning_loop("w", "b"), "GET", "", None, None),
            (lambda: c.pause_learning_loop("w", "b"), "POST", "/pause", None, None),
            (lambda: c.resume_learning_loop("w", "b", "resume"), "POST", "/resume", "resume", None),
            (lambda: c.stop_learning_loop("w", "b"), "POST", "/stop", None, None),
            (lambda: c.list_learning_rounds("w", "b", before=10, limit=2),
             "GET", "/rounds?before=10&limit=2", None, None),
            (lambda: c.get_learning_round("w", "b", "r", evaluation="x y"),
             "GET", "/rounds/r?evaluation=x+y", None, None),
            (lambda: c.get_learning_memory("w", "b"), "GET", "/memory", None, None),
            (lambda: c.get_learning_memory("w", "b", revision=0), "GET", "/memory?revision=0", None, None),
            (lambda: c.list_learning_evolve_cases("w", "b"), "GET", "/evolve-cases", None, None),
            (lambda: c.list_learning_evolve_cases("w", "b", after="a:b", limit=100),
             "GET", "/evolve-cases?after=a%3Ab&limit=100", None, None),
            (lambda: c.add_learning_evolve_cases("w", "b", evolve), "POST", "/evolve-cases", None, evolve),
            (lambda: c.report_learning_outcome("w", "b", outcome), "POST", "/outcomes", "outcome-id", outcome),
            (lambda: c.get_learning_work("w", "b"), "GET", "/work", None, None),
            (lambda: c.start_learning_evaluation("w", "b", "e", start),
             "POST", "/evaluations/e/start", "attempt", start),
            (lambda: c.report_learning_evaluation("w", "b", "e", report, "attempt:error"),
             "POST", "/evaluations/e/report", "attempt:error", report),
        ]
        for call, method, suffix, key, body in routes:
            with self.subTest(method=method, suffix=suffix):
                self.assertEqual(call(), Recorder.response)
                actual = self.last()
                self.assertEqual((actual["method"], actual["path"], actual["key"], actual["body"]),
                                 (method, prefix + suffix, key, body))

    def test_live_evolve_cases_preserve_page_and_entry_revisions(self):
        Recorder.response = {
            "items": [{"caseId": "a", "input": {"text": "hello"}, "expected": 1, "addedRevision": 2}],
            "next": "a",
            "evolveRevision": 3,
        }
        self.assertEqual(self.client.list_learning_evolve_cases("w", "b"), Recorder.response)

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
                "provenance": {**provenance, "evolveRevision": 2, "heldOutDigest": "sha256:held",
                               "optimizerModel": "optimizer"},
            }],
        }
        Recorder.response = memory
        self.assertEqual(self.client.get_learning_memory("w", "b", revision=1), memory)

    def test_held_out_commitment_matches_shared_fixture(self):
        fixture = json.loads((FIXTURES / "learning-held-out-v1.json").read_text())
        self.assertEqual(held_out_digest(fixture["cases"]), fixture["digest"])
        self.assertEqual(held_out_digest(list(reversed(fixture["cases"]))), fixture["digest"])

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
    def test_learning_schema_fields_and_required_keys(self):
        schemas = json.loads((ROOT / "contracts" / "openapi.json").read_text())["components"]["schemas"]
        for name in ("LearningLoopRequest", "LearningLoop", "LearningEvaluationReport",
                     "LearningEvaluationReportRequest", "LearningWork", "LearningOutcomeRequest",
                     "LearningRound", "LearningCandidate", "LearningDiagnosis", "LearningSelection",
                     "LearningMemory", "LearningEvolveCasesPage", "LearningLiveEvolveCase"):
            with self.subTest(schema=name):
                schema, typed_dict = schemas[name], getattr(types, name)
                self.assertEqual(set(schema["properties"]), set(typed_dict.__annotations__))
                self.assertEqual(set(schema.get("required", [])), set(typed_dict.__required_keys__))

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
