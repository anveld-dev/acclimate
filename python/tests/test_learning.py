import contextlib
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from acclimate import Acclimate, AcclimateClient, ApiError, UsageError
from acclimate.evaluation_app import main
from acclimate.learning import (
    _enroll, _is_held_out, _load_cases, _sync_cases, define_loop,
    exact, held_out_digest, serve_learning_loop, tests as command_grade,
)


def case(case_id, input=None, expected=1):
    return {"caseId": case_id, "input": input, "expected": expected}


class DefinitionTest(unittest.TestCase):
    def definition(self, **settings):
        return define_loop(bundle="support", channel="stable", cases="cases.jsonl",
                           execute=lambda *_: 1, grade=exact(), policy_model="model", **settings)

    def test_fixed_split_vectors_and_canonical_case_id(self):
        for case_id, held_out in [
            ("a", False), ("b", True), ("c", True),
            ("case-001", False), ("case-002", True), ("Z._:-", True),
        ]:
            with self.subTest(case_id=case_id):
                self.assertEqual(_is_held_out(case_id, 0.5), held_out)
        self.assertTrue(_is_held_out("a", 0.8))
        self.assertFalse(_is_held_out("b", 0.2))
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "cases.jsonl"
            filename.write_text('\n'.join(map(json.dumps, [
                case("a"), case("b"), {"input": {"z": 1, "a": "x"}, "expected": 2},
            ])))
            evolve, held_out = _load_cases(self.definition(), filename.parent)
        identifier = hashlib.sha256(b'{"a":"x","z":1}').hexdigest()
        self.assertIn(case(identifier, {"a": "x", "z": 1}, 2), evolve + held_out)

    def test_enroll_unchanged_reconcile_and_conflict(self):
        evaluator = Mock(spec=AcclimateClient)
        admin = Mock(spec=AcclimateClient)
        admin.get_learning_loop.side_effect = ApiError(404, "not_found", "missing")
        held_out = [case("b")]
        definition = self.definition()
        _enroll(evaluator, "w", "b", definition, held_out, "machine:app", admin)
        args = admin.enroll_learning_loop.call_args.args
        self.assertEqual(args[:2], ("w", "b"))
        self.assertEqual(args[2], {
            "channel": "stable", "appPrincipalId": "machine:app",
            "heldOut": {"cases": 1, "digest": held_out_digest(held_out)},
            "setting": {"domain": "support", "benchmark": "cases.jsonl", "policyModel": "model"},
        })
        UUID(args[3])
        evaluator.enroll_learning_loop.assert_not_called()
        existing = {**args[2], "status": "running", "activeRound": None}
        admin.get_learning_loop.side_effect = None
        admin.get_learning_loop.return_value = existing
        evaluator.get_principal.return_value = {
            "principalId": "machine:app", "kind": "machine", "rights": ["evaluate"],
        }
        admin.enroll_learning_loop.reset_mock()
        self.assertIs(_enroll(evaluator, "w", "b", definition, held_out, None, admin), existing)
        admin.enroll_learning_loop.assert_not_called()
        _enroll(evaluator, "w", "b", self.definition(domain="billing"), held_out, None, admin)
        self.assertEqual(admin.enroll_learning_loop.call_args.args[2]["setting"]["domain"], "billing")
        admin.enroll_learning_loop.side_effect = ApiError(409, "learning_conflict", "active")
        with self.assertRaisesRegex(UsageError, "let the active round finish"):
            _enroll(evaluator, "w", "b", definition, [case("c")], None, admin)

    def test_sync_restarts_pagination_on_revision_changes_and_chunks_updates(self):
        client = Mock(spec=AcclimateClient)
        client.list_learning_evolve_cases.side_effect = [
            {"items": [case("obsolete-snapshot")], "next": "next", "evolveRevision": 1},
            {"items": [], "next": None, "evolveRevision": 2},
            {"items": [case("keep"), case("old")], "next": "old", "evolveRevision": 2},
            {"items": [case("outcome:correction")], "next": None, "evolveRevision": 2},
        ]
        cases = [case("keep"), *(case(f"new-{i}") for i in range(101))]
        _sync_cases(client, "w", "b", cases)
        self.assertEqual([call.kwargs["after"] for call in client.list_learning_evolve_cases.call_args_list],
                         [None, "next", None, "old"])
        writes = [call.args[2] for call in client.add_learning_evolve_cases.call_args_list]
        self.assertEqual(writes, [{"cases": cases[1:101], "retire": ["old"]},
                                  {"cases": cases[101:], "retire": []}])
        client.add_learning_evolve_cases.reset_mock()
        client.list_learning_evolve_cases.side_effect = None
        client.list_learning_evolve_cases.return_value = {
            "items": [case("keep")], "next": None, "evolveRevision": 2,
        }
        with self.assertRaisesRegex(UsageError, "immutable"):
            _sync_cases(client, "w", "b", [case("keep", expected=True)])
        client.add_learning_evolve_cases.assert_not_called()

    def test_grades(self):
        self.assertEqual(exact()({"a": [1, None], "b": 2}, {"b": 2, "a": [1.0, None]}), 1)
        self.assertEqual(exact()({"a": [True]}, {"a": [1]}), 0)
        self.assertEqual(exact("action")({"action": "refund", "reason": "duplicate"}, "refund"), 1)
        self.assertEqual(exact("action")({}, None), 0)
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "output.json"
            fixture.write_text("original")
            command = shlex.join([sys.executable, "-c",
                                  "import json; assert json.load(open('output.json')) == {'ok': True}"])
            grade = command_grade(command, cwd=directory)
            self.assertEqual(grade({"ok": True}, None), 1)
            self.assertEqual(grade({"ok": False}, None), 0)
            self.assertEqual(fixture.read_text(), "original")


