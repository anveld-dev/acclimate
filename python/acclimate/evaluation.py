"""Installed, application-owned paired evaluation with conservative durable recovery."""
from __future__ import annotations

from concurrent.futures import Future as ConcurrentFuture
import copy
from dataclasses import dataclass
from datetime import datetime, timezone
import inspect
import math
import os
from pathlib import Path
import shutil
import threading
from typing import Any, Callable, Generic, TypeVar
import uuid

from .delivery import resolve_and_cache
from .types import VerifiedBundle
from ._evaluation_shared import (
    MIB, DIGEST_RE, EvaluationError, ExecutionUncertainError, CallbackCancelled,
    TaskExecutionError, _text, assert_descriptor, clone_json, descriptor_from,
    ensure_private_directory, guided_uuid, json_bytes, make_client, mutate,
    parse_json, read_evaluator_config, safe_error, scope_from, sha256,
    validate_descriptor, validate_handoff,
)
from ._evaluation_journal import Journal

I = TypeVar("I")
E = TypeVar("E")
O = TypeVar("O")
_APP_TOKEN=object()


@dataclass(frozen=True)
class Case(Generic[I,E]):
    case_id: str
    input: I
    expected: E
    repetitions: int = 1


EvaluationCase = Case


@dataclass(frozen=True)
class CancellationContext:
    _event: threading.Event

    def is_cancelled(self) -> bool:
        return self._event.is_set()

    def raise_if_cancelled(self) -> None:
        if self.is_cancelled():
            raise CallbackCancelled()


@dataclass(frozen=True)
class ExecutionContext:
    request_id: str
    attempt_id: str
    side: str
    job_id: str
    private_job_directory: str


@dataclass(frozen=True)
class ExecuteInput(Generic[I]):
    bundle: VerifiedBundle
    input: I
    case_id: str
    repetition: int
    cancellation: CancellationContext
    context: ExecutionContext


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
    execution_status: str = "completed"
    error: str | None = None
    output_ref: str | None = None
    usage: dict | None = None


@dataclass(frozen=True)
class GradeResult:
    reward: float
    error: str | None = None
    explanation: Any = None


class EvaluationApp(Generic[I,E,O]):
    def __init__(self, descriptor: dict, cases: tuple[Case, ...], execute: Callable,
                 grade: Callable, execution: str, *, _token=None):
        if _token is not _APP_TOKEN:
            raise EvaluationError("config.schema")
        self._descriptor = clone_json(descriptor)
        self._cases, self._execute, self._grade = cases,execute,grade
        self._execution = execution

    @property
    def descriptor(self) -> dict:
        return copy.deepcopy(self._descriptor)

    @property
    def execution(self) -> str:
        return self._execution


def _async_function(callback: Callable) -> bool:
    return inspect.iscoroutinefunction(callback) or inspect.iscoroutinefunction(getattr(callback,"__call__",None))


def define_evaluation(*, config_id: str, config_revision: str, dataset_revision: str,
                      grader_revision: str, runtime: dict[str,str], execution: str,
                      cases: list[Case[I,E]] | tuple[Case[I,E],...],
                      execute: Callable[[ExecuteInput[I]],ExecutionResult[O]],
                      grade: Callable[[GradeInput[E,O]],GradeResult]) -> EvaluationApp[I,E,O]:
    if not callable(execute) or not callable(grade) or _async_function(execute) or _async_function(grade):
        raise EvaluationError("config.schema")
    if execution not in ("model-free","live") or type(runtime) is not dict or type(cases) not in (list,tuple):
        raise EvaluationError("config.schema")
    reserved={"configId","configRevision","execution","concurrency","gradeRetries"}
    if reserved.intersection(runtime):
        raise EvaluationError("config.schema")
    captured=[]
    inventory=[]
    seen=set()
    for case in cases:
        if not isinstance(case,Case) or type(case.case_id) is not str or not case.case_id.strip() or case.case_id in seen or type(case.repetitions) is not int or not 1<=case.repetitions<=1000:
            raise EvaluationError("config.schema")
        seen.add(case.case_id)
        captured.append(Case(case.case_id,clone_json(case.input),clone_json(case.expected),case.repetitions))
        inventory.extend({"caseId":case.case_id,"repetition":r} for r in range(case.repetitions))
        if len(inventory)>1000:
            raise EvaluationError("config.schema")
    descriptor=validate_descriptor({"datasetRevision":dataset_revision,"graderRevision":grader_revision,
        "runtime":{**runtime,"configId":config_id,"configRevision":config_revision,"execution":execution,
            "concurrency":"1","gradeRetries":"0"},"expectedCases":inventory})
    if len(json_bytes([{"input":case.input,"expected":case.expected} for case in captured]))>16*MIB:
        raise EvaluationError("config.schema")
    # Bound the actual report envelope, including escaped refs, before paid work.
    worst={"executionStatus":"infrastructure_failed","gradingStatus":"missing","reward":-1.7976931348623157e308,
        "outputRef":"\\"*1024,"error":"x"*128,
        "usage":{"inputTokens":1.7976931348623157e308,"outputTokens":1.7976931348623157e308,"costUsd":1.7976931348623157e308}}
    budget={**descriptor,"parentVersionId":"0"*36,"candidateVersionId":"0"*36,
        "parentDigest":"sha256:"+"0"*64,"candidateDigest":"sha256:"+"0"*64,
        "evaluation":{"requestId":"0"*36,"attemptId":"0"*36},
        "results":[{**key,"parent":worst,"candidate":worst} for key in inventory]}
    if len(json_bytes(budget))>2*MIB:
        raise EvaluationError("definition.report_budget_exceeded",phase="preflight")
    return EvaluationApp(descriptor,tuple(captured),execute,grade,execution,_token=_APP_TOKEN)


