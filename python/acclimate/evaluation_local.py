"""Local comparisons and smoke tests: no service, no config, no handoff.

Local results are advisory. They are never release evidence or a release receipt.
"""
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
from ._evaluation_trials import TrialHooks, reported_usage, run_trials
from .delivery import DeliveryError, validate_payload

MAX_PAYLOAD_FILE = 2 * 1024 * 1024
MAX_FILES = 128
MAX_TEXT = 256 * 1024

LOCAL_NOTICE = ("Local comparison: not a release receipt. The service did not verify these versions, this evidence "
                "or this policy result. Run compare against the service to gate a release.")


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


def create_local_run_directory(out: str | None = None, base: str | os.PathLike | None = None) -> Path:
    base_path = Path.cwd() if base is None else Path(base)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = (base_path / out) if out else base_path / ".acclimate" / "local" / f"{stamp}-{uuid.uuid4().hex[:8]}"
    target = Path(os.path.abspath(target)).resolve()
    if target.is_dir() and any(target.iterdir()):
        raise LocalRunError(f"{target} is not empty. Choose a new --out folder.", "--out")
    try:
        return ensure_private_directory(target)
    except EvaluationError:
        raise LocalRunError(f"Cannot create a private folder at {target}. It must be owned by you with mode 0700; "
                            "choose another --out folder.", "--out") from None


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


def run_local_comparison(*, app, parent: dict, candidate: dict, directory: str | os.PathLike,
                         allow_live: bool = False, controls: RunControls | None = None,
                         cancel_event: threading.Event | None = None) -> dict:
    """Run the service comparison's trial schedule on two local payloads.

    Nothing contacts the service and the result is never release evidence.
    `directory` must be a private, empty folder for job directories and artifacts.
    """
    from .evaluation import CancellationContext, EvaluationApp
    if not isinstance(app, EvaluationApp):
        raise EvaluationError("config.schema")
    _assert_live(app, allow_live)
    validate_payload(parent)
    validate_payload(candidate)
    parent_version = local_version(parent)
    candidate_version = local_version(candidate, parent_version)
    root = ensure_private_directory(Path(directory))
    request_id, attempt_id = str(uuid.uuid4()), str(uuid.uuid4())
    lock = threading.Lock()
    diagnostics: list[dict] = []
    callbacks = {"started": 0}

    def job_directory(case_id, repetition, side, version):
        identity = {"requestId": request_id, "attemptId": attempt_id, "caseId": case_id, "repetition": repetition,
                    "side": side, "versionId": version["id"], "digest": version["digest"]}
        job_id = hashlib.sha256(json_bytes(identity)).hexdigest()
        with lock:
            job_dir = ensure_private_directory(ensure_private_directory(root / "jobs") / job_id)
        atomic_private_write(job_dir / "binding.json", json_bytes(identity))
        return job_id, job_dir

    def write_artifact(identity, value):
        body = json_bytes({"schemaVersion": 1, "identity": {"requestId": request_id, "attemptId": attempt_id, **identity}, "value": value})
        digest = hashlib.sha256(body).hexdigest()
        with lock:
            # Identical artifacts share one content-addressed file.
            atomic_private_write(ensure_private_directory(root / "artifacts") / f"{digest}.json", body + b"\n")
        return {"sha256": digest, "bytes": len(body)}

    def record_diagnostic(job_dir, phase, error):
        binding = json.loads((Path(job_dir) / "binding.json").read_text("utf-8"))
        if isinstance(error, PrivateJsonError):
            path = Path(job_dir) / "output-validation.json"
            atomic_private_write(path, json_bytes({"field": error.field, "reason": error.reason}))
            detail, phase = f"{error.field}: {error.reason}", "output"
        else:
            detail = _describe_error(error)
            path = Path(job_dir) / "callback-error.json"
            atomic_private_write(path, json_bytes({"phase": phase, "detail": detail}) + b"\n")
        with lock:
            diagnostics.append({"caseId": binding["caseId"], "repetition": binding["repetition"], "side": binding["side"],
                                "phase": phase, "detail": detail})
        return str(path)

    def started():
        with lock:
            callbacks["started"] += 1

    cancellation = CancellationContext(cancel_event or threading.Event())
    results, summary = run_trials(
        app=app, request_id=request_id, attempt_id=attempt_id,
        bundles={"parent": parent_version, "candidate": candidate_version}, cancellation=cancellation,
        controls=app._controls if controls is None else controls, on_callback_started=started,
        hooks=TrialHooks(checkpoint=lambda: None, assert_owned=lambda: None, job_directory=job_directory,
                         write_artifact=write_artifact, record_diagnostic=record_diagnostic))
    descriptor = app.descriptor
    comparison = {
        "parentVersionId": parent_version["version"]["id"], "candidateVersionId": candidate_version["version"]["id"],
        "parentDigest": parent_version["version"]["digest"], "candidateDigest": candidate_version["version"]["digest"],
        "datasetRevision": descriptor["datasetRevision"], "graderRevision": descriptor["graderRevision"],
        "runtime": dict(descriptor["runtime"]), "evaluation": {"requestId": request_id, "attemptId": attempt_id},
        "expectedCases": [dict(key) for key in descriptor["expectedCases"]], "results": results,
        "id": str(uuid.uuid4()),
        "complete": all(outcome["gradingStatus"] == "scored" and outcome["executionStatus"] != "infrastructure_failed"
                        for pair in results for outcome in (pair["parent"], pair["candidate"])),
        "submitter": "local", "createdAt": _now(),
    }
    diagnostics.sort(key=lambda item: (item["caseId"], item["repetition"]))
    return {
        "schemaVersion": 1, "authoritative": False, "descriptor": descriptor,
        "versions": {"parent": parent_version["version"], "candidate": candidate_version["version"]},
        "comparison": comparison,
        "binding": {"parentVersionId": comparison["parentVersionId"], "candidateVersionId": comparison["candidateVersionId"],
                    "parentDigest": comparison["parentDigest"], "candidateDigest": comparison["candidateDigest"],
                    "requestId": request_id, "attemptId": attempt_id, "comparisonId": comparison["id"], "submitter": "local"},
        "summary": summary, "callbacksStarted": callbacks["started"], "diagnostics": diagnostics,
        "warnings": run_warnings(summary, {"parent": comparison["parentDigest"], "candidate": comparison["candidateDigest"]}),
    }


