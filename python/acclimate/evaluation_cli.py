"""Closed commands for a statically installed application evaluator.

The helper returns a process status; the application decides when to exit.
"""
from __future__ import annotations

import signal
import sys
import threading

from .evaluation import preflight_evaluation, run_evaluation
from ._evaluation_shared import (
    EvaluationError, assert_descriptor, json_bytes, make_client, mutation_path,
    read_evaluator_config, read_reader_config, safe_error, validate_handoff,
    guided_uuid, DIGEST_RE,
)
from ._evaluation_cli_intents import (
    create_request_from_intent, interrupt_from_intent, read_command_bytes,
    read_command_json,
)
from .evaluation_policy import check_comparison, parse_evaluation_policy
from .evaluation_artifacts import (
    export_review_evidence, verify_review_export, parse_artifact_selection,
)

_FLAGS = {
    "describe": set(),
    "doctor": {"config", "bundle", "handoff", "policy"},
    "request": {"config", "bundle", "channel", "payload", "intent", "out", "policy"},
    "run": {"config", "handoff", "live"},
    "check": {"config", "read-config", "handoff", "policy"},
    "status": {"config", "read-config", "handoff"},
    "interrupt": {"config", "handoff", "reason"},
    "export": {"config", "read-config", "handoff", "out", "selection"},
    "verify-export": {"manifest", "read-config", "handoff"},
}


def _parse(argv):
    if not argv or argv[0] not in _FLAGS:
        raise EvaluationError("config.schema")
    command, flags, position = argv[0], {}, 1
    while position < len(argv):
        argument = argv[position]
        if type(argument) is not str or not argument.startswith("--"):
            raise EvaluationError("config.schema")
        name = argument[2:]
        if name not in _FLAGS[command] or name in flags:
            raise EvaluationError("config.schema")
        if name == "live":
            flags[name] = True
        else:
            position += 1
            if position >= len(argv) or not argv[position] or argv[position].startswith("--"):
                raise EvaluationError("config.schema")
            flags[name] = argv[position]
        position += 1
    return command, flags


def _required(flags, name):
    value = flags.get(name)
    if type(value) is not str or not value:
        raise EvaluationError("config.schema")
    return value


def _handoff(flags):
    return validate_handoff(read_command_json(_required(flags, "handoff")))


def _connection(flags, handoff):
    if bool(flags.get("config")) == bool(flags.get("read-config")):
        raise EvaluationError("config.schema")
    config = read_reader_config(_required(flags, "read-config")) if flags.get("read-config") else read_evaluator_config(_required(flags, "config"))
    if config["serviceUrl"] != handoff["serviceUrl"] or config["projectId"] != handoff["projectId"]:
        raise EvaluationError("version.binding_mismatch", phase="inspect")
    return make_client(config), config["projectId"]


def _assert_request(request, handoff, app=None):
    if request.get("requireBoundEvidence") is not True:
        raise EvaluationError("evidence.identity_mismatch", phase="inspect")
    if any(not guided_uuid(request.get(key)) for key in ("parentVersionId", "candidateVersionId")) or any(type(request.get(key)) is not str or not DIGEST_RE.fullmatch(request[key]) for key in ("parentDigest", "candidateDigest")):
        raise EvaluationError("version.binding_mismatch", phase="inspect")
    if request.get("id") != handoff["requestId"] or request.get("status") not in ("requested", "running", "completed", "failed", "interrupted") or (request.get("attemptId") is not None and not guided_uuid(request["attemptId"])) or (request.get("comparisonId") is not None and not guided_uuid(request["comparisonId"])):
        raise EvaluationError("version.binding_mismatch", phase="inspect")
    assert_descriptor(request, handoff["configuration"])
    if app is not None:
        assert_descriptor(request, app.descriptor)


def _safe_request(request):
    return {"schemaVersion": 1, "requestId": request["id"], "status": request["status"], "comparisonId": request.get("comparisonId"), "attemptId": request.get("attemptId")}


