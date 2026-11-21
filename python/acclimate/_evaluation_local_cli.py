"""Run local `try` checks.

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

from ._evaluation_controls import run_controls_from_flags
from ._evaluation_shared import EXIT_CODES, EvaluationError, EvaluationUsageError, json_bytes

TRY_USAGE = "\n".join([
    "try [--case ID[,ID...]] [--payload PAYLOAD] [--live] [--case-timeout DURATION] [--json]",
    "Runs execute and grade once for each case (default: the first case) and checks every returned shape.",
])
def _assert_live_flag(app, flags):
    """Live evaluators require --live. Model-free evaluators reject it."""
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
    """Run `try` with paths resolved against directory.

    The installed command reaches the same code through evaluation_main.
    """
    from .evaluation_cli import evaluation_main
    return evaluation_main(app, list(argv), cwd=str(directory) if directory is not None else None)