class LearningService:
    def __init__(self):
        self.bundle = str(uuid4())
        self.evaluation = str(uuid4())
        self.round = str(uuid4())
        self.payload = (Path(__file__).resolve().parents[2] / "contracts/fixtures/bundle-v1.json").read_bytes()
        self.version = {
            "id": str(uuid4()), "bundleId": self.bundle, "parentVersionId": None,
            "digest": "sha256:" + hashlib.sha256(self.payload).hexdigest(),
            "createdAt": "2026-11-20T00:00:00Z",
        }
        self.item = {
            "evaluationId": self.evaluation, "split": "evolve", "roundId": self.round,
            "versionId": self.version["id"], "digest": self.version["digest"],
            "evolveRevision": 1, "heldOut": None,
        }
        self.assignment_cases = [case("done", "already reported"), case("x" * 128, "pending")]
        self.reported = ["done"]
        self.reports = []
        self.attempts = []
        self.outcomes = []
        self.evolve_updates = []
        self.configuration = None
        self.cli_mode = False

    def respond(self, path, method, body, key, authorization):
        if path.endswith("/principal"):
            return {"principalId": "machine:evaluator", "kind": "machine", "rights": ["evaluate"]}
        if path.endswith("/bundles"):
            return {"items": [{"id": self.bundle, "name": "support"}], "nextCursor": None}
        if path.endswith("/channels/stable"):
            return {"channel": "stable", "revision": "1", "version": self.version}
        if path.endswith("/payload"):
            return self.payload
        if path.endswith(self.version["id"]):
            return self.version
        if path.endswith("/learning"):
            if method == "PUT":
                if authorization != "Bearer admin":
                    return {"error": {"code": "denied"}}, 403
                self.configuration = body
                return self.loop_view()
            if self.configuration is None:
                return {"error": {"code": "not_found"}}, 404
            return self.loop_view()
        if path.endswith("/evolve-cases"):
            if method == "POST":
                self.evolve_updates.extend(body["cases"])
                return {}
            return {"items": [], "next": None, "evolveRevision": 1}
        if path.endswith(f"/rounds/{self.round}"):
            return {
                **self.round_summary(), "heldOutError": None, "adoptedSample": None,
                "heldOutScore": 0.80 if self.reports else None, "reason": "selector-kept",
                "selection": {"reason": "Keep the incumbent."},
                "candidates": [{
                    "sample": 1, "status": "evaluated", "evolveScore": 0.80, "dropReason": None,
                    "diagnosis": {"problem": {"new": "Missed refunds"}, "predicted": ["a"]},
                    "screen": {"verdict": "evaluate", "reason": "Valid candidate"},
                }],
            }
        if path.endswith("/work"):
            return {"bundleId": self.bundle, "status": "running", "items": [] if self.reports else [self.item]}
        if path.endswith("/start"):
            self.attempts.append((key, body["attemptId"]))
            return {
                "evaluation": {**self.item, "id": self.evaluation, "status": "running",
                               "cases": len(self.assignment_cases)},
                "heldOut": self.item["heldOut"], "reportedCaseIds": self.reported,
                "cases": self.assignment_cases if self.item["split"] == "evolve" else None,
            }
        if path.endswith("/report"):
            self.reports.append((key, body))
            return {}
        if path.endswith("/outcomes"):
            self.outcomes.append((key, body))
            return {"outcomeId": body["outcomeId"], "caseId": "outcome:" + body["outcomeId"], "evolveRevision": 2}
        return {"error": {"code": "not_found"}}, 404

    def round_summary(self):
        return {"id": self.round, "number": 1, "incumbentScore": 0.75,
                "state": "completed" if self.reports else "scoring_held_out",
                "endedAt": "now" if self.reports else None, "decision": "kept"}

    def loop_view(self):
        active = self.round_summary() if self.cli_mode and self.evolve_updates and not self.reports else None
        return {**self.configuration, "status": "running", "activeRound": active,
                "nextRound": 2 if active or self.reports else 1, "pauseReason": None,
                "rounds": [self.round_summary()] if self.reports else []}


