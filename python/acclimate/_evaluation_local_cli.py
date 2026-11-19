"""`compare --local` and `try`: no service, no config, no handoff. Also routes run-control flags."""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading
import shutil

from ._evaluation_controls import (
    RUN_CONTROL_FLAGS, RunControlError, RunControls, extract_run_control_flags, progress_line,
    run_controls_from_flags, run_warnings, summary_lines, wants_progress,
)
from ._evaluation_shared import EvaluationError, json_bytes, safe_error

LOCAL_COMPARE_USAGE = "\n".join([
    "compare --local --parent PAYLOAD --candidate PAYLOAD [--live] [--policy POLICY] [--out DIR] [--json]",
    "        [--cases ID,ID | --shard I/N] [--deadline DURATION] [--case-timeout DURATION] [--max-cost-usd USD] [--progress | --quiet]",
    "PAYLOAD is a payload JSON file or a folder: skills/** become skill files, memory/** memory files, and other files instructions.",
    "Local runs need no service or config. Their report is advisory and never a release receipt.",
])
TRY_USAGE = "\n".join([
    "try [--case ID[,ID...]] [--payload PAYLOAD] [--live] [--case-timeout DURATION] [--json]",
    "Runs execute and grade once for each case (default: the first case) and checks every returned shape.",
])
_LOCAL_FLAGS = {
    "compare": ("local", "parent", "candidate", "live", "policy", "out", "json", "quiet", "progress", *RUN_CONTROL_FLAGS),
    "try": ("case", "payload", "live", "json", "case-timeout"),
}
_BOOLEAN = {"local", "live", "json", "quiet", "progress"}


def is_local_command(argv) -> bool:
    return bool(argv) and (argv[0] == "try" or (argv[0] == "compare" and "--local" in argv))


def _parse(argv):
    from .evaluation_local import LocalRunError
    command = argv[0]
    allowed = _LOCAL_FLAGS[command]
    flags: dict = {}
    index = 1
    while index < len(argv):
        argument = argv[index]
        name = argument[2:] if type(argument) is str and argument.startswith("--") else ""
        if name not in allowed:
            label = "--" + name if name else json.dumps(argument)
            raise LocalRunError(f"{label} is not a {'try' if command == 'try' else 'local compare'} flag.")
        if name in flags:
            raise LocalRunError(f"Supply --{name} once.")
        if name in _BOOLEAN:
            flags[name] = True
        else:
            index += 1
            if index >= len(argv) or argv[index].startswith("--"):
                raise LocalRunError(f"--{name} needs a value.")
            flags[name] = argv[index]
        index += 1
    return command, flags


class _Signals:
    """Turn SIGINT/SIGTERM into a cooperative cancel while a local run is active."""

    def __init__(self):
        self.event = threading.Event()
        self._originals = {}

    def __enter__(self):
        if threading.current_thread() is threading.main_thread():
            for number in (signal.SIGINT, signal.SIGTERM):
                self._originals[number] = signal.getsignal(number)
                signal.signal(number, lambda *_: self.event.set())
        return self.event

    def __exit__(self, *_):
        for number, handler in self._originals.items():
            signal.signal(number, handler)


