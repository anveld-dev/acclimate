"""The paired trial loop shared by the service runner and local comparisons."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import inspect
import math
import threading
import time
from typing import Any, Callable

from ._evaluation_controls import CONTROL_ERRORS, RunControls, selected_case_ids, validate_run_controls
from ._evaluation_shared import (
    MIB, CallbackCancelled, ExecutionUncertainError, OutputValidationError, TaskExecutionError, _text,
    atomic_private_write, clone_json, json_bytes,
)


@dataclass
class TrialHooks:
    """Storage and lifecycle seams. The service runner binds them to its journal."""
    # Runs before each execute and each grade. The service runner re-reads the request.
    checkpoint: Callable[[], Any]
    assert_owned: Callable[[], Any]
    # (case_id, repetition, side, version) -> (job_id, job_directory); writes binding.json.
    job_directory: Callable[..., tuple]
    # (identity with role, value) -> entry with at least "sha256".
    write_artifact: Callable[[dict, Any], dict]
    # (job_directory, phase, error) -> diagnostic file path or None. Records private diagnostics.
    record_diagnostic: Callable[[Any, str, BaseException], Any]


class _Abandoned(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def empty_outcome(error: str = "cancelled", execution_status: str = "infrastructure_failed") -> dict:
    return {"executionStatus": execution_status, "gradingStatus": "missing", "reward": None,
            "outputRef": None, "error": error, "usage": None}


_USAGE_KEYS = {"inputTokens": "inputTokens", "outputTokens": "outputTokens", "costUsd": "costUsd",
               "input_tokens": "inputTokens", "output_tokens": "outputTokens", "cost_usd": "costUsd"}


def reported_usage(value: Any):
    """Validate usage. Unknown keys and invalid numbers raise instead of being silently dropped."""
    if value is None:
        return None
    if type(value) is not dict:
        raise OutputValidationError("usage", "Return usage as a dict with inputTokens, outputTokens and costUsd.")
    result: dict = {}
    for key, number in value.items():
        name = _USAGE_KEYS.get(key) if type(key) is str else None
        if name is None:
            raise OutputValidationError("usage." + str(key)[:64],
                                        "Unknown usage key. Use inputTokens, outputTokens and costUsd.")
        if name in result:
            raise OutputValidationError("usage." + key, "Supply each usage value once.")
        if type(number) not in (int, float) or not math.isfinite(number) or number < 0:
            raise OutputValidationError("usage." + key, "Use a finite, nonnegative number.")
        result[name] = number
    return result


def _role_value(value, field):
    result = clone_json(value, field=field)
    if len(json_bytes(result)) > MIB:
        raise OutputValidationError(field, "Return at most 1 MiB of JSON. Store larger evidence privately and return a digest.")
    return result


def _async_value(value: Any, seen: set[int] | None = None) -> bool:
    from concurrent.futures import Future as ConcurrentFuture
    from .evaluation import ExecutionResult, GradeResult
    if inspect.isawaitable(value) or isinstance(value, ConcurrentFuture):
        return True
    if isinstance(value, (ExecutionResult, GradeResult)):
        value = vars(value)
    # Invalid JSON containers may still own active work. Inspect their contents
    # before ordinary JSON validation, including mapping keys and subclasses.
    if not isinstance(value, (list, dict, tuple, set, frozenset)):
        return False
    seen = set() if seen is None else seen
    if id(value) in seen:
        return False
    seen.add(id(value))
    children = (*value.keys(), *value.values()) if isinstance(value, dict) else value
    return any(_async_value(v, seen) for v in children)


def output_digest(value: Any) -> str:
    from .evaluation_manifest import canonical_evaluation_json
    return hashlib.sha256(canonical_evaluation_json(value).encode("utf-8")).hexdigest()


def run_trials(*, app, request_id: str, attempt_id: str, bundles: dict, cancellation, hooks: TrialHooks,
               controls: RunControls | None = None, on_callback_started: Callable[[], Any] | None = None,
               on_callback_failure: Callable[[dict], Any] | None = None) -> tuple[list, dict]:
    """Execute and grade every expected pair in the schedule's arm order.

    Results keep inventory order regardless of concurrency. Exceptions from
    checkpoints and ExecutionUncertainError stop the whole run.
    on_callback_failure receives the first failed callback, in completion order.
    """
    from .evaluation import CancellationContext, CollectionContext, ExecuteInput, ExecutionContext, ExecutionResult, GradeInput, GradeResult

    controls = validate_run_controls(controls)
    concurrency, grade_retries = _declared(app.descriptor["runtime"])
    schedule = app._collection
    order_by_key = {}
    if schedule is not None:
        for index, pair in enumerate(schedule["pairs"]):
            order_by_key[(pair["caseId"], pair["repetition"])] = (index, pair["firstSide"])
    case_ids = [case.case_id for case in app._cases]
    selected = selected_case_ids(controls.selection, case_ids)
    plan = [(case, repetition) for case in app._cases for repetition in range(case.repetitions)]
    selected_pairs = sum(1 for case, _ in plan if case.case_id in selected)
    total_arms = selected_pairs * 2

    lock = threading.Lock()
    deadline_event, fatal_event = threading.Event(), threading.Event()
    state = {"stopReason": "completed", "costUsd": None, "armsDone": 0, "timedOut": 0, "retriesUsed": 0,
             "pairsStarted": 0, "compared": 0, "identical": 0}
    started_at = time.monotonic()
    digests: dict = {}
    bounded_calls = bool(controls.case_timeout_ms or controls.deadline_ms)

    def halted():
        return cancellation.is_cancelled() or fatal_event.is_set()

    def halt_code():
        return CONTROL_ERRORS["deadline"] if deadline_event.is_set() and not cancellation.is_cancelled() else "cancelled"

    def report(case_id, repetition, side, outcome):
        with lock:
            state["armsDone"] += 1
            done = min(state["armsDone"], total_arms)
        if controls.progress is None:
            return
        try:
            controls.progress({"completed": done, "total": total_arms, "caseId": case_id, "repetition": repetition,
                               "side": side, "outcome": dict(outcome),
                               "elapsedMs": int((time.monotonic() - started_at) * 1000)})
        except Exception:
            pass  # Progress is advisory; a failing observer never changes outcomes.

    def bounded(call, arm_event):
        """Run a callback, abandoning it at the case timeout or run deadline."""
        if not bounded_calls:
            return call()
        box: dict = {}
        done = threading.Event()

        def target():
            try:
                box["value"] = call()
            except BaseException as error:  # relayed to the waiting thread
                box["error"] = error
            finally:
                done.set()

        threading.Thread(target=target, name="acclimate-callback", daemon=True).start()
        limit = time.monotonic() + controls.case_timeout_ms / 1000 if controls.case_timeout_ms else None
        while not done.wait(0.02):
            if deadline_event.is_set():
                arm_event.set()
                raise _Abandoned("deadline")
            if limit is not None and time.monotonic() >= limit:
                arm_event.set()
                raise _Abandoned("timeout")
        if "error" in box:
            raise box["error"]
        return box["value"]

    first_failure: list = []

    def note_failure(case, repetition, side, stage, reason, path):
        with lock:
            if first_failure:
                return
            failure = {"caseId": case.case_id, "repetition": repetition, "side": side,
                       "stage": stage, "reason": reason}
            if path:
                failure["diagnosticFile"] = path
            first_failure.append(failure)
        if on_callback_failure is not None:
            on_callback_failure(failure)

    def run_arm(case, repetition, side, pair_index, arm_index, first):
        if halted() or deadline_event.is_set():
            return empty_outcome(halt_code())
        hooks.checkpoint()
        version = bundles[side]["version"]
        job_id, job_dir = hooks.job_directory(case.case_id, repetition, side, version)
        collection_context = None
        if schedule is not None:
            collection_context = CollectionContext(schedule["protocol"], schedule["digest"], pair_index, arm_index, first)
            atomic_private_write(job_dir / "collection-binding.json", json_bytes({
                "schemaVersion": 1, "jobId": job_id, "caseId": case.case_id,
                "repetition": repetition, "side": side, "protocol": schedule["protocol"],
                "scheduleDigest": schedule["digest"], "pairIndex": pair_index,
                "armIndex": arm_index, "firstSide": first,
            }) + b"\n")
        arm_event = threading.Event()
        arm_cancellation = (CancellationContext(cancellation._event, (*cancellation._extra, deadline_event, arm_event))
                            if bounded_calls else cancellation)
        context = ExecutionContext(request_id, attempt_id, side, job_id, str(job_dir), collection_context)
        identity = {"caseId": case.case_id, "repetition": repetition, "side": side,
                    "versionId": version["id"], "digest": version["digest"]}
        execute_input = ExecuteInput(clone_json(bundles[side]), clone_json(case.input), case.case_id, repetition, arm_cancellation, context)
        hooks.assert_owned()
        if halted() or deadline_event.is_set():
            return empty_outcome(halt_code())
        try:
            if on_callback_started:
                on_callback_started()
            execution = bounded(lambda: app._execute(execute_input), arm_event)
            if _async_value(execution) or (isinstance(execution, ExecutionResult) and _async_value(execution.output)):
                if inspect.iscoroutine(execution):
                    execution.close()
                raise ExecutionUncertainError()
            if not isinstance(execution, ExecutionResult):
                raise OutputValidationError("output", "Return ExecutionResult(output=...) from execute.")
            if execution.execution_status not in ("completed", "task_failed"):
                raise OutputValidationError("execution_status", 'Use "completed" or "task_failed".')
            output = _role_value(execution.output, "output")
            entry = hooks.write_artifact({**identity, "role": "output"}, output)
            ref = execution.output_ref
            if ref is None:
                ref = "acclimate:artifact:" + entry["sha256"]
            if not _text(ref, 1024):
                raise ValueError()
            outcome = {"executionStatus": execution.execution_status, "gradingStatus": "missing", "reward": None,
                       "outputRef": ref, "error": "task_failed" if execution.execution_status == "task_failed" else None,
                       "usage": reported_usage(execution.usage)}
        except ExecutionUncertainError:
            raise
        except _Abandoned as abandoned:
            if abandoned.reason == "timeout":
                with lock:
                    state["timedOut"] += 1
            return empty_outcome(CONTROL_ERRORS["timeout" if abandoned.reason == "timeout" else "deadline"])
        except CallbackCancelled:
            cancellation._event.set()
            return empty_outcome()
        except TaskExecutionError as error:
            note_failure(case, repetition, side, "execute", "task_failed",
                         hooks.record_diagnostic(job_dir, "execute", error))
            return empty_outcome("task_failed", "task_failed")
        except Exception as error:
            reason = "output_invalid" if isinstance(error, OutputValidationError) else "execution_failed"
            note_failure(case, repetition, side, "execute", reason, hooks.record_diagnostic(job_dir, "execute", error))
            return empty_outcome(reason)
        usage = outcome["usage"] or {}
        with lock:
            if type(usage.get("costUsd")) in (int, float):
                state["costUsd"] = (state["costUsd"] or 0) + usage["costUsd"]
            digests[(case.case_id, repetition, side)] = output_digest(output)
        if halted() or deadline_event.is_set():
            outcome["error"] = halt_code()
            return outcome
        hooks.checkpoint()
        grade_input = GradeInput(clone_json(output), clone_json(case.expected), case.case_id, repetition, arm_cancellation)
        hooks.assert_owned()
        if halted() or deadline_event.is_set():
            outcome["error"] = halt_code()
            return outcome
        for attempt in range(grade_retries + 1):
            if attempt:
                if halted() or deadline_event.is_set():
                    break
                with lock:
                    state["retriesUsed"] += 1
                if bounded_calls:
                    arm_event = threading.Event()
                    arm_cancellation = CancellationContext(cancellation._event, (*cancellation._extra, deadline_event, arm_event))
                    grade_input = GradeInput(clone_json(output), clone_json(case.expected), case.case_id, repetition, arm_cancellation)
            try:
                grade = bounded(lambda: app._grade(grade_input), arm_event)
                if _async_value(grade) or (isinstance(grade, GradeResult) and _async_value(grade.explanation)):
                    if inspect.iscoroutine(grade):
                        grade.close()
                    raise ExecutionUncertainError()
                if not isinstance(grade, GradeResult) or type(grade.reward) not in (int, float) or not math.isfinite(grade.reward):
                    raise OutputValidationError("grade.reward", "Return GradeResult with a finite numeric reward.")
                if grade.explanation is not None:
                    hooks.write_artifact({**identity, "role": "grader-explanation"}, _role_value(grade.explanation, "grade.explanation"))
                result = {**outcome, "gradingStatus": "scored", "reward": float(grade.reward)}
                if grade.error is not None:
                    result["error"] = "grading_reported_error"
                return result
            except ExecutionUncertainError:
                raise
            except _Abandoned as abandoned:
                if abandoned.reason == "timeout":
                    with lock:
                        state["timedOut"] += 1
                outcome = {**outcome, "gradingStatus": "failed",
                           "error": CONTROL_ERRORS["timeout" if abandoned.reason == "timeout" else "deadline"]}
                if abandoned.reason == "deadline":
                    break
            except CallbackCancelled:
                cancellation._event.set()
                return {**outcome, "gradingStatus": "missing", "error": "cancelled"}
            except Exception as error:
                note_failure(case, repetition, side, "grade", "grading_failed",
                             hooks.record_diagnostic(job_dir, "grade", error))
                outcome = {**outcome, "gradingStatus": "failed", "error": "grading_failed"}
        return outcome

    def run_pair(index):
        case, repetition = plan[index]
        pair = {"caseId": case.case_id, "repetition": repetition}
        if case.case_id not in selected:
            pair["parent"] = empty_outcome(CONTROL_ERRORS["notSelected"])
            pair["candidate"] = empty_outcome(CONTROL_ERRORS["notSelected"])
            return pair
        with lock:
            if halted() or deadline_event.is_set():
                stop = halt_code()
            elif controls.max_cost_usd is not None and (state["costUsd"] or 0) >= controls.max_cost_usd:
                stop = CONTROL_ERRORS["costLimit"]
                if state["stopReason"] == "completed":
                    state["stopReason"] = "cost_limit"
            else:
                stop = None
                state["pairsStarted"] += 1
        if stop:
            for side in ("parent", "candidate"):
                pair[side] = empty_outcome(stop)
                report(case.case_id, repetition, side, pair[side])
            return pair
        pair_index, first = order_by_key.get((case.case_id, repetition), (index, "parent"))
        order = ("parent", "candidate") if first == "parent" else ("candidate", "parent")
        for arm_index, side in enumerate(order):
            pair[side] = run_arm(case, repetition, side, pair_index, arm_index, first)
            report(case.case_id, repetition, side, pair[side])
        parent, candidate = digests.get((case.case_id, repetition, "parent")), digests.get((case.case_id, repetition, "candidate"))
        if parent and candidate:
            with lock:
                state["compared"] += 1
                state["identical"] += parent == candidate
        return {"caseId": pair["caseId"], "repetition": repetition, "parent": pair["parent"], "candidate": pair["candidate"]}

    results: list = [None] * len(plan)
    failures: list[BaseException] = []
    cursor = iter(range(len(plan)))

    def worker():
        while not failures:
            with lock:
                index = next(cursor, None)
            if index is None:
                return
            try:
                results[index] = run_pair(index)
            except BaseException as error:  # re-raised on the caller thread
                with lock:
                    failures.append(error)
                fatal_event.set()
                return

    timer = None
    if controls.deadline_ms:
        def expire():
            with lock:
                if state["stopReason"] == "completed":
                    state["stopReason"] = "deadline"
            deadline_event.set()
        timer = threading.Timer(controls.deadline_ms / 1000, expire)
        timer.daemon = True
        timer.start()
    try:
        workers = max(1, min(concurrency, len(plan)))
        if workers == 1:
            worker()
        else:
            threads = [threading.Thread(target=worker, name=f"acclimate-pair-{n}", daemon=True) for n in range(workers)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
    finally:
        if timer is not None:
            timer.cancel()
    if failures:
        raise failures[0]
    if state["stopReason"] == "completed" and cancellation._event.is_set():
        state["stopReason"] = "cancelled"
    not_selected = len(plan) - selected_pairs
    selection = ({**controls.selection, "selectedPairs": selected_pairs, "totalPairs": len(plan)}
                 if controls.selection else None)
    summary = {
        "schemaVersion": 1, "stopReason": state["stopReason"],
        "partial": state["stopReason"] != "completed" or not_selected > 0,
        "concurrency": concurrency, "gradeRetries": grade_retries, "selection": selection,
        "pairs": {"expected": len(plan), "selected": selected_pairs, "started": state["pairsStarted"], "notSelected": not_selected},
        "costUsd": state["costUsd"], "maxCostUsd": controls.max_cost_usd,
        "deadlineMs": controls.deadline_ms, "caseTimeoutMs": controls.case_timeout_ms,
        "timedOutCallbacks": state["timedOut"], "gradeRetriesUsed": state["retriesUsed"],
        "outputs": {"comparedPairs": state["compared"], "identicalPairs": state["identical"]},
    }
    return results, summary


def _declared(runtime: dict) -> tuple[int, int]:
    def number(value, default, minimum):
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return default
        return parsed if parsed >= minimum else default
    return number(runtime.get("concurrency", "1"), 1, 1), number(runtime.get("gradeRetries", "0"), 0, 0)
