"""`compare --local` and `try`: no service, no config, no handoff.

The shared evaluator parser in evaluation_cli owns the grammar, errors and exit codes.
"""
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
    RunControls, progress_line, run_controls_from_flags, run_warnings, summary_lines, wants_progress,
)
from ._evaluation_shared import EXIT_CODES, EvaluationError, EvaluationUsageError, json_bytes

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
#: Service compare flags that compare --local rejects.
_SERVICE_COMPARE_FLAGS = ("config", "handoff", "bundle", "channel", "payload", "name", "retry-after")


def _assert_live_flag(app, flags):
    """Local runs share compare's --live rule: live evaluators need it, model-free ones reject it."""
    live = app.execution == "live"
    if live != (flags.get("live") is True):
        raise EvaluationUsageError("usage.missing_flag" if live else "usage.invalid_flag", field="--live",
                                   reason="This evaluator is live. Add --live to authorize model calls." if live
                                   else "This evaluator is model-free. Omit --live.")


def _payload(path, flag):
    """Name the flag a payload came from when it cannot be read."""
    from .evaluation_local import LocalRunError, load_local_payload
    try:
        return load_local_payload(path)
    except LocalRunError as error:
        if error.field:
            raise
        raise LocalRunError(str(error), flag) from None


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


def compare_local_command(app, flags, directory):
    """`compare --local`: run the trial schedule on two payloads without a service."""
    from .evaluation_cli import _comparison_text
    from .evaluation_local import (
        LOCAL_NOTICE, create_local_run_directory, local_report, read_local_text,
        run_local_comparison, score_local_comparison, write_local_report,
    )
    from .evaluation_policy import parse_evaluation_policy
    service = [name for name in _SERVICE_COMPARE_FLAGS if name in flags]
    if service:
        raise EvaluationUsageError("usage.conflicting_flags", field="--" + service[0],
                                   reason=f"--{service[0]} belongs to the service compare. compare --local needs no config or handoff.",
                                   hint=LOCAL_COMPARE_USAGE)
    if not flags.get("parent") or not flags.get("candidate"):
        raise EvaluationUsageError("usage.missing_flag", field="--candidate" if flags.get("parent") else "--parent",
                                   reason="Supply --parent and --candidate, each a payload JSON file or a folder of bundle files.",
                                   hint=LOCAL_COMPARE_USAGE)
    _assert_live_flag(app, flags)
    if flags.get("quiet") and flags.get("progress"):
        raise EvaluationUsageError("usage.conflicting_flags", field="--progress", reason="Use --progress or --quiet, not both.")
    controls = run_controls_from_flags(flags)
    policy_text = read_local_text(flags["policy"]) if flags.get("policy") else None
    sources = {"parent": _payload(flags["parent"], "--parent"), "candidate": _payload(flags["candidate"], "--candidate")}
    if policy_text is not None:
        # Parse before any callback runs so a typo costs nothing.
        parse_evaluation_policy(policy_text, app.descriptor)
    run_directory = create_local_run_directory(flags.get("out"), directory)
    terminal = sys.stdout.isatty() and not flags.get("json")
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
    # Advisory policy: pass 0, fail 2, indeterminate 3. Without a policy, a run stopped by
    # its deadline, cost limit or a signal is partial evidence: 3.
    verdict = scored["policy"]["verdict"] if scored["policy"] else None
    if verdict:
        status = (EXIT_CODES["ok"] if verdict == "pass" else EXIT_CODES["gate_failed"] if verdict == "fail"
                  else EXIT_CODES["indeterminate"])
    else:
        status = EXIT_CODES["indeterminate"] if result["summary"]["stopReason"] != "completed" else EXIT_CODES["ok"]
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


def try_command(app, flags):
    """`try`: execute and grade selected cases once and check every returned shape."""
    from .evaluation_local import try_evaluation
    _assert_live_flag(app, flags)
    controls = run_controls_from_flags({"cases": flags.get("case"), "case-timeout": flags.get("case-timeout")})
    payload = _payload(flags["payload"], "--payload") if flags.get("payload") else None
    directory = Path(tempfile.mkdtemp(prefix="acclimate-try-")).resolve()
    try:
        with _Signals() as cancel_event:
            result = try_evaluation(app=app, directory=directory, payload=payload, selection=controls.selection,
                                    allow_live=flags.get("live") is True, case_timeout_ms=controls.case_timeout_ms,
                                    cancel_event=cancel_event)
    finally:
        shutil.rmtree(directory, ignore_errors=True)
    terminal = sys.stdout.isatty() and not flags.get("json")
    # A shape error is the application's to fix: exit 1.
    return (EXIT_CODES["ok"] if result["ok"] else EXIT_CODES["usage"]), (_try_text(result) if terminal else result)


def _json_safe(value):
    """try output may hold invalid JSON on purpose; render it without failing."""
    return json.loads(json.dumps(value, ensure_ascii=False, default=repr, allow_nan=True)
                      .replace("NaN", "null").replace("Infinity", "null"))


def json_safe_bytes(value) -> bytes:
    """try output may hold invalid JSON on purpose; render it without failing."""
    try:
        return json_bytes(value)
    except EvaluationError:
        return json.dumps(_json_safe(value), ensure_ascii=False, separators=(",", ":")).encode()


def local_main(app, argv, directory=None) -> int:
    """Run `compare --local` or `try` with paths resolved against directory.

    The installed command reaches the same code through evaluation_main.
    """
    from .evaluation_cli import evaluation_main
    return evaluation_main(app, list(argv), cwd=str(directory) if directory is not None else None)


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