def _request_snapshot(request: dict) -> dict:
    return {**descriptor_from(request),**{key:request[key] for key in
        ("parentVersionId","candidateVersionId","parentDigest","candidateDigest")}}


def _assert_request(request: dict, handoff: dict, app: EvaluationApp, frozen: dict | None=None):
    if request.get("id")!=handoff["requestId"] or request.get("status") not in ("requested","running","completed","failed","interrupted"):
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
        raise safe_error(error,phase="preflight") from None
    if type(caps.get("schemaVersion")) is not int or caps.get("schemaVersion")!=1 or caps.get("retainedEvaluationOperations") is not True:
        raise EvaluationError("capabilities.unsupported",phase="preflight",next_action="upgrade_service")
    if caps.get("projectId")!=config["projectId"] or caps.get("principalId")!=config["evaluatorPrincipalId"]:
        raise EvaluationError("auth.principal_mismatch",phase="preflight",next_action="ask_operator")
    if caps.get("readUnpublished") is not True or caps.get("writeEvaluation") is not True:
        raise EvaluationError("auth.denied",phase="preflight",next_action="ask_operator")
    return caps


def preflight_evaluation(*, app: EvaluationApp, config_path: str,
                         target: dict | None=None, handoff: dict | None=None) -> dict:
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
            raise EvaluationError("config.schema")
        selected=validate_handoff(target["handoff"]) if "handoff" in target else None
        if selected:
            scope_from(config,selected)
        elif not guided_uuid(target.get("bundleId")):
            raise EvaluationError("guided_target_unsupported")
        current_check="journalStorage"
        root=ensure_private_directory(config["journalRoot"])
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
        current_check="descriptor"
        if selected is None and target.get("requestId"):
            selected={"schemaVersion":1,"serviceUrl":config["serviceUrl"],"projectId":config["projectId"],
                "bundleId":target["bundleId"],"requestId":target["requestId"],"configuration":app.descriptor}
            selected=validate_handoff(selected)
        if selected:
            request=client.get_evaluation(config["projectId"],selected["bundleId"],selected["requestId"])
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
        safe=safe_error(error)
        if safe.code in ("auth.denied","auth.principal_mismatch"):
            authorization="denied"
        checks.append({"check":current_check,"status":"unverified" if safe.code=="capabilities.unsupported" else "failed","code":safe.code})
        return {"schemaVersion":1,"status":"blocked","authorization":authorization,
            "checkedAt":datetime.now(timezone.utc).isoformat(),"checks":checks,"nextAction":safe.next_action}
    finally:
        if probe is not None:
            shutil.rmtree(probe)