def score_local_comparison(result: dict, policy_text: str | None = None) -> dict:
    """Score a local comparison and, when supplied, apply a policy as advice only."""
    from .evaluation_analysis import analyze_comparison
    from .evaluation_policy import check_comparison, parse_evaluation_policy
    policy = None if policy_text is None else parse_evaluation_policy(policy_text, result["descriptor"])
    evidence = dict(comparison=result["comparison"], expected_descriptor=result["descriptor"], expected_binding=result["binding"])
    metrics = [{**policy["policy"]["metric"], "source": "reward", "id": "reward"}] if policy else None
    metric = analyze_comparison(**evidence, metrics=metrics)["metrics"][0]
    scores = {key: metric[key] for key in ("counts", "summary", "cases")}
    if "evidenceGaps" in metric:
        scores["evidenceGaps"] = metric["evidenceGaps"]
    if policy is None:
        return {"scores": scores, "policy": None}
    verdict = check_comparison(**evidence, policy=policy["policy"], policy_digest=policy["sha256"])
    return {"scores": scores, "policy": {**verdict, "advisory": True}}


def local_report(result: dict, scored: dict, sources: dict, directory: str | os.PathLike) -> dict:
    """The report written beside local artifacts. It is never accepted as release evidence."""
    candidate_payload = str(Path(directory) / "candidate.payload.json")
    return {
        "schemaVersion": 1, "kind": "acclimate.local-comparison", "authoritative": False, "releaseReceipt": False,
        "notice": LOCAL_NOTICE, "createdAt": result["comparison"]["createdAt"], "descriptor": result["descriptor"],
        "parent": {**result["versions"]["parent"], "source": sources["parent"].source, "form": sources["parent"].form},
        "candidate": {**result["versions"]["candidate"], "source": sources["candidate"].source, "form": sources["candidate"].form},
        "run": result["summary"], "callbacksStarted": result["callbacksStarted"], "scores": scored["scores"],
        "policy": scored["policy"], "warnings": result["warnings"], "diagnostics": result["diagnostics"],
        "comparison": result["comparison"],
        "replay": {
            "description": ("Local evidence cannot be uploaded: the service only accepts results produced under an attempt it "
                            "issued for versions it stores. Replay the same candidate against the service instead. The service "
                            "compares it with the current parent on its channel; check that the digest of that parent matches "
                            "parent.digest to reproduce this comparison."),
            "candidatePayload": candidate_payload,
            "command": f"compare --config CONFIG --bundle BUNDLE_ID --channel CHANNEL --payload {candidate_payload} --name RUN_NAME",
            "parentDigest": result["versions"]["parent"]["digest"],
        },
    }


def write_local_report(directory: str | os.PathLike, report: dict, sources: dict) -> str:
    root = Path(directory)
    atomic_private_write(root / "parent.payload.json", (json.dumps(sources["parent"].payload, ensure_ascii=False, indent=2) + "\n").encode())
    atomic_private_write(root / "candidate.payload.json", (json.dumps(sources["candidate"].payload, ensure_ascii=False, indent=2) + "\n").encode())
    target = root / "local-report.json"
    atomic_private_write(target, (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode())
    return str(target)


# --------------------------------------------------------------------- try ---

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
                       "message": f"{reward} is outside 0–1. Comparisons accept any finite reward, but thresholds and "
                                  "connected-learning policies expect 0–1."})
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


def read_local_text(target: str | os.PathLike, limit: int = 2 * 1024 * 1024) -> str:
    path = Path(target)
    try:
        info = path.stat()
    except OSError:
        raise LocalRunError(f"Cannot read {target}.") from None
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        raise LocalRunError(f"{target} must be a file of at most {limit} bytes.")
    try:
        return _decode(path.read_bytes())
    except (OSError, UnicodeDecodeError):
        raise LocalRunError(f"Cannot read {target} as UTF-8 text.") from None


__all__ = ["LOCAL_NOTICE", "LocalPayload", "LocalRunError", "PLACEHOLDER_PAYLOAD", "create_local_run_directory",
           "inspect_execution", "inspect_grade", "load_local_payload", "local_file_kind", "local_payload_digest",
           "local_report", "local_version", "read_local_text", "run_local_comparison", "score_local_comparison",
           "try_evaluation", "write_local_report"]
