"""Closed commands for a statically installed application evaluator.

The helper returns a process status; the application decides when to exit.
"""
from __future__ import annotations

import json
import os
import re
import traceback
from pathlib import Path
import signal
import sys
import threading

from .evaluation import preflight_evaluation, run_evaluation
from ._evaluation_shared import (
    _canonical_path, ERROR_CODES, EXIT_CODES, EvaluationUsageError, exit_code_for,
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
from .evaluation_policy import check_comparison, parse_evaluation_policy
from ._evaluation_local_cli import service_run_notices
from ._evaluation_controls import RUN_CONTROL_FLAGS, RunControls, progress_line, run_controls_from_flags, selected_case_ids, wants_progress
from .evaluation_artifacts import (
    export_review_evidence, verify_review_export, parse_artifact_selection,
)

#: Run controls accepted by compare (service and local) and run.
_RUN_CONTROL_FLAGS = {*RUN_CONTROL_FLAGS, "progress", "quiet"}
#: compare --local flags that the service form rejects.
_LOCAL_COMPARE_FLAGS = {"local", "parent", "candidate", "out"}
_FLAGS = {
    "compare": {"config", "handoff", "bundle", "channel", "payload", "name", "retry-after", "live", "policy",
                *_LOCAL_COMPARE_FLAGS, *_RUN_CONTROL_FLAGS},
    "try": {"case", "payload", "live", "case-timeout"},
    "coverage": set(),
    "describe": set(),
    "doctor": {"config", "bundle", "handoff", "policy", "name"},
    "request": {"config", "bundle", "channel", "payload", "intent", "out", "policy"},
    "run": {"config", "handoff", "live", "name", *_RUN_CONTROL_FLAGS},
    "check": {"config", "read-config", "handoff", "policy", "name"},
    "status": {"config", "read-config", "handoff", "name"},
    "interrupt": {"config", "handoff", "reason", "name"},
    "export": {"config", "read-config", "handoff", "out", "selection", "name"},
    "verify-export": {"manifest", "read-config", "handoff"},
    "pull": {"config", "bundle", "channel", "out"},
}
#: Flags every command accepts.
_GLOBAL_FLAGS = {"json", "verbose"}
_BOOLEAN_FLAGS = {"live", "json", "verbose", "local", "progress", "quiet"}
#: Flags whose values are paths, resolved against the working directory.
_PATH_FLAGS = {"config", "read-config", "handoff", "payload", "parent", "candidate", "intent", "out", "policy",
               "selection", "manifest"}
#: Commands that never import the application module.
ADAPTER_FREE_COMMANDS = ("status", "verify-export", "interrupt", "pull")
EVALUATOR_COMMANDS = tuple(_FLAGS)


def _commands():
    return ", ".join(EVALUATOR_COMMANDS)


def _flag_list(command):
    return ", ".join("--" + name for name in sorted(_FLAGS[command] | _GLOBAL_FLAGS))


def _usage_error(code, *, field=None, reason=None, hint=None):
    return EvaluationUsageError(code, field=field, reason=reason, hint=hint)


def parse_evaluator_arguments(argv, cwd=None):
    """Parse evaluator arguments without loading application code or reading files."""
    if not argv:
        raise _usage_error("usage.missing_command", hint=f"Choose a command: {_commands()}. Run with --help for usage.")
    if argv[0] not in _FLAGS:
        raise _usage_error("usage.unknown_command", field=json.dumps(str(argv[0])[:80]),
                           hint=f"Choose a command: {_commands()}. Run with --help for usage.")
    command, flags, position = argv[0], {}, 1
    while position < len(argv):
        argument = argv[position]
        if type(argument) is not str or not argument.startswith("--"):
            raise _usage_error("usage.invalid_flag", field=json.dumps(str(argument)[:80]),
                               reason="Unexpected argument. Values must follow their flag.",
                               hint=f"{command} accepts {_flag_list(command)}.")
        name = argument[2:]
        if name not in _FLAGS[command] and name not in _GLOBAL_FLAGS:
            raise _usage_error("usage.unknown_flag", field=json.dumps(argument[:80]),
                               hint=f"{command} accepts {_flag_list(command)}.")
        if name in flags:
            raise _usage_error("usage.invalid_flag", field=argument, reason=f"Supply {argument} once.")
        if name in _BOOLEAN_FLAGS:
            flags[name] = True
        else:
            position += 1
            if position >= len(argv) or not argv[position] or argv[position].startswith("--"):
                raise _usage_error("usage.missing_flag", field=argument, reason=f"{argument} needs a value.")
            value = argv[position]
            flags[name] = os.path.join(cwd or os.getcwd(), value) if name in _PATH_FLAGS else value
        position += 1
    return command, flags


_parse = parse_evaluator_arguments


_COMPARE_USAGE = (
    "compare --config CONFIG --handoff HANDOFF [--live] [--policy POLICY] [--json]\n"
    "compare --config CONFIG --bundle ID --channel CHANNEL --payload FILE (--name RUN_NAME | --retry-after PRIOR_NAME [--name RUN_NAME]) [--live] [--policy POLICY] [--json]\n"
    "compare --local --parent PAYLOAD --candidate PAYLOAD [--live] [--policy POLICY] [--out DIR] [--json]  (no service; advisory)\n"
    "Run controls: [--deadline DURATION] [--case-timeout DURATION] [--max-cost-usd USD] [--cases ID,ID | --shard I/N] [--progress | --quiet]\n"
    "Live evaluators require --live. Use one input form and supply each flag once."
)


def _usage_for(command):
    from ._evaluation_local_cli import LOCAL_COMPARE_USAGE, TRY_USAGE
    from ._evaluation_pull import USAGE as PULL_USAGE
    return {"compare": _COMPARE_USAGE + "\n" + LOCAL_COMPARE_USAGE, "try": TRY_USAGE, "pull": PULL_USAGE}.get(command)


def _write_progress(event):
    sys.stderr.write(progress_line(event) + "\n")
    sys.stderr.flush()


def _run_controls(flags, case_ids):
    """Parse run-control flags and attach stderr progress unless --quiet."""
    if flags.get("quiet") and flags.get("progress"):
        raise _usage_error("usage.conflicting_flags", field="--progress", reason="Use --progress or --quiet, not both.")
    controls = run_controls_from_flags(flags)
    if controls.selection:
        selected_case_ids(controls.selection, case_ids)
    progress = wants_progress("off" if flags.get("quiet") else "on" if flags.get("progress") else "auto")
    return RunControls(deadline_ms=controls.deadline_ms, case_timeout_ms=controls.case_timeout_ms,
                       max_cost_usd=controls.max_cost_usd, selection=controls.selection,
                       progress=_write_progress if progress else None)


def _validate_compare_flags(flags, live):
    local = [key for key in ("parent", "candidate", "out") if flags.get(key)]
    if local:
        raise _usage_error("usage.unknown_flag", field="--" + local[0], reason=f"--{local[0]} belongs to compare --local.",
                           hint=_COMPARE_USAGE)
    if live != (flags.get("live") is True):
        raise _usage_error("usage.missing_flag" if live else "usage.invalid_flag", field="--live",
                           reason="This evaluator is live. Add --live to authorize model calls." if live
                           else "This evaluator is model-free. Omit --live.")
    creation = ("bundle", "channel", "payload", "name", "retry-after")
    used = [key for key in creation if flags.get(key)]
    if flags.get("handoff") and used:
        raise _usage_error("usage.conflicting_flags", field="--" + used[0],
                           reason="--handoff cannot be combined with candidate creation flags.", hint=_COMPARE_USAGE)
    if not flags.get("config"):
        raise _usage_error("usage.missing_flag", field="--config", hint=_COMPARE_USAGE)
    if flags.get("handoff"):
        return
    if not used:
        raise _usage_error("usage.missing_flag", field="--handoff", hint=_COMPARE_USAGE,
                           reason="Supply --handoff FILE, or create a run with --bundle, --channel, --payload and --name RUN_NAME.")
    for key in ("bundle", "channel", "payload"):
        if not flags.get(key):
            raise _usage_error("usage.missing_flag", field="--" + key, hint=_COMPARE_USAGE)
    if not flags.get("name") and not flags.get("retry-after"):
        raise _usage_error("usage.missing_flag", field="--name", hint=_COMPARE_USAGE,
                           reason="Name the run with --name RUN_NAME, or repeat a finished run with --retry-after PRIOR_NAME.")
    if flags.get("name") and flags.get("name") == flags.get("retry-after"):
        raise _usage_error("usage.conflicting_flags", field="--name", hint=_COMPARE_USAGE,
                           reason="Give the retry a new --name, or omit --name to use after-<request ID>.")
    if "name" in flags and not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", flags["name"]):
        raise _usage_error("usage.invalid_flag", field="--name", reason="Use 1–80 letters, digits, underscores or hyphens.")


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
        raise _usage_error("usage.missing_flag", field="--" + name)
    return value


def _exactly_one(flags, first, second):
    if not flags.get(first) and not flags.get(second):
        raise _usage_error("usage.missing_flag", field="--" + first, reason=f"Supply --{first} or --{second}.")
    if flags.get(first) and flags.get(second):
        raise _usage_error("usage.conflicting_flags", field="--" + first, reason=f"Supply --{first} or --{second}, not both.")


def _named_handoff(journal_root, name, flag="--name"):
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", name):
        raise _usage_error("usage.invalid_flag", field=flag, reason="Use 1–80 letters, digits, underscores or hyphens.")
    return _canonical_path(journal_root, alias_issue="journalAlias") / "comparisons" / name / "request.json"


def _read_handoff(filename, flag, name=None):
    """Read a handoff file. A missing file is handoff.missing, not a config problem."""
    try:
        if not os.path.lexists(filename):
            raise EvaluationError("config.missing")
        value = read_command_json(filename)
    except EvaluationError as error:
        if error.code == "config.missing":
            raise EvaluationError("handoff.missing", field=flag,
                reason=f"No run named {json.dumps(name)} in the journal." if name else None,
                hint="Check the run name, or create the run with compare --name." if name else
                "Download the handoff from the console, or create one with request --out.") from None
        raise
    return validate_handoff(value)


def _handoff(flags):
    name = flags.get("run-name")
    return _read_handoff(_required(flags, "handoff"), "--name" if name else "--handoff", name)


def _connection(flags, handoff):
    _exactly_one(flags, "config", "read-config")
    config = read_reader_config(_required(flags, "read-config")) if flags.get("read-config") else read_evaluator_config(_required(flags, "config"))
    if config["serviceUrl"] != handoff["serviceUrl"] or config["projectId"] != handoff["projectId"]:
        raise EvaluationError("version.binding_mismatch", phase="inspect")
    return make_client(config), config["projectId"]


def _assert_request(request, handoff, app=None):
    if request.get("requireBoundEvidence") is not True:
        raise EvaluationError("evidence.identity_mismatch", phase="inspect")
    if any(not guided_uuid(request.get(key)) for key in ("parentVersionId", "candidateVersionId")) or any(type(request.get(key)) is not str or not DIGEST_RE.fullmatch(request[key]) for key in ("parentDigest", "candidateDigest")):
        raise EvaluationError("version.binding_mismatch", phase="inspect")
    if request.get("id") != handoff["requestId"] or request.get("status") not in ("requested", "running", "completed", "failed", "interrupted", "abandoned") or (request.get("attemptId") is not None and not guided_uuid(request["attemptId"])) or (request.get("comparisonId") is not None and not guided_uuid(request["comparisonId"])):
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
    """ready -> 0. An unreachable or unverified service -> 4. Any setup problem -> 1."""
    if result["status"] == "ready":
        return EXIT_CODES["ok"]
    if any(check.get("code") == "service.unavailable" or check.get("status") == "unverified"
           for check in result.get("checks", []) if check.get("code")):
        return EXIT_CODES["infrastructure"]
    return EXIT_CODES["usage"]


def _run_status(evaluation):
    """completed -> 0, failed (execution or infrastructure failure) -> 4, interrupted or abandoned -> 5."""
    return {"completed": EXIT_CODES["ok"], "failed": EXIT_CODES["infrastructure"],
            "interrupted": EXIT_CODES["recovery"], "abandoned": EXIT_CODES["recovery"]}.get(
                evaluation["status"], EXIT_CODES["indeterminate"])


def _failure_text(failure):
    text = (f'First callback failure: {json.dumps(failure["caseId"], ensure_ascii=False)} [{failure["repetition"]}] '
            f'{failure["side"]} · {failure["stage"]} · {failure["reason"]}')
    if failure.get("diagnosticFile"):
        text += "\n  Details (private, not uploaded): " + failure["diagnosticFile"]
    return text


def _run(app, flags, handoff, controls=None):
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
            allow_live=flags.get("live") is True, cancel_event=cancel_event, controls=controls)
    finally:
        for number, handler in originals.items():
            signal.signal(number, handler)


