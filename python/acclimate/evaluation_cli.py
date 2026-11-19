"""Closed commands for a statically installed application evaluator.

The helper returns a process status; the application decides when to exit.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
import signal
import sys
import threading

from .evaluation import preflight_evaluation, run_evaluation
from ._evaluation_shared import (
    _canonical_path,
    EvaluationError, assert_descriptor, json_bytes, make_client, mutation_path,
    read_evaluator_config, read_reader_config, safe_error, validate_handoff,
    guided_uuid, DIGEST_RE,
)
from ._evaluation_cli_intents import (
    create_request_from_intent, interrupt_from_intent, read_command_bytes,
    read_command_json,
)
from .evaluation_analysis import analyze_comparison
from ._evaluation_policy_receipt import record_policy_receipt
from .evaluation_policy import PolicyError, check_comparison, parse_evaluation_policy
from .evaluation_plan import plan_command, policy_readiness
from .evaluation_artifacts import (
    export_review_evidence, verify_review_export, parse_artifact_selection,
)

_FLAGS = {
    "compare": {"config", "handoff", "bundle", "channel", "payload", "name", "retry-after", "live", "policy", "json"},
    "describe": set(),
    "doctor": {"config", "bundle", "handoff", "policy", "name"},
    "request": {"config", "bundle", "channel", "payload", "intent", "out", "policy"},
    "run": {"config", "handoff", "live", "name"},
    "check": {"config", "read-config", "handoff", "policy", "name"},
    "status": {"config", "read-config", "handoff", "name"},
    "interrupt": {"config", "handoff", "reason", "name"},
    "export": {"config", "read-config", "handoff", "out", "selection", "name"},
    "verify-export": {"manifest", "read-config", "handoff"},
    "plan": {"policy", "aa", "effects", "simulations", "seed"},
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
        if name in ("live", "json"):
            flags[name] = True
        else:
            position += 1
            if position >= len(argv) or not argv[position] or argv[position].startswith("--"):
                raise EvaluationError("config.schema")
            flags[name] = argv[position]
        position += 1
    return command, flags


_COMPARE_USAGE = (
    "compare --config CONFIG --handoff HANDOFF [--live] [--policy POLICY] [--json]\n"
    "compare --config CONFIG --bundle ID --channel CHANNEL --payload FILE (--name RUN_NAME | --retry-after PRIOR_NAME) [--live] [--policy POLICY] [--json]\n"
    "Live evaluators require --live. Use one input form and supply each flag once."
)


class _CompareUsageError(EvaluationError):
    def __init__(self, hint):
        super().__init__("config.schema")
        self.hint = hint


def _validate_compare_flags(flags, live):
    if live != (flags.get("live") is True):
        raise _CompareUsageError("This evaluator requires --live." if live else "Omit --live for this evaluator.")
    creation = ("bundle", "channel", "payload", "name", "retry-after")
    if flags.get("handoff") and any(key in flags for key in creation):
        raise _CompareUsageError("--handoff cannot be combined with candidate creation flags.")
    if not flags.get("handoff") and bool(flags.get("name")) == bool(flags.get("retry-after")):
        raise _CompareUsageError("Choose --name for a run or --retry-after for a fresh attempt.")
    for key in ("config",) if flags.get("handoff") else ("config", "bundle", "channel", "payload"):
        if not flags.get(key):
            raise _CompareUsageError("Missing --" + key + ".")
    if "name" in flags and not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", flags["name"]):
        raise _CompareUsageError("--name requires 1–80 letters, digits, underscores or hyphens.")


def _comparison_text(request, comparison, scores, policy, policy_requested):
    def value(number):
        return "unknown" if number is None else str(number)

    def label(case_id):
        return re.sub(r"[\x7f-\x9f\u2028-\u202e\u2066-\u2069]", lambda m: "\\u%04x" % ord(m[0]),
                      json.dumps(case_id, ensure_ascii=False))

    summary = (scores or {}).get("summary") or {}
    counts = (scores or {}).get("counts")
    coverage = (f'{counts["comparablePairs"]}/{counts["expectedPairs"]}' + (" (partial)" if counts["missingPairs"] else "")
                if counts else f'unknown/{len(request["expectedCases"])}')
    decision = policy["verdict"] if policy else "indeterminate" if policy_requested else "not supplied"
    lines = [f'Request {request["id"]} · {request["status"]}',
             f'Equal-case means    parent {value(summary.get("parentMean"))}    candidate {value(summary.get("candidateMean"))}',
             f"Pair coverage       {coverage}", f"Policy              {decision}"]
    for check in (policy or {}).get("checks", []):
        if check["result"] != "pass":
            lines.append(f'  {check["result"]}  {check["code"]}')
    gaps = (policy or {}).get("evidenceGaps") or (scores or {}).get("evidenceGaps")
    if gaps:
        lines.append(f'Evidence gaps       showing {len(gaps["rows"])} of {gaps["total"]}')
        for gap in gaps["rows"]:
            lines.append(f'  {label(gap["caseId"])} [{gap["repetition"]}] {gap["side"]} · {gap["stage"]} · {gap["reason"]}')
    if scores and scores["cases"]:
        lines.append("Per-case means" if summary else "Means for fully scored cases")
        for row in scores["cases"]:
            lines.append(f'  {label(row["caseId"])}    parent {value(row["parentMean"])}    candidate {value(row["candidateMean"])}')
    if not summary and comparison:
        lines.append("Available scores by case and repetition")
        for row in comparison["results"]:
            values = [value(row[side]["reward"] if row[side]["gradingStatus"] == "scored" and row[side]["executionStatus"] != "infrastructure_failed" else None)
                      for side in ("parent", "candidate")]
            lines.append(f'  {label(row["caseId"])} [{row["repetition"]}]    parent {values[0]}    candidate {values[1]}')
    elif not comparison:
        lines.append("Per-case scores     unknown")
    return "\n".join(lines)


def _required(flags, name):
    value = flags.get(name)
    if type(value) is not str or not value:
        raise EvaluationError("config.schema")
    return value


def _named_handoff(journal_root, name):
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", name):
        raise EvaluationError("config.schema")
    return _canonical_path(journal_root, alias_issue="journalAlias") / "comparisons" / name / "request.json"


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


def _read_progress(client, project_id, bundle_id, request):
    unknown = {"activity": "unknown", "reason": "unavailable"}
    def timestamp(value):
        return type(value) is str and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})", value)
    try:
        view = client.get_evaluation_progress(project_id, bundle_id, request["id"])
        if (view.get("schemaVersion") != 1 or view["requestId"] != request["id"]
                or view["attemptId"] != request["attemptId"] or view["status"] != request["status"]
                or not timestamp(view["checkedAt"])):
            return unknown
        report = view["observation"]
        if report is None and view["activity"] == "absent":
            return {"activity": "unknown", "reason": "no_report", "checkedAt": view["checkedAt"]}
        if (not request["attemptId"] or report["attemptId"] != request["attemptId"]
                or view["activity"] not in ("fresh", "stale")
                or report["phase"] not in ("preparing", "executing", "grading", "submitting")
                or not timestamp(report["receivedAt"]) or type(report["completed"]) is not int
                or type(report["total"]) is not int or report["total"] != len(request["expectedCases"]) * 2
                or not 0 <= report["completed"] <= report["total"]):
            return unknown
        progress = {key: report[key] for key in ("phase", "completed", "total", "receivedAt")}
        progress.update(activity=view["activity"], checkedAt=view["checkedAt"])
        if report.get("case") is not None:
            current = {key: report["case"][key] for key in ("caseId", "repetition")}
            if type(current["repetition"]) is not int or current not in request["expectedCases"]:
                return unknown
            progress["case"] = current
        return progress
    except Exception:
        # Status remains available when an older service lacks optional progress.
        return unknown


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


def _comparison_binding(request):
    return {"parentVersionId": request["parentVersionId"], "candidateVersionId": request["candidateVersionId"], "parentDigest": request["parentDigest"], "candidateDigest": request["candidateDigest"], "requestId": request["id"], "attemptId": request.get("attemptId"), "comparisonId": request["comparisonId"], "submitter": request.get("evaluatorPrincipal")}


def _policy_exit(verdict):
    return 0 if verdict == "pass" else 2 if verdict == "fail" else 3


def _create_request(app, flags, predecessor=None):
    config_path = _required(flags, "config")
    config = read_evaluator_config(config_path)
    bundle_id, channel = _required(flags, "bundle"), _required(flags, "channel")
    mutation_path("createDraft", {"projectId": config["projectId"], "bundleId": bundle_id, "channel": channel})
    preflight = preflight_evaluation(app=app, config_path=config_path, target={"bundleId": bundle_id})
    if preflight["status"] != "ready":
        return 1, preflight
    return 0, create_request_from_intent(app=app, config=config, bundle_id=bundle_id, channel=channel,
        payload_file=_required(flags, "payload"), intent_path=_required(flags, "intent"), output_file=_required(flags, "out"), predecessor=predecessor)


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
        readiness = None
        if flags.get("policy"):
            readiness = policy_readiness(parse_evaluation_policy(
                read_command_bytes(_required(flags, "policy")).decode(), app.descriptor)["policy"], app.descriptor)
        target = {"handoff": _handoff(flags)} if flags.get("handoff") else {"bundleId": _required(flags, "bundle")}
        result = preflight_evaluation(app=app, config_path=_required(flags, "config"), target=target)
        return _readiness_status(result), ({**result, "policyReadiness": readiness} if readiness else result)
    if command == "plan":
        return plan_command(app.descriptor, flags, read_command_bytes, read_command_json, EvaluationError)
    comparing = command == "compare"
    policy = None
    if comparing:
        _validate_compare_flags(flags, app.execution == "live")
        terminal = sys.stdout.isatty() and not flags.get("json")
        if flags.get("policy"):
            policy = parse_evaluation_policy(read_command_bytes(flags["policy"]).decode(), app.descriptor)
        if not flags.get("handoff"):
            config = read_evaluator_config(_required(flags, "config"))
            predecessor = None
            if flags.get("retry-after"):
                handoff_file = _named_handoff(config["journalRoot"], flags["retry-after"])
                prior = validate_handoff(read_command_json(handoff_file))
                if prior["bundleId"] != flags["bundle"]:
                    raise EvaluationError("request.intent_mismatch")
                client, project_id = _connection(flags, prior)
                request = client.get_evaluation(project_id, prior["bundleId"], prior["requestId"])
                _assert_request(request, prior)
                if request["status"] not in ("completed", "failed") or not request.get("attemptId") or not request.get("comparisonId"):
                    raise EvaluationError("evidence.not_terminal", phase="inspect", next_action="inspect_external_app")
                predecessor = handoff_file, request
                flags["name"] = "after-" + request["id"]
            root = _named_handoff(config["journalRoot"], _required(flags, "name")).parent
            flags["handoff"] = str(root / "request.json")
            created = _create_request(app, {**flags, "intent": str(root / "intent.json"), "out": flags["handoff"]}, predecessor)
            if created[0] != 0:
                if terminal:
                    failures = "\n".join(" ".join(filter(None, (check["code"], check.get("hint")))) for check in created[1]["checks"] if check.get("code"))
                    return created[0], f'Comparison blocked before request creation.\n{failures}\nNext action: {created[1]["nextAction"]}'
                return created
    if command == "request":
        if flags.get("policy"):
            parse_evaluation_policy(read_command_bytes(_required(flags, "policy")).decode(), app.descriptor)
        return _create_request(app, flags)
    handoff = _handoff(flags)
    if command == "run" or comparing:
        result = _run(app, flags, handoff)
        evaluation = result["evaluation"]
        status = 0 if evaluation["status"] == "completed" else 2 if evaluation["status"] == "failed" else 3
        if comparing:
            scores, policy_result = None, None
            if policy:
                status = 3
            if result.get("comparison") and all(evaluation.get(key) for key in ("attemptId", "comparisonId", "evaluatorPrincipal")):
                evidence = dict(comparison=result["comparison"], expected_descriptor=app.descriptor,
                                expected_binding=_comparison_binding(evaluation))
                metrics = [{**policy["policy"]["metric"], "source": "reward", "id": "reward"}] if policy else None
                metric = analyze_comparison(**evidence, metrics=metrics)["metrics"][0]
                scores = {key: metric[key] for key in ("counts", "summary", "cases")}
                if "evidenceGaps" in metric:
                    scores["evidenceGaps"] = metric["evidenceGaps"]
                if policy:
                    policy_result = check_comparison(**evidence, policy=policy["policy"], policy_digest=policy["sha256"])
                    status = _policy_exit(policy_result["verdict"])
            receipt = record_policy_receipt(_connection(flags, handoff)[0], handoff, policy_result) if policy_result else None
            if receipt and receipt["status"] == "unconfirmed" and status == 0:
                status = 1
            run_name = flags.get("name")
            invocation = {"callbacksStarted": result["callbacksStarted"], "reusedEvidence": result["reusedEvidence"]}
            if terminal:
                summary = _comparison_text(evaluation, result.get("comparison"), scores, policy_result, bool(policy))
                activity = ("Reused saved evidence. No execution callbacks started." if result["reusedEvidence"]
                            else f'Execution callbacks started this time: {result["callbacksStarted"]}.')
                if receipt:
                    summary += ("\nPolicy receipt recorded for release review." if receipt["status"] == "recorded" else
                                "\nPolicy receipt unconfirmed. Retry check with the evaluator config.")
                return status, summary + "\n" + activity + ("\nRun handle: --name " + run_name if run_name else "")
            return status, {**_safe_request(evaluation), "invocation": invocation, **({"runName": run_name} if run_name else {}),
                            "parentVersionId": evaluation["parentVersionId"],
                            "candidateVersionId": evaluation["candidateVersionId"], "candidateDigest": evaluation["candidateDigest"],
                            "scores": scores, "policy": policy_result, **({"policyReceipt": receipt} if receipt else {})}
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
            expected_binding=_comparison_binding(request),
            policy=policy["policy"], policy_digest=policy["sha256"])
        receipt = record_policy_receipt(client, handoff, verdict) if flags.get("config") else {"status": "read_only"}
        pinned = request.get("policyDigest")
        pin = "unpinned" if not pinned else "matched" if pinned == policy["sha256"] else "mismatched"
        return (_policy_exit(verdict["verdict"]) or int(receipt["status"] == "unconfirmed"),
                {**verdict, "policyPin": pin, "policyReceipt": receipt})
    client, project_id = _connection(flags, handoff)
    request = client.get_evaluation(project_id, handoff["bundleId"], handoff["requestId"])
    _assert_request(request, handoff)
    return 0, {**_safe_request(request), "progress": _read_progress(client, project_id, handoff["bundleId"], request)}


def evaluation_main(app, argv=None, *, review=None) -> int:
    """Run one command; review mapper is trusted installed code, never a path."""
    command = "invalid"
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        command, flags = _parse(args)
        if command != "compare" and flags.get("name"):
            if flags.get("handoff") or flags.get("read-config"):
                raise EvaluationError("config.schema")
            config = read_evaluator_config(_required(flags, "config"))
            flags["handoff"] = str(_named_handoff(config["journalRoot"], flags["name"]))
        status, result = _dispatch(app, command, flags, review)
        output = result.encode("utf-8") if command == "compare" and isinstance(result, str) else json_bytes(result)
        if len(output) > 4 * 1024 * 1024:
            raise EvaluationError("transport.response_too_large")
        sys.stdout.write(output.decode() + "\n")
        return status
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        missing = error.diagnostic.get("missingFields") if isinstance(error, PolicyError) else None
        codes = {"policy.invalid", "policy.inventory_incompatible", "evidence.identity_mismatch", "evidence.malformed", "artifact.missing", "artifact.hash_mismatch", "artifact.integrity", "artifact.selection_invalid", "artifact.mapper_failed"}
        if not isinstance(error, EvaluationError) and getattr(error, "code", None) in codes:
            error = EvaluationError(error.code, phase="policy" if command == "check" or error.code.startswith("policy.") else "export")
        diagnostic = safe_error(error).diagnostic
        hints = {
            "request.intent_mismatch": "Restore the original evaluator and candidate to recover this run. To measure a changed evaluator on the same settled candidate, replace --name with --retry-after and the prior name.",
            "request.base_conflict": "The published parent changed. Review the new parent and choose a new name for a comparison against it.",
            "evidence.not_terminal": "Check status with the prior name and inspect the original worker. A fresh attempt requires a completed or failed comparison.",
            "policy.invalid": "Use the editable quality-policy.example.json from the evaluator starter or copy the policy in the getting-started guide.",
        }
        if (command == "compare" or diagnostic["code"] == "policy.invalid") and diagnostic["code"] in hints:
            diagnostic = {**diagnostic, "hint": hints[diagnostic["code"]]}
        if missing:
            diagnostic = {**diagnostic, "missingFields": missing}
        if (args[:1] == ["compare"] and sys.stdout.isatty() and "--json" not in args
                and (command == "invalid" or isinstance(error, _CompareUsageError))):
            hint = error.hint if isinstance(error, _CompareUsageError) else "Invalid compare flags."
            sys.stderr.write(hint + "\n" + _COMPARE_USAGE + "\n")
        else:
            sys.stderr.write(json_bytes({"schemaVersion": 1, "command": command, "error": diagnostic}).decode() + "\n")
        if diagnostic["code"] in {"execution.uncertain", "submission.unconfirmed", "journal.busy", "journal.foreign", "journal.missing", "journal.relocated", "journal.ownership_lost", "request.interrupted", "request.base_conflict", "evidence.not_terminal"} or diagnostic.get("executionState") in {"may_have_started", "report_saved"}:
            return 3
        if command == "export" and diagnostic["code"] == "artifact.missing":
            return 3
        return 1
