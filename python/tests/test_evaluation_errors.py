"""Error taxonomy, definition diagnostics and CLI usage behavior shared with the TypeScript SDK."""
import contextlib
import datetime
import io
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

from acclimate import AcclimateClient, ApiError, DeliveryError, TransportError
from acclimate.errors import AcclimateError, UsageError
from acclimate.evaluation import (
    Case, DefinitionError, EvaluationError, ExecuteInput, ExecutionResult, GradeResult, OutputValidationError,
    define_evaluation,
)
from acclimate._evaluation_shared import ERROR_CODES, EXIT_CODES, exit_code_for, safe_error
from acclimate.evaluation_app import case_inventory, main
from acclimate.evaluation_cli import parse_evaluator_arguments

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((ROOT / "contracts/fixtures/evaluation-errors/definition-mistakes.json").read_text())
PAGE = ROOT / "apps/docs/content/docs/reference/error-codes.mdx"


def base():
    return dict(config_id="errors", config_revision="1", dataset_revision="1", grader_revision="1",
                runtime={"model": "none"}, execution="model-free",
                cases=[Case("a", {"task": 1}, 1), Case("b", {"task": 2}, 2)],
                execute=lambda run: ExecutionResult(1), grade=lambda run: GradeResult(1.0))


def _replace_case(definition, index, **changes):
    case = definition["cases"][index]
    values = {"case_id": case.case_id, "input": case.input, "expected": case.expected,
              "repetitions": case.repetitions, **changes}
    definition["cases"][index] = Case(**values)


MISTAKES = {
    "missing_grade": lambda d: d.update(grade=None),
    "misspelled_execution": lambda d: d.update(execution="modelfree"),
    "empty_cases": lambda d: d.update(cases=[]),
    "duplicate_case_id": lambda d: _replace_case(d, 1, case_id="a"),
    "blank_case_id": lambda d: _replace_case(d, 0, case_id=" "),
    "zero_repetitions": lambda d: _replace_case(d, 0, repetitions=0),
    "date_in_input": lambda d: _replace_case(d, 0, input={"when": datetime.datetime(2026, 1, 1)}),
    "empty_config_id": lambda d: d.update(config_id=""),
    "reserved_runtime_key": lambda d: d.update(runtime={"configId": "x"}),
    "non_string_runtime_value": lambda d: d.update(runtime={"model": 3}),
}


@contextlib.contextmanager
def _captured():
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


