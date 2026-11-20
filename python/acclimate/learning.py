"""Define a learning loop and grade its rollouts."""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import Any
from uuid import uuid4

from ._evaluation_shared import EvaluationError
from .client import AcclimateClient, ApiError
from .errors import AcclimateError, UsageError
from .evaluation_manifest import canonical_evaluation_json
from .types import (
    LearningEvolveCase, LearningHeldOutRollout, LearningJson, LearningLiveEvolveCase,
    LearningLoop, LearningLoopRequest, LearningSetting, VerifiedVersion,
)

__all__ = ["LoopDefinition", "define_loop", "exact", "tests", "held_out_digest", "serve_learning_loop"]

Execute = Callable[[VerifiedVersion, LearningJson, int], Any]
Grade = Callable[[Any, LearningJson], float | LearningHeldOutRollout]


def _hash(value: LearningJson) -> str:
    return hashlib.sha256(canonical_evaluation_json(value).encode("utf-8")).hexdigest()


def held_out_digest(cases: Sequence[LearningEvolveCase]) -> str:
    """Return the same order-independent commitment as the TypeScript SDK."""
    identities: list[LearningJson] = [
        {"caseId": case["caseId"], "input": _hash(case["input"]), "expected": _hash(case["expected"])}
        for case in sorted(cases, key=lambda case: case["caseId"].encode("utf-8"))
    ]
    return "sha256:" + _hash(identities)


@dataclass(frozen=True)
class LoopDefinition:
    bundle: str
    channel: str
    execute: Execute
    cases: Path
    grade: Grade
    setting: LearningSetting
    split: float


def define_loop(
    *,
    bundle: str,
    channel: str,
    execute: Execute,
    policy_model: str,
    cases: str | Path,
    grade: Grade,
    split: float = 0.5,
    domain: str | None = None,
    benchmark: str | None = None,
) -> LoopDefinition:
    """Define the application, case file, grader and learning setting."""
    filename = Path(cases)
    setting: LearningSetting = {
        "domain": bundle if domain is None else domain,
        "benchmark": filename.name if benchmark is None else benchmark,
        "policyModel": policy_model,
    }
    for name, value in {**setting, "bundle": bundle, "channel": channel}.items():
        if (not isinstance(value, str) or not value.strip() or len(value.encode()) > 256
                or any(ord(char) < 32 or ord(char) == 127 for char in value)):
            raise UsageError(f"{name} must contain 1–256 UTF-8 bytes without control characters.", name)
    if not callable(execute) or not callable(grade):
        raise UsageError("Pass callable execute and grade functions.")
    if type(split) not in (int, float) or not 0 < split < 1:
        raise UsageError("Choose a split strictly between 0 and 1.", "split")
    return LoopDefinition(bundle, channel, execute, filename, grade, setting, split)


def exact(path: str | None = None) -> Grade:
    """Compare the entire output, or one top-level output key, with expected JSON."""
    def grade(output: Any, expected: LearningJson) -> int:
        if path is not None:
            if not isinstance(output, dict) or path not in output:
                return 0
            output = output[path]
        try:
            return int(canonical_evaluation_json(output) == canonical_evaluation_json(expected))
        except EvaluationError:
            return 0

    return grade