def _readiness_status(result):
    if result["status"] == "ready":
        return 0
    if any(check.get("code", "").startswith("config.") or check.get("code") in {"guided_target_unsupported", "definition.report_budget_exceeded", "internal.error"} for check in result.get("checks", [])):
        return 1
    if result.get("authorization") == "unverified" or any(check.get("status") == "unverified" for check in result.get("checks", [])):
        return 3
    return 2


def _run(app, flags, handoff):
    cancel_event = threading.Event()
    originals = {}
    if threading.current_thread() is threading.main_thread():
        def cancel(_number, _frame):
            cancel_event.set()
        for number in (signal.SIGINT, signal.SIGTERM):
            originals[number] = signal.getsignal(number)
            signal.signal(number, cancel)
    try:
        return run_evaluation(app=app, config_path=_required(flags, "config"), handoff=handoff,
            allow_live=flags.get("live") is True, cancel_event=cancel_event)
    finally:
        for number, handler in originals.items():
            signal.signal(number, handler)


def _dispatch(app, command, flags, review):
    if command == "describe":
        return 0, app.descriptor
    if command == "verify-export":
        online = bool(flags.get("read-config") or flags.get("handoff"))
        if online and not (flags.get("read-config") and flags.get("handoff")):
            raise EvaluationError("config.schema")
        options = {"manifest_path": _required(flags, "manifest")}
        if online:
            options["online"] = {"readConfigPath": _required(flags, "read-config"), "expectedHandoff": _handoff(flags)}
        return 0, verify_review_export(**options)
    if command == "doctor":
        if bool(flags.get("bundle")) == bool(flags.get("handoff")):
            raise EvaluationError("config.schema")
        if flags.get("policy"):
            parse_evaluation_policy(read_command_bytes(_required(flags, "policy")).decode(), app.descriptor)
        target = {"handoff": _handoff(flags)} if flags.get("handoff") else {"bundleId": _required(flags, "bundle")}
        result = preflight_evaluation(app=app, config_path=_required(flags, "config"), target=target)
        return _readiness_status(result), result
    if command == "request":
        if flags.get("policy"):
            parse_evaluation_policy(read_command_bytes(_required(flags, "policy")).decode(), app.descriptor)
        config_path = _required(flags, "config")
        config = read_evaluator_config(config_path)
        bundle_id, channel = _required(flags, "bundle"), _required(flags, "channel")
        mutation_path("createDraft", {"projectId": config["projectId"], "bundleId": bundle_id, "channel": channel})
        preflight = preflight_evaluation(app=app, config_path=config_path, target={"bundleId": bundle_id})
        if preflight["status"] != "ready":
            return 1, preflight
        return 0, create_request_from_intent(app=app, config=config, bundle_id=bundle_id, channel=channel,
            payload_file=_required(flags, "payload"), intent_path=_required(flags, "intent"), output_file=_required(flags, "out"))
    handoff = _handoff(flags)
    if command == "run":
        result = _run(app, flags, handoff)
        evaluation = result["evaluation"]
        status = 0 if evaluation["status"] == "completed" else 2 if evaluation["status"] == "failed" else 3
        return status, {**_safe_request(evaluation), "executionState": result["executionState"]}
    if command == "export":
        if bool(flags.get("config")) == bool(flags.get("read-config")):
            raise EvaluationError("config.schema")
        selection = parse_artifact_selection(read_command_json(_required(flags, "selection"))) if flags.get("selection") else None
        mapper = review.get("to_review_artifact") if review else None
        result = export_review_evidence(config_path=flags.get("config"), read_config_path=flags.get("read-config"),
            handoff=handoff, output_directory=_required(flags, "out"), selection=selection, to_review_artifact=mapper)
        return 0, {key: result[key] for key in ("schemaVersion", "status", "localInspection", "selection")}
    if command == "interrupt":
        config = read_evaluator_config(_required(flags, "config"))
        if config["serviceUrl"] != handoff["serviceUrl"] or config["projectId"] != handoff["projectId"]:
            raise EvaluationError("version.binding_mismatch")
        return 0, _safe_request(interrupt_from_intent(config, handoff, _required(flags, "reason")))
    if command == "check":
        policy = parse_evaluation_policy(read_command_bytes(_required(flags, "policy")).decode(), app.descriptor)
        client, project_id = _connection(flags, handoff)
        request = client.get_evaluation(project_id, handoff["bundleId"], handoff["requestId"])
        _assert_request(request, handoff, app)
        if request.get("status") not in ("completed", "failed") or not request.get("comparisonId"):
            return 3, {"schemaVersion": 1, "verdict": "indeterminate", "code": "evidence.not_terminal", "requestId": request["id"]}
        parent = client.get_version(project_id, handoff["bundleId"], request["parentVersionId"])
        candidate = client.get_version(project_id, handoff["bundleId"], request["candidateVersionId"])
        if parent.get("id") != request["parentVersionId"] or candidate.get("id") != request["candidateVersionId"] or parent.get("bundleId") != handoff["bundleId"] or candidate.get("bundleId") != handoff["bundleId"] or parent.get("digest") != request["parentDigest"] or candidate.get("digest") != request["candidateDigest"] or candidate.get("parentVersionId") != parent["id"]:
            raise EvaluationError("version.binding_mismatch", phase="inspect")
        comparison = client.get_comparison(project_id, handoff["bundleId"], request["comparisonId"])
        verdict = check_comparison(comparison=comparison, expected_descriptor=app.descriptor,
            expected_binding={"parentVersionId": request["parentVersionId"], "candidateVersionId": request["candidateVersionId"], "parentDigest": request["parentDigest"], "candidateDigest": request["candidateDigest"], "requestId": request["id"], "attemptId": request.get("attemptId"), "comparisonId": request["comparisonId"], "submitter": request.get("evaluatorPrincipal")},
            policy=policy["policy"], policy_digest=policy["sha256"])
        return 0 if verdict["verdict"] == "pass" else 2 if verdict["verdict"] == "fail" else 3, verdict
    client, project_id = _connection(flags, handoff)
    request = client.get_evaluation(project_id, handoff["bundleId"], handoff["requestId"])
    _assert_request(request, handoff)
    return 0, _safe_request(request)