class ErrorTaxonomyTests(unittest.TestCase):
    def test_shared_definition_mistakes_produce_the_shared_code_and_name_the_field(self):
        self.assertEqual(set(MISTAKES), {item["mistake"] for item in FIXTURE["mistakes"]})
        for expected in FIXTURE["mistakes"]:
            definition = base()
            MISTAKES[expected["mistake"]](definition)
            with self.subTest(expected["mistake"]), self.assertRaises(DefinitionError) as caught:
                define_evaluation(**definition)
            self.assertEqual(caught.exception.code, expected["code"])
            self.assertEqual(caught.exception.field, expected["python"])
            self.assertEqual(caught.exception.diagnostic["field"], expected["python"])
            self.assertTrue(caught.exception.reason)
            self.assertNotIn("not confirmed", str(caught.exception))

    def test_catalog_matches_the_error_code_reference_page(self):
        rows = re.findall(r"^\| `([^`]+)` \| (\d) \| `([a-z_]+)` \|", PAGE.read_text(), re.M)
        documented = {code: (int(exit_code), action) for code, exit_code, action in rows}
        self.assertEqual(documented, {code: (exit_code, action) for code, (_, action, exit_code) in ERROR_CODES.items()})
        exits = dict(re.findall(r"^\| (\d) \| `([a-zA-Z]+)` \|", PAGE.read_text(), re.M))
        self.assertEqual(sorted(int(code) for code in exits), sorted(EXIT_CODES.values()))

    def test_only_transport_errors_are_outages(self):
        outage = safe_error(TransportError("down", "http://127.0.0.1:9"))
        self.assertEqual(outage.code, "service.unavailable")
        self.assertEqual(outage.diagnostic["serviceUrl"], "http://127.0.0.1:9")
        self.assertEqual(outage.next_action, "check_service")
        self.assertEqual(exit_code_for(outage.diagnostic), 4)
        try:
            getattr(None, "missing")
        except AttributeError as bug:
            self.assertEqual(safe_error(bug).code, "internal.error")
        self.assertEqual(safe_error(UsageError("bad", "base_url")).code, "internal.error")
        self.assertEqual(exit_code_for({"code": "config.schema", "executionState": "report_saved"}), 5)

    def test_client_argument_checks_raise_usage_errors_that_remain_value_errors(self):
        with self.assertRaises(UsageError) as caught:
            AcclimateClient("https://x.test", token="", scope="s")
        self.assertEqual(caught.exception.field, "token")
        self.assertIsInstance(caught.exception, ValueError)
        with self.assertRaises(UsageError):
            AcclimateClient("https://x.test", token="t", scope="s", retries=9)

    def test_every_sdk_error_shares_the_base_class(self):
        for error in (ApiError(404, "not_found", "missing"), DeliveryError("invalid_payload", "bad"),
                      TransportError(), UsageError("bad"), EvaluationError("config.schema"),
                      DefinitionError("cases", "bad"), OutputValidationError("output", "bad")):
            self.assertIsInstance(error, AcclimateError)
            self.assertIsInstance(error.code, str)
    def test_execute_input_exposes_instructions_skills_and_memory(self):
        bundle = {"version": {}, "resolvedAt": 0, "stale": False, "payload": {"schemaVersion": 1, "files": [
            {"path": "AGENTS.md", "kind": "instruction", "text": "Be brief."},
            {"path": "skills/a.md", "kind": "skill", "text": "skill"},
            {"path": "more.md", "kind": "instruction", "text": "Cite sources."},
            {"path": "memory.md", "kind": "memory", "text": "remember"}]}}
        run = ExecuteInput(bundle, None, "a", 0, None, None)  # type: ignore[arg-type]
        self.assertEqual(run.instructions, "Be brief.\n\nCite sources.")
        self.assertEqual([file["path"] for file in run.skill_files], ["skills/a.md"])
        self.assertEqual([file["path"] for file in run.memory_files], ["memory.md"])

    def test_usage_keys_are_validated_and_snake_case_is_mapped_explicitly(self):
        from acclimate.evaluation import _usage
        self.assertEqual(_usage({"input_tokens": 3, "outputTokens": 4, "cost_usd": 0.5}),
                         {"inputTokens": 3, "outputTokens": 4, "costUsd": 0.5})
        with self.assertRaises(OutputValidationError) as caught:
            _usage({"prompt_tokens": 3})
        self.assertEqual(caught.exception.field, "usage.prompt_tokens")
        with self.assertRaises(OutputValidationError):
            _usage({"inputTokens": 1, "input_tokens": 2})
        with self.assertRaises(OutputValidationError):
            _usage({"costUsd": -1})

    def test_dict_cases_accept_case_id_and_name_bad_fields(self):
        self.assertEqual(case_inventory([{"case_id": "a", "input": 1, "expected": 1}])[0].case_id, "a")
        self.assertEqual(case_inventory([{"caseId": "a", "input": 1, "expected": 1}])[0].case_id, "a")
        for rows, field in (([], "cases"), ([{"case_id": "a", "caseId": "a", "input": 1, "expected": 1}], "cases[0].case_id"),
                            ([{"case_id": "a", "input": 1}], "cases[0].expected"),
                            ([{"case_id": "a", "input": 1, "expected": 1, "repetition": 2}], "cases[0].repetition")):
            with self.subTest(field), self.assertRaises(EvaluationError) as caught:
                case_inventory(rows)
            self.assertEqual(caught.exception.diagnostic["field"], field)
            self.assertEqual(caught.exception.code, "definition.invalid")