def _shorten(value, limit=1200) -> str:
    try:
        rendered = json.dumps(value, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        rendered = repr(value)
    return rendered if len(rendered) <= limit else rendered[:limit] + f"\n… ({len(rendered) - limit} more characters)"


def _write_progress(event):
    sys.stderr.write(progress_line(event) + "\n")
    sys.stderr.flush()


def _compare_local(app, flags, directory):
    from .evaluation_cli import _comparison_text
    from .evaluation_local import (
        LOCAL_NOTICE, LocalRunError, create_local_run_directory, load_local_payload, local_report, read_local_text,
        run_local_comparison, score_local_comparison, write_local_report,
    )
    from .evaluation_policy import parse_evaluation_policy
    if not flags.get("parent") or not flags.get("candidate"):
        raise LocalRunError("Supply --parent and --candidate, each a payload JSON file or a folder of bundle files.")
    controls = run_controls_from_flags(flags)
    policy_text = read_local_text(flags["policy"]) if flags.get("policy") else None
    sources = {"parent": load_local_payload(flags["parent"]), "candidate": load_local_payload(flags["candidate"])}
    if policy_text is not None:
        # Parse before any callback runs so a typo costs nothing.
        parse_evaluation_policy(policy_text, app.descriptor)
    run_directory = create_local_run_directory(flags.get("out"), directory)
    terminal = sys.stdout.isatty() and not flags.get("json")
    if flags.get("quiet") and flags.get("progress"):
        raise LocalRunError("Use --progress or --quiet, not both.")
    progress = wants_progress("off" if flags.get("quiet") else "on" if flags.get("progress") else "auto")
    if progress:
        sys.stderr.write(f"Local comparison in {run_directory}\n")
    controls = RunControls(deadline_ms=controls.deadline_ms, case_timeout_ms=controls.case_timeout_ms,
                           max_cost_usd=controls.max_cost_usd, selection=controls.selection,
                           progress=_write_progress if progress else None)
    with _Signals() as cancel_event:
        result = run_local_comparison(app=app, parent=sources["parent"].payload, candidate=sources["candidate"].payload,
                                      directory=run_directory, allow_live=flags.get("live") is True, controls=controls,
                                      cancel_event=cancel_event)
    scored = score_local_comparison(result, policy_text)
    report = local_report(result, scored, sources, run_directory)
    report_file = write_local_report(run_directory, report, sources)
    if not terminal:
        # Terminal output already shows warnings; JSON output also flags them on stderr.
        for warning in result["warnings"]:
            sys.stderr.write(f"WARNING: {warning}\n")
    verdict = scored["policy"]["verdict"] if scored["policy"] else None
    if verdict:
        status = 0 if verdict == "pass" else 2 if verdict == "fail" else 3
    else:
        status = 3 if result["summary"]["stopReason"] in ("deadline", "cost_limit", "cancelled") else 0
    if not terminal:
        return status, {
            "schemaVersion": 1, "kind": report["kind"], "authoritative": False, "notice": LOCAL_NOTICE,
            "report": report_file, "parent": report["parent"], "candidate": report["candidate"], "run": result["summary"],
            "invocation": {"callbacksStarted": result["callbacksStarted"]}, "scores": scored["scores"],
            "policy": scored["policy"], "warnings": result["warnings"], "diagnostics": result["diagnostics"],
        }
    pseudo_request = {"id": "local", "status": "completed", "expectedCases": result["descriptor"]["expectedCases"]}
    table = _comparison_text(pseudo_request, result["comparison"], scored["scores"], scored["policy"], policy_text is not None).split("\n")[1:]
    table = [("Policy (advisory)   " + line[20:]) if line.startswith("Policy              ") else line for line in table]
    lines = ["Local comparison · not a release receipt", *table, *summary_lines(result["summary"]),
             f'Parent              {result["versions"]["parent"]["digest"]}  {sources["parent"].source}',
             f'Candidate           {result["versions"]["candidate"]["digest"]}  {sources["candidate"].source}',
             f'Execution callbacks started: {result["callbacksStarted"]}.']
    diagnostics = result["diagnostics"]
    if diagnostics:
        lines.append(f"Callback problems   showing {min(len(diagnostics), 10)} of {len(diagnostics)} (local only)")
        for item in diagnostics[:10]:
            lines.append(f'  {json.dumps(item["caseId"], ensure_ascii=False)} [{item["repetition"]}] {item["side"]} · {item["phase"]} · {item["detail"]}')
    lines.extend(f"WARNING: {warning}" for warning in result["warnings"])
    lines.append(f"Report              {report_file}")
    lines.append("To gate a release, replay the candidate against the service:\n  python -m acclimate "
                 + report["replay"]["command"] + (" --live" if flags.get("live") else ""))
    return status, "\n".join(lines)


def _try_text(result) -> str:
    lines = [f'Try · payload {result["payload"]["source"] or "placeholder (pass --payload to use your files)"} · {result["payload"]["digest"]}']
    for row in result["cases"]:
        lines.append(f'Case {json.dumps(row["caseId"], ensure_ascii=False)}')
        execute = row["execute"]
        lines.append(f'  execute  {execute["status"]}' + ("" if execute.get("error") else f' in {execute["durationMs"]} ms')
                     + (f' · {execute["executionStatus"]}' if execute.get("executionStatus") else ""))
        if execute.get("error"):
            lines.append(f'    {execute["error"]}')
        lines.extend(f'    {issue["severity"]}  {issue["field"]}: {issue["message"]}' for issue in execute["issues"])
        if "output" in execute:
            lines.extend("    │ " + line for line in _shorten(execute["output"]).split("\n"))
        if "usage" in execute:
            lines.append(f'    usage {json.dumps(execute["usage"])}')
        grade = row["grade"]
        detail = (" (execute did not return a usable result)" if grade["status"] == "skipped"
                  else "" if grade.get("error") else f' in {grade["durationMs"]} ms')
        lines.append(f'  grade    {grade["status"]}{detail}' + (f' · reward {grade["reward"]}' if "reward" in grade else ""))
        if grade.get("error"):
            lines.append(f'    {grade["error"]}')
        lines.extend(f'    {issue["severity"]}  {issue["field"]}: {issue["message"]}' for issue in grade["issues"])
        if "explanation" in grade:
            lines.extend("    │ " + line for line in _shorten(grade["explanation"], 600).split("\n"))
    lines.append("All shapes are valid. Next: compare --local --parent PAYLOAD --candidate PAYLOAD." if result["ok"]
                 else "Fix the errors above; a real run records them as evidence gaps.")
    return "\n".join(lines)


def _try(app, flags):
    from .evaluation_local import load_local_payload, try_evaluation
    controls = run_controls_from_flags({"cases": flags.get("case"), "case-timeout": flags.get("case-timeout")})
    payload = load_local_payload(flags["payload"]) if flags.get("payload") else None
    directory = Path(tempfile.mkdtemp(prefix="acclimate-try-")).resolve()
    try:
        with _Signals() as cancel_event:
            result = try_evaluation(app=app, directory=directory, payload=payload, selection=controls.selection,
                                    allow_live=flags.get("live") is True, case_timeout_ms=controls.case_timeout_ms,
                                    cancel_event=cancel_event)
    finally:
        shutil.rmtree(directory, ignore_errors=True)
    terminal = sys.stdout.isatty() and not flags.get("json")
    return (0 if result["ok"] else 1), (_try_text(result) if terminal else result)


def _json_safe(value):
    """try output may hold invalid JSON on purpose; render it without failing."""
    return json.loads(json.dumps(value, ensure_ascii=False, default=repr, allow_nan=True)
                      .replace("NaN", "null").replace("Infinity", "null"))


def local_main(app, argv, directory=None) -> int:
    from .evaluation_local import LocalRunError
    from .evaluation_policy import PolicyError
    as_json = "--json" in argv or not sys.stdout.isatty()
    try:
        command, flags = _parse(argv)
        status, result = _try(app, flags) if command == "try" else _compare_local(app, flags, directory or os.getcwd())
        if isinstance(result, str):
            sys.stdout.write(result + "\n")
        else:
            try:
                output = json_bytes(result).decode()
            except EvaluationError:
                output = json.dumps(_json_safe(result), ensure_ascii=False, separators=(",", ":"))
            sys.stdout.write(output + "\n")
        return status
    except KeyboardInterrupt:
        return 130
    except (LocalRunError, RunControlError, PolicyError) as error:
        if isinstance(error, PolicyError):
            message = f"The policy is invalid or does not fit this evaluator's cases ({error.code})."
        else:
            message = error.hint if isinstance(error, RunControlError) else str(error)
        if as_json:
            sys.stderr.write(json.dumps({"schemaVersion": 1, "command": argv[0], "error": {"code": "local.invalid", "message": message}},
                                        ensure_ascii=False) + "\n")
        else:
            sys.stderr.write(f"{message}\n\n{TRY_USAGE if argv[0] == 'try' else LOCAL_COMPARE_USAGE}\n")
        return 1
    except Exception as error:
        sys.stderr.write(json_bytes({"schemaVersion": 1, "command": argv[0], "error": safe_error(error).diagnostic}).decode() + "\n")
        return 1


def service_run_notices(result: dict, digests: dict) -> tuple[list[str], dict]:
    """Summary lines and warnings appended to a service compare."""
    summary = result.get("runSummary")
    warnings = run_warnings(summary, digests)
    # Service compare keeps stderr a single JSON diagnostic; warnings ride in the result.
    if warnings and sys.stderr.isatty():
        for warning in warnings:
            sys.stderr.write(f"WARNING: {warning}\n")
    lines = [*(summary_lines(summary) if summary else []), *(f"WARNING: {warning}" for warning in warnings)]
    return lines, ({"run": summary, "warnings": warnings} if summary else {})


def route_evaluation_command(app, argv, service):
    """Route local commands, then strip and bind run-control flags for the service parser."""
    from .evaluation import bind_run_controls
    if is_local_command(argv):
        return local_main(app, argv)
    try:
        rest, controls, progress, _ = extract_run_control_flags(list(argv))
    except RunControlError as error:
        diagnostic = {**safe_error(EvaluationError("config.schema")).diagnostic, "hint": error.hint}
        sys.stderr.write(json_bytes({"schemaVersion": 1, "command": argv[0] if argv else "invalid", "error": diagnostic}).decode() + "\n")
        return 1
    if argv and argv[0] in ("compare", "run") and wants_progress(progress):
        controls = RunControls(deadline_ms=controls.deadline_ms, case_timeout_ms=controls.case_timeout_ms,
                               max_cost_usd=controls.max_cost_usd, selection=controls.selection, progress=_write_progress)
    bound = app
    if app is not None and any(getattr(controls, name) is not None for name in
                               ("deadline_ms", "case_timeout_ms", "max_cost_usd", "selection", "progress")):
        bound = bind_run_controls(app, controls)
    return service(bound, rest)