def evaluation_main(app, argv=None, *, review=None) -> int:
    """Run one command; review mapper is trusted installed code, never a path."""
    command = "invalid"
    try:
        command, flags = _parse(list(sys.argv[1:] if argv is None else argv))
        status, result = _dispatch(app, command, flags, review)
        output = json_bytes(result)
        if len(output) > 4 * 1024 * 1024:
            raise EvaluationError("transport.response_too_large")
        sys.stdout.write(output.decode() + "\n")
        return status
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        codes = {"policy.invalid", "policy.inventory_incompatible", "evidence.identity_mismatch", "evidence.malformed", "artifact.missing", "artifact.hash_mismatch", "artifact.integrity", "artifact.selection_invalid", "artifact.mapper_failed"}
        if not isinstance(error, EvaluationError) and getattr(error, "code", None) in codes:
            error = EvaluationError(error.code, phase="policy" if command == "check" or error.code.startswith("policy.") else "export")
        diagnostic = safe_error(error).diagnostic
        sys.stderr.write(json_bytes({"schemaVersion": 1, "command": command, "error": diagnostic}).decode() + "\n")
        if diagnostic["code"] in {"execution.uncertain", "submission.unconfirmed", "legacy.submission_unconfirmed", "journal.busy", "journal.foreign", "journal.missing", "journal.relocated", "journal.ownership_lost", "request.interrupted", "request.base_conflict"} or diagnostic.get("executionState") in {"may_have_started", "report_saved"}:
            return 3
        if command == "export" and diagnostic["code"] == "artifact.missing":
            return 3
        return 1