def _comparison_binding(request):
    return {"parentVersionId": request["parentVersionId"], "candidateVersionId": request["candidateVersionId"], "parentDigest": request["parentDigest"], "candidateDigest": request["candidateDigest"], "requestId": request["id"], "attemptId": request.get("attemptId"), "comparisonId": request["comparisonId"], "submitter": request.get("evaluatorPrincipal")}


def _policy_exit(verdict):
    return EXIT_CODES["ok"] if verdict == "pass" else EXIT_CODES["gate_failed"] if verdict == "fail" else EXIT_CODES["indeterminate"]


def _create_request(app, flags, predecessor=None):
    config_path = _required(flags, "config")
    config = read_evaluator_config(config_path)
    bundle_id, channel = _required(flags, "bundle"), _required(flags, "channel")
    mutation_path("createDraft", {"projectId": config["projectId"], "bundleId": bundle_id, "channel": channel})
    preflight = preflight_evaluation(app=app, config_path=config_path, target={"bundleId": bundle_id})
    if preflight["status"] != "ready":
        return _readiness_status(preflight), preflight
    return 0, create_request_from_intent(app=app, config=config, bundle_id=bundle_id, channel=channel,
        payload_file=_required(flags, "payload"), intent_path=_required(flags, "intent"), output_file=_required(flags, "out"), predecessor=predecessor,
        run_name=flags.get("name"))


