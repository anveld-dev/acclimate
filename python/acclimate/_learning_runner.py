"""Serve the learning evaluation protocol with a durable local rollout journal."""

from collections.abc import Callable, Sequence
from copy import deepcopy
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import time
from typing import Any
from uuid import UUID, uuid4

from ._learning_openai import _TranscriptError
from ._evaluation_shared import atomic_private_write, ensure_private_directory, read_private_bytes
from .client import AcclimateClient, ApiError, TransportError
from .delivery import DeliveryError, resolve_and_cache
from .errors import AcclimateError, UsageError
from .evaluation import redact_diagnostic_text
from .learning import Execute, Grade, _valid_case_id, held_out_digest
from .types import (
    LearningEvaluationReportRequest, LearningEvolveCase, LearningRollout,
    LearningWork, LearningWorkItem, VerifiedVersion,
)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _read(path: Path) -> Any:
    if not path.exists() and not path.is_symlink():
        return None
    try:
        saved = json.loads(read_private_bytes(path, limit=128 * 1024))
    except ValueError:
        raise AcclimateError("journal.invalid", "Invalid learning journal record.") from None
    if not isinstance(saved, dict):
        raise AcclimateError("journal.invalid", "Invalid learning journal record.")
    return saved


def _save(path: Path, value: object) -> None:
    atomic_private_write(path, json.dumps(value, ensure_ascii=False, allow_nan=False).encode())


def _score(value: Any) -> LearningRollout:
    if type(value) in (int, float):
        value = {"score": value, "passed": value == 1}
    if isinstance(value, dict):
        score, passed = value.get("score"), value.get("passed")
        if type(score) in (int, float) and 0 <= score <= 1 and type(passed) is bool:
            return {"score": score, "passed": passed}
    raise ValueError("Return a score between 0 and 1 and an optional boolean passed verdict.")


def _failure(private: bool, error: str) -> LearningRollout:
    return {"score": 0, "passed": False} if private else {
        "score": 0, "passed": False, "trace": None, "error": error
    }


def _trace(text: str, token: str) -> str:
    data = text.replace(token, "[redacted]").encode(errors="replace")
    if len(data) <= 16 * 1024:
        return data.decode()
    first = data[:8000].decode(errors="ignore")
    last = data[-8000:].decode(errors="ignore")
    omitted = len(data) - len(first.encode()) - len(last.encode())
    return f"{first}\n[… {omitted} bytes omitted …]\n{last}"


def _run(
    execute: Execute, grade: Grade, version: VerifiedVersion, case: LearningEvolveCase,
    index: int, private: bool, token: str,
) -> LearningRollout:
    stage = "execution"
    try:
        result = execute(deepcopy(version), deepcopy(case["input"]), index)
        output, trace = result if isinstance(result, tuple) else (result, None)
        stage = "grading"
        score = _score(grade(output, deepcopy(case["expected"])))
    except Exception as error:
        if private:
            return _failure(True, "")
        message = redact_diagnostic_text(f"{stage}.failed {error}".replace(token, "[redacted]"))
        failed = _failure(False, message.encode(errors="replace")[:4096].decode(errors="ignore"))
        if isinstance(error, _TranscriptError):
            failed["trace"] = _trace(error.trace, token)
        return failed
    if not private:
        score.update(trace=_trace(trace, token) if isinstance(trace, str) else None, error=None)
    return score


def _trial(
    path: Path, execute: Execute, grade: Grade, version: VerifiedVersion,
    case: LearningEvolveCase, index: int, private: bool, token: str,
) -> LearningRollout:
    entry = _read(path)
    if entry is None:
        _save(path, {"state": "started"})
        result = _run(execute, grade, version, case, index, private, token)
    elif entry.get("state") == "started":
        result = _failure(private, "execution.uncertain")
    elif entry.get("state") == "complete":
        try:
            saved = entry["result"]
            if not isinstance(saved, dict):
                raise ValueError
            result = _score(saved)
        except (ValueError, KeyError):
            raise AcclimateError("journal.invalid", "Invalid saved rollout.") from None
        if not private:
            for key in ("trace", "error"):
                if saved.get(key) is not None and not isinstance(saved[key], str):
                    raise AcclimateError("journal.invalid", "Invalid saved rollout evidence.")
            result.update(trace=saved.get("trace"), error=saved.get("error"))
        return result
    else:
        raise AcclimateError("journal.invalid", "Invalid saved rollout state.")
    _save(path, {"state": "complete", "result": result})
    return result


def _work(client: AcclimateClient, workspace: str, bundle: str) -> LearningWork:
    work = client.get_learning_work(workspace, bundle)
    if work["bundleId"].lower() != bundle.lower():
        raise AcclimateError("evidence.identity_mismatch", "Work feed returned a different bundle.")
    return work


