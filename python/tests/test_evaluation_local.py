import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from acclimate._evaluation_controls import (
    RunControlError, RunControls, extract_run_control_flags, parse_duration, parse_selection, progress_line,
    selected_case_ids,
)
from acclimate._evaluation_shared import json_bytes
from acclimate.evaluation import (
    Case, EvaluationError, ExecutionResult, GradeResult, bind_run_controls, define_evaluation, run_evaluation,
)
from acclimate.evaluation_async import run_evaluation_async
from acclimate.evaluation_cli import evaluation_main
from acclimate.evaluation_local import (
    LOCAL_BUNDLE_ID, LocalRunError, load_local_payload, local_payload_digest, local_version, run_local_comparison,
    score_local_comparison, try_evaluation,
)
from acclimate.evaluation_manifest import create_evaluation_manifest, restore_evaluation_manifest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_evaluation_core import BUNDLE, REQUEST, FakeService

PARENT = {"schemaVersion": 1, "files": [{"path": "AGENTS.md", "kind": "instruction", "text": "Be brief."}]}
CANDIDATE = {"schemaVersion": 1, "files": [{"path": "AGENTS.md", "kind": "instruction", "text": "Be polite."}]}


def sees_polite(run):
    return "polite" in run.bundle["payload"]["files"][0]["text"]


def make_app(execute=None, grade=None, cases=None, **options):
    return define_evaluation(
        config_id="local", config_revision="1", dataset_revision="tasks-1", grader_revision="grade-1",
        runtime={"app": "fixture"}, execution=options.pop("execution", "model-free"),
        cases=cases or [Case("a", 1, True), Case("b", 2, True, 2), Case("c", 3, True)],
        execute=execute or (lambda run: ExecutionResult({"polite": sees_polite(run), "input": run.input})),
        grade=grade or (lambda run: GradeResult(1.0 if run.output["polite"] else 0.5)), **options)


class LocalTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def run_local(self, app, parent=PARENT, candidate=CANDIDATE, name="run", **kwargs):
        return run_local_comparison(app=app, parent=parent, candidate=candidate, directory=self.root / name, **kwargs)


class PayloadTests(LocalTestCase):
    def test_digest_and_ids_match_the_typescript_sdk(self):
        # Computed with packages/sdk/src/evaluation/local.ts (localPayloadDigest, localVersion).
        payload = {"schemaVersion": 1, "files": [
            {"path": "AGENTS.md", "kind": "instruction", "text": 'Café “quotes”   tab\t nl\n ctl\u0001 bs\\ q" é😀'},
            {"path": "memory/notes.md", "kind": "memory", "text": ""}]}
        self.assertEqual(local_payload_digest(payload), "sha256:32939042508263e31961145f1bd52951fb4eef3cb9ff3272286c21a060c860d4")
        self.assertEqual(local_version(payload)["version"]["id"], "996edc1c-201b-8ab0-bafd-8b792bcc799c")
        self.assertEqual(LOCAL_BUNDLE_ID, "e483f8f7-ed26-803c-98dc-bfc903c69f85")

    def test_directory_maps_skills_memory_and_instructions_and_skips_dot_entries(self):
        folder = self.root / "bundle"
        (folder / "skills" / "lookup").mkdir(parents=True)
        (folder / "memory").mkdir()
        (folder / ".git").mkdir()
        (folder / ".git" / "HEAD").write_text("ref")
        (folder / "AGENTS.md").write_bytes("﻿# Agent\n".encode())
        (folder / "skills" / "lookup" / "SKILL.md").write_text("---\nname: lookup\ndescription: d\n---\n")
        (folder / "memory" / "prefs.md").write_text("email")
        loaded = load_local_payload(folder)
        self.assertEqual(loaded.form, "directory")
        self.assertEqual([(f["path"], f["kind"]) for f in loaded.payload["files"]],
                         [("AGENTS.md", "instruction"), ("memory/prefs.md", "memory"), ("skills/lookup/SKILL.md", "skill")])
        self.assertEqual(loaded.payload["files"][0]["text"], "# Agent\n")  # BOM stripped like TextDecoder
        self.assertEqual(loaded.digest, local_payload_digest(loaded.payload))

    def test_directory_errors_name_the_offending_file(self):
        folder = self.root / "bad"
        folder.mkdir()
        (folder / "bad name.md").write_text("x")
        with self.assertRaisesRegex(LocalRunError, r"^bad name\.md: not a valid bundle file"):
            load_local_payload(folder)
        os.symlink(folder / "bad name.md", self.root / "link.md")
        linked = self.root / "linked"
        linked.mkdir()
        os.symlink(folder / "bad name.md", linked / "a.md")
        with self.assertRaisesRegex(LocalRunError, "symbolic links"):
            load_local_payload(linked)
        empty = self.root / "empty"
        empty.mkdir()
        with self.assertRaisesRegex(LocalRunError, "has no files"):
            load_local_payload(empty)

    def test_payload_file_validation_messages(self):
        good = self.root / "payload.json"
        good.write_text(json.dumps(PARENT))
        self.assertEqual(load_local_payload(good).payload, PARENT)
        bad = self.root / "bad.json"
        bad.write_text(json.dumps({"schemaVersion": 1, "files": [{"path": "a.md", "kind": "notes", "text": "x"}]}))
        with self.assertRaisesRegex(LocalRunError, r"files\[0\] needs exactly path, kind"):
            load_local_payload(bad)
        duplicate = self.root / "duplicate.json"
        duplicate.write_text('{"schemaVersion":1,"schemaVersion":1,"files":[]}')
        with self.assertRaisesRegex(LocalRunError, "duplicate keys"):
            load_local_payload(duplicate)