def _dispatch(app, command, flags, review, cwd=None):
    if command == "pull":
        from ._evaluation_pull import pull_command
        return pull_command(flags)
    if command == "describe":
        return 0, app.descriptor
    if command == "try":
        from ._evaluation_local_cli import try_command
        return try_command(app, flags)
    if command == "compare" and flags.get("local"):
        from ._evaluation_local_cli import compare_local_command
        return compare_local_command(app, flags, cwd or os.getcwd())
    if command == "coverage":
        raise _usage_error("usage.unknown_command", field='"coverage"', hint="Run coverage through python -m acclimate.")
    if command == "interrupt":
        # Check every flag before reading any file.
        config_path, reason = _required(flags, "config"), _required(flags, "reason")
        handoff = _handoff(flags)
        config = read_evaluator_config(config_path)
        if config["serviceUrl"] != handoff["serviceUrl"] or config["projectId"] != handoff["projectId"]:
            raise EvaluationError("version.binding_mismatch", field="--handoff",
                                  reason="The handoff names a different service or workspace than the config.")
        return 0, _safe_request(interrupt_from_intent(config, handoff, reason))
    if command == "verify-export":
        online = bool(flags.get("read-config") or flags.get("handoff"))
        if online and not (flags.get("read-config") and flags.get("handoff")):
            raise _usage_error("usage.missing_flag", field="--handoff" if flags.get("read-config") else "--read-config",
                               reason="Online verification needs both --read-config and --handoff.")
        options = {"manifest_path": _required(flags, "manifest")}
        if online:
            options["online"] = {"readConfigPath": _required(flags, "read-config"), "expectedHandoff": _handoff(flags)}
        return 0, verify_review_export(**options)
    if command == "doctor":
        _exactly_one(flags, "bundle", "handoff")
        if flags.get("policy"):
            parse_evaluation_policy(read_command_bytes(_required(flags, "policy")).decode(), app.descriptor)
        target = {"handoff": _handoff(flags)} if flags.get("handoff") else {"bundleId": _required(flags, "bundle")}
        result = preflight_evaluation(app=app, config_path=_required(flags, "config"), target=target)
        return _readiness_status(result), result
    comparing = command == "compare"
    policy = None
    controls = None
    if comparing:
        _validate_compare_flags(flags, app.execution == "live")
    if comparing or command == "run":
        # Parse run controls before any request is created or callback starts.
        controls = _run_controls(flags, list(dict.fromkeys(item["caseId"] for item in app.descriptor["expectedCases"])))
    if comparing:
        terminal = sys.stdout.isatty() and not flags.get("json")
        if flags.get("policy"):
            policy = parse_evaluation_policy(read_command_bytes(flags["policy"]).decode(), app.descriptor)
        if not flags.get("handoff"):
            config = read_evaluator_config(_required(flags, "config"))
            predecessor = None
            if flags.get("retry-after"):
                handoff_file = _named_handoff(config["journalRoot"], flags["retry-after"], "--retry-after")
                prior = _read_handoff(handoff_file, "--retry-after", flags["retry-after"])
                if prior["bundleId"] != flags["bundle"]:
                    raise EvaluationError("request.intent_mismatch", field="--bundle",
                                          reason="The prior run used a different bundle.")
                client, project_id = _connection(flags, prior)
                request = client.get_evaluation(project_id, prior["bundleId"], prior["requestId"])
                _assert_request(request, prior)
                # A settled predecessor, or one the service abandoned, may be retried.
                # An abandoned attempt's evidence never counts, so it needs no comparison.
                settled = request["status"] in ("completed", "failed") and request.get("attemptId") and request.get("comparisonId")
                if not settled and request["status"] != "abandoned":
                    raise EvaluationError("evidence.not_terminal", phase="inspect", next_action="inspect_external_app")
                predecessor = handoff_file, request
                flags.setdefault("name", "after-" + request["id"])
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
    if command == "status":
        _exactly_one(flags, "config", "read-config")
    handoff = _handoff(flags)
    if command == "run" or comparing:
        result = _run(app, flags, handoff, controls)
        evaluation = result["evaluation"]
        status = _run_status(evaluation)
        failure = result.get("firstCallbackFailure")
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
                status = EXIT_CODES["infrastructure"]
            run_name = flags.get("name")
            notice_lines, notice_json = service_run_notices(result, {"parent": evaluation["parentDigest"], "candidate": evaluation["candidateDigest"]})
            if status == 0 and (result.get("runSummary") or {}).get("stopReason", "completed") != "completed":
                # A deadline, cost limit or interruption left pairs unrun: partial evidence is indeterminate.
                status = EXIT_CODES["indeterminate"]
            invocation = {"callbacksStarted": result["callbacksStarted"], "reusedEvidence": result["reusedEvidence"]}
            if terminal:
                summary = "\n".join([_comparison_text(evaluation, result.get("comparison"), scores, policy_result, bool(policy)), *notice_lines])
                activity = ("Reused saved evidence. No execution callbacks started." if result["reusedEvidence"]
                            else f'Execution callbacks started this time: {result["callbacksStarted"]}.')
                summary += "\n" + activity
                if failure:
                    summary += "\n" + _failure_text(failure)
                if receipt:
                    summary += ("\nPolicy receipt recorded for release review." if receipt["status"] == "recorded" else
                                "\nPolicy receipt unconfirmed. Retry check with the evaluator config.")
                return status, summary + ("\nRun handle: --name " + run_name if run_name else "")
            return status, {**_safe_request(evaluation), "invocation": invocation,
                            **({"firstCallbackFailure": failure} if failure else {}),
                            **({"runName": run_name} if run_name else {}),
                            "parentVersionId": evaluation["parentVersionId"],
                            "candidateVersionId": evaluation["candidateVersionId"], "candidateDigest": evaluation["candidateDigest"],
                            "scores": scores, "policy": policy_result, **({"policyReceipt": receipt} if receipt else {}), **notice_json}
        return status, {**_safe_request(evaluation), "executionState": result["executionState"],
                        **({"firstCallbackFailure": failure} if failure else {}),
                        **({"run": result["runSummary"]} if result.get("runSummary") else {})}
    if command == "export":
        _exactly_one(flags, "config", "read-config")
        selection = parse_artifact_selection(read_command_json(_required(flags, "selection"))) if flags.get("selection") else None
        mapper = review.get("to_review_artifact") if review else None
        result = export_review_evidence(config_path=flags.get("config"), read_config_path=flags.get("read-config"),
            handoff=handoff, output_directory=_required(flags, "out"), selection=selection, to_review_artifact=mapper)
        return 0, {key: result[key] for key in ("schemaVersion", "status", "localInspection", "selection")}
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
        return _policy_exit(verdict["verdict"]) or (EXIT_CODES["infrastructure"] if receipt["status"] == "unconfirmed" else 0), {**verdict, "policyReceipt": receipt}
    client, project_id = _connection(flags, handoff)
    request = client.get_evaluation(project_id, handoff["bundleId"], handoff["requestId"])
    _assert_request(request, handoff)
    return 0, {**_safe_request(request), "progress": _read_progress(client, project_id, handoff["bundleId"], request)}


