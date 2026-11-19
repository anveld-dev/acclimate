"""Run controls shared by service and local runs: deadline, timeouts, cost cap, selection, progress."""
from __future__ import annotations

from dataclasses import dataclass
import json
import math
import re
import sys
from typing import Any, Callable

from ._evaluation_shared import EvaluationError, EvaluationUsageError

CONTROL_ERRORS = {
    "notSelected": "not_selected",
    "timeout": "timeout",
    "deadline": "deadline_exceeded",
    "costLimit": "cost_limit_reached",
}
RUN_CONTROL_FLAGS = ("deadline", "case-timeout", "max-cost-usd", "cases", "shard")


class RunControlError(EvaluationUsageError):
    """An invalid run-control flag. A usage error (exit 1) that names the flag."""

    def __init__(self, hint: str, field: str | None = None):
        super().__init__("usage.invalid_flag", field=field, reason=hint, message=hint)
        self.hint = hint


@dataclass(frozen=True)
class RunControls:
    """Invocation controls. They change when the runner stops, not what a trial measures.

    Concurrency and grade retries are declared in the definition instead, where
    the descriptor fingerprints them.
    """
    deadline_ms: int | None = None
    case_timeout_ms: int | None = None
    max_cost_usd: float | None = None
    # {"kind": "cases", "caseIds": [...]} or {"kind": "shard", "index": i, "count": n}
    selection: dict | None = None
    # Called with a progress dict after each arm settles. Exceptions are ignored.
    progress: Callable[[dict], Any] | None = None


def merge_controls(base: RunControls | None, override: RunControls | None) -> RunControls:
    if base is None:
        return override or RunControls()
    if override is None:
        return base
    values = {name: getattr(override, name) if getattr(override, name) is not None else getattr(base, name)
              for name in ("deadline_ms", "case_timeout_ms", "max_cost_usd", "selection", "progress")}
    return RunControls(**values)


def validate_run_controls(controls: Any) -> RunControls:
    if controls is None:
        return RunControls()
    if not isinstance(controls, RunControls):
        raise EvaluationError("config.schema")

    def positive(value):
        return value is None or (type(value) in (int, float) and math.isfinite(value) and value > 0)

    if not (positive(controls.deadline_ms) and positive(controls.case_timeout_ms) and positive(controls.max_cost_usd)):
        raise EvaluationError("config.schema")
    if controls.progress is not None and not callable(controls.progress):
        raise EvaluationError("config.schema")
    selection = controls.selection
    if selection is not None:
        ok = type(selection) is dict and (
            (selection.get("kind") == "cases" and type(selection.get("caseIds")) is list and selection["caseIds"]
             and all(type(x) is str and x for x in selection["caseIds"]))
            or (selection.get("kind") == "shard" and type(selection.get("index")) is int
                and type(selection.get("count")) is int and 1 <= selection["index"] <= selection["count"]))
        if not ok:
            raise EvaluationError("config.schema")
    return controls


_DURATION = re.compile(r"^(\d+(?:\.\d+)?)(ms|s|m|h)?$")


def parse_duration(text: str, flag: str) -> int:
    """Parse 90, 90s, 1.5m, 2h or 500ms into milliseconds. Bare numbers are seconds."""
    match = _DURATION.fullmatch(text.strip())
    scale = {"ms": 1, "s": 1000, "m": 60_000, "h": 3_600_000}
    value = float(match[1]) * scale[match[2] or "s"] if match else math.nan
    if not math.isfinite(value) or value <= 0 or value > 7 * 24 * 3_600_000:
        raise RunControlError(f"{flag} needs a positive duration such as 90s, 15m or 2h.", flag)
    return round(value)


def parse_cost(text: str) -> float:
    value = float(text) if re.fullmatch(r"\d+(?:\.\d+)?", text.strip()) else math.nan
    if not math.isfinite(value) or value <= 0:
        raise RunControlError("--max-cost-usd needs a positive number of US dollars, such as 2.50.", "--max-cost-usd")
    return value


def parse_selection(cases: str | None = None, shard: str | None = None) -> dict | None:
    if cases is not None and shard is not None:
        raise RunControlError("Use --cases or --shard, not both.", "--cases")
    if cases is not None:
        ids = [item.strip() for item in cases.split(",")]
        if not ids or any(not item for item in ids) or len(set(ids)) != len(ids):
            raise RunControlError("--cases needs a comma-separated list of distinct case IDs.", "--cases")
        return {"kind": "cases", "caseIds": ids}
    if shard is not None:
        match = re.fullmatch(r"(\d+)/(\d+)", shard.strip())
        index, count = (int(match[1]), int(match[2])) if match else (0, 0)
        if not match or count < 1 or count > 1000 or index < 1 or index > count:
            raise RunControlError("--shard needs INDEX/COUNT with 1 <= INDEX <= COUNT, such as 2/4.", "--shard")
        return {"kind": "shard", "index": index, "count": count}
    return None


def selected_case_ids(selection: dict | None, case_ids: list[str]) -> set[str]:
    """Resolve a selection against the inventory. Shards deal whole cases round-robin."""
    if selection is None:
        return set(case_ids)
    if selection["kind"] == "cases":
        known = set(case_ids)
        unknown = [item for item in selection["caseIds"] if item not in known]
        if unknown:
            names = ", ".join(json.dumps(item, ensure_ascii=False) for item in unknown[:5])
            raise RunControlError(f"Unknown case ID{'s' if len(unknown) > 1 else ''}: {names}. Run describe to list the expected cases.", "--cases")
        return set(selection["caseIds"])
    if selection["count"] > len(case_ids):
        raise RunControlError(f'--shard {selection["index"]}/{selection["count"]} needs at least {selection["count"]} cases; '
                              f"this evaluator has {len(case_ids)}.", "--shard")
    return {case_id for position, case_id in enumerate(case_ids) if position % selection["count"] == selection["index"] - 1}