def _serve_item(
    client: AcclimateClient, workspace: str, bundle: str, root: Path, item: LearningWorkItem,
    execute: Execute, grade: Grade, held_out: Sequence[LearningEvolveCase], commitment: str,
) -> None:
    evaluation_id = item["evaluationId"]
    try:
        valid_id = str(UUID(evaluation_id)) == evaluation_id.lower()
    except ValueError:
        valid_id = False
    if not valid_id or item["split"] not in ("evolve", "heldOut"):
        raise AcclimateError("evidence.malformed", "Invalid learning work item.")
    directory = ensure_private_directory(root / evaluation_id)
    fd = os.open(directory / "lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        identity_fields = ("roundId", "versionId", "digest", "split", "evolveRevision")
        identity = _hash(json.dumps([*(item[field] for field in identity_fields), item["heldOut"]], sort_keys=True))
        filename = directory / "attempt.json"
        journal = _read(filename)
        if journal is None:
            journal = {"identity": identity, "attemptId": str(uuid4())}
            _save(filename, journal)
        attempt = journal.get("attemptId")
        if journal.get("identity") != identity or not isinstance(attempt, str) or len(attempt) != 36:
            raise AcclimateError("journal.invalid", "Learning journal does not match the assignment.")
        assignment = client.start_learning_evaluation(workspace, bundle, evaluation_id, {"attemptId": attempt})
        def report(body: LearningEvaluationReportRequest) -> None:
            cases = body.get("cases")
            case_id = cases[0]["caseId"] if cases else "error"
            key = f"{attempt}:{case_id}"
            if len(key) > 128 or case_id == "error":
                key = _hash("case:" + key)
            client.report_learning_evaluation(workspace, bundle, evaluation_id, body, key)

        evaluation = assignment["evaluation"]
        if evaluation["id"] != evaluation_id or any(
            evaluation[field] != item[field] for field in identity_fields
        ):
            report({"attemptId": attempt, "error": "evidence.identity_mismatch"})
            return
        if evaluation["status"] != "running":
            return

        private = item["split"] == "heldOut"
        if private and (item["heldOut"] != assignment["heldOut"] or
                        assignment["heldOut"] != {"digest": commitment, "cases": len(held_out)}):
            report({"attemptId": attempt, "error": "learning.held_out_mismatch"})
            return
        try:
            version = resolve_and_cache(
                client, workspace, bundle, version_id=item["versionId"], cache_dir=str(root / "cache"),
            )
        except DeliveryError:
            report({"attemptId": attempt, "error": "evidence.identity_mismatch"})
            return
        if version["version"]["digest"] != item["digest"] or version["version"]["id"] != item["versionId"]:
            report({"attemptId": attempt, "error": "evidence.identity_mismatch"})
            return
        cases = held_out if private else assignment["cases"]
        if (cases is None or len(cases) != evaluation["cases"]
                or any(not _valid_case_id(case["caseId"]) for case in cases)
                or len({case["caseId"] for case in cases}) != len(cases)):
            report({"attemptId": attempt, "error": "evidence.malformed"})
            return
        reported = set(assignment["reportedCaseIds"])

        def active() -> bool:
            work = _work(client, workspace, bundle)
            return work["status"] != "stopped" and any(
                candidate["evaluationId"] == evaluation_id for candidate in work["items"]
            )

        for case in cases:
            if case["caseId"] in reported:
                continue
            rollouts = []
            for index in range(5):
                if not active():
                    return
                trial = directory / (_hash(json.dumps([attempt, case["caseId"], index])) + ".json")
                rollouts.append(_trial(trial, execute, grade, version, case, index, private, client._token))
            if not active():
                return
            report({"attemptId": attempt, "cases": [{"caseId": case["caseId"], "rollouts": rollouts}]})
    finally:
        os.close(fd)


def serve(
    client: AcclimateClient, workspace: str, bundle: str, execute: Execute, grade: Grade,
    held_out: Sequence[LearningEvolveCase], journal_dir: str | Path | None, poll_interval: float,
    stop: Callable[[], bool] | None, on_diagnostic: Callable[[AcclimateError], None] | None,
) -> None:
    if not math.isfinite(poll_interval) or poll_interval <= 0:
        raise UsageError("Use a positive poll interval.", "poll_interval")
    held_out = deepcopy(held_out)
    if (not 1 <= len(held_out) <= 10_000
            or any(not _valid_case_id(case["caseId"]) for case in held_out)
            or len({case["caseId"] for case in held_out}) != len(held_out)):
        raise UsageError("Use 1–10,000 held-out cases with unique, valid IDs.", "held_out")
    commitment = held_out_digest(held_out)
    base = Path(journal_dir).absolute() if journal_dir is not None else (
        Path.home().resolve() / ".local" / "state" / "acclimate" / "python-learning"
    )
    namespace = _hash(json.dumps([client.base_url, workspace, bundle.lower()]))
    root = ensure_private_directory(ensure_private_directory(base) / namespace)
    while True:
        try:
            if stop is not None and stop():
                return
            work = _work(client, workspace, bundle)
            if work["status"] != "stopped":
                for item in work["items"]:
                    try:
                        _serve_item(client, workspace, bundle, root, item, execute, grade, held_out, commitment)
                    except ApiError as error:
                        if error.status != 409:
                            raise
                        if on_diagnostic is not None:
                            on_diagnostic(error)
        except (TransportError, ApiError) as error:
            if isinstance(error, ApiError) and error.status != 429 and error.status < 500:
                raise
            if on_diagnostic is not None:
                on_diagnostic(error)
        time.sleep(poll_interval)