_RECOVERY_HINTS = {
    "request.intent_mismatch": "Restore the original evaluator and candidate to recover this run. To measure a changed evaluator on the same settled candidate, replace --name with --retry-after and the prior name.",
    "request.base_conflict": "The published parent changed. Review the new parent and choose a new name for a comparison against it.",
    "evidence.not_terminal": "Check status with the prior name and inspect the original worker. A fresh attempt requires a completed or failed comparison.",
    "policy.invalid": "Use the editable quality-policy.example.json from the evaluator starter or copy the policy in the getting-started guide.",
    "config.missing": "Check the --config path. Relative paths resolve against the current directory.",
}
_FORWARDED_CODES = {"policy.invalid", "policy.inventory_incompatible", "evidence.identity_mismatch", "evidence.malformed",
                    "artifact.missing", "artifact.hash_mismatch", "artifact.integrity", "artifact.selection_invalid",
                    "artifact.mapper_failed"}


def verbose_requested(argv) -> bool:
    """True when --verbose was passed or ACCLIMATE_DEBUG is set to a truthy value."""
    debug = os.environ.get("ACCLIMATE_DEBUG", "")
    return "--verbose" in argv or (bool(debug) and debug.lower() not in ("0", "false", "no"))


def _describe_cause(cause):
    if cause is None:
        return None
    message = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", " ", str(cause)).split("\n")[0][:1000]
    described = {"name": type(cause).__name__[:128], "message": message}
    code = getattr(cause, "code", None)
    if type(code) is str and re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", code):
        described["code"] = code
    return described


