from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import threading
import time
import traceback
from typing import Any
import uuid

from ._evaluation_controls import RunControls, run_warnings, selected_case_ids
from ._evaluation_shared import (
    CallbackCancelled, EvaluationError, EvaluationUsageError, PrivateJsonError, TaskExecutionError, _text,
    atomic_private_write, clone_json, ensure_private_directory, json_bytes, parse_json,
)
from ._evaluation_trials import reported_usage
from .delivery import DeliveryError, validate_payload

MAX_PAYLOAD_FILE = 2 * 1024 * 1024
MAX_FILES = 128
MAX_TEXT = 256 * 1024

class LocalRunError(EvaluationUsageError):
    """A local input problem: an unreadable payload, a nonempty --out folder or a missing --live.

    A usage error (exit 1) whose message is meant for the developer's terminal.
    """

    def __init__(self, message: str, field: str | None = None):
        super().__init__("usage.invalid_flag", field=field, reason=message, message=message)


@dataclass(frozen=True)
class LocalPayload:
    payload: dict
    source: str
    form: str  # "file" or "directory"
    digest: str


def local_payload_digest(payload: dict) -> str:
    """The digest the service would assign: SHA-256 of the canonical payload JSON plus a newline."""
    canonical = {"schemaVersion": payload["schemaVersion"],
                 "files": [{"path": f["path"], "kind": f["kind"], "text": f["text"]} for f in payload["files"]]}
    data = json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    return "sha256:" + hashlib.sha256(data).hexdigest()


def local_file_kind(relative_path: str) -> str:
    """Directory layout: skills/** -> skill, memory/** -> memory, everything else -> instruction."""
    first = relative_path.split("/")[0]
    return "skill" if first == "skills" else "memory" if first == "memory" else "instruction"


def _explain_payload_error(error: Exception, payload: dict):
    # Re-run the shared validator per file so the message can name the culprit.
    for file in payload["files"]:
        try:
            validate_payload({"schemaVersion": 1, "files": [file]})
        except DeliveryError:
            raise LocalRunError(
                f'{file["path"]}: not a valid bundle file. Paths use letters, digits, ".", "_", "-" and "/" (at most 240 '
                'characters, no "..", no reserved device names); each file holds at most 256 KiB of UTF-8 text.') from None
    message = str(error) if isinstance(error, DeliveryError) else "Invalid bundle payload"
    raise LocalRunError(f"{message}. A payload holds 1–{MAX_FILES} files, at most 1 MiB of text in total, and no two paths "
                        "that differ only by case or where one is a folder of the other.") from None


def _decode(data: bytes) -> str:
    # utf-8-sig strips a leading BOM, matching the TypeScript SDK's TextDecoder.
    return data.decode("utf-8-sig")


def _payload_from_directory(root: Path) -> dict:
    files: list[dict] = []

    def walk(directory: Path):
        for entry in sorted(os.scandir(directory), key=lambda item: item.name):
            if entry.name.startswith("."):
                continue
            absolute = Path(entry.path)
            relative = absolute.relative_to(root).as_posix()
            if entry.is_symlink():
                raise LocalRunError(f"{relative}: symbolic links are not read. Copy the file into the folder.")
            if entry.is_dir(follow_symlinks=False):
                walk(absolute)
                continue
            if not entry.is_file(follow_symlinks=False):
                raise LocalRunError(f"{relative}: only regular files can be bundle files.")
            if len(files) == MAX_FILES:
                raise LocalRunError(f"The folder has more than {MAX_FILES} files. A bundle holds at most {MAX_FILES}.")
            size = entry.stat(follow_symlinks=False).st_size
            if size > MAX_TEXT:
                raise LocalRunError(f"{relative}: {size} bytes exceeds the 256 KiB bundle file limit.")
            try:
                text = _decode(absolute.read_bytes())
            except UnicodeDecodeError:
                raise LocalRunError(f"{relative}: bundle files must be UTF-8 text.") from None
            files.append({"path": relative, "kind": local_file_kind(relative), "text": text})

    walk(root)
    if not files:
        raise LocalRunError(f"{root} has no files. Add an instruction file such as AGENTS.md, skills/<name>/SKILL.md or memory/<file>.")
    return {"schemaVersion": 1, "files": files}