class LocalComparisonTests(LocalTestCase):
    def test_local_compare_uses_the_counterbalanced_schedule_and_service_bundle_shape(self):
        seen = []

        def execute(run):
            seen.append((run.case_id, run.repetition, run.context.side, run.context.collection.first_side))
            self.assertEqual(set(run.bundle), {"version", "payload", "resolvedAt", "stale"})
            self.assertEqual(run.bundle["version"]["bundleId"], LOCAL_BUNDLE_ID)
            return ExecutionResult({"polite": sees_polite(run)})

        app = make_app(execute=execute, collection={"protocol": "seeded-balanced-v1", "seed": "s"})
        result = self.run_local(app)
        self.assertFalse(result["authoritative"])
        self.assertTrue(result["comparison"]["complete"])
        self.assertEqual(result["versions"]["candidate"]["parentVersionId"], result["versions"]["parent"]["id"])
        for pair in app._collection["pairs"]:
            arms = [row for row in seen if row[:2] == (pair["caseId"], pair["repetition"])]
            self.assertEqual(arms[0][2], pair["firstSide"])
        scored = score_local_comparison(result)
        self.assertEqual(scored["scores"]["summary"]["parentMean"], 0.5)
        self.assertEqual(scored["scores"]["summary"]["candidateMean"], 1.0)
        self.assertEqual(result["warnings"], [])

    def test_policy_is_advisory(self):
        policy = json.dumps({"schemaVersion": 1, "id": "no-regression", "revision": "1",
                             "metric": {"name": "reward", "unit": "reward", "direction": "higher"},
                             "aggregation": "equal-case-means", "minimumMeanImprovement": 0,
                             "maximumCaseRegression": 0, "requiredCases": []})
        scored = score_local_comparison(self.run_local(make_app()), policy)
        self.assertEqual(scored["policy"]["verdict"], "pass")
        self.assertTrue(scored["policy"]["advisory"])

    def test_identical_outputs_warn_and_same_payload_explains_itself(self):
        app = make_app(execute=lambda run: ExecutionResult({"same": True}), grade=lambda run: GradeResult(1))
        result = self.run_local(app)
        self.assertEqual(result["summary"]["outputs"], {"comparedPairs": 4, "identicalPairs": 4})
        self.assertIn("Check that execute uses the bundle argument", result["warnings"][0])
        same = self.run_local(app, candidate=PARENT, name="same")
        self.assertIn("are the same payload", same["warnings"][0])

    def test_concurrency_overlaps_pairs_preserves_order_and_is_fingerprinted(self):
        active, peak, lock = [0], [0], threading.Lock()

        def execute(run):
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time.sleep(0.05)
            with lock:
                active[0] -= 1
            return ExecutionResult({"polite": sees_polite(run)})

        app = make_app(execute=execute, concurrency=3, grade_retries=1)
        self.assertEqual(app.descriptor["runtime"]["concurrency"], "3")
        self.assertEqual(app.descriptor["runtime"]["gradeRetries"], "1")
        self.assertEqual(make_app().descriptor["runtime"]["concurrency"], "1")
        result = self.run_local(app)
        self.assertGreater(peak[0], 1)
        self.assertLessEqual(peak[0], 3)
        self.assertEqual([(r["caseId"], r["repetition"]) for r in result["comparison"]["results"]],
                         [("a", 0), ("b", 0), ("b", 1), ("c", 0)])
        with self.assertRaises(EvaluationError):
            make_app(concurrency=65)
        with self.assertRaises(EvaluationError):
            make_app(grade_retries=6)

    def test_manifest_fingerprints_declared_scheduling_and_keeps_defaults_byte_identical(self):
        options = dict(config_id="m", execution="live", cases=[Case("a", 1, 1)], grader={"artifactDigest": "sha256:" + "0" * 64},
                       runtime={"settings": {}, "artifacts": {"x": "sha256:" + "1" * 64}})
        plain = create_evaluation_manifest(**options)
        self.assertNotIn("concurrency", plain.private_manifest_json)
        tuned = create_evaluation_manifest(**options, concurrency=4, grade_retries=2)
        self.assertEqual(tuned.descriptor["runtime"]["concurrency"], "4")
        self.assertEqual(tuned.definition["grade_retries"], 2)
        self.assertEqual(restore_evaluation_manifest(tuned.private_manifest_json).descriptor, tuned.descriptor)

    def test_grade_retries_repeat_only_the_grader(self):
        calls = {"execute": 0, "grade": 0}

        def execute(run):
            calls["execute"] += 1
            return ExecutionResult({"ok": True})

        def grade(run):
            calls["grade"] += 1
            if calls["grade"] % 2:
                raise RuntimeError("flaky judge")
            return GradeResult(1)

        result = self.run_local(make_app(execute=execute, grade=grade, cases=[Case("a", 1, 1)], grade_retries=2))
        self.assertTrue(result["comparison"]["complete"])
        self.assertEqual(calls, {"execute": 2, "grade": 4})
        self.assertEqual(result["summary"]["gradeRetriesUsed"], 2)

    def test_case_timeout_abandons_a_hung_callback_and_cancels_it(self):
        observed = []

        def execute(run):
            if run.case_id == "a" and run.context.side == "candidate":
                for _ in range(200):
                    if run.cancellation.is_cancelled():
                        observed.append("cancelled")
                        break
                    time.sleep(0.01)
            return ExecutionResult({"ok": True})

        result = self.run_local(make_app(execute=execute, grade=lambda run: GradeResult(1), cases=[Case("a", 1, 1)]),
                                controls=RunControls(case_timeout_ms=100))
        self.assertEqual(result["comparison"]["results"][0]["candidate"]["error"], "timeout")
        self.assertEqual(result["summary"]["timedOutCallbacks"], 1)
        self.assertIn("case timeout", " ".join(result["warnings"]))
        for _ in range(100):
            if observed:
                break
            time.sleep(0.01)
        self.assertEqual(observed, ["cancelled"])

    def test_deadline_stops_scheduling_and_reports_partial(self):
        def execute(run):
            time.sleep(0.08)
            return ExecutionResult({"ok": True})

        cases = [Case(f"c{index}", index, 1) for index in range(6)]
        result = self.run_local(make_app(execute=execute, grade=lambda run: GradeResult(1), cases=cases),
                                controls=RunControls(deadline_ms=200))
        summary = result["summary"]
        self.assertEqual(summary["stopReason"], "deadline")
        self.assertTrue(summary["partial"])
        self.assertFalse(result["comparison"]["complete"])
        errors = {row[side]["error"] for row in result["comparison"]["results"] for side in ("parent", "candidate")}
        self.assertIn("deadline_exceeded", errors)
        self.assertIn("Stopped at the 200ms deadline", " ".join(result["warnings"]))

    def test_cost_cap_stops_new_pairs_after_reported_cost(self):
        app = make_app(execute=lambda run: ExecutionResult({"ok": True}, usage={"costUsd": 0.5}),
                       grade=lambda run: GradeResult(1), cases=[Case(f"c{i}", i, 1) for i in range(4)])
        result = self.run_local(app, controls=RunControls(max_cost_usd=1.0))
        summary = result["summary"]
        self.assertEqual(summary["stopReason"], "cost_limit")
        self.assertEqual(summary["pairs"]["started"], 1)
        self.assertEqual(summary["costUsd"], 1.0)
        self.assertEqual(result["comparison"]["results"][1]["parent"]["error"], "cost_limit_reached")
        scored = score_local_comparison(result)
        self.assertEqual(scored["scores"]["evidenceGaps"]["rows"][0]["reason"], "cost_limit_reached")

    def test_cases_and_shard_are_partial_and_never_complete(self):
        app = make_app()
        subset = self.run_local(app, controls=RunControls(selection={"kind": "cases", "caseIds": ["b"]}))
        rows = {(r["caseId"], r["repetition"]): r for r in subset["comparison"]["results"]}
        self.assertEqual(rows[("a", 0)]["candidate"]["error"], "not_selected")
        self.assertEqual(rows[("b", 1)]["candidate"]["gradingStatus"], "scored")
        self.assertFalse(subset["comparison"]["complete"])
        self.assertTrue(subset["summary"]["partial"])
        self.assertEqual(subset["summary"]["pairs"], {"expected": 4, "selected": 2, "started": 2, "notSelected": 2})
        shard = self.run_local(app, name="shard", controls=RunControls(selection={"kind": "shard", "index": 2, "count": 2}))
        self.assertEqual({r["caseId"] for r in shard["comparison"]["results"] if r["candidate"]["error"] != "not_selected"}, {"b"})
        self.assertIn("never claims full coverage", " ".join(shard["warnings"]))
        policy = json.dumps({"schemaVersion": 1, "id": "p", "revision": "1",
                             "metric": {"name": "reward", "unit": "reward", "direction": "higher"},
                             "aggregation": "equal-case-means", "minimumMeanImprovement": 0,
                             "maximumCaseRegression": 0, "requiredCases": []})
        self.assertNotEqual(score_local_comparison(shard, policy)["policy"]["verdict"], "pass")
        self.assertEqual(selected_case_ids({"kind": "shard", "index": 1, "count": 2}, ["a", "b", "c"]), {"a", "c"})
        with self.assertRaisesRegex(RunControlError, "Unknown case ID"):
            selected_case_ids({"kind": "cases", "caseIds": ["zz"]}, ["a"])

    def test_live_adapter_requires_allow_live(self):
        app = make_app(execution="live")
        with self.assertRaisesRegex(LocalRunError, "Add --live"):
            self.run_local(app)
        self.assertTrue(self.run_local(app, allow_live=True)["comparison"]["complete"])
        with self.assertRaisesRegex(LocalRunError, "Omit --live"):
            self.run_local(make_app(), allow_live=True, name="model-free")

    def test_callback_errors_become_local_diagnostics(self):
        def execute(run):
            if run.context.side == "candidate":
                raise ValueError("adapter forgot the bundle")
            return ExecutionResult({"when": object()} if run.case_id == "a" else {"ok": True})

        result = self.run_local(make_app(execute=execute, grade=lambda run: GradeResult(1)))
        details = " ".join(item["detail"] for item in result["diagnostics"])
        self.assertIn("ValueError: adapter forgot the bundle", details)
        self.assertIn("Convert this value", details)


