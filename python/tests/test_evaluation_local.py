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
    RunControlError, RunControls, parse_duration, parse_selection, progress_line, run_controls_from_flags,
    selected_case_ids,
)
from acclimate._evaluation_shared import json_bytes
from acclimate.evaluation import (
    Case, EvaluationError, ExecutionResult, GradeResult, define_evaluation,
)
from acclimate.evaluation_cli import evaluation_main, parse_evaluator_arguments
from acclimate.evaluation_local import (
    LOCAL_BUNDLE_ID, LocalRunError, load_local_payload, local_payload_digest, local_version,
    try_evaluation,
)
from acclimate.evaluation_manifest import create_evaluation_manifest, restore_evaluation_manifest


PARENT = {"schemaVersion": 1, "files": [{"path": "AGENTS.md", "kind": "instruction", "text": "Be brief."}]}
CANDIDATE = {"schemaVersion": 1, "files": [{"path": "AGENTS.md", "kind": "instruction", "text": "Be polite."}]}


def sees_polite(run):
    return "polite" in run.version["payload"]["files"][0]["text"]


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
        command, flags = parse_evaluator_arguments(
            ["try", "--case", "a,b", "--case-timeout", "30m", "--payload", "bundle.json"], "/work")
        self.assertEqual((command, flags["payload"]), ("try", "/work/bundle.json"))
        controls = run_controls_from_flags({"cases": flags["case"], "case-timeout": flags["case-timeout"]})
        self.assertEqual(controls.case_timeout_ms, 1_800_000)
        for command in ("compare", "request", "run", "status", "check", "interrupt", "export", "verify-export", "plan"):
            with self.assertRaises(EvaluationError) as caught:
                parse_evaluator_arguments([command])
            self.assertEqual(caught.exception.code, "usage.unknown_command")
        for flag in ("--policy", "--handoff"):
            with self.assertRaises(EvaluationError) as caught:
                parse_evaluator_arguments(["doctor", flag, "input.json"])
            self.assertEqual(caught.exception.code, "usage.unknown_flag")
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

    def test_try_command(self):
        status, out, _ = self.invoke(make_app(), ["try", "--case", "b", "--json"])
        self.assertEqual(status, 0)
        self.assertEqual([row["caseId"] for row in json.loads(out)["cases"]], ["b"])
        status, _, err = self.invoke(make_app(), ["try", "--case", "missing", "--json"])
        self.assertEqual(status, 1)
        self.assertIn("Unknown case ID", err)