def report_evaluator_error(error, argv, command="invalid") -> int:
    """Print an error for a local evaluator command and return its exit code.

    On a terminal, stderr gets readable text; otherwise, or with --json, one JSON line.
    --verbose or ACCLIMATE_DEBUG=1 adds the traceback and the chained cause.
    """
    if not isinstance(error, EvaluationError) and getattr(error, "code", None) in _FORWARDED_CODES:
        error = EvaluationError(error.code, phase="policy" if command == "check" or error.code.startswith("policy.") else "export",
                                missing_fields=(getattr(error, "diagnostic", None) or {}).get("missingFields"))
    safe = safe_error(error, phase="configure")
    diagnostic = dict(safe.diagnostic)
    hint = diagnostic.get("hint")
    if hint is None and (command == "compare" or diagnostic["code"] in ("policy.invalid", "config.missing")):
        hint = _RECOVERY_HINTS.get(diagnostic["code"])
    message = str(safe) if isinstance(error, EvaluationError) else ERROR_CODES.get(diagnostic["code"], ERROR_CODES["internal.error"])[0]
    # An unexpected exception is itself the cause; an evaluator error names its chained cause.
    cause = error.__cause__ if isinstance(error, EvaluationError) else error
    first_cause = _describe_cause(cause)
    verbose = verbose_requested(argv)
    public = {**diagnostic, "message": message, **({"hint": hint} if hint else {}),
              **({"cause": first_cause} if first_cause else {})}
    if sys.stderr.isatty() and "--json" not in argv:
        lines = [f'error[{diagnostic["code"]}]: {message}']
        if diagnostic.get("field") and diagnostic["field"] not in message:
            lines.append("  field: " + diagnostic["field"])
        if diagnostic.get("reason") and diagnostic["reason"] not in message:
            lines.append("  reason: " + diagnostic["reason"])
        if diagnostic.get("missingFields"):
            lines.append("  missing fields: " + ", ".join(diagnostic["missingFields"]))
        if diagnostic.get("serviceUrl"):
            lines.append("  service: " + diagnostic["serviceUrl"])
        if first_cause:
            lines.append("  caused by: " + first_cause["name"] + (f' [{first_cause["code"]}]' if "code" in first_cause else "")
                         + ": " + first_cause["message"])
        if hint:
            lines.append("  hint: " + hint.replace("\n", "\n        "))
        elif _usage_for(command) and diagnostic["code"].startswith("usage."):
            lines.append("  usage:\n    " + _usage_for(command).replace("\n", "\n    "))
        lines.append("  next: " + diagnostic["nextAction"])
        if verbose:
            lines.extend(["", "".join(traceback.format_exception(error)).rstrip()])
        elif first_cause:
            lines.append("  Rerun with --verbose or ACCLIMATE_DEBUG=1 for the traceback.")
        sys.stderr.write("\n".join(lines) + "\n")
    else:
        record = {"schemaVersion": 1, "command": command, "error": public}
        if verbose:
            record["traceback"] = "".join(traceback.format_exception(error))
        sys.stderr.write(json.dumps(record, ensure_ascii=False) + "\n")
    return exit_code_for(diagnostic)