class ControlParsingTests(unittest.TestCase):
    def test_parsers_and_flag_extraction(self):
        self.assertEqual(parse_duration("90", "--deadline"), 90_000)
        self.assertEqual(parse_duration("1.5m", "--deadline"), 90_000)
        self.assertEqual(parse_duration("250ms", "--case-timeout"), 250)
        with self.assertRaises(RunControlError):
            parse_duration("soon", "--deadline")
        self.assertEqual(parse_selection(shard="2/4"), {"kind": "shard", "index": 2, "count": 4})
        with self.assertRaises(RunControlError):
            parse_selection(shard="5/4")
        rest, controls, progress, supplied = extract_run_control_flags(
            ["compare", "--config", "c", "--deadline", "30m", "--shard", "1/2", "--quiet", "--handoff", "h"])
        self.assertEqual(rest, ["compare", "--config", "c", "--handoff", "h"])
        self.assertEqual((controls.deadline_ms, controls.selection["index"], progress, supplied), (1_800_000, 1, "off", True))
        with self.assertRaisesRegex(RunControlError, "apply to compare and run"):
            extract_run_control_flags(["status", "--deadline", "1m"])
        line = progress_line({"completed": 3, "total": 12, "caseId": "a ", "repetition": 0, "side": "parent",
                              "elapsedMs": 1234, "outcome": {"executionStatus": "completed", "gradingStatus": "scored",
                                                             "reward": 1.0, "usage": {"costUsd": 0.25}, "error": None}})
        self.assertEqual(line, '[ 3/12] "a\\u2028" #0 parent    reward 1 · $0.2500 · 1.2s')


