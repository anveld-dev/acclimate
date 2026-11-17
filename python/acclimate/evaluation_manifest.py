"""Pure app-retained evaluation identities. No filesystem, environment or network reads.

Only descriptor is public. definition and private_manifest contain private cases.
Hashes bind declared bytes/settings; they do not authenticate callbacks or execution.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from typing import Any

from ._evaluation_shared import EvaluationError, validate_descriptor
from .evaluation import Case

_SCHEMA = "acclimate-evaluation-manifest-v1"
_LIMIT = 16 * 1024 * 1024
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")


def _fail():
    raise EvaluationError("config.schema")


def _string(value: str):
    try:
        if len(value.encode("utf-8")) > 1024 * 1024:
            _fail()
    except UnicodeError:
        _fail()


def _decimal(value: int | float) -> str:
    if type(value) is int:
        if abs(value) > 2**53 - 1:
            _fail()
        return str(value)
    if not math.isfinite(value) or (value.is_integer() and abs(value) > 2**53 - 1):
        _fail()
    if value == 0:
        return "0"
    if value.is_integer():
        return str(int(value))
    numerator, denominator = abs(value).as_integer_ratio()
    places = denominator.bit_length() - 1
    digits = str(numerator * 5**places).rjust(places + 1, "0")
    return ("-" if value < 0 else "") + digits[:-places] + "." + digits[-places:]


def canonical_evaluation_json(value: Any) -> str:
    """Canonical UTF-8 JSON, exact binary64 decimals, with bounded portable data only."""
    nodes = 0
    size = 0
    active: set[int] = set()

    def charge(text):
        nonlocal size
        size += len(text.encode("utf-8"))
        if size > _LIMIT:
            _fail()
        return text

    def visit(item, depth):
        nonlocal nodes
        nodes += 1
        if nodes > 100_000 or depth > 64:
            _fail()
        if item is None:
            return charge("null")
        if type(item) is bool:
            return charge("true" if item else "false")
        if type(item) in (int, float):
            return charge(_decimal(item))
        if type(item) is str:
            _string(item)
            return charge(json.dumps(item, ensure_ascii=False))
        if type(item) not in (dict, list) or id(item) in active:
            _fail()
        active.add(id(item))
        if type(item) is list:
            values = [visit(child, depth + 1) for child in item]
            charge("[" + "," * max(0, len(values) - 1) + "]")
            result = "[" + ",".join(values) + "]"
        else:
            for key in item:
                if type(key) is not str:
                    _fail()
                _string(key)
            values = []
            for key in sorted(item, key=lambda key: key.encode("utf-8")):
                encoded = json.dumps(key, ensure_ascii=False)
                charge(encoded + ":")
                values.append(encoded + ":" + visit(item[key], depth + 1))
            charge("{" + "," * max(0, len(values) - 1) + "}")
            result = "{" + ",".join(values) + "}"
        active.remove(id(item))
        return result

    try:
        return visit(value, 0)
    except (ValueError, TypeError, RecursionError, OverflowError, UnicodeError):
        _fail()


def _record(value, required, optional=()):
    if type(value) is not dict or not set(required).issubset(value) or set(value) - set(required) - set(optional):
        _fail()


def _identity(value, maximum):
    if type(value) is not str or re.fullmatch(r"[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*", value) is not None or len(value.encode("utf-8")) > maximum or any(ord(x) < 32 or ord(x) == 127 for x in value):
        _fail()


def _hash(domain, value):
    return "sha256:" + hashlib.sha256((_SCHEMA + "\n" + domain + "\n" + canonical_evaluation_json(value)).encode("utf-8")).hexdigest()


class EvaluationManifest:
    """Captured manifest; every structured accessor returns a separate clone."""
    def __init__(self, private_json: str, descriptor: dict, definition: dict):
        self._private_json = private_json
        self._descriptor = copy.deepcopy(descriptor)
        self._definition = copy.deepcopy(definition)

    @property
    def descriptor(self) -> dict:
        return copy.deepcopy(self._descriptor)

    @property
    def definition(self) -> dict:
        """Arguments for define_evaluation(**manifest.definition, execute=..., grade=...)."""
        return copy.deepcopy(self._definition)

    @property
    def private_manifest(self) -> dict:
        return json.loads(self._private_json)

    @property
    def private_manifest_json(self) -> str:
        return self._private_json


def create_evaluation_manifest(*, config_id: str, execution: str, cases: list[Case] | tuple[Case, ...],
                               grader: dict, runtime: dict) -> EvaluationManifest:
    """Capture the SAME Case inventory used to define execution; declare all artifacts.

    grader is exactly {"sourceUtf8": text} or {"artifactDigest": "sha256:..."}.
    runtime is {"settings": {...}, "artifacts": {"executor": "sha256:...", ...}}.
    Settings/artifacts are app assertions. This helper does not inspect callbacks/builds.
    """
    if type(cases) not in (list, tuple) or not cases or len(cases) > 1000:
        _fail()
    wire_cases = []
    for case in cases:
        if type(case) is not Case or set(vars(case)) != {"case_id", "input", "expected", "repetitions"}:
            _fail()
        wire_cases.append({"caseId": case.case_id, "input": case.input, "expected": case.expected, "repetitions": case.repetitions})
    captured = json.loads(canonical_evaluation_json({"configId": config_id, "execution": execution,
        "cases": wire_cases, "grader": grader, "runtime": runtime}))
    return _capture(captured)


def _capture(captured):
    _record(captured, ("configId", "execution", "cases", "grader", "runtime"))
    _identity(captured["configId"], 128)
    if captured["execution"] not in ("model-free", "live") or type(captured["cases"]) is not list or not captured["cases"]:
        _fail()
    grader = captured["grader"]
    _record(grader, (), ("sourceUtf8", "artifactDigest"))
    if len(grader) != 1:
        _fail()
    if "sourceUtf8" in grader:
        if type(grader["sourceUtf8"]) is not str or not grader["sourceUtf8"]:
            _fail()
    elif type(grader["artifactDigest"]) is not str or not _DIGEST.fullmatch(grader["artifactDigest"]):
        _fail()
    runtime = captured["runtime"]
    _record(runtime, ("settings", "artifacts"))
    if type(runtime["settings"]) is not dict or type(runtime["artifacts"]) is not dict or not 1 <= len(runtime["artifacts"]) <= 32:
        _fail()
    for name, digest in runtime["artifacts"].items():
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", name) or type(digest) is not str or not _DIGEST.fullmatch(digest):
            _fail()
    seen = set()
    total = 0
    for case in captured["cases"]:
        _record(case, ("caseId", "input", "expected"), ("repetitions",))
        _identity(case["caseId"], 1024)
        if case["caseId"] in seen:
            _fail()
        seen.add(case["caseId"])
        case.setdefault("repetitions", 1)
        repetitions = case["repetitions"]
        if type(repetitions) is not int or not 1 <= repetitions <= 1000:
            _fail()
        total += repetitions
        if total > 1000:
            _fail()
    captured["cases"].sort(key=lambda case: case["caseId"].encode("utf-8"))
    private_json = canonical_evaluation_json({"schema": _SCHEMA, **captured})
    dataset_revision = _hash("dataset", captured["cases"])
    grader_revision = _hash("grader", grader)
    runtime_revision = _hash("runtime", runtime)
    config_revision = _hash("configuration", {"configId": captured["configId"], "execution": captured["execution"],
        "datasetRevision": dataset_revision, "graderRevision": grader_revision, "runtimeRevision": runtime_revision})
    public_runtime = {"manifestSchema": _SCHEMA, "runtimeRevision": runtime_revision}
    definition = {"config_id": captured["configId"], "execution": captured["execution"],
        "cases": [Case(case["caseId"], case["input"], case["expected"], case["repetitions"]) for case in captured["cases"]],
        "config_revision": config_revision, "dataset_revision": dataset_revision, "grader_revision": grader_revision, "runtime": public_runtime}
    descriptor = validate_descriptor({"datasetRevision": dataset_revision, "graderRevision": grader_revision,
        "runtime": {**public_runtime, "configId": captured["configId"], "configRevision": config_revision,
            "execution": captured["execution"], "concurrency": "1", "gradeRetries": "0"},
        "expectedCases": [{"caseId": case["caseId"], "repetition": r} for case in captured["cases"] for r in range(case["repetitions"])]})
    return EvaluationManifest(private_json, descriptor, definition)


def restore_evaluation_manifest(text: str) -> EvaluationManifest:
    """Restore a private saved JSON manifest; reject unknown and duplicate decoded keys."""
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                _fail()
            out[key] = value
        return out
    try:
        if type(text) is not str or len(text.encode("utf-8")) > _LIMIT:
            _fail()
        captured = json.loads(text, object_pairs_hook=pairs, parse_constant=lambda _: _fail())
        # Reparse canonical bytes so integral binary64 spellings capture exactly
        # the same values/types as create and JavaScript (including -0 -> 0).
        captured = json.loads(canonical_evaluation_json(captured))
        _record(captured, ("schema", "configId", "execution", "cases", "grader", "runtime"))
        if captured.pop("schema") != _SCHEMA:
            _fail()
        return _capture(captured)
    except (ValueError, TypeError, RecursionError, OverflowError, UnicodeError):
        _fail()
