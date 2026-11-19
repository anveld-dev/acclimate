"""Installed, application-owned paired evaluation with conservative durable recovery."""
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

from .delivery import resolve_and_cache
from .client import ApiError
from .types import (
    BundleFile, Comparison, Evaluation, EvaluationDescriptor, EvaluationHandoff, Usage, VerifiedVersion,
)
from ._evaluation_shared import (
    MIB, DIGEST_RE, EvaluationError, ExecutionUncertainError, CallbackCancelled, DefinitionError,
    EvaluationUsageError, ERROR_CODES, EXIT_CODES, SafeCode, exit_code_for,
    OutputValidationError, TaskExecutionError, _text, assert_descriptor, atomic_private_write,
    clone_json, descriptor_from,
    ensure_private_directory, guided_uuid, json_bytes, make_client, mutate,
    parse_json, read_evaluator_config, safe_error, scope_from, sha256,
    validate_descriptor, validate_handoff,
)
from ._evaluation_journal import Journal
from ._evaluation_trials import TrialHooks, reported_usage, run_trials
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


def _files(bundle: Any, kind: str) -> tuple[BundleFile, ...]:
    try:
        return tuple(file for file in bundle["payload"]["files"] if file.get("kind") == kind)
    except (KeyError, TypeError, AttributeError):
        return ()


@dataclass(frozen=True)
class ExecuteInput(Generic[I]):
    bundle: VerifiedVersion
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
        return _files(self.bundle, "instruction")

    @property
    def skill_files(self) -> tuple[BundleFile, ...]:
        """Skill files in payload order."""
        return _files(self.bundle, "skill")

    @property
    def memory_files(self) -> tuple[BundleFile, ...]:
        """Memory files in payload order."""
        return _files(self.bundle, "memory")


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


class PreflightCheck(TypedDict, total=False):
    check: Literal["runtime", "privateConfig", "journalStorage", "lock", "serviceIdentity",
                   "evaluatorAccess", "targetBundle", "targetRequest", "descriptor", "versions"]
    status: Literal["passed", "failed", "not_applicable", "unverified"]
    code: str
    pathIssue: str
    field: str
    hint: str
    serviceUrl: str


class PreflightResult(TypedDict):
    schemaVersion: Literal[1]
    status: Literal["ready", "blocked"]
    authorization: Literal["verified", "denied", "unverified"]
    checkedAt: str
    checks: list[PreflightCheck]
    nextAction: str


class CallbackFailure(TypedDict, total=False):
    caseId: str
    repetition: int
    side: Literal["parent", "candidate"]
    stage: Literal["execute", "grade"]
    reason: Literal["execution_failed", "task_failed", "output_invalid", "grading_failed", "execution_uncertain"]
    #: Private local file with the redacted message and traceback. Never uploaded.
    diagnosticFile: str


class EvaluationRunResult(TypedDict, total=False):
    schemaVersion: Literal[1]
    evaluation: Evaluation
    comparison: Comparison | None
    executionState: Literal["finished", "interrupted"]
    callbacksStarted: int
    reusedEvidence: bool
    firstCallbackFailure: CallbackFailure
    #: Present when this invocation executed trials: stop reason, cost and coverage.
    runSummary: dict


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
    # Bound the actual report envelope, including escaped refs, before paid work.
    worst={"executionStatus":"infrastructure_failed","gradingStatus":"missing","reward":-1.7976931348623157e308,
        "outputRef":"\\"*1024,"error":"x"*128,
        "usage":{"inputTokens":1.7976931348623157e308,"outputTokens":1.7976931348623157e308,"costUsd":1.7976931348623157e308}}
    budget={**descriptor,"parentVersionId":"0"*36,"candidateVersionId":"0"*36,
        "parentDigest":"sha256:"+"0"*64,"candidateDigest":"sha256:"+"0"*64,
        "evaluation":{"requestId":"0"*36,"attemptId":"0"*36},
        "results":[{**key,"parent":worst,"candidate":worst} for key in inventory]}
    limit = 2 * MIB
    estimated = len(json_bytes(budget))
    if estimated > limit:
        fixed = len(json_bytes({**budget, "expectedCases": [], "results": []}))
        largest_pair = max(len(json_bytes(key)) + len(json_bytes(row)) + 2
                           for key, row in zip(inventory, budget["results"]))
        max_pairs = (limit - fixed + 2) // largest_pair
        error = EvaluationError("definition.report_budget_exceeded", phase="preflight")
        error.diagnostic["reportBudget"] = {"estimatedBytes": estimated, "limitBytes": limit,
            "expectedPairs": len(inventory), "maxPairsPerPartition": max_pairs}
        error.args = (f"{error.code}: estimated {estimated} bytes for {len(inventory)} pairs, limit {limit}. "
                      f"Partition the cases into groups of at most {max_pairs} pairs using this configuration.",)
        raise error
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