class TryTests(LocalTestCase):
    def test_try_reports_shape_errors_before_a_paid_run(self):
        def execute(run):
            return ExecutionResult({"at": float("nan")}, execution_status="done", usage={"cost": 1})

        result = try_evaluation(app=make_app(execute=execute), directory=self.root / "try")
        self.assertFalse(result["ok"])
        fields = {issue["field"] for issue in result["cases"][0]["execute"]["issues"]}
        self.assertEqual(fields, {'output["at"]', "execution_status", "usage.cost"})
        self.assertEqual(result["cases"][0]["grade"]["status"], "skipped")

    def test_try_checks_reward_and_runs_selected_cases_with_a_payload(self):
        payload = self.root / "payload.json"
        payload.write_text(json.dumps(CANDIDATE))
        app = make_app(grade=lambda run: GradeResult(7))
        result = try_evaluation(app=app, directory=self.root / "try", payload=load_local_payload(payload),
                                selection={"kind": "cases", "caseIds": ["b", "c"]})
        self.assertTrue(result["ok"])
        self.assertEqual([row["caseId"] for row in result["cases"]], ["b", "c"])
        self.assertEqual(result["cases"][0]["execute"]["output"]["polite"], True)
        self.assertEqual(result["cases"][0]["grade"]["issues"][0]["severity"], "warning")
        bad = try_evaluation(app=make_app(grade=lambda run: {"reward": 1}), directory=self.root / "try2")
        self.assertEqual(bad["cases"][0]["grade"]["issues"][0]["field"], "grade()")


