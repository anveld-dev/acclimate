"""Installed-app command workflow against a deterministic local HTTP fixture."""
from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

from acclimate.evaluation import Case, ExecutionResult, GradeResult, define_evaluation
from acclimate.evaluation_cli import evaluation_main
from acclimate._evaluation_journal import Journal

BUNDLE = "11111111-1111-4111-8111-111111111111"
PARENT = "22222222-2222-4222-8222-222222222222"
CANDIDATE = "33333333-3333-4333-8333-333333333333"
DRAFT = "44444444-4444-4444-8444-444444444444"
REQUEST = "55555555-5555-4555-8555-555555555555"
COMPARISON = "66666666-6666-4666-8666-666666666666"
NOW = "2026-11-16T12:00:00Z"


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.traffic = []
        self.policy_receipts = {}
        self.temporary = tempfile.TemporaryDirectory(prefix="acclimate-cli-")
        self.root = Path(self.temporary.name).resolve()
        self.configuration = self.root / "configuration"
        self.configuration.mkdir(mode=0o700)
        self.original = {"schemaVersion": 1, "files": [{"path": "instruction.md", "kind": "instruction", "text": "bad"}]}
        self.payload = {"schemaVersion": 1, "files": [{"path": "instruction.md", "kind": "instruction", "text": "good"}]}
        def version(identifier, payload, parent):
            return {"id": identifier, "bundleId": BUNDLE, "parentVersionId": parent, "digest": "sha256:" + hashlib.sha256(encoded(payload)).hexdigest(), "createdAt": NOW}
        self.parent = version(PARENT, self.original, None)
        self.candidate = version(CANDIDATE, self.payload, PARENT)
        self.state = {"request": None, "comparison": None, "revision": "1", "drafts": 0, "requests": 0, "executions": 0, "loseRequests": 0, "loseDrafts": 0, "receipts": {}, "failGrade": False, "flip": False}
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def reply(self, value, status=200, raw=False):
                body = value if raw else encoded(value)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def do_GET(self):
                owner.traffic.append(("GET", self.path))
                route = urlsplit(self.path).path
                state = owner.state
                if route.endswith("/policy-receipts"):
                    return self.reply({"items": list(owner.policy_receipts.values())})
                if route.endswith("/evaluation-capabilities"):
                    return self.reply({"schemaVersion": 1, "projectId": "project", "principalId": "evaluator", "checkedAt": NOW, "readUnpublished": True, "writeEvaluation": True, "retainedEvaluationOperations": True})
                if route=="/v1/workspaces/project/bundles":
                    return self.reply({"items":[{"id":BUNDLE}],"nextCursor":None})
                if "/operations/" in route:
                    key = route.rsplit("/", 1)[1]
                    return self.reply(state["receipts"].get(key, {"status": "not_observed", "operationId": key}))
                if route.endswith("/channels/stable"):
                    return self.reply({"channel": "stable", "revision": state["revision"], "version": owner.parent})
                for identifier, version, payload in ((PARENT, owner.parent, owner.original), (CANDIDATE, owner.candidate, owner.payload)):
                    if route.endswith("/versions/" + identifier + "/payload"):
                        return self.reply(encoded(payload), raw=True)
                    if route.endswith("/versions/" + identifier):
                        return self.reply(version)
                if route.endswith("/evaluation-requests/" + REQUEST) and state["request"]:
                    return self.reply(state["request"])
                if route.endswith("/evaluation-requests/" + REQUEST + "/progress") and "progress" in state:
                    return self.reply(state["progress"])
                if route.endswith("/comparisons/" + COMPARISON) and state["comparison"]:
                    return self.reply(state["comparison"])
                self.reply({"error": {"code": "not_found", "message": "fixture missing", "requestId": "fixture"}}, 404)
            def do_POST(self):
                owner.traffic.append(("POST", self.path))
                try:
                    route = urlsplit(self.path).path
                    state = owner.state
                    raw = self.rfile.read(int(self.headers["Content-Length"]))
                    body = json.loads(raw)
                    if route.endswith("/policy-receipts"):
                        receipt = {**body, "comparisonId": COMPARISON, "reportedBy": "evaluator", "receivedAt": NOW}
                        owner.policy_receipts[body["policy"]["sha256"]] = receipt
                        return self.reply(receipt)
                    key = self.headers["Idempotency-Key"]
                    owner.assertEqual(self.headers["X-Acclimate-Durable-Operation"], "true")
                    fingerprint = "sha256:" + hashlib.sha256(b"POST\0" + route.replace("/v1/workspaces/", "/v1/projects/", 1).encode() + b"\0" + raw).hexdigest()
                    result = state["receipts"].get(key, {}).get("result")
                    if result is not None:
                        owner.assertEqual(state["receipts"][key]["requestFingerprint"], fingerprint)
                    elif route.endswith("/drafts"):
                        state["drafts"] += 1
                        result = {"id": DRAFT, "channel": "stable", "baseVersionId": PARENT, "baseRevision": "1", "snapshotVersion": owner.candidate, "generation": 1, "status": "open", "createdAt": NOW, "updatedAt": NOW, "promotionId": None}
                    elif route.endswith("/evaluation-requests"):
                        state["requests"] += 1
                        state["request"] = {**body, "id": REQUEST, "status": "requested", "attemptId": None, "evaluatorPrincipal": None, "comparisonId": None, "error": None, "createdAt": NOW, "updatedAt": NOW}
                        result = state["request"]
                    elif route.endswith("/start"):
                        state["request"] = {**state["request"], "status": "running", "attemptId": body["attemptId"], "evaluatorPrincipal": "evaluator"}
                        result = state["request"]
                    elif route.endswith("/comparisons"):
                        complete = all(outcome["executionStatus"] != "infrastructure_failed" and outcome["gradingStatus"] == "scored" for pair in body["results"] for outcome in (pair["parent"], pair["candidate"]))
                        state["comparison"] = {**body, "id": COMPARISON, "complete": complete, "submitter": "evaluator", "createdAt": NOW}
                        result = state["comparison"]
                    elif route.endswith("/finish"):
                        state["request"] = {**state["request"], "status": "completed" if state["comparison"]["complete"] else "failed", "comparisonId": body["comparisonId"]}
                        result = state["request"]
                    elif route.endswith("/interrupt"):
                        state["request"] = {**state["request"], "status": "interrupted", "error": body["reason"]}
                        result = state["request"]
                    else:
                        raise ValueError()
                    state["receipts"][key] = {"status": "committed", "operationId": key, "path": route, "requestFingerprint": fingerprint, "result": deepcopy(result)}
                    if (route.endswith("/evaluation-requests") and state["loseRequests"]) or (route.endswith("/drafts") and state["loseDrafts"]):
                        state["loseDrafts" if route.endswith("/drafts") else "loseRequests"] -= 1
                        self.close_connection = True
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                        return
                    self.reply(result)
                except Exception:
                    self.reply({"error": {"code": "fixture", "message": "private fixture error", "requestId": "fixture"}}, 500)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.service = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.config, self.reader = self.configuration / "evaluator.json", self.configuration / "reader.json"
        self.config.write_bytes(encoded({"schemaVersion": 1, "serviceUrl": self.service, "projectId": "project", "evaluatorPrincipalId": "evaluator", "evaluatorToken": "PRIVATE_CANARY", "journalRoot": str(self.root / "journals")}))
        self.reader.write_bytes(encoded({"schemaVersion": 1, "serviceUrl": self.service, "projectId": "project", "readToken": "READER_CANARY"}))
        self.config.chmod(0o600)
        self.reader.chmod(0o600)
        self.payload_file, self.intent, self.handoff, self.policy = [self.root / name for name in ("candidate.json", "intent.json", "request.json", "policy.json")]
        self.payload_file.write_bytes(encoded(self.payload))
        self.quality = {"schemaVersion": 1, "id": "quality", "revision": "1", "metric": {"name": "correct", "unit": "reward", "direction": "higher"}, "aggregation": "equal-case-means", "minimumMeanImprovement": 0.5, "maximumCaseRegression": 0, "requiredCases": ["case"],
                        "inference": {"method": "none"}}  # one saved case: point-estimate check
        self.policy.write_bytes(encoded(self.quality))
        def execute(run):
            self.state["executions"] += 1
            return ExecutionResult(output={"correct": run.bundle["payload"]["files"][0]["text"] == ("bad" if self.state["flip"] else "good")})
        def grade(run):
            if self.state["failGrade"]:
                raise RuntimeError("PRIVATE_GRADER_CANARY")
            return GradeResult(reward=float(run.output["correct"] == run.expected), explanation={"reason": "fixture rubric"})
        self.app = define_evaluation(config_id="app", config_revision="1", dataset_revision="cases-1", grader_revision="grader-1", runtime={"model": "none"}, execution="model-free", cases=[Case("case", {"task": "saved"}, True)], execute=execute, grade=grade)
        self.request_args = ["request", "--config", str(self.config), "--bundle", BUNDLE, "--channel", "stable", "--payload", str(self.payload_file), "--intent", str(self.intent), "--out", str(self.handoff)]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def invoke(self, args, review=None):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            status = evaluation_main(self.app, args, review=review)
        return status, json.loads(output.getvalue()) if output.getvalue() else None, json.loads(errors.getvalue()) if errors.getvalue() else None

    def test_plan_sizes_the_inventory_without_running_callbacks(self):
        status, plan, _ = self.invoke(["plan", "--policy", str(self.policy), "--simulations", "20"])
        self.assertEqual((status, plan["method"], plan["cases"]), (0, "none", 1))
        self.policy.write_bytes(encoded({**self.quality, "inference": {"method": "paired-t"}}))
        status, plan, _ = self.invoke(["plan", "--policy", str(self.policy), "--simulations", "5"])
        self.assertEqual((status, plan["sufficient"]), (3, False))
        self.assertEqual(plan["simulation"]["results"][0]["indeterminateRate"], 1)
        status, _, error = self.invoke(["plan", "--policy", str(self.policy), "--effects", "x"])
        self.assertEqual((status, error["error"]["code"]), (1, "config.schema"))

    def test_closed_usage_and_descriptor(self):
        status, value, _ = self.invoke(["describe"])
        self.assertEqual(status, 0)
        self.assertEqual(value["runtime"]["configId"], "app")
        self.assertNotIn("cases", value)
        status, _, error = self.invoke(["run", "--config", str(self.config), "--config", "PRIVATE_CANARY"])
        self.assertEqual(status, 1)
        self.assertEqual(error["error"]["code"], "config.schema")
        self.assertNotIn("PRIVATE_CANARY", json.dumps(error))

    def test_named_compare_exposes_reuse_and_resolves_for_followups(self):
        handle = ["--config", str(self.config), "--name", "first-run"]
        compare = ["compare", *handle, "--bundle", BUNDLE, "--channel", "stable", "--payload", str(self.payload_file)]
        code, first, error = self.invoke(compare)
        self.assertEqual(code, 0, error)
        self.assertEqual(first["runName"], "first-run")
        self.assertEqual(first["invocation"], {"callbacksStarted": 2, "reusedEvidence": False})
        _, again, _ = self.invoke(compare)
        self.assertEqual(again["invocation"], {"callbacksStarted": 0, "reusedEvidence": True})
        self.assertEqual(again["requestId"], first["requestId"])
        self.assertEqual(self.invoke(["status", *handle])[1]["requestId"], first["requestId"])
        self.assertEqual(self.invoke(["check", *handle, "--policy", str(self.policy)])[1]["verdict"], "pass")
        destination = self.root / "named-export"
        self.assertEqual(self.invoke(["export", *handle, "--out", str(destination)])[0], 0)
        self.assertEqual(self.invoke(["verify-export", "--manifest", str(destination / "manifest.json")])[0], 0)
        self.assertEqual(self.state["executions"], 2)

    def test_fresh_attempt_requires_settled_predecessor_and_matching_target(self):
        inputs = ["compare", "--config", str(self.config), "--bundle", BUNDLE, "--channel", "stable", "--payload", str(self.payload_file)]
        self.assertEqual(self.invoke([*inputs, "--name", "original"])[0], 0)
        retry = [*inputs, "--retry-after", "original"]
        for status in ("requested", "running", "interrupted"):
            self.state["request"]["status"] = status
            code, _, error = self.invoke(retry)
            self.assertEqual(code, 3)
            self.assertEqual(error["error"]["code"], "evidence.not_terminal")
        self.state["request"]["status"] = "completed"
        self.state["revision"] = "2"
        self.assertEqual(self.invoke(retry)[2]["error"]["code"], "request.base_conflict")
        self.payload_file.write_bytes(encoded(self.original))
        self.assertEqual(self.invoke(retry)[2]["error"]["code"], "request.intent_mismatch")
        self.assertEqual(self.state["drafts"], 1)
        self.assertEqual(self.state["executions"], 2)

    def test_first_policy_error_names_only_known_missing_fields(self):
        value = {**self.quality, "metric": {"name": "PRIVATE_CANARY"}, "PRIVATE_CANARY": "x"}
        del value["requiredCases"], value["id"]
        self.policy.write_bytes(encoded(value))
        _, _, error = self.invoke(["compare", "--config", str(self.config), "--handoff", str(self.handoff), "--policy", str(self.policy)])
        self.assertEqual(error["error"]["code"], "policy.invalid")
        self.assertEqual(sorted(error["error"]["missingFields"]), ["id", "metric.direction", "metric.unit", "requiredCases"])
        self.assertNotIn("PRIVATE_CANARY", json.dumps(error))
        self.assertFalse(self.traffic)

    def test_headless_full_workflow_and_policy_separation(self):
        self.assertEqual(self.invoke(self.request_args)[0], 0)
        check = ["check", "--read-config", str(self.reader), "--handoff", str(self.handoff), "--policy", str(self.policy)]
        self.assertEqual(self.invoke(check)[0], 3)
        self.assertEqual(self.invoke(["run", "--config", str(self.config), "--handoff", str(self.handoff)])[0], 0)
        self.assertEqual(self.state["executions"], 2)
        self.assertEqual(self.invoke(check)[0], 0)
        self.policy.write_bytes(encoded({**self.quality, "minimumMeanImprovement": 2}))
        self.assertEqual(self.invoke(check)[0], 2)
        destination = self.root / "export"
        self.assertEqual(self.invoke(["export", "--read-config", str(self.reader), "--handoff", str(self.handoff), "--out", str(destination)])[0], 0)
        status, value, error = self.invoke(["verify-export", "--manifest", str(destination / "manifest.json"), "--read-config", str(self.reader), "--handoff", str(self.handoff)])
        self.assertEqual(status, 0, error)
        self.assertEqual(value["provenance"], "online_scalar_binding")
        self.assertEqual(self.invoke(["run", "--config", str(self.config), "--handoff", str(self.handoff)])[0], 0)
        self.assertEqual(self.state["executions"], 2)

    def test_compare_terminal_policy_and_machine_output_use_the_existing_result(self):
        args = ["compare", "--config", str(self.config), "--handoff", str(self.handoff), "--policy", str(self.policy)]
        def run(args, terminal):
            output, errors = io.StringIO(), io.StringIO()
            with patch.object(output, "isatty", return_value=terminal), redirect_stdout(output), redirect_stderr(errors):
                code = evaluation_main(self.app, args)
            return code, output.getvalue(), errors.getvalue()
        with patch.object(type(self.app), "execution", new=property(lambda self: "live")):
            code, _, usage = run(args, True)
            self.assertEqual(code, 1)
            self.assertIn("requires --live", usage)
            self.assertIn("--bundle ID --channel CHANNEL", usage)
            self.assertNotIn(str(self.config), usage)
        code, _, usage = run(args + ["--name", "PRIVATE_CANARY"], True)
        self.assertIn("--handoff cannot be combined", usage)
        self.assertNotIn("PRIVATE_CANARY", usage)
        self.assertEqual(self.traffic, [])
        self.assertEqual(self.invoke(self.request_args)[0], 0)
        self.policy.write_bytes(encoded({**self.quality, "minimumMeanImprovement": 2}))
        code, text, _ = run(args, True)
        self.assertEqual(code, 2)
        self.assertIn(REQUEST, text)
        self.assertRegex(text, r"Equal-case means\s+parent 0.0\s+candidate 1.0")
        self.assertRegex(text, r"Pair coverage\s+1/1")
        self.assertRegex(text, r'"case"\s+parent 0.0\s+candidate 1.0')
        self.assertRegex(text, r"Policy\s+fail")
        self.assertIn("policy.minimum_mean_improvement", text)
        before = len(self.traffic)
        piped = run(args, False)
        reads = self.traffic[before:]
        before = len(self.traffic)
        explicit = run(args + ["--json"], True)
        self.assertEqual(explicit, piped)
        self.assertEqual(reads, self.traffic[before:])
        before = len(self.traffic)
        self.assertIn("Execution callbacks started this time: 2", text)
        self.assertIn("Reused saved evidence", run(args, True)[1])
        self.assertEqual(self.traffic[before:], reads)
        self.assertTrue(all(method == "GET" for method, _ in reads))
        self.assertEqual(self.state["executions"], 2)

    def test_compare_terminal_reports_partial_grades(self):
        self.assertEqual(self.invoke(self.request_args)[0], 0)
        self.state["failGrade"] = True
        output = io.StringIO()
        with patch.object(output, "isatty", return_value=True), redirect_stdout(output):
            code = evaluation_main(self.app, ["compare", "--config", str(self.config), "--handoff", str(self.handoff), "--policy", str(self.policy)])
        self.assertEqual(code, 3)
        self.assertIn("candidate · grade · grading_failed", output.getvalue())
        self.assertRegex(output.getvalue(), r'0/1 \(partial\)')
        self.assertRegex(output.getvalue(), r'"case" \[0\]\s+parent unknown\s+candidate unknown')
        self.assertRegex(output.getvalue(), r'Policy\s+indeterminate')
        self.assertIn("evidence.incomplete", output.getvalue())
        code, result, _ = self.invoke(["compare", "--config", str(self.config),
            "--handoff", str(self.handoff), "--policy", str(self.policy), "--json"])
        self.assertEqual(code, 3)
        self.assertEqual(result["scores"]["evidenceGaps"]["rows"],
            [{"caseId":"case", "repetition":0, "side":side, "stage":"grade", "reason":"grading_failed"}
             for side in ("parent", "candidate")])

    def test_private_policy_result_and_recorded_release_receipt_are_distinct(self):
        self.assertEqual(self.invoke(self.request_args)[0], 0)
        args = ["compare", "--config", str(self.config), "--handoff", str(self.handoff), "--policy", str(self.policy)]
        from acclimate.client import AcclimateClient, TransportError
        with patch.object(AcclimateClient, "report_comparison_policy_receipt", side_effect=TransportError()):
            code, result, _ = self.invoke(args)
        self.assertEqual((code, result["policy"]["verdict"], result["policyReceipt"]["status"]),
                         (1, "pass", "unconfirmed"))
        self.assertEqual(len(self.policy_receipts), 0)
        code, result, _ = self.invoke(["check", "--read-config", str(self.reader), "--handoff",
                                      str(self.handoff), "--policy", str(self.policy)])
        self.assertEqual((code, result["policyReceipt"]["status"]), (0, "read_only"))
        self.assertEqual(len(self.policy_receipts), 0)
        code, result, _ = self.invoke(args)
        self.assertEqual((code, result["policyReceipt"]["status"], len(self.policy_receipts)), (0, "recorded", 1))
        self.assertEqual(self.state["executions"], 2)

    def test_status_projects_bound_optional_progress(self):
        self.assertEqual(self.invoke(self.request_args)[0], 0)
        args = ["status", "--read-config", str(self.reader), "--handoff", str(self.handoff)]
        self.assertEqual(self.invoke(args)[1]["progress"]["reason"], "unavailable")
        view = {"schemaVersion": 1, "requestId": REQUEST, "attemptId": None, "status": "requested",
                "activity": "absent", "checkedAt": NOW, "observation": None}
        self.state["progress"] = view
        self.assertEqual(self.invoke(args)[1]["progress"]["reason"], "no_report")
        attempt = "88888888-8888-4888-8888-888888888888"
        self.state["request"].update(status="running", attemptId=attempt)
        current = self.state["request"]["expectedCases"][0]
        view.update(status="running", attemptId=attempt, activity="fresh",
                    observation={"attemptId": attempt, "phase": "grading", "completed": 1, "total": 2,
                                 "receivedAt": NOW, "case": current})
        self.assertEqual(self.invoke(args)[1]["progress"], {"activity": "fresh", "phase": "grading",
                         "completed": 1, "total": 2, "case": current, "receivedAt": NOW, "checkedAt": NOW})
        view["observation"]["attemptId"] = PARENT
        self.assertEqual(self.invoke(args)[1]["progress"]["reason"], "unavailable")

    def test_lost_creation_recovers_original_before_drift_and_changed_payload_rejected(self):
        self.state["loseRequests"] = 3
        self.assertEqual(self.invoke(self.request_args)[0], 3)
        self.state["revision"] = "2"
        status, result, error = self.invoke(self.request_args)
        self.assertEqual(status, 0, error)
        self.assertEqual(result["requestId"], REQUEST)
        self.assertEqual(self.state["drafts"], 1)
        self.assertEqual(self.state["requests"], 1)
        self.payload_file.write_bytes(encoded(self.original))
        status, _, error = self.invoke(self.request_args)
        self.assertEqual(status, 1)
        self.assertEqual(error["error"]["code"], "request.intent_mismatch")

    def test_static_selected_role_export(self):
        self.assertEqual(self.invoke(self.request_args)[0], 0)
        self.assertEqual(self.invoke(["run", "--config", str(self.config), "--handoff", str(self.handoff)])[0], 0)
        selection = self.root / "selection.json"
        selection.write_bytes(encoded({"schemaVersion": 1, "entries": [{"caseId": "case", "repetition": 0, "side": "candidate", "role": "output", "required": True}]}))
        status, result, error = self.invoke(["export", "--config", str(self.config), "--handoff", str(self.handoff), "--selection", str(selection), "--out", str(self.root / "selected")], review={"to_review_artifact": lambda value: {"mediaType": "application/json", "value": value["value"]}})
        self.assertEqual(status, 0, error)
        self.assertEqual(result["selection"]["exportedRequired"], 1)

    def test_completed_candidate_loss_is_run_success_and_policy_failure(self):
        self.state["flip"] = True
        self.assertEqual(self.invoke(self.request_args)[0], 0)
        self.assertEqual(self.invoke(["run", "--config", str(self.config), "--handoff", str(self.handoff)])[0], 0)
        self.assertEqual(self.invoke(["check", "--config", str(self.config), "--handoff", str(self.handoff), "--policy", str(self.policy)])[0], 2)
        pair = self.state["comparison"]["results"][0]
        self.assertLess(pair["candidate"]["reward"], pair["parent"]["reward"])

    def test_failed_grading_is_run_failure_and_indeterminate_policy(self):
        self.state["failGrade"] = True
        self.assertEqual(self.invoke(self.request_args)[0], 0)
        status, result, _ = self.invoke(["run", "--config", str(self.config), "--handoff", str(self.handoff)])
        self.assertEqual(status, 2)
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("PRIVATE_GRADER_CANARY", json.dumps(result))
        self.assertEqual(self.invoke(["check", "--config", str(self.config), "--handoff", str(self.handoff), "--policy", str(self.policy)])[0], 3)

    def test_interrupted_request_never_invokes_callbacks(self):
        self.assertEqual(self.invoke(self.request_args)[0], 0)
        self.state["request"]["status"] = "interrupted"
        self.assertEqual(self.invoke(["run", "--config", str(self.config), "--handoff", str(self.handoff)])[0], 3)
        self.assertEqual(self.state["executions"], 0)

    def test_check_without_terminal_comparison_is_indeterminate_for_all_lifecycle_states(self):
        self.assertEqual(self.invoke(self.request_args)[0],0)
        check=["check","--read-config",str(self.reader),"--handoff",str(self.handoff),"--policy",str(self.policy)]
        for lifecycle in ("requested","running","interrupted"):
            with self.subTest(lifecycle=lifecycle):
                self.state["request"]["status"]=lifecycle
                self.state["request"]["attemptId"]=None if lifecycle=="requested" else "77777777-7777-4777-8777-777777777777"
                self.state["request"]["evaluatorPrincipal"]=None if lifecycle=="requested" else "evaluator"
                status,result,error=self.invoke(check)
                self.assertEqual(status,3)
                self.assertIsNone(error)
                self.assertEqual(result["verdict"],"indeterminate")
                self.assertEqual(result["code"],"evidence.not_terminal")
                self.assertEqual(result["requestId"],REQUEST)
                self.assertEqual(self.state["executions"],0)
                self.assertIsNone(self.state["comparison"])

    def test_committed_comparison_oversized_response_is_exit3_and_exact_retry_without_execution(self):
        self.assertEqual(self.invoke(self.request_args)[0],0)
        run=["run","--config",str(self.config),"--handoff",str(self.handoff)]
        handler_type=self.server.RequestHandlerClass
        original_reply=handler_type.reply
        oversize_once=True
        submitted=[]
        def reply(handler,value,status=200,raw=False):
            nonlocal oversize_once
            if handler.command=="POST" and handler.path.endswith("/comparisons"):
                key=handler.headers["Idempotency-Key"]
                # The existing handler has already committed the original result
                # and its fingerprint before calling reply.
                submitted.append((key,self.state["receipts"][key]["requestFingerprint"]))
                if oversize_once:
                    oversize_once=False
                    value={**value,"padding":"x"*(4*1024*1024)}
            try:
                return original_reply(handler,value,status,raw)
            except (BrokenPipeError,ConnectionResetError):
                return None
        with patch.object(handler_type,"reply",reply):
            status,result,error=self.invoke(run)
            self.assertEqual(status,3)
            self.assertIsNone(result)
            self.assertEqual(error["error"]["code"],"transport.response_too_large")
            self.assertEqual(error["error"]["executionState"],"report_saved")
            self.assertEqual(error["error"]["nextAction"],"retry_same_command")
            self.assertNotIn("PRIVATE_CANARY",json.dumps(error))
            self.assertEqual(self.state["comparison"]["id"],COMPARISON)
            attempt_file=next((self.root/"journals").glob("*/attempt.python.json"))
            attempt=json.loads(attempt_file.read_bytes())
            attempt_id=attempt["attemptId"]
            submit_key=attempt["keys"]["submit"]
            body=(attempt_file.parent/attempt["wireBodies"]["submit"]["file"]).read_bytes()
            self.assertTrue(attempt["report"])
            self.assertNotIn("comparisonId",attempt)
            executions=self.state["executions"]
            self.assertEqual(executions,2)
            status,result,error=self.invoke(run)
            self.assertEqual(status,0,error)
            self.assertEqual(result["comparisonId"],COMPARISON)
            self.assertEqual(result["attemptId"],attempt_id)
            self.assertEqual(self.state["executions"],executions)
            self.assertEqual(len(submitted),2)
            route=f"/v1/workspaces/project/bundles/{BUNDLE}/comparisons"
            fingerprint="sha256:"+hashlib.sha256(b"POST\0"+route.replace("/v1/workspaces/", "/v1/projects/", 1).encode()+b"\0"+body).hexdigest()
            self.assertEqual(submitted,[(submit_key,fingerprint),(submit_key,fingerprint)])
            final=json.loads(attempt_file.read_bytes())
            self.assertEqual(final["keys"]["submit"],submit_key)
            self.assertEqual((attempt_file.parent/"submit-body.json").read_bytes(),body)

    def test_interrupt_does_not_wait_for_the_running_scope_lock(self):
        self.assertEqual(self.invoke(self.request_args)[0], 0)
        config = json.loads(self.config.read_text())
        scope = {"serviceUrl": self.service, "projectId": "project", "bundleId": BUNDLE, "requestId": REQUEST, "evaluatorPrincipalId": "evaluator"}
        with Journal(config["journalRoot"], scope) as journal:
            status, result, error = self.invoke(["interrupt", "--config", str(self.config), "--handoff", str(self.handoff), "--reason", "reviewed"])
            self.assertEqual(status, 0, error)
            self.assertEqual(result["status"], "interrupted")
            journal.assert_owned()

    def test_lost_candidate_then_channel_drift_refuses_rebase(self):
        self.state["loseDrafts"] = 3
        self.assertEqual(self.invoke(self.request_args)[0], 3)
        self.assertEqual(self.state["drafts"], 1)
        self.assertEqual(self.state["requests"], 0)
        self.state["revision"] = "2"
        status, _, error = self.invoke(self.request_args)
        self.assertEqual(status, 3)
        self.assertEqual(error["error"]["code"], "request.base_conflict")
        self.assertEqual(self.state["drafts"], 1)
        self.assertEqual(self.state["requests"], 0)

    def test_missing_original_intent_does_not_regenerate_creation_keys(self):
        self.state["loseRequests"] = 3
        self.assertEqual(self.invoke(self.request_args)[0], 3)
        self.intent.unlink()
        status, _, error = self.invoke(self.request_args)
        self.assertEqual(status, 3)
        self.assertEqual(error["error"]["code"], "journal.missing")
        self.assertEqual(self.state["drafts"], 1)
        self.assertEqual(self.state["requests"], 1)

    def test_request_denial_uses_exit1_while_doctor_uses_exit2(self):
        blocked = {"status": "blocked", "authorization": "denied", "checks": [{"status": "failed", "code": "auth.denied"}]}
        with patch("acclimate.evaluation_cli.preflight_evaluation", return_value=blocked):
            self.assertEqual(self.invoke(["doctor", "--config", str(self.config), "--bundle", BUNDLE])[0], 2)
            self.assertEqual(self.invoke(self.request_args)[0], 1)
        self.assertEqual(self.state["drafts"], 0)
        self.assertEqual(self.state["requests"], 0)

    def test_doctor_verifies_bundle_and_reports_missing_request_without_execution(self):
        status,result,_=self.invoke(["doctor","--config",str(self.config),"--bundle",BUNDLE])
        self.assertEqual(status,0)
        self.assertEqual(result["status"],"ready")
        status,result,_=self.invoke(["doctor","--config",str(self.config),"--bundle",COMPARISON])
        self.assertEqual(status,2)
        self.assertEqual(result["checks"][-1]["code"],"bundle.missing")
        self.assertEqual(result["nextAction"],"fix_config")
        self.handoff.write_bytes(encoded({"schemaVersion":1,"serviceUrl":self.service,
            "projectId":"project","bundleId":BUNDLE,"requestId":REQUEST,"configuration":self.app.descriptor}))
        status,result,error=self.invoke(["doctor","--config",str(self.config),"--handoff",str(self.handoff)])
        self.assertEqual(status,2)
        self.assertEqual(result["checks"][-1]["code"],"request.missing")
        self.assertEqual(result["nextAction"],"fix_config")
        self.assertIsNone(error)
        self.assertNotIn("PRIVATE_CANARY",json.dumps(result))
        self.assertNotIn(str(self.root),json.dumps(result))
        self.assertEqual(self.state["executions"],0)
        self.assertEqual(self.state["drafts"],0)
        self.assertEqual(self.state["requests"],0)
        self.assertIsNone(self.state["request"])

    def test_interrupt_rejects_mismatched_descriptor_before_mutation(self):
        self.assertEqual(self.invoke(self.request_args)[0], 0)
        handoff = json.loads(self.handoff.read_bytes())
        handoff["configuration"]["graderRevision"] = "another-grader"
        self.handoff.write_bytes(encoded(handoff))
        status, _, error = self.invoke(["interrupt", "--config", str(self.config), "--handoff", str(self.handoff), "--reason", "reviewed"])
        self.assertEqual(status, 1)
        self.assertEqual(error["error"]["code"], "descriptor.mismatch")
        self.assertEqual(self.state["request"]["status"], "requested")

    def test_check_rejects_unbound_request_and_candidate_without_direct_parent(self):
        self.assertEqual(self.invoke(self.request_args)[0], 0)
        self.assertEqual(self.invoke(["run", "--config", str(self.config), "--handoff", str(self.handoff)])[0], 0)
        args = ["check", "--read-config", str(self.reader), "--handoff", str(self.handoff), "--policy", str(self.policy)]
        self.state["request"]["requireBoundEvidence"] = False
        status, _, error = self.invoke(args)
        self.assertEqual(status, 1)
        self.assertEqual(error["error"]["code"], "evidence.identity_mismatch")
        self.state["request"]["requireBoundEvidence"] = True
        self.candidate["parentVersionId"] = None
        status, _, error = self.invoke(args)
        self.assertEqual(status, 1)
        self.assertEqual(error["error"]["code"], "version.binding_mismatch")

    def test_creation_recovery_survives_same_principal_token_rotation(self):
        self.state["loseRequests"] = 3
        self.assertEqual(self.invoke(self.request_args)[0], 3)
        config = json.loads(self.config.read_bytes())
        config["evaluatorToken"] = "ROTATED_PRIVATE_CANARY"
        self.config.write_bytes(encoded(config))
        status, result, error = self.invoke(self.request_args)
        self.assertEqual(status, 0, error)
        self.assertEqual(result["requestId"], REQUEST)
        self.assertEqual(self.state["requests"], 1)
        self.assertNotIn("PRIVATE_CANARY", self.intent.read_text())
        self.assertNotIn("PRIVATE_CANARY", json.dumps(result))

    def test_doctor_missing_private_config_is_invalid_input_exit1(self):
        status, result, error = self.invoke(["doctor", "--config", str(self.root / "missing.json"), "--bundle", BUNDLE])
        self.assertEqual(status, 1, error)
        self.assertEqual(result["checks"][-1]["code"], "config.missing")
        self.assertEqual(self.state["executions"], 0)


if __name__ == "__main__":
    unittest.main()