def sdk_version() -> str:
    """The installed SDK version, or the source checkout's version."""
    from importlib.metadata import PackageNotFoundError, version
    try:
        return version("acclimate-sdk")
    except PackageNotFoundError:
        pass
    declared = getattr(sys.modules.get(__package__ or "acclimate"), "__version__", None)
    if isinstance(declared, str):
        return declared
    try:
        project = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
        match = re.search(r'^version\s*=\s*"([^"]+)"', project, re.M)
        if match:
            return match.group(1)
    except OSError:
        pass
    return "unknown"


def evaluation_main(app, argv=None, *, review=None, cwd=None) -> int:
    """Run one command; review mapper is trusted installed code, never a path.

    compare --local and try run without a service. Run-control flags (--deadline,
    --case-timeout, --max-cost-usd, --cases, --shard, --progress, --quiet) apply
    to compare and run. cwd resolves relative paths and the default local report folder.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    command = "invalid"
    try:
        if args in (["--version"], ["-V"]):
            sys.stdout.write(sdk_version() + "\n")
            return EXIT_CODES["ok"]
        command, flags = parse_evaluator_arguments(args, cwd)
        if command != "compare" and flags.get("name"):
            if flags.get("handoff") or flags.get("read-config"):
                raise _usage_error("usage.conflicting_flags", field="--name",
                                   reason="--name uses the evaluator config and cannot be combined with --handoff or --read-config.")
            config = read_evaluator_config(_required(flags, "config"))
            flags["handoff"] = str(_named_handoff(config["journalRoot"], flags["name"]))
            flags["run-name"] = flags["name"]
        status, result = _dispatch(app, command, flags, review, cwd)
        if command in ("compare", "try") and isinstance(result, str):
            output = result.encode("utf-8")
        elif command == "try":
            from ._evaluation_local_cli import json_safe_bytes
            output = json_safe_bytes(result)
        else:
            output = json_bytes(result)
        if len(output) > 4 * 1024 * 1024:
            raise EvaluationError("transport.response_too_large")
        sys.stdout.write(output.decode() + "\n")
        return status
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        return report_evaluator_error(error, args, command)