class CliTests(LocalTestCase):
    def invoke(self, app, argv, cwd=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            previous = os.getcwd()
            os.chdir(cwd or self.root)
            try:
                status = evaluation_main(app, argv)
            finally:
                os.chdir(previous)
        return status, stdout.getvalue(), stderr.getvalue()

    def test_compare_local_writes_an_advisory_report(self):
        (self.root / "parent").mkdir()
        (self.root / "parent" / "AGENTS.md").write_text("Be brief.")
        (self.root / "candidate.json").write_text(json.dumps(CANDIDATE))
        status, out, err = self.invoke(make_app(), ["compare", "--local", "--parent", "parent", "--candidate",
                                                    "candidate.json", "--out", "report", "--json", "--progress"])
        self.assertEqual(status, 0, err)
        result = json.loads(out)
        self.assertFalse(result["authoritative"])
        self.assertIn("not a release receipt", result["notice"])
        self.assertIn("[1/8]", err)
        report = json.loads(Path(result["report"]).read_text())
        self.assertEqual((report["kind"], report["authoritative"], report["releaseReceipt"]),
                         ("acclimate.local-comparison", False, False))
        self.assertTrue(report["replay"]["command"].startswith("compare --config CONFIG --bundle BUNDLE_ID"))
        self.assertEqual(json.loads((self.root / "report" / "candidate.payload.json").read_text()), CANDIDATE)
        self.assertEqual(os.stat(self.root / "report").st_mode & 0o777, 0o700)

    def test_compare_local_usage_errors_and_stop_exit_codes(self):
        (self.root / "p.json").write_text(json.dumps(PARENT))
        status, _, err = self.invoke(make_app(), ["compare", "--local", "--parent", "p.json", "--json"])
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(err)["error"]["code"], "local.invalid")
        status, _, err = self.invoke(make_app(execution="live"), ["compare", "--local", "--parent", "p.json", "--candidate", "p.json", "--json"])
        self.assertEqual(status, 1)
        self.assertIn("Add --live", err)
        app = make_app(execute=lambda run: ExecutionResult({"ok": 1}, usage={"costUsd": 2}), grade=lambda run: GradeResult(1))
        status, out, err = self.invoke(app, ["compare", "--local", "--parent", "p.json", "--candidate", "p.json",
                                             "--max-cost-usd", "1", "--json"])
        self.assertEqual(status, 3)
        self.assertEqual(json.loads(out)["run"]["stopReason"], "cost_limit")
        self.assertIn("WARNING:", err)

    def test_try_command(self):
        status, out, _ = self.invoke(make_app(), ["try", "--case", "b", "--json"])
        self.assertEqual(status, 0)
        self.assertEqual([row["caseId"] for row in json.loads(out)["cases"]], ["b"])
        status, _, err = self.invoke(make_app(), ["try", "--case", "missing", "--json"])
        self.assertEqual(status, 1)
        self.assertIn("Unknown case ID", err)

    def test_run_control_flags_are_rejected_outside_compare_and_run(self):
        status, _, err = self.invoke(make_app(), ["describe", "--deadline", "1m"])
        self.assertEqual(status, 1)
        self.assertIn("apply to compare and run", json.loads(err)["error"]["hint"])