def load_local_payload(target: str | os.PathLike) -> LocalPayload:
    """Read a payload JSON file or map a folder of instruction, skill and memory files."""
    source = Path(os.path.abspath(target))
    try:
        info = source.lstat()
    except OSError:
        raise LocalRunError(f"Cannot read {target}. Supply a payload JSON file or a folder of bundle files.") from None
    if stat.S_ISDIR(info.st_mode):
        form = "directory"
        payload: Any = _payload_from_directory(source)
    elif stat.S_ISREG(info.st_mode):
        form = "file"
        if info.st_size > MAX_PAYLOAD_FILE:
            raise LocalRunError(f"{target} exceeds {MAX_PAYLOAD_FILE} bytes.")
        try:
            payload = parse_json(_decode(source.read_bytes()))
        except (UnicodeDecodeError, EvaluationError, OSError):
            raise LocalRunError(f"{target} is not valid UTF-8 JSON (duplicate keys are rejected).") from None
        if type(payload) is not dict or payload.get("schemaVersion") != 1 or type(payload.get("files")) is not list:
            raise LocalRunError(f'{target} must be {{"schemaVersion":1,"files":[{{"path","kind","text"}}]}}, '
                                "where kind is instruction, skill or memory.")
        for index, file in enumerate(payload["files"]):
            if (type(file) is not dict or set(file) - {"path", "kind", "text"}
                    or file.get("kind") not in ("instruction", "skill", "memory")
                    or type(file.get("text")) is not str or type(file.get("path")) is not str):
                raise LocalRunError(f"{target}: files[{index}] needs exactly path, kind (instruction, skill or memory) and text strings.")
    else:
        raise LocalRunError(f"{target} is not a regular file or folder.")
    try:
        validate_payload(payload)
    except DeliveryError as error:
        _explain_payload_error(error, payload)
    return LocalPayload(payload, str(source), form, local_payload_digest(payload))


def _uuid_from(seed: str) -> str:
    """Same derivation as the TypeScript SDK, so a payload keeps one local ID across SDKs."""
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    variant = format((int(digest[16], 16) & 3) | 8, "x")
    return f"{digest[0:8]}-{digest[8:12]}-8{digest[13:16]}-{variant}{digest[17:20]}-{digest[20:32]}"


LOCAL_BUNDLE_ID = _uuid_from("acclimate-local-bundle")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def local_version(payload: dict, parent: dict | None = None) -> dict:
    """The same VerifiedVersion shape the service runner passes to execute."""
    digest = local_payload_digest(payload)
    version_id = _uuid_from("acclimate-local-version\n" + digest)
    parent_id = parent["version"]["id"] if parent and parent["version"]["id"] != version_id else None
    return {"version": {"id": version_id, "bundleId": LOCAL_BUNDLE_ID, "parentVersionId": parent_id,
                        "digest": digest, "createdAt": _now()},
            "payload": clone_json(payload), "resolvedAt": int(time.time() * 1000), "stale": False}


def _describe_error(error: BaseException) -> str:
    try:
        frames = [frame for frame in traceback.extract_tb(error.__traceback__) if "acclimate" not in Path(frame.filename).parts]
        frame = frames[-1] if frames else None
        where = f" (at {frame.filename}:{frame.lineno} in {frame.name})" if frame else ""
        return f"{type(error).__name__}: {error}"[:500] + where[:300]
    except Exception:
        return "Unreadable exception"


def _assert_live(app, allow_live: bool):
    live = app.execution == "live"
    if live != (allow_live is True):
        raise LocalRunError("This evaluator calls live models or services. Add --live to confirm the run may spend money."
                            if live else "This evaluator is model-free. Omit --live.", "--live")