def _async_value(value: Any,seen: set[int] | None=None) -> bool:
    if inspect.isawaitable(value) or isinstance(value,ConcurrentFuture):
        return True
    if isinstance(value,(ExecutionResult,GradeResult)):
        value=vars(value)
    # Invalid JSON containers may still own active work. Inspect their contents
    # before ordinary JSON validation, including mapping keys and subclasses.
    if not isinstance(value,(list,dict,tuple,set,frozenset)):
        return False
    seen=set() if seen is None else seen
    if id(value) in seen:
        return False
    seen.add(id(value))
    children = (*value.keys(), *value.values()) if isinstance(value,dict) else value
    return any(_async_value(v,seen) for v in children)


def _usage(value: Any):
    if value is None:
        return None
    if type(value) is not dict or set(value)-{"inputTokens","outputTokens","costUsd"}:
        return None
    if any(type(v) not in (int,float) or not math.isfinite(v) or v<0 for v in value.values()):
        return None
    return copy.deepcopy(value)


def _empty(error: str="cancelled",execution_status="infrastructure_failed") -> dict:
    return {"executionStatus":execution_status,"gradingStatus":"missing","reward":None,
        "outputRef":None,"error":error,"usage":None}


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


def run_evaluation(*, app: EvaluationApp, config_path: str, handoff: dict,
                   allow_live: bool=False, cancel_event: threading.Event | None=None) -> dict:
    """Run or reconcile one bound request. Never replay ambiguous callbacks."""
    state=None
    phase="configure"
    request=None
    try:
        if not isinstance(app,EvaluationApp) or type(allow_live) is not bool or (app.execution=="live") != allow_live:
            raise EvaluationError("config.schema")
        if cancel_event is not None and not isinstance(cancel_event,threading.Event):
            raise EvaluationError("config.schema")
        cancellation=CancellationContext(cancel_event or threading.Event())
        handoff=validate_handoff(handoff)
        config=read_evaluator_config(config_path)
        scope=scope_from(config,handoff)
        assert_descriptor(handoff["configuration"],app.descriptor)
        phase="preflight"
        check=preflight_evaluation(app=app,config_path=config_path,target={"handoff":handoff})
        if check["status"]!="ready":
            failed=next((x for x in reversed(check["checks"]) if x.get("code")),{})
            raise EvaluationError(failed.get("code","config.schema"),phase="preflight",next_action=check["nextAction"])
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

            def terminal(current):
                if current["status"]=="interrupted":
                    return {"schemaVersion":1,"evaluation":current,"comparison":None,"executionState":"interrupted"}
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
                return {"schemaVersion":1,"evaluation":current,"comparison":comparison,"executionState":"finished"}

            done=terminal(request)
            if done:
                return done
            if state is None:
                if request["status"]!="requested":
                    raise EvaluationError("journal.missing",phase="claim",next_action="restore_original_journal")
                state={"scope":scope,"request":_request_snapshot(request),"attemptId":str(uuid.uuid4()),
                    "keys":{name:str(uuid.uuid4()) for name in ("start","submit","finish")},
                    "retainedOperations":True,"wireBodies":{}}
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
                if latest["status"]=="interrupted":
                    raise _Interrupted(latest)
                if latest["status"]!="running" or latest.get("attemptId")!=state["attemptId"] or latest.get("evaluatorPrincipal")!=config["evaluatorPrincipalId"]:
                    raise EvaluationError("evidence.identity_mismatch",phase="verify")
                return latest

            try:
                request=current_request()
                if not state.get("report"):
                    phase="verify"
                    bundles=_bundles(client,config,handoff,request,journal.directory/"cache")
                    current_request()
                    state["executionStarted"]=True
                    journal.save(state)
                    phase="execute"
                    index={"schemaVersion":1,"requestId":request["id"],"attemptId":state["attemptId"],
                        "reportSha256":"","entries":[]}
                    results=[]
                    for case in app._cases:
                        for repetition in range(case.repetitions):
                            pair={"caseId":case.case_id,"repetition":repetition}
                            for side in ("parent","candidate"):
                                if cancellation.is_cancelled():
                                    pair[side]=_empty()
                                    continue
                                current_request()
                                version=bundles[side]["version"]
                                job_id,job_dir=journal.job_directory(request["id"],state["attemptId"],case.case_id,repetition,side,version)
                                context=ExecutionContext(request["id"],state["attemptId"],side,job_id,str(job_dir))
                                identity={"caseId":case.case_id,"repetition":repetition,"side":side,
                                    "versionId":version["id"],"digest":version["digest"]}
                                execute_input=ExecuteInput(clone_json(bundles[side]),clone_json(case.input),case.case_id,repetition,cancellation,context)
                                journal.assert_owned()
                                if cancellation.is_cancelled():
                                    pair[side]=_empty()
                                    continue
                                try:
                                    execution=app._execute(execute_input)
                                    if _async_value(execution) or (isinstance(execution,ExecutionResult) and _async_value(execution.output)):
                                        if inspect.iscoroutine(execution):
                                            execution.close()
                                        raise ExecutionUncertainError()
                                    if not isinstance(execution,ExecutionResult) or execution.execution_status not in ("completed","task_failed"):
                                        raise ValueError()
                                    output=clone_json(execution.output)
                                    entry=journal.write_artifact({**identity,"role":"output"},output)
                                    index["entries"].append(entry)
                                    journal.save_artifact_index(index)
                                    ref=execution.output_ref
                                    if ref is None:
                                        ref=(journal.directory/entry["file"]).as_uri()
                                    if not _text(ref,1024):
                                        raise ValueError()
                                    outcome={"executionStatus":execution.execution_status,"gradingStatus":"missing","reward":None,
                                        "outputRef":ref,"error":"task_failed" if execution.execution_status=="task_failed" else None,"usage":_usage(execution.usage)}
                                except ExecutionUncertainError:
                                    raise
                                except CallbackCancelled:
                                    cancellation._event.set()
                                    pair[side]=_empty()
                                    continue
                                except TaskExecutionError:
                                    pair[side]=_empty("task_failed","task_failed")
                                    continue
                                except Exception:
                                    pair[side]=_empty("execution_failed")
                                    continue
                                if cancellation.is_cancelled():
                                    outcome["error"]="cancelled"
                                    pair[side]=outcome
                                    continue
                                current_request()
                                grade_input=GradeInput(clone_json(output),clone_json(case.expected),case.case_id,repetition,cancellation)
                                journal.assert_owned()
                                if cancellation.is_cancelled():
                                    outcome["error"]="cancelled"
                                    pair[side]=outcome
                                    continue
                                try:
                                    grade=app._grade(grade_input)
                                    if _async_value(grade) or (isinstance(grade,GradeResult) and _async_value(grade.explanation)):
                                        if inspect.iscoroutine(grade):
                                            grade.close()
                                        raise ExecutionUncertainError()
                                    if not isinstance(grade,GradeResult) or type(grade.reward) not in (int,float) or not math.isfinite(grade.reward):
                                        raise ValueError()
                                    if grade.explanation is not None:
                                        explanation=journal.write_artifact({**identity,"role":"grader-explanation"},clone_json(grade.explanation))
                                        index["entries"].append(explanation)
                                        journal.save_artifact_index(index)
                                    outcome.update(gradingStatus="scored",reward=float(grade.reward))
                                    if grade.error is not None:
                                        outcome["error"]="grading_reported_error"
                                except ExecutionUncertainError:
                                    raise
                                except CallbackCancelled:
                                    cancellation._event.set()
                                    outcome.update(gradingStatus="missing",error="cancelled")
                                except Exception:
                                    outcome.update(gradingStatus="failed",error="grading_failed")
                                pair[side]=outcome
                            results.append(pair)
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
                done=terminal(request)
                if not done:
                    raise EvaluationError("submission.unconfirmed",phase="finish",execution_state="report_saved",next_action="retry_same_command")
                state["completed"]=True
                journal.save(state)
                return done
            except _Interrupted as interrupted:
                return {"schemaVersion":1,"evaluation":interrupted.request,"comparison":None,"executionState":"interrupted"}
    except EvaluationError:
        raise
    except Exception as error:
        certainty="report_saved" if state and state.get("report") else "may_have_started" if state and state.get("executionStarted") else "not_started"
        safe=safe_error(error,phase=phase,execution_state=certainty)
        if certainty=="report_saved" and safe.code in ("service.unavailable","internal.error"):
            safe=EvaluationError("submission.unconfirmed",phase=phase,execution_state=certainty,next_action="retry_same_command")
        raise safe from None


__all__=["Case","EvaluationCase","EvaluationApp","ExecutionContext","ExecuteInput","GradeInput",
    "ExecutionResult","GradeResult","EvaluationError","ExecutionUncertainError","CallbackCancelled",
    "TaskExecutionError","CancellationContext","define_evaluation","preflight_evaluation","run_evaluation"]