def _request_snapshot(request: dict) -> dict:
    return {**descriptor_from(request),**{key:request[key] for key in
        ("parentVersionId","candidateVersionId","parentDigest","candidateDigest")}}


def _assert_request(request: dict, handoff: dict, app: EvaluationApp, frozen: dict | None=None):
    if request.get("id")!=handoff["requestId"] or request.get("status") not in ("requested","running","completed","failed","interrupted","abandoned"):
        raise EvaluationError("evidence.identity_mismatch",phase="verify")
    validate_descriptor(descriptor_from(request))
    assert_descriptor(request,app.descriptor)
    assert_descriptor(request,handoff["configuration"])
    for key in ("parentVersionId","candidateVersionId"):
        if not guided_uuid(request.get(key)):
            raise EvaluationError("version.binding_mismatch",phase="verify")
    for key in ("parentDigest","candidateDigest"):
        if type(request.get(key)) is not str or not DIGEST_RE.fullmatch(request[key]):
            raise EvaluationError("version.binding_mismatch",phase="verify")
    if request.get("requireBoundEvidence") is not True:
        raise EvaluationError("evidence.identity_mismatch",phase="verify")
    if frozen is not None:
        assert_descriptor(request,frozen)
        if any(request[key]!=frozen[key] for key in ("parentVersionId","candidateVersionId","parentDigest","candidateDigest")):
            raise EvaluationError("version.binding_mismatch",phase="verify")


def _bundles(client,config: dict,handoff: dict,request: dict,cache: Path):
    parent=resolve_and_cache(client,config["projectId"],handoff["bundleId"],version_id=request["parentVersionId"],cache_dir=str(cache))
    candidate=resolve_and_cache(client,config["projectId"],handoff["bundleId"],version_id=request["candidateVersionId"],cache_dir=str(cache))
    if parent["version"]["digest"]!=request["parentDigest"] or candidate["version"]["digest"]!=request["candidateDigest"] or candidate["version"]["parentVersionId"]!=parent["version"]["id"]:
        raise EvaluationError("version.binding_mismatch",phase="verify")
    return {"parent":clone_json(parent),"candidate":clone_json(candidate)}


def _authority(client,config: dict):
    try:
        caps=client.get_evaluation_capabilities(config["projectId"])
    except Exception as error:
        if isinstance(error,ApiError) and error.status==404:
            raise EvaluationError("capabilities.unsupported",phase="preflight",next_action="upgrade_service",http_status=404) from None
        raise safe_error(error,phase="preflight") from None
    if type(caps.get("schemaVersion")) is not int or caps.get("schemaVersion")!=1 or caps.get("retainedEvaluationOperations") is not True:
        raise EvaluationError("capabilities.unsupported",phase="preflight",next_action="upgrade_service")
    if caps.get("projectId")!=config["projectId"] or caps.get("principalId")!=config["evaluatorPrincipalId"]:
        raise EvaluationError("auth.principal_mismatch",phase="preflight",next_action="ask_operator")
    if caps.get("readUnpublished") is not True or caps.get("writeEvaluation") is not True:
        raise EvaluationError("auth.denied",phase="preflight",next_action="ask_operator")
    return caps


def _assert_bundle_exists(client,project_id: str,bundle_id: str):
    # Empty request/channel listings also succeed for a nonexistent bundle.
    cursor=None
    seen=set()
    for _ in range(100):
        page=client._request("GET",client._base(project_id)+client._listing(cursor,100))
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