class ServiceRunnerTests(LocalTestCase):
    def setUp(self):
        super().setUp()
        self.config = self.root / "config.json"
        self.config.write_bytes(json_bytes({"schemaVersion": 1, "serviceUrl": "https://fixture.example", "projectId": "project",
                                            "evaluatorPrincipalId": "evaluator", "evaluatorToken": "private-canary-token",
                                            "journalRoot": str(self.root / "journals")}))
        self.config.chmod(0o600)

    def handoff(self, app):
        return {"schemaVersion": 1, "serviceUrl": "https://fixture.example", "projectId": "project", "bundleId": BUNDLE,
                "requestId": REQUEST, "configuration": app.descriptor}

    def test_service_run_reports_summary_and_selected_pairs_stay_partial(self):
        events = []
        app = make_app(execute=lambda run: ExecutionResult({"text": run.bundle["payload"]["files"][0]["text"]}),
                       grade=lambda run: GradeResult(1), concurrency=2)
        bound = bind_run_controls(app, RunControls(selection={"kind": "cases", "caseIds": ["a"]}, progress=events.append))
        self.assertEqual(bound.descriptor, app.descriptor)
        service = FakeService(app)
        with patch("acclimate.evaluation.make_client", return_value=service):
            result = run_evaluation(app=bound, config_path=str(self.config), handoff=self.handoff(app))
        summary = result["runSummary"]
        self.assertEqual(summary["pairs"]["selected"], 1)
        self.assertTrue(summary["partial"])
        self.assertEqual(summary["concurrency"], 2)
        self.assertEqual(len(events), 2)
        self.assertEqual(result["evaluation"]["status"], "failed")
        self.assertFalse(service.comparison["complete"])
        not_selected = [row for row in service.comparison["results"] if row["caseId"] != "a"]
        self.assertTrue(all(row[side]["error"] == "not_selected" for row in not_selected for side in ("parent", "candidate")))

    def test_run_evaluation_async_matches_the_sync_runner(self):
        app = make_app(grade=lambda run: GradeResult(1))
        service = FakeService(app)

        async def main():
            with patch("acclimate.evaluation.make_client", return_value=service):
                return await run_evaluation_async(app=app, config_path=str(self.config), handoff=self.handoff(app))

        result = asyncio.run(main())
        self.assertEqual(result["evaluation"]["status"], "completed")
        self.assertEqual(result["runSummary"]["stopReason"], "completed")


class InstalledAsyncConcurrencyTests(LocalTestCase):
    def test_async_callbacks_run_concurrently_on_worker_threads(self):
        from acclimate.evaluation_app import installed_application
        (self.root / "app").mkdir()
        (self.root / "app" / "application.py").write_text("\n".join([
            "import asyncio, threading",
            "from acclimate.evaluation import Case, ExecutionResult, GradeResult",
            "cases = [Case(str(i), i, 1) for i in range(6)]",
            "concurrency = 3",
            "active = [0, 0]",
            "lock = threading.Lock()",
            "async def execute(run):",
            "    with lock:",
            "        active[0] += 1; active[1] = max(active[1], active[0])",
            "    await asyncio.sleep(0.05)",
            "    with lock:",
            "        active[0] -= 1",
            "    return ExecutionResult({'peak': active[1]})",
            "async def grade(run):",
            "    await asyncio.sleep(0)",
            "    return GradeResult(1)",
        ]))
        with installed_application(self.root / "app") as (app, _):
            self.assertEqual(app.descriptor["runtime"]["concurrency"], "3")
            result = run_local_comparison(app=app, parent=PARENT, candidate=CANDIDATE, directory=self.root / "run", allow_live=True)
        self.assertTrue(result["comparison"]["complete"])
        self.assertEqual(result["callbacksStarted"], 12)
        self.assertGreater(max(json.loads(p.read_text())["value"]["peak"]
                               for p in (self.root / "run" / "artifacts").iterdir()), 1)


if __name__ == "__main__":
    unittest.main()
