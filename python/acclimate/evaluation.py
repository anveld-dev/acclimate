"""Installed application adapters and evaluator preflight."""
from __future__ import annotations

import asyncio
from concurrent.futures import CancelledError as ConcurrentCancelledError
import copy
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import inspect
import math
import os
from pathlib import Path
import shutil
import re
import threading
import traceback
from typing import Any, Callable, Generic, Literal, TypedDict, TypeVar
import uuid
import weakref

from .client import ApiError
from .types import BundleFile, VerifiedVersion
from ._evaluation_types import EvaluationDescriptor, Usage
from ._evaluation_shared import (
    MIB, CallbackCancelled, DefinitionError as DefinitionError, EvaluationError as EvaluationError,
    OutputValidationError as OutputValidationError, TaskExecutionError as TaskExecutionError,
    ExecutionUncertainError as ExecutionUncertainError, _text, clone_json,
    ensure_private_directory, guided_uuid, json_bytes, make_client,
    read_evaluator_config, safe_error, sha256, validate_descriptor,
)
from ._evaluation_trials import reported_usage
from ._evaluation_controls import RunControls, merge_controls, validate_run_controls

I = TypeVar("I")
E = TypeVar("E")
O = TypeVar("O")
_APP_TOKEN=object()

#: ``"live"`` callbacks call models and need ``allow_live=True`` (``--live``).
Execution = Literal["model-free", "live"]
#: What an execute callback reports. Infrastructure failures are raised, not returned.
ExecutionStatus = Literal["completed", "task_failed"]


@dataclass(frozen=True)
class Case(Generic[I,E]):
    case_id: str
    input: I
    expected: E
    #: How many times to run the case, counting from 1. Each run receives a 0-based
    #: ``repetition`` index, so ``repetitions=3`` yields repetitions 0, 1 and 2.
    repetitions: int = 1


EvaluationCase = Case


@dataclass(frozen=True)
class CancellationContext:
    _event: threading.Event
    # Per-callback stops (case timeout, run deadline). They never cancel the run.
    _extra: tuple[threading.Event, ...] = ()

    def is_cancelled(self) -> bool:
        return self._event.is_set() or any(event.is_set() for event in self._extra)

    def raise_if_cancelled(self) -> None:
        if self.is_cancelled():
            raise CallbackCancelled()


@dataclass(frozen=True)
class CollectionContext:
    protocol: str
    schedule_digest: str
    pair_index: int
    arm_index: int
    first_side: str


@dataclass(frozen=True)
class ExecutionContext:
    request_id: str
    attempt_id: str
    side: str
    job_id: str
    private_job_directory: str
    collection: CollectionContext | None = None


def _files(version: Any, kind: str) -> tuple[BundleFile, ...]:
    try:
        return tuple(file for file in version["payload"]["files"] if file.get("kind") == kind)
    except (KeyError, TypeError, AttributeError):
        return ()


@dataclass(frozen=True)
class ExecuteInput(Generic[I]):
    #: The verified parent or candidate version under test.
    version: VerifiedVersion
    input: I
    case_id: str
    #: 0-based index of this run of the case.
    repetition: int
    cancellation: CancellationContext
    context: ExecutionContext

    @property
    def instructions(self) -> str:
        """Text of every instruction file in the bundle, joined with blank lines in payload order."""
        return "\n\n".join(file["text"] for file in self.instruction_files)

    @property
    def instruction_files(self) -> tuple[BundleFile, ...]:
        """Instruction files in payload order."""
        return _files(self.version, "instruction")

    @property
    def skill_files(self) -> tuple[BundleFile, ...]:
        """Skill files in payload order."""
        return _files(self.version, "skill")

    @property
    def memory_files(self) -> tuple[BundleFile, ...]:
        """Memory files in payload order."""
        return _files(self.version, "memory")


@dataclass(frozen=True)
class GradeInput(Generic[E,O]):
    output: O
    expected: E
    case_id: str
    repetition: int
    cancellation: CancellationContext