def preflight_evaluation(*, app: EvaluationApp, config_path: str,
                         target: dict | None=None, handoff: EvaluationHandoff | dict | None=None) -> PreflightResult:
    """Nonexecuting check: only a private local probe and authorized GETs."""
    checks=[]
    authorization="unverified"
    current_check="runtime"
    probe=None
    try:
        if os.name!="posix" or not isinstance(app,EvaluationApp):
            raise EvaluationError("runtime.unsupported")
        import fcntl
        checks.append({"check":"runtime","status":"passed"})
        current_check="privateConfig"
        config=read_evaluator_config(config_path)
        checks.append({"check":"privateConfig","status":"passed"})
        if handoff is not None:
            target={"handoff":handoff}
        if type(target) is not dict:
            raise EvaluationError("config.schema", field="target", reason='Pass {"bundleId": ...} or {"handoff": ...}.')
        selected=validate_handoff(target["handoff"]) if "handoff" in target else None
        if selected:
            scope_from(config,selected)
        elif not guided_uuid(target.get("bundleId")):
            raise EvaluationError("guided_target_unsupported")
        current_check="journalStorage"
        root=ensure_private_directory(config["journalRoot"], journal_root=True)
        probe=ensure_private_directory(root/(".probe-"+uuid.uuid4().hex))
        checks.append({"check":"journalStorage","status":"passed"})
        current_check="lock"
        fd=os.open(probe/"probe.lock",os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            os.fsync(fd)
        finally:
            os.close(fd)
        checks.append({"check":"lock","status":"passed"})
        current_check="evaluatorAccess"
        client=make_client(config)
        caps=_authority(client,config)
        authorization="verified"
        checks.extend([{"check":"serviceIdentity","status":"passed"},{"check":"evaluatorAccess","status":"passed"}])
        current_check="targetBundle"
        _assert_bundle_exists(client,config["projectId"],selected["bundleId"] if selected else target["bundleId"])
        checks.append({"check":"targetBundle","status":"passed"})
        if selected is None and target.get("requestId"):
            selected={"schemaVersion":1,"serviceUrl":config["serviceUrl"],"projectId":config["projectId"],
                "bundleId":target["bundleId"],"requestId":target["requestId"],"configuration":app.descriptor}
            selected=validate_handoff(selected)
        if selected:
            current_check="targetRequest"
            request=client.get_evaluation(config["projectId"],selected["bundleId"],selected["requestId"])
            checks.append({"check":"targetRequest","status":"passed"})
            current_check="descriptor"
            _assert_request(request,selected,app)
            checks.append({"check":"descriptor","status":"passed"})
            current_check="versions"
            _bundles(client,config,selected,request,probe/"cache")
            checks.append({"check":"versions","status":"passed"})
        else:
            checks.extend([{"check":"descriptor","status":"passed"},{"check":"versions","status":"not_applicable"}])
        return {"schemaVersion":1,"status":"ready","authorization":authorization,
            "checkedAt":caps["checkedAt"],"checks":checks,"nextAction":"review_terminal_evidence"}
    except Exception as error:
        missing={"targetRequest":"request.missing","versions":"version.missing"}.get(current_check)
        safe=(EvaluationError(missing,phase="preflight",http_status=404)
            if isinstance(error,ApiError) and error.status==404 and missing else safe_error(error))
        if safe.code in ("auth.denied","auth.principal_mismatch"):
            authorization="denied"
        checks.append({"check":current_check,"status":"unverified" if safe.code=="capabilities.unsupported" else "failed","code":safe.code,
                       **{k: safe.diagnostic[k] for k in ("pathIssue","field","hint","serviceUrl") if k in safe.diagnostic}})
        return {"schemaVersion":1,"status":"blocked","authorization":authorization,
            "checkedAt":datetime.now(timezone.utc).isoformat(),"checks":checks,"nextAction":safe.next_action}
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


def _record_diagnostic(journal, directory, phase, error, capture_callback_errors, secrets=()):
    """Keep a failed callback's details in its private job directory. Never uploaded.

    Returns the file path, or None when nothing was recorded.
    """
    if isinstance(error, OutputValidationError):
        filename = "output-validation.json"
        data: dict[str, Any] = {"field": error.field, "reason": error.reason}
    elif capture_callback_errors:
        filename = "callback-error.json"
        frames = [{"file": Path(frame.f_code.co_filename).name[:128], "line": line,
                   "function": frame.f_code.co_name[:128]} for frame, line in traceback.walk_tb(error.__traceback__)]
        try:
            message = redact_diagnostic_text(str(error), secrets)[:4096]
            stack = redact_diagnostic_text("".join(traceback.format_exception(error)), secrets)[:16384]
        except Exception:
            message, stack = "", ""
        data = {"phase": phase, "exceptionType": type(error).__name__[:128], "message": message,
                "frames": frames[-8:], "stack": stack}
        code = getattr(error, "code", None)
        if type(code) is str and re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", code):
            data["code"] = code
    else:
        return None
    journal.assert_owned()
    try:
        atomic_private_write(directory / filename, json_bytes(data))
    except (OSError, EvaluationError):
        # A diagnostic is optional. Keep the original callback outcome and let
        # the durable report follow its normal journal/ownership checks.
        journal.assert_owned()
        return None
    return str(directory / filename)


class _Interrupted(Exception):
    def __init__(self,request):
        self.request=request


def _assert_report(report: dict,request: dict,attempt: str):
    validate_descriptor(descriptor_from(report))
    assert_descriptor(report,request)
    if report.get("evaluation")!={"requestId":request["id"],"attemptId":attempt} or any(report.get(k)!=request[k] for k in ("parentVersionId","candidateVersionId","parentDigest","candidateDigest")):
        raise EvaluationError("evidence.identity_mismatch",phase="verify")
    expected={(row["caseId"],row["repetition"]) for row in request["expectedCases"]}
    rows=report.get("results")
    if type(rows) is not list or len(rows)!=len(expected):
        raise EvaluationError("evidence.malformed",phase="verify")
    for pair in rows:
        if type(pair) is not dict or set(pair)!={"caseId","repetition","parent","candidate"} or type(pair.get("repetition")) is not int:
            raise EvaluationError("evidence.malformed",phase="verify")
        key=(pair.get("caseId"),pair.get("repetition"))
        if key not in expected:
            raise EvaluationError("evidence.malformed",phase="verify")
        expected.remove(key)
        for side in ("parent","candidate"):
            outcome=pair.get(side)
            if type(outcome) is not dict or outcome.get("executionStatus") not in ("completed","task_failed","infrastructure_failed") or outcome.get("gradingStatus") not in ("scored","failed","missing"):
                raise EvaluationError("evidence.malformed",phase="verify")
            reward=outcome.get("reward")
            if outcome["gradingStatus"]=="scored":
                if type(reward) not in (int,float) or not math.isfinite(reward):
                    raise EvaluationError("evidence.malformed",phase="verify")
            elif reward is not None:
                raise EvaluationError("evidence.malformed",phase="verify")
    if "complete" in report:
        complete=all(outcome["executionStatus"]!="infrastructure_failed" and outcome["gradingStatus"]=="scored"
            for row in rows for outcome in (row["parent"],row["candidate"]))
        if type(report["complete"]) is not bool or report["complete"]!=complete:
            raise EvaluationError("evidence.malformed",phase="verify")


def _reconcile_artifact_index(journal: Journal,state: dict,comparison_id: str | None=None):
    """Repair only the crash window after report fsync and before index seal.

    A nonempty conflicting hash or confirmed comparison is corruption, not a
    recoverable blank value. Never reconstruct missing role associations.
    """
    index=journal.read_artifact_index()
    if index is None:
        return
    expected_hash=sha256(journal.read_body("submit",state))
    if index.get("requestId")!=state["scope"]["requestId"] or index.get("attemptId")!=state["attemptId"] or index.get("reportSha256") not in (None,"",expected_hash):
        raise EvaluationError("artifact.integrity",phase="inspect",execution_state="report_saved",next_action="review_terminal_evidence")
    if comparison_id and index.get("comparisonId") not in (None,comparison_id):
        raise EvaluationError("artifact.integrity",phase="inspect",execution_state="report_saved",next_action="review_terminal_evidence")
    index["reportSha256"]=expected_hash
    if comparison_id:
        index["comparisonId"]=comparison_id
    journal.save_artifact_index(index)


def _reports_equal(saved: dict, comparison: dict) -> bool:
    # Inventory and paired results are unique keyed sets on the wire. Their
    # order need not match the originating worker's private execution order.
    def shape(report):
        value={key:report.get(key) for key in (
            "parentVersionId","candidateVersionId","parentDigest","candidateDigest",
            "datasetRevision","graderRevision","runtime","evaluation")}
        for name in ("expectedCases","results"):
            value[name]=sorted(report[name],key=lambda row:(row["caseId"],row["repetition"]))
        return value
    return shape(saved)==shape(comparison)


def run_evaluation(*, app: EvaluationApp, config_path: str, handoff: EvaluationHandoff | dict,
                   allow_live: bool=False, cancel_event: threading.Event | None=None,
                   controls: RunControls | None=None) -> EvaluationRunResult:
    """Run or reconcile one bound request. Never replay ambiguous callbacks.

    controls adds a deadline, per-callback timeout, cost limit, case selection
    and progress callback. When trials run, the result includes "runSummary".

    A failed callback's redacted message and traceback go to ``callback-error.json`` in its
    private job directory unless the config sets ``captureCallbackErrors: false``. The
    result's ``firstCallbackFailure`` names the first one.
    """
    state=None
    run_summary=None
    callbacks_started=0
    first_failure: CallbackFailure | None = None
    phase="configure"
    request=None
    try:
        if not isinstance(app,EvaluationApp):
            raise DefinitionError("app", "Pass the value returned by define_evaluation().")
        if type(allow_live) is not bool or (app.execution=="live") != allow_live:
            raise EvaluationError("config.schema", field="allow_live", reason=(
                "This evaluation is live. Pass allow_live=True (--live on the CLI) to authorize model calls."
                if app.execution == "live" else "This evaluation is model-free. Omit allow_live (--live on the CLI)."))
        if cancel_event is not None and not isinstance(cancel_event,threading.Event):
            raise EvaluationError("config.schema", field="cancel_event", reason="Pass a threading.Event.")
        controls=merge_controls(app._controls, validate_run_controls(controls))
        cancellation=CancellationContext(cancel_event or threading.Event())
        handoff=validate_handoff(handoff)
        config=read_evaluator_config(config_path)
        capture_errors = config.get("captureCallbackErrors", True) is not False
        secrets = (config.get("evaluatorToken", ""),)
        scope=scope_from(config,handoff)
        assert_descriptor(handoff["configuration"],app.descriptor)
        phase="preflight"
        check=preflight_evaluation(app=app,config_path=config_path,target={"handoff":handoff})
        if check["status"]!="ready":
            failed=next((x for x in reversed(check["checks"]) if x.get("code")),{})
            raise EvaluationError(failed.get("code","config.schema"),phase="preflight",next_action=check["nextAction"],path_issue=failed.get("pathIssue"))
        client=make_client(config)
        phase="claim"
        with Journal(config["journalRoot"],scope) as journal:
            request=client.get_evaluation(config["projectId"],handoff["bundleId"],handoff["requestId"])
            _assert_request(request,handoff,app)
            state=journal.read()
            if state:
                _assert_request(request,handoff,app,state["request"])
                if request.get("attemptId") and (request["attemptId"]!=state["attemptId"] or request.get("evaluatorPrincipal")!=config["evaluatorPrincipalId"]):
                    raise EvaluationError("evidence.identity_mismatch",phase="claim")
                if state.get("comparisonId") and request.get("comparisonId") and state["comparisonId"]!=request["comparisonId"]:
                    raise EvaluationError("evidence.identity_mismatch",phase="claim")

            def terminal(current, reused_evidence):
                # An abandoned attempt is settled like an interruption: nothing more is reported.
                if current["status"] in ("interrupted","abandoned"):
                    return {"schemaVersion":1,"evaluation":current,"comparison":None,"executionState":"interrupted","callbacksStarted":callbacks_started,"reusedEvidence":False}
                if current["status"] not in ("completed","failed"):
                    return None
                if current.get("evaluatorPrincipal")!=config["evaluatorPrincipalId"] or not guided_uuid(current.get("attemptId")) or not guided_uuid(current.get("comparisonId")):
                    raise EvaluationError("evidence.identity_mismatch",phase="inspect")
                comparison=client.get_comparison(config["projectId"],handoff["bundleId"],current["comparisonId"])
                _assert_report(comparison,current,current["attemptId"])
                if comparison.get("id")!=current["comparisonId"] or comparison.get("submitter")!=current["evaluatorPrincipal"]:
                    raise EvaluationError("evidence.identity_mismatch",phase="inspect")
                if state and state.get("report") is not None and not _reports_equal(state["report"],comparison):
                    raise EvaluationError("evidence.identity_mismatch",phase="inspect")
                if state and state.get("report") is not None:
                    _reconcile_artifact_index(journal,state,comparison["id"])
                return {"schemaVersion":1,"evaluation":current,"comparison":comparison,"executionState":"finished","callbacksStarted":callbacks_started,"reusedEvidence":reused_evidence}

            done=terminal(request, True)
            if done:
                return done
            if state is None:
                if request["status"]!="requested":
                    raise EvaluationError("journal.missing",phase="claim",next_action="restore_original_journal")
                state={"scope":scope,"request":_request_snapshot(request),"attemptId":str(uuid.uuid4()),
                    "keys":{name:str(uuid.uuid4()) for name in ("start","submit","finish")},
                    "wireBodies":{}}
                state["wireBodies"]["start"]=journal.save_body("start",json_bytes({"attemptId":state["attemptId"]}))
                journal.save(state)
            if state.get("executionStarted") and not state.get("report"):
                raise ExecutionUncertainError()
            if state.get("report"):
                body=journal.read_body("submit",state)
                if parse_json(body)!=state["report"]:
                    raise EvaluationError("journal.invalid",phase="submit")
                _assert_report(state["report"],request,state["attemptId"])
                _reconcile_artifact_index(journal,state,state.get("comparisonId"))
            phase="claim"
            if request["status"]=="requested":
                mutate(client,"start",scope,journal.read_body("start",state),state["keys"]["start"])

            def current_request():
                journal.assert_owned()
                latest=client.get_evaluation(config["projectId"],handoff["bundleId"],handoff["requestId"])
                # The read may block while ownership is lost or cancellation is
                # requested. Historical authority checks do not guard callbacks.
                journal.assert_owned()
                _assert_request(latest,handoff,app,state["request"])
                if latest["status"] in ("interrupted","abandoned"):
                    raise _Interrupted(latest)
                if latest["status"]!="running" or latest.get("attemptId")!=state["attemptId"] or latest.get("evaluatorPrincipal")!=config["evaluatorPrincipalId"]:
                    raise EvaluationError("evidence.identity_mismatch",phase="verify")
                return latest

            try:
                request=current_request()
                reused_evidence = bool(state.get("report"))
                if not reused_evidence:
                    phase="verify"
                    bundles=_bundles(client,config,handoff,request,journal.directory/"cache")
                    current_request()
                    schedule = app._collection
                    if schedule is not None:
                        atomic_private_write(journal.directory / "collection.json",
                            json_bytes({"schemaVersion": 1, **schedule}) + b"\n")
                    state["executionStarted"]=True
                    journal.save(state)
                    phase="execute"
                    index={"schemaVersion":1,"requestId":request["id"],"attemptId":state["attemptId"],
                        "reportSha256":"","entries":[]}
                    index_lock=threading.Lock()

                    def job_directory(case_id,repetition,side,version):
                        with index_lock:
                            return journal.job_directory(request["id"],state["attemptId"],case_id,repetition,side,version)

                    def write_artifact(identity,value):
                        # Concurrent arms share one index; serialize its updates.
                        with index_lock:
                            entry=journal.write_artifact(identity,value)
                            index["entries"].append(entry)
                            journal.save_artifact_index(index)
                            return entry

                    def started():
                        nonlocal callbacks_started
                        callbacks_started += 1

                    def failed(failure):
                        nonlocal first_failure
                        if first_failure is None:
                            first_failure = failure

                    results,run_summary=run_trials(app=app,request_id=request["id"],attempt_id=state["attemptId"],
                        bundles=bundles,cancellation=cancellation,controls=controls,on_callback_started=started,
                        on_callback_failure=failed,
                        hooks=TrialHooks(checkpoint=current_request,assert_owned=journal.assert_owned,
                            job_directory=job_directory,write_artifact=write_artifact,
                            record_diagnostic=lambda directory,phase,error: _record_diagnostic(
                                journal,directory,phase,error,capture_errors,secrets)))
                    report={**state["request"],"evaluation":{"requestId":request["id"],"attemptId":state["attemptId"]},"results":results}
                    body=json_bytes(report)
                    if len(body)>2*MIB:
                        raise ExecutionUncertainError()
                    _assert_report(report,request,state["attemptId"])
                    current_request()
                    state["wireBodies"]["submit"]=journal.save_body("submit",body)
                    state["report"]=report
                    journal.save(state)
                    index["reportSha256"]=sha256(body)
                    journal.save_artifact_index(index)
                phase="submit"
                current_request()
                if not state.get("comparisonId"):
                    comparison=mutate(client,"submit",scope,journal.read_body("submit",state),state["keys"]["submit"])
                    _assert_report(comparison,request,state["attemptId"])
                    if not guided_uuid(comparison.get("id")) or comparison.get("submitter")!=config["evaluatorPrincipalId"]:
                        raise EvaluationError("evidence.identity_mismatch",phase="submit")
                    state["comparisonId"]=comparison["id"]
                    journal.save(state)
                _reconcile_artifact_index(journal,state,state["comparisonId"])
                phase="finish"
                current_request()
                if not state["wireBodies"].get("finish"):
                    state["wireBodies"]["finish"]=journal.save_body("finish",json_bytes({"attemptId":state["attemptId"],"comparisonId":state["comparisonId"]}))
                    journal.save(state)
                mutate(client,"finish",scope,journal.read_body("finish",state),state["keys"]["finish"])
                request=client.get_evaluation(config["projectId"],handoff["bundleId"],handoff["requestId"])
                _assert_request(request,handoff,app,state["request"])
                done=terminal(request, reused_evidence)
                if not done:
                    raise EvaluationError("submission.unconfirmed",phase="finish",execution_state="report_saved",next_action="retry_same_command")
                state["completed"]=True
                journal.save(state)
                if first_failure is not None:
                    done["firstCallbackFailure"] = first_failure
                if run_summary is not None:
                    done["runSummary"] = run_summary
                return done
            except _Interrupted as interrupted:
                return {"schemaVersion":1,"evaluation":interrupted.request,"comparison":None,"executionState":"interrupted","callbacksStarted":callbacks_started,"reusedEvidence":False}
    except EvaluationError:
        raise
    except Exception as error:
        certainty="report_saved" if state and state.get("report") else "may_have_started" if state and state.get("executionStarted") else "not_started"
        safe=safe_error(error,phase=phase,execution_state=certainty)
        if certainty=="report_saved" and safe.code in ("service.unavailable","internal.error"):
            safe=EvaluationError("submission.unconfirmed",phase=phase,execution_state=certainty,next_action="retry_same_command")
        raise safe from None


__all__=["Case","EvaluationCase","EvaluationApp","CollectionContext","ExecutionContext","ExecuteInput","GradeInput",
    "ExecutionResult","GradeResult","EvaluationError","ExecutionUncertainError","CallbackCancelled",
    "TaskExecutionError","CancellationContext","define_evaluation","capture_cases","preflight_evaluation","run_evaluation",
    "DefinitionError","OutputValidationError","Execution","ExecutionStatus","EvaluationRunResult",
    "PreflightResult","PreflightCheck","CallbackFailure","redact_diagnostic_text",
    "EvaluationUsageError","ERROR_CODES","EXIT_CODES","SafeCode","exit_code_for",
    "RunControls","bind_run_controls"]


def __getattr__(name):
    # Lazy: the async helper imports this module.
    if name == "run_evaluation_async":
        from .evaluation_async import run_evaluation_async
        return run_evaluation_async
    raise AttributeError(name)