def describe_selection(selection: dict | None) -> str:
    if not selection:
        return "all cases"
    if selection["kind"] == "shard":
        scope = f'shard {selection["index"]}/{selection["count"]}'
    else:
        count = len(selection["caseIds"])
        scope = f"{count} selected case{'' if count == 1 else 's'}"
    return f'{scope} · {selection["selectedPairs"]} of {selection["totalPairs"]} pairs'


def run_controls_from_flags(flags: dict) -> RunControls:
    def text(name):
        value = flags.get(name)
        if value is None:
            return None
        if type(value) is not str or not value:
            raise RunControlError(f"--{name} needs a value.", f"--{name}")
        return value

    deadline, timeout, cost = text("deadline"), text("case-timeout"), text("max-cost-usd")
    return RunControls(
        deadline_ms=parse_duration(deadline, "--deadline") if deadline else None,
        case_timeout_ms=parse_duration(timeout, "--case-timeout") if timeout else None,
        max_cost_usd=parse_cost(cost) if cost else None,
        selection=parse_selection(text("cases"), text("shard")),
    )


def wants_progress(mode: str, stream=None) -> bool:
    """Progress goes to stderr when it is a terminal or --progress asks for it (CI logs)."""
    stream = sys.stderr if stream is None else stream
    return mode == "on" or (mode == "auto" and bool(getattr(stream, "isatty", lambda: False)()))


def _label(case_id: str) -> str:
    return re.sub(r"[\x7f-\x9f -‮⁦-⁩]", lambda m: "\\u%04x" % ord(m[0]),
                  json.dumps(case_id, ensure_ascii=False))


def progress_line(event: dict) -> str:
    """One progress line for stderr. Never includes outputs or expected values."""
    outcome = event["outcome"]
    if outcome["gradingStatus"] == "scored":
        result = f'reward {_number(outcome["reward"])}'
    elif outcome["executionStatus"] == "infrastructure_failed":
        result = outcome.get("error") or "failed"
    elif outcome["gradingStatus"] == "failed":
        result = "grading_failed"
    else:
        result = outcome.get("error") or outcome["executionStatus"]
    usage = outcome.get("usage") or {}
    cost = f' · ${usage["costUsd"]:.4f}' if type(usage.get("costUsd")) in (int, float) else ""
    width = len(str(event["total"]))
    return (f'[{str(event["completed"]).rjust(width)}/{event["total"]}] {_label(event["caseId"])} #{event["repetition"]} '
            f'{event["side"].ljust(9)} {result}{cost} · {event["elapsedMs"] / 1000:.1f}s')


def _number(value) -> str:
    """Render numbers as JavaScript does for the shared text lines."""
    if type(value) is float and value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    return str(value)


def _format_ms(value: int | None) -> str:
    if value is None:
        return "configured"
    for unit, scale in (("h", 3_600_000), ("m", 60_000), ("s", 1000)):
        if value % scale == 0:
            return f"{value // scale}{unit}"
    return f"{value}ms"


def run_warnings(summary: dict | None, digests: dict | None = None) -> list[str]:
    """Warnings shared by local and service comparisons."""
    warnings: list[str] = []
    if not summary:
        return warnings
    compared, identical = summary["outputs"]["comparedPairs"], summary["outputs"]["identicalPairs"]
    if compared > 0 and identical == compared:
        if digests and digests["parent"] == digests["candidate"]:
            warnings.append(f'Parent and candidate are the same payload ({digests["parent"]}), so identical outputs are expected. '
                            "Supply a changed candidate to measure a difference.")
        else:
            warnings.append(f"Both arms returned identical output on all {compared} compared pair{'' if compared == 1 else 's'}. "
                            "Check that execute uses the bundle argument; an adapter that ignores it compares the agent with itself.")
    if summary["stopReason"] == "deadline":
        warnings.append(f'Stopped at the {_format_ms(summary["deadlineMs"])} deadline. The result is partial and indeterminate.')
    if summary["stopReason"] == "cost_limit":
        warnings.append(f'Stopped starting pairs after reported cost reached ${(summary["costUsd"] or 0):.4f} '
                        f'(limit ${_number(summary["maxCostUsd"])}). The result is partial and indeterminate.')
    if summary["timedOutCallbacks"]:
        count = summary["timedOutCallbacks"]
        warnings.append(f"{count} callback{'' if count == 1 else 's'} exceeded the {_format_ms(summary['caseTimeoutMs'])} case timeout. "
                        "The SDK cancelled them and stopped waiting; work that ignores cancellation may still be running.")
    if summary["selection"]:
        warnings.append(f'Ran {describe_selection(summary["selection"])}. Unselected pairs are reported as not_selected, '
                        "so this result never claims full coverage.")
    return warnings


def summary_lines(summary: dict) -> list[str]:
    if summary["costUsd"] is None:
        cost = "not reported"
    else:
        cost = f'${summary["costUsd"]:.4f}' + (f' of ${_number(summary["maxCostUsd"])} limit' if summary["maxCostUsd"] is not None else "")
    pairs = summary["pairs"]
    lines = [
        f'Run                 {summary["stopReason"]}{" (partial)" if summary["partial"] else ""} · {pairs["started"]}/{pairs["selected"]} pairs started'
        f' · concurrency {summary["concurrency"]}' + (f' · grade retries {summary["gradeRetries"]}' if summary["gradeRetries"] else ""),
        f"Reported cost       {cost}",
    ]
    if summary["selection"]:
        lines.append(f'Selection           {describe_selection(summary["selection"])}')
    return lines