PLACEHOLDER_PAYLOAD = {"schemaVersion": 1, "files": [
    {"path": "AGENTS.md", "kind": "instruction", "text": "# Placeholder instructions for acclimate-eval try\n"}]}

_EXECUTION_FIELDS = ("output", "execution_status", "error", "output_ref", "usage")
_GRADE_FIELDS = ("reward", "error", "explanation")


def _inspect_json(value, field, issues):
    try:
        clone_json(value, field=field)
    except PrivateJsonError as error:
        issues.append({"severity": "error", "field": error.field, "message": error.reason})
        return
    if len(json_bytes(value)) > 1024 * 1024:
        issues.append({"severity": "error", "field": field,
                       "message": "Return at most 1 MiB of JSON. Store larger evidence privately and return a digest."})


def inspect_execution(value: Any) -> list[dict]:
    """Check the shapes the runner accepts. Problems here become silent gaps in a real run."""
    from .evaluation import ExecutionResult
    issues: list[dict] = []
    if not isinstance(value, ExecutionResult):
        issues.append({"severity": "error", "field": "execute()",
                       "message": f"Return ExecutionResult(output=...), not {type(value).__name__}."})
        return issues
    _inspect_json(value.output, "output", issues)
    if value.execution_status not in ("completed", "task_failed"):
        issues.append({"severity": "error", "field": "execution_status", "message": 'Use "completed" or "task_failed".'})
    try:
        reported_usage(value.usage)
    except PrivateJsonError as error:
        issues.append({"severity": "error", "field": error.field,
                       "message": f"{error.reason} The runner records this arm as output_invalid."})
    if value.output_ref is not None and not _text(value.output_ref, 1024):
        issues.append({"severity": "error", "field": "output_ref", "message": "Use a string of at most 1024 bytes without control characters."})
    if value.error is not None and type(value.error) is not str:
        issues.append({"severity": "warning", "field": "error", "message": "Use a string or None."})
    return issues


def inspect_grade(value: Any) -> list[dict]:
    from .evaluation import GradeResult
    issues: list[dict] = []
    if not isinstance(value, GradeResult):
        issues.append({"severity": "error", "field": "grade()", "message": f"Return GradeResult(reward=...), not {type(value).__name__}."})
        return issues
    reward = value.reward
    if type(reward) not in (int, float) or not math.isfinite(reward):
        issues.append({"severity": "error", "field": "reward", "message": "Return a finite number. The runner records a grading failure otherwise."})
    elif reward < 0 or reward > 1:
        issues.append({"severity": "warning", "field": "reward",
                       "message": f"{reward} is outside 0–1. Use a score in 0–1 for a normalized scale."})
    if value.explanation is not None:
        _inspect_json(value.explanation, "explanation", issues)
    return issues