@dataclass(frozen=True)
class ExecutionResult(Generic[O]):
    output: O
    execution_status: ExecutionStatus = "completed"
    error: str | None = None
    output_ref: str | None = None
    #: ``{"inputTokens": ..., "outputTokens": ..., "costUsd": ...}``. The snake_case keys
    #: ``input_tokens``, ``output_tokens`` and ``cost_usd`` are mapped explicitly. Any other
    #: key makes the output invalid instead of being dropped.
    usage: Usage | None = None


@dataclass(frozen=True)
class GradeResult:
    reward: float
    error: str | None = None
    explanation: Any = None
    #: Named numeric grades, such as correctness or citation quality.
    components: dict[str, float] | None = None


class PreflightCheck(TypedDict, total=False):
    check: Literal["runtime", "privateConfig", "journalStorage", "lock",
                   "targetBundle", "descriptor"]
    status: Literal["passed", "failed", "not_applicable", "unverified"]
    code: str
    pathIssue: str
    field: str
    hint: str
    serviceUrl: str


class PreflightResult(TypedDict):
    schemaVersion: Literal[1]
    status: Literal["ready", "blocked"]
    checkedAt: str
    checks: list[PreflightCheck]
    nextAction: str


class EvaluationApp(Generic[I,E,O]):
    def __init__(self, descriptor: dict, cases: tuple[Case, ...], execute: Callable,
                 grade: Callable, execution: Execution, *, collection: dict | None = None, _token=None):
        if _token is not _APP_TOKEN:
            raise DefinitionError("app", "Create the app with define_evaluation().")
        self._descriptor = clone_json(descriptor)
        self._cases, self._execute, self._grade = cases,execute,grade
        self._execution = execution
        self._collection = collection
        self._controls: RunControls | None = None

    @property
    def descriptor(self) -> EvaluationDescriptor:
        return copy.deepcopy(self._descriptor)  # type: ignore[return-value]

    @property
    def execution(self) -> Execution:
        return self._execution  # type: ignore[return-value]


def _async_function(callback: Callable) -> bool:
    return inspect.iscoroutinefunction(callback) or inspect.iscoroutinefunction(getattr(callback,"__call__",None))