class ProtocolTest(unittest.TestCase):
    def setUp(self):
        self.service = service = LearningService()

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def handle_request(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                result = service.respond(urlsplit(self.path).path, self.command, json.loads(raw) if raw else None,
                                         self.headers.get("Idempotency-Key"), self.headers.get("Authorization"))
                result, status = result if isinstance(result, tuple) else (result, 200)
                data = result if isinstance(result, bytes) else json.dumps(result).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = handle_request

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        self.url = f"http://127.0.0.1:{server.server_port}"
        self.client = AcclimateClient(self.url, "token", "scope")
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()

    def run_loop(self, execute, held_out):
        polls = 0

        def stop():
            nonlocal polls
            polls += 1
            if polls > 3:
                self.fail("The runner never reported the evaluation")
            return bool(self.service.reports)

        serve_learning_loop(self.client, "w", self.service.bundle, execute=execute, grade=exact(),
                            held_out=held_out, journal_dir=self.tmp / "journal", poll_interval=0.001, stop=stop)

    def test_resume_completed_and_uncertain_rollouts_and_skip_reported_cases(self):
        calls = []

        def interrupt(version, input, rollout):
            calls.append((version["version"]["id"], input, rollout))
            if rollout == 2:
                raise KeyboardInterrupt
            return 1, "a" * 16000 + "🦆" * 3000

        with self.assertRaises(KeyboardInterrupt):
            self.run_loop(interrupt, [case("private")])
        self.assertEqual(self.service.reports, [])

        def recover(_version, input, rollout):
            calls.append((self.service.version["id"], input, rollout))
            if rollout == 4:
                raise ValueError("🦆" * 3000)
            return 1, "recovered"

        self.run_loop(recover, [case("private")])
        self.assertEqual(calls, [(self.service.version["id"], "pending", i) for i in range(5)])
        self.assertEqual(self.service.attempts, [self.service.attempts[0]] * 2)
        key, body = self.service.reports[0]
        attempt = self.service.attempts[0][0]
        self.assertEqual(body["attemptId"], attempt)
        self.assertEqual(key, hashlib.sha256(f"case:{attempt}:{'x' * 128}".encode()).hexdigest())
        rollouts = body["cases"][0]["rollouts"]
        self.assertEqual([row["score"] for row in rollouts], [1, 1, 0, 1, 0])
        self.assertEqual(rollouts[2]["error"], "execution.uncertain")
        self.assertLessEqual(len(rollouts[0]["trace"].encode()), 16 * 1024)
        self.assertIn("bytes omitted", rollouts[0]["trace"])
        self.assertLessEqual(len(rollouts[4]["error"].encode()), 4096)

    def test_held_out_wire_report_and_journal_only_contain_scores(self):
        held_out = [case("private", "private input")]
        self.service.assignment_cases = held_out
        self.service.reported = []
        self.service.item.update(split="heldOut", evolveRevision=None,
                                 heldOut={"cases": 1, "digest": held_out_digest(held_out)})
        self.run_loop(lambda *_: (1, "PRIVATE TRACE"), held_out)
        key, body = self.service.reports[0]
        self.assertEqual(key, body["attemptId"] + ":private")
        self.assertEqual(body["cases"], [{"caseId": "private", "rollouts": [{"score": 1, "passed": True}] * 5}])
        for journal in (self.tmp / "journal").rglob("*.json"):
            self.assertNotIn("PRIVATE TRACE", journal.read_text())

    def test_digest_mismatch_does_not_execute(self):
        self.service.item["digest"] = "sha256:" + "0" * 64
        execute = Mock()
        self.run_loop(execute, [case("private")])
        execute.assert_not_called()
        self.assertEqual(self.service.reports[0][1]["error"], "evidence.identity_mismatch")

    def test_job_pins_version_and_replays_the_same_outcome(self):
        self.enterContext(patch.dict(os.environ, {
            "ACCLIMATE_URL": self.url, "ACCLIMATE_WORKSPACE": "w", "ACCLIMATE_TOKEN": "token",
        }))
        input = {"text": "original"}
        job = Acclimate.from_env(cache_dir=self.tmp / "delivery").job("support", channel="stable", input=input)
        original_version = self.service.version["id"]
        self.service.version["id"] = str(uuid4())
        input["text"] = "modified"
        with job.prepare() as prepared:
            self.assertEqual(prepared.version["version"]["id"], original_version)
        self.assertEqual(job.expect(1), job.expect(1))
        self.assertEqual(self.service.outcomes, [(job.outcome_id, {
            "outcomeId": job.outcome_id, "versionId": original_version, "digest": job.version["version"]["digest"],
            "input": {"text": "original"}, "expected": 1,
        })] * 2)
        UUID(job.outcome_id)

    def test_learn_once_loads_config_syncs_and_prints_a_completed_round(self):
        self.service.cli_mode = True
        self.service.assignment_cases = [case("a")]
        self.service.reported = []
        self.enterContext(patch.dict(os.environ, {
            "ACCLIMATE_URL": self.url, "ACCLIMATE_WORKSPACE": "w", "ACCLIMATE_TOKEN": "token",
            "ACCLIMATE_ENROLL_TOKEN": "admin",
        }))
        os.environ.pop("ACCLIMATE_APP_PRINCIPAL", None)
        self.enterContext(patch("pathlib.Path.home", return_value=self.tmp))
        (self.tmp / "cases.jsonl").write_text("\n".join(map(json.dumps, [case("a"), case("b")])))
        (self.tmp / "demo.py").write_text(
            'from acclimate.learning import define_loop, exact\n'
            'loop = define_loop(bundle="support", channel="stable", execute=lambda *_: 1,\n'
            '                   policy_model="model", cases="cases.jsonl", grade=exact())\n'
        )
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(main(["learn", "--config", "demo.py", "--once"], directory=self.tmp), 0)
        self.assertEqual(self.service.evolve_updates, [case("a")])
        self.assertEqual(self.service.configuration["heldOut"], {"cases": 1, "digest": held_out_digest([case("b")])})
        for expected in ("incumbent 0.75", "diagnosis Missed refunds", "predictions 1",
                         "screen evaluate", "evolve 0.80", "Selection kept", "held-out 0.80"):
            self.assertIn(expected, stdout.getvalue())
        self.assertNotIn("\x1b", stdout.getvalue())