def try_evaluation(*, app, directory: str | os.PathLike, payload: LocalPayload | None = None,
                   selection: dict | None = None, allow_live: bool = False, case_timeout_ms: int | None = None,
                   cancel_event: threading.Event | None = None) -> dict:
    """Run execute and grade once per selected case (default: the first) and validate every returned shape."""
    from .evaluation import CancellationContext, EvaluationApp, ExecuteInput, ExecutionContext, GradeInput
    if not isinstance(app, EvaluationApp):
        raise EvaluationError("config.schema")
    _assert_live(app, allow_live)
    case_ids = [case.case_id for case in app._cases]
    chosen = selected_case_ids(selection, case_ids) if selection else set(case_ids[:1])
    bundle = local_version(payload.payload if payload else PLACEHOLDER_PAYLOAD)
    request_id, attempt_id = str(uuid.uuid4()), str(uuid.uuid4())
    root = ensure_private_directory(Path(directory))
    global_event = cancel_event or threading.Event()

    def timed(call, arm_event):
        begin = time.monotonic()
        if not case_timeout_ms:
            value = call()
            return value, int((time.monotonic() - begin) * 1000)
        box: dict = {}
        done = threading.Event()

        def target():
            try:
                box["value"] = call()
            except BaseException as error:  # relayed to the caller
                box["error"] = error
            finally:
                done.set()

        threading.Thread(target=target, daemon=True).start()
        if not done.wait(case_timeout_ms / 1000):
            arm_event.set()
            raise LocalRunError(f"Timed out after {case_timeout_ms} ms; the callback was cancelled.")
        if "error" in box:
            raise box["error"]
        return box["value"], int((time.monotonic() - begin) * 1000)

    rows = []
    for case in app._cases:
        if case.case_id not in chosen:
            continue
        job_id = hashlib.sha256(json_bytes([request_id, attempt_id, case.case_id])).hexdigest()
        job_dir = ensure_private_directory(ensure_private_directory(root / "jobs") / job_id)
        arm_event = threading.Event()
        cancellation = CancellationContext(global_event, (arm_event,))
        context = ExecutionContext(request_id, attempt_id, "candidate", job_id, str(job_dir))
        row = {"caseId": case.case_id, "execute": {"status": "failed", "durationMs": 0, "issues": []},
               "grade": {"status": "skipped", "durationMs": 0, "issues": []}}
        rows.append(row)
        try:
            execution, row["execute"]["durationMs"] = timed(
                lambda: app._execute(ExecuteInput(clone_json(bundle), clone_json(case.input), case.case_id, 0, cancellation, context)),
                arm_event)
        except TaskExecutionError as error:
            row["execute"]["error"] = f"TaskExecutionError (recorded as task_failed): {_describe_error(error)}"
            continue
        except CallbackCancelled:
            row["execute"]["error"] = "CallbackCancelled: the runner treats this as a cancelled run."
            continue
        except Exception as error:
            row["execute"]["error"] = str(error) if isinstance(error, LocalRunError) else _describe_error(error)
            continue
        row["execute"]["issues"] = inspect_execution(execution)
        if hasattr(execution, "output"):
            row["execute"]["output"] = execution.output
            row["execute"]["executionStatus"] = getattr(execution, "execution_status", None)
            if getattr(execution, "usage", None) is not None:
                row["execute"]["usage"] = execution.usage
        if any(issue["severity"] == "error" for issue in row["execute"]["issues"]):
            continue
        row["execute"]["status"] = "ok"
        arm_event = threading.Event()
        grade_cancellation = CancellationContext(global_event, (arm_event,))
        try:
            grade, row["grade"]["durationMs"] = timed(
                lambda: app._grade(GradeInput(clone_json(execution.output), clone_json(case.expected), case.case_id, 0, grade_cancellation)),
                arm_event)
        except Exception as error:
            row["grade"]["status"] = "failed"
            row["grade"]["error"] = str(error) if isinstance(error, LocalRunError) else _describe_error(error)
            continue
        row["grade"]["issues"] = inspect_grade(grade)
        if type(getattr(grade, "reward", None)) in (int, float):
            row["grade"]["reward"] = grade.reward
        if getattr(grade, "explanation", None) is not None:
            row["grade"]["explanation"] = grade.explanation
        row["grade"]["status"] = "failed" if any(issue["severity"] == "error" for issue in row["grade"]["issues"]) else "ok"
    return {"schemaVersion": 1,
            "ok": bool(rows) and all(row["execute"]["status"] == "ok" and row["grade"]["status"] == "ok" for row in rows),
            "payload": {"digest": bundle["version"]["digest"], "source": payload.source if payload else None},
            "cases": rows}


__all__ = ["LocalPayload", "LocalRunError", "PLACEHOLDER_PAYLOAD",
           "inspect_execution", "inspect_grade", "load_local_payload", "local_file_kind", "local_payload_digest",
           "local_version",
           "try_evaluation"]