def tests(command: str, cwd: str | Path | None = None) -> Grade:
    """Write output.json in a temporary directory and score the command's exit status."""
    fixture = Path(cwd).resolve() if cwd is not None else None

    def grade(output: Any, expected: LearningJson) -> int:
        with tempfile.TemporaryDirectory(prefix="acclimate-grade-") as directory:
            if fixture is not None:
                shutil.copytree(fixture, directory, dirs_exist_ok=True, symlinks=True)
            filename = Path(directory) / "output.json"
            filename.unlink(missing_ok=True)
            filename.write_text(json.dumps(output, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
            result = subprocess.run(
                command, shell=True, cwd=directory, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            )
            return int(result.returncode == 0)

    return grade


def _is_held_out(case_id: str, split: float) -> bool:
    digest = int.from_bytes(hashlib.sha256(case_id.encode()).digest(), "big")
    return digest < math.ceil(split * 2**256)


def _load_cases(
    definition: LoopDefinition, directory: Path
) -> tuple[list[LearningEvolveCase], list[LearningEvolveCase]]:
    filename = directory / definition.cases
    try:
        source = filename.read_text(encoding="utf-8")
        if filename.suffix == ".jsonl":
            rows = [json.loads(line) for line in source.split("\n") if line.strip()]
        elif filename.suffix == ".json":
            rows = json.loads(source)
        else:
            raise UsageError("Use a .json or .jsonl cases file.", "cases")
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise UsageError("Could not read the cases file as JSON.", "cases") from None
    if not isinstance(rows, list):
        raise UsageError("The cases file must contain a list of cases.", "cases")
    evolve: list[LearningEvolveCase] = []
    held_out: list[LearningEvolveCase] = []
    seen: set[str] = set()
    for number, row in enumerate(rows, 1):
        if not isinstance(row, dict) or not {"input", "expected"} <= row.keys():
            raise UsageError(f"Case {number} needs input and expected.", "cases")
        try:
            for field in ("input", "expected"):
                canonical_evaluation_json(row[field])
                if _wire_size(row[field]) > 64 * 1024:
                    raise ValueError
        except (EvaluationError, ValueError):
            raise UsageError(f"Case {number} needs portable JSON values up to 64 KiB each.", "cases") from None
        case_id = row.get("caseId", _hash(row["input"]))
        if not _valid_case_id(case_id) or case_id.startswith("outcome:") or case_id in seen:
            raise UsageError(f"Case {number} needs a valid, unique caseId without the outcome: prefix.", "cases")
        seen.add(case_id)
        target = held_out if _is_held_out(case_id, definition.split) else evolve
        target.append({"caseId": case_id, "input": row["input"], "expected": row["expected"]})
    if not evolve or not 1 <= len(held_out) <= 10_000:
        raise UsageError("Provide at least one evolve case and 1–10,000 held-out cases.", "cases")
    return evolve, held_out


def _valid_case_id(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", value) is not None


def _wire_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


def _discover_principal(
    client: AcclimateClient, workspace: str, current: LearningLoop | None
) -> str:
    try:
        principal = client.get_principal(workspace)
    except ApiError as error:
        if error.status != 404:
            raise
        if current is not None:
            return current["appPrincipalId"]
        raise UsageError("Set ACCLIMATE_APP_PRINCIPAL to the evaluator principal (machine:<name> for a machine token).") from error
    if principal["kind"] != "machine" or not {"evaluate", "write"}.intersection(principal["rights"]):
        raise UsageError("ACCLIMATE_TOKEN must belong to a machine principal with evaluate access.")
    return principal["principalId"]


def _enroll(
    client: AcclimateClient, workspace: str, bundle: str, definition: LoopDefinition,
    held_out: Sequence[LearningEvolveCase], principal: str | None,
    enrollment_client: AcclimateClient | None = None,
) -> LearningLoop:
    admin = enrollment_client or client
    try:
        current = admin.get_learning_loop(workspace, bundle)
    except ApiError as error:
        if error.status != 404:
            raise
        current = None
    principal = principal or _discover_principal(client, workspace, current)
    request: LearningLoopRequest = {
        "channel": definition.channel,
        "appPrincipalId": principal,
        "setting": definition.setting,
        "heldOut": {"digest": held_out_digest(held_out), "cases": len(held_out)},
    }
    if current and current["status"] != "stopped" and all(
        current[key] == request[key] for key in ("channel", "appPrincipalId", "setting", "heldOut")
    ):
        return current
    try:
        return admin.enroll_learning_loop(workspace, bundle, request, str(uuid4()))
    except ApiError as error:
        if error.status == 409 and error.code == "learning_conflict":
            raise UsageError("The server refused the configuration change. Pause the loop and let the active round finish before retrying.") from error
        if error.status == 403 and enrollment_client is None:
            raise UsageError("Enrollment requires promote access. Set ACCLIMATE_ENROLL_TOKEN to a separate principal with promote access.") from error
        raise


def _sync_cases(
    client: AcclimateClient, workspace: str, bundle: str, cases: Sequence[LearningEvolveCase]
) -> None:
    # Restart the collection if a concurrent outcome or mutation changes its revision.
    limit = 100
    for _ in range(5):
        live: dict[str, LearningLiveEvolveCase] = {}
        revision, cursor = None, None
        while True:
            try:
                page = client.list_learning_evolve_cases(workspace, bundle, after=cursor, limit=limit)
            except ApiError as error:
                if error.code != "response_too_large" or limit == 1:
                    raise
                limit = max(1, limit // 2)
                continue
            if revision is not None and revision != page["evolveRevision"]:
                break
            revision = page["evolveRevision"]
            live.update((case["caseId"], case) for case in page["items"])
            cursor = page["next"]
            if cursor is None:
                break
        if cursor is None:
            break
    else:
        raise UsageError("The evolve cases changed repeatedly while listing. Retry case sync.")

    desired = {case["caseId"]: case for case in cases}
    for case_id in desired.keys() & live.keys():
        if any(canonical_evaluation_json(desired[case_id][field]) !=
               canonical_evaluation_json(live[case_id][field]) for field in ("input", "expected")):
            raise UsageError(f"Evolve case {case_id!r} is immutable. Use a new caseId for changed content.")
    additions = [case for case in cases if case["caseId"] not in live]
    retired = sorted(case_id for case_id in live.keys() - desired.keys() if not case_id.startswith("outcome:"))
    added, removed = 0, 0
    while added < len(additions) or removed < len(retired):
        batch: list[LearningEvolveCase] = []
        size = 0
        for case in additions[added:added + 100]:
            case_size = _wire_size(case) + 1
            # Leave space for the mutation envelope and up to 100 retirement IDs.
            if size + case_size > 2 * 1024 * 1024 - 14_000:
                break
            batch.append(case)
            size += case_size
        retire = retired[removed:removed + 100]
        client.add_learning_evolve_cases(workspace, bundle, {"cases": batch, "retire": retire}, str(uuid4()))
        added += len(batch)
        removed += len(retire)


def serve_learning_loop(
    client: AcclimateClient,
    workspace_id: str,
    bundle_id: str,
    *,
    execute: Execute,
    grade: Grade,
    held_out: Sequence[LearningEvolveCase],
    journal_dir: str | Path | None = None,
    poll_interval: float = 1,
    stop: Callable[[], bool] | None = None,
    on_diagnostic: Callable[[AcclimateError], None] | None = None,
) -> None:
    """Serve assigned evaluations until interrupted or the stop callback returns true."""
    from ._learning_runner import serve

    serve(client, workspace_id, bundle_id, execute, grade, held_out,
          journal_dir, poll_interval, stop, on_diagnostic)