class CommandLineTests(unittest.TestCase):
    def run_main(self, args, files=None, env=None):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, env or {}), _captured() as (out, err):
            os.environ.pop("ACCLIMATE_EVALUATOR_CASES", None)
            for name, text in (files or {}).items():
                Path(temporary, name).write_text(text)
            status = main(args, directory=temporary)
        lines = err.getvalue().strip().splitlines()
        error = json.loads(lines[-1])["error"] if lines and lines[-1].startswith("{") else None
        return status, out.getvalue(), err.getvalue(), error

    def test_no_arguments_fails_while_help_and_version_succeed(self):
        status, _, err, error = self.run_main([])
        self.assertEqual((status, error["code"]), (1, "usage.missing_command"))
        self.assertIn("Commands:", err)
        self.assertEqual(self.run_main(["--help"])[0], 0)
        status, out, _, _ = self.run_main(["--version"])
        self.assertEqual(status, 0)
        project = (ROOT / "python/pyproject.toml").read_text()
        self.assertEqual(out.strip(), re.search(r'^version = "([^"]+)"', project, re.M).group(1))

    def test_arguments_are_validated_before_the_application_is_imported(self):
        with patch("acclimate.evaluation_app.installed_application", side_effect=AssertionError("imported")):
            status, _, err, error = self.run_main(["frobnicate"])
            self.assertEqual((status, error["code"], error["field"]), (1, "usage.unknown_command", '"frobnicate"'))
            self.assertNotIn("application.py", err)
            _, _, _, error = self.run_main(["describe", "--bogus"])
            self.assertEqual((error["code"], error["field"]), ("usage.unknown_flag", '"--bogus"'))
        self.assertEqual(parse_evaluator_arguments(["pull", "--config", "c.json"], "/work")[1]["config"], "/work/c.json")

    def test_import_errors_show_the_real_exception_and_verbose_adds_the_traceback(self):
        source = "import definitely_missing_module_for_acclimate\n"
        status, _, _, error = self.run_main(["describe"], {"application.py": source})
        self.assertEqual((status, error["code"]), (1, "application.import_failed"))
        self.assertIn("ModuleNotFoundError", error["message"])
        self.assertIn("definitely_missing_module_for_acclimate", error["message"])
        self.assertEqual(error["cause"]["name"], "ModuleNotFoundError")
        status, _, err, _ = self.run_main(["describe", "--verbose"], {"application.py": source})
        self.assertIn("Traceback", json.loads(err.strip().splitlines()[-1])["traceback"])
        _, _, _, error = self.run_main(["describe"], {"application.py": "undefined_name\n"})
        self.assertIn("NameError", error["message"])

    def test_adapter_errors_name_the_attribute_case_and_field(self):
        good = "from acclimate.evaluation import ExecutionResult, GradeResult\n"
        status, _, _, error = self.run_main(["describe"], {"application.py": good +
            "cases = [{'case_id': 'a', 'input': 1, 'expected': 1}]\ndef execute(run): return ExecutionResult(1)\n"})
        self.assertEqual((status, error["code"], error["field"]), (1, "application.invalid", "grade"))
        _, _, _, error = self.run_main(["describe"], {"application.py": good +
            "import datetime\ncases = [{'case_id': 'a', 'input': {'when': datetime.date(2026, 1, 1)}, 'expected': 1}]\n"
            "def execute(run): return ExecutionResult(1)\ndef grade(run): return GradeResult(1.0)\n"})
        self.assertEqual((error["code"], error["field"]), ("definition.invalid", 'cases[0]["input"]["when"]'))
        self.assertIn("isoformat", error["message"])
        _, _, _, error = self.run_main(["describe"], {"application.py": good +
            "cases = [{'case_id': 'a', 'input': 1, 'expected': 1}, {'case_id': 'a', 'input': 2, 'expected': 2}]\n"
            "def execute(run): return ExecutionResult(1)\ndef grade(run): return GradeResult(1.0)\n"})
        self.assertEqual((error["code"], error["field"]), ("definition.invalid", "cases[1].case_id"))

    def test_model_free_adapters_and_async_callbacks_need_no_live_flag(self):
        source = ("from acclimate.evaluation import ExecutionResult, GradeResult\nexecution = 'model-free'\n"
                  "cases = [{'case_id': 'a', 'input': 1, 'expected': 1}]\n"
                  "async def execute(run): return ExecutionResult(run.input)\n"
                  "def grade(run): return GradeResult(float(run.output == run.expected))\n")
        status, out, _, _ = self.run_main(["describe"], {"application.py": source})
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(out)["runtime"]["execution"], "model-free")


if __name__ == "__main__":
    unittest.main()