class _CoroutineRunner:
    """Run one app's coroutine callbacks to completion on a private event loop thread.

    One loop serves every callback of the app, so clients bound to a loop keep working,
    and callers that already run an event loop can still use the synchronous runner.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    def run(self, awaitable):
        with self._lock:
            if self._loop is None:
                loop = asyncio.new_event_loop()
                threading.Thread(target=loop.run_forever, name="acclimate-callbacks", daemon=True).start()
                self._loop = loop
            loop = self._loop

        async def settle():
            return await awaitable
        try:
            return asyncio.run_coroutine_threadsafe(settle(), loop).result()
        except (asyncio.CancelledError, ConcurrentCancelledError):
            # A cancelled coroutine cannot attest that an external job stopped.
            raise ExecutionUncertainError() from None

    def close(self):
        loop, self._loop = self._loop, None
        if loop is not None:
            loop.call_soon_threadsafe(loop.stop)


def _synchronous(callback: Callable, runner: _CoroutineRunner) -> Callable:
    if not _async_function(callback):
        return callback

    def invoke(run):
        return runner.run(callback(run))
    return invoke


_COLLECTION_KEYS = {f"acclimate.collection.{key}" for key in ("protocol", "seed", "schedule")}


def _collection_schedule(config: dict, inventory: list[dict]) -> dict:
    if (type(config) is not dict or set(config) != {"protocol", "seed"}
            or config["protocol"] != "seeded-balanced-v1"):
        raise EvaluationError("config.schema")
    seed = config["seed"]
    if type(seed) is not str:
        raise EvaluationError("config.schema")
    clone_json(seed)
    if not seed.strip() or len(seed.encode("utf-8")) > 256:
        raise EvaluationError("config.schema")

    # The ranking and wire manifest use the same UTF-8 JSON bytes as the TypeScript SDK.
    def rank(index: int) -> bytes:
        pair = inventory[index]
        return hashlib.sha256(json_bytes([seed, pair["caseId"], pair["repetition"]])).digest()

    ranked = sorted(range(len(inventory)), key=rank)
    phase = hashlib.sha256(json_bytes([seed, "first-arm"])).digest()[0] % 2
    pairs = [key.copy() for key in inventory]
    for position, index in enumerate(ranked):
        pairs[index]["firstSide"] = "candidate" if (position + phase) % 2 else "parent"
    manifest = {"protocol": config["protocol"], "seed": seed, "pairs": pairs}
    return {**manifest, "digest": sha256(json_bytes(manifest) + b"\n")}


def _nonempty(value: Any, maximum: int) -> bool:
    return type(value) is str and bool(value.strip()) and _text(value, maximum)


def capture_cases(cases: Any, root: str = "cases") -> tuple[list[Case], list[dict]]:
    """Check Case values and return private clones plus the public inventory.

    Raises ``DefinitionError`` naming the case and field, for example ``cases[1].case_id``.
    """
    if type(cases) not in (list, tuple):
        raise DefinitionError(root, "Supply cases as a list of Case values.")
    if not cases:
        raise DefinitionError(root, "cases is empty. Add at least one case.")
    captured=[]
    inventory=[]
    seen: dict[str, int] = {}
    for index, case in enumerate(cases):
        at = f"{root}[{index}]"
        if not isinstance(case,Case):
            raise DefinitionError(at, "Use Case(case_id, input, expected).")
        if not _nonempty(case.case_id, 1024):
            raise DefinitionError(at + ".case_id", "Use a nonempty string of at most 1024 bytes.")
        if case.case_id in seen:
            raise DefinitionError(at + ".case_id",
                f"Duplicate case_id {json_bytes(case.case_id).decode()}; cases[{seen[case.case_id]}] uses it too.")
        if type(case.repetitions) is not int or not 1<=case.repetitions<=1000:
            raise DefinitionError(at + ".repetitions",
                "Use an integer count from 1 to 1000. Each run receives a 0-based repetition index.")
        seen[case.case_id] = index
        try:
            values = (clone_json(case.input, field=at + '["input"]'),
                      clone_json(case.expected, field=at + '["expected"]'))
        except OutputValidationError as error:
            raise DefinitionError(error.field, error.reason) from None
        captured.append(Case(case.case_id, values[0], values[1], case.repetitions))
        inventory.extend({"caseId":case.case_id,"repetition":r} for r in range(case.repetitions))
        if len(inventory)>1000:
            raise DefinitionError(root, "Use at most 1000 case repetitions in one evaluation.")
    return captured, inventory


def define_evaluation(*, config_id: str, config_revision: str, dataset_revision: str,
                      grader_revision: str, runtime: dict[str,str], execution: Execution,
                      cases: list[Case[I,E]] | tuple[Case[I,E],...],
                      execute: Callable[[ExecuteInput[I]],ExecutionResult[O]],
                      grade: Callable[[GradeInput[E,O]],GradeResult],
                      collection: dict[str,str] | None = None,
                      concurrency: int = 1, grade_retries: int = 0) -> EvaluationApp[I,E,O]:
    """Capture an evaluation. Callbacks may be ordinary functions or coroutine functions.

    concurrency (1-64) is the number of pairs in flight; arms within a pair keep
    schedule order. grade_retries (0-5) repeats a grade call that raised or timed
    out; execution is never repeated. Both are fingerprinted in the descriptor.

    Invalid input raises ``DefinitionError`` (code ``definition.invalid``) whose ``field``
    names the argument or case, for example ``cases[1].case_id``.
    """
    for name, callback in (("execute", execute), ("grade", grade)):
        if not callable(callback):
            raise DefinitionError(name, f"Supply {name} as a function.")
    if execution not in ("model-free", "live"):
        raise DefinitionError("execution", 'Use "model-free" or "live".')
    for name, value, maximum in (("config_id", config_id, 128), ("config_revision", config_revision, 1024),
                                 ("dataset_revision", dataset_revision, 1024),
                                 ("grader_revision", grader_revision, 1024)):
        if not _nonempty(value, maximum):
            raise DefinitionError(name, f"Use a nonempty string of at most {maximum} bytes.")
    if type(runtime) is not dict:
        raise DefinitionError("runtime", "Supply runtime as a dict of string settings.")
    reserved={"configId","configRevision","execution","concurrency","gradeRetries"} | _COLLECTION_KEYS
    if len(runtime) > 64 - 5 - (0 if collection is None else 3):
        raise DefinitionError("runtime", "Use at most 59 runtime settings.")
    for key, setting in runtime.items():
        if key in reserved:
            raise DefinitionError(f"runtime.{key}", "This key is reserved. Set it with the matching argument or remove it.")
        if not _nonempty(key, 128):
            raise DefinitionError(f"runtime[{json_bytes(str(key)).decode()}]", "Use a nonempty key of at most 128 bytes.")
        if not _nonempty(setting, 4096):
            raise DefinitionError(f"runtime.{key}", "Use a nonempty string of at most 4096 bytes.")
    scheduling = declared_scheduling(concurrency, grade_retries)
    captured, inventory = capture_cases(cases)
    if collection is not None:
        try:
            _collection_schedule(collection, inventory)
        except EvaluationError:
            raise DefinitionError("collection",
                'Use {"protocol": "seeded-balanced-v1", "seed": ...} with a nonempty seed of at most 256 bytes.') from None
    schedule = _collection_schedule(collection, inventory) if collection is not None else None
    collection_runtime = {} if schedule is None else {
        "acclimate.collection.protocol": schedule["protocol"],
        "acclimate.collection.seed": schedule["seed"],
        "acclimate.collection.schedule": schedule["digest"],
    }
    try:
        descriptor=validate_descriptor({"datasetRevision":dataset_revision,"graderRevision":grader_revision,
            "runtime":{**runtime,"configId":config_id,"configRevision":config_revision,"execution":execution,
                **scheduling,**collection_runtime},"expectedCases":inventory})
    except EvaluationError:
        raise DefinitionError("descriptor", "The definition does not form a valid public descriptor.") from None
    if len(json_bytes([{"input":case.input,"expected":case.expected} for case in captured]))>16*MIB:
        raise DefinitionError("cases", "Keep case inputs and expected values under 16 MiB in total.")
    runner = _CoroutineRunner()
    app: EvaluationApp[I, E, O] = EvaluationApp(descriptor, tuple(captured), _synchronous(execute, runner),
        _synchronous(grade, runner), execution, collection=schedule, _token=_APP_TOKEN)
    weakref.finalize(app, runner.close)
    return app


def declared_scheduling(concurrency: Any = 1, grade_retries: Any = 0) -> dict[str, str]:
    """Fingerprint declared scheduling. Defaults keep existing descriptors byte-identical."""
    if type(concurrency) is not int or not 1 <= concurrency <= 64:
        raise DefinitionError("concurrency", "Use an integer from 1 to 64.")
    if type(grade_retries) is not int or not 0 <= grade_retries <= 5:
        raise DefinitionError("grade_retries", "Use an integer from 0 to 5.")
    return {"concurrency": str(concurrency), "gradeRetries": str(grade_retries)}


def bind_run_controls(app: EvaluationApp, controls: RunControls) -> EvaluationApp:
    """Bind invocation controls without changing the descriptor or the callbacks."""
    if not isinstance(app, EvaluationApp):
        raise DefinitionError("app", "Pass the value returned by define_evaluation().")
    bound = EvaluationApp(app._descriptor, app._cases, app._execute, app._grade, app._execution,
                          collection=app._collection, _token=_APP_TOKEN)
    bound._controls = merge_controls(app._controls, validate_run_controls(controls))
    return bound


def _assert_bundle_exists(client,workspace_id: str,bundle_id: str):
    # Empty request/channel listings also succeed for a nonexistent bundle.
    cursor=None
    seen=set()
    for _ in range(100):
        page=client._request("GET",client._base(workspace_id)+client._listing(cursor,100))
        if (type(page) is not dict or type(page.get("items")) is not list or len(page["items"])>100 or
            any(type(item) is not dict or type(item.get("id")) is not str for item in page["items"]) or
            "nextCursor" not in page or (page["nextCursor"] is not None and
                (type(page["nextCursor"]) is not str or not page["nextCursor"] or len(page["nextCursor"])>4096))):
            raise EvaluationError("evidence.malformed",phase="preflight")
        if any(item["id"]==bundle_id for item in page["items"]):
            return
        cursor=page["nextCursor"]
        if cursor is None:
            raise EvaluationError("bundle.missing",phase="preflight")
        if cursor in seen:
            raise EvaluationError("evidence.malformed",phase="preflight")
        seen.add(cursor)
    raise EvaluationError("evidence.incomplete",phase="preflight",next_action="ask_operator")


def preflight_evaluation(*, app: EvaluationApp, config_path: str, target: dict) -> PreflightResult:
    """Check the application, private evaluator storage and bundle access."""
    checks = []
    current_check = "runtime"
    probe = None
    try:
        if os.name != "posix" or not isinstance(app, EvaluationApp):
            raise EvaluationError("runtime.unsupported")
        import fcntl
        checks.append({"check": "runtime", "status": "passed"})
        current_check = "privateConfig"
        config = read_evaluator_config(config_path)
        checks.append({"check": "privateConfig", "status": "passed"})
        if type(target) is not dict or not guided_uuid(target.get("bundleId")):
            raise EvaluationError("guided_target_unsupported")
        current_check = "journalStorage"
        root = ensure_private_directory(config["journalRoot"], journal_root=True)
        probe = ensure_private_directory(root / (".probe-" + uuid.uuid4().hex))
        checks.append({"check": "journalStorage", "status": "passed"})
        current_check = "lock"
        fd = os.open(probe / "probe.lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.fsync(fd)
        finally:
            os.close(fd)
        checks.append({"check": "lock", "status": "passed"})
        current_check = "targetBundle"
        _assert_bundle_exists(make_client(config), config["workspaceId"], target["bundleId"])
        checks.extend([{"check": "targetBundle", "status": "passed"}, {"check": "descriptor", "status": "passed"}])
        return {"schemaVersion": 1, "status": "ready", "checkedAt": datetime.now(timezone.utc).isoformat(),
                "checks": checks, "nextAction": "none"}
    except Exception as error:
        safe = (EvaluationError("bundle.missing", phase="preflight", http_status=404)
                if isinstance(error, ApiError) and error.status == 404 else safe_error(error))
        checks.append({"check": current_check, "status": "failed", "code": safe.code,
                       **{key: safe.diagnostic[key] for key in ("pathIssue", "field", "hint", "serviceUrl")
                          if key in safe.diagnostic}})
        return {"schemaVersion": 1, "status": "blocked", "checkedAt": datetime.now(timezone.utc).isoformat(),
                "checks": checks, "nextAction": safe.next_action}
    finally:
        if probe is not None:
            shutil.rmtree(probe)


# Usage validation is shared with the trial scheduler.
_usage = reported_usage


_SECRET_PATTERNS = (
    (re.compile(r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}", re.I), r"\1 [redacted]"),
    (re.compile(r"\b(sk|pk|rk|ghp|gho|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{8,}"), "[redacted]"),
    (re.compile(r"\b((?:api[_-]?key|access[_-]?token|token|secret|password|authorization)[\"']?\s*[:=]\s*[\"']?)[^\s\"',;]{4,}", re.I),
     r"\1[redacted]"),
)


def redact_diagnostic_text(value: str, secrets: tuple[str, ...] = ()) -> str:
    """Remove credentials that commonly appear in provider error messages."""
    text = value[:16384]
    for secret in secrets:
        if secret and len(secret) >= 8:
            text = text.replace(secret, "[redacted]")
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text
