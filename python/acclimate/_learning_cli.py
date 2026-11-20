"""Configure and run a one-file Python learning loop."""

import argparse
import os
from pathlib import Path
import sys
import unicodedata

from ._application_imports import load_adapter
from ._evaluation_shared import validate_service_url
from ._jobs import Acclimate
from .client import AcclimateClient, ApiError
from .errors import AcclimateError, UsageError
from .learning import LoopDefinition, _enroll, _load_cases, _sync_cases, serve_learning_loop
from .types import LearningRound


def _plain(text: str) -> str:
    return "".join(
        " " if unicodedata.category(char) in {"Cc", "Cf", "Zl", "Zp"} else char
        for char in text[:300]
    )


def _score(value: float | None) -> str:
    return "pending" if value is None else f"{value:.2f}"


def _round_lines(round_: LearningRound) -> dict[str, str]:
    lines = {"round": f"Round {round_['number']} {round_['state']} | incumbent {_score(round_['incumbentScore'])}"}
    for candidate in round_["candidates"]:
        details = [candidate["status"]]
        if diagnosis := candidate["diagnosis"]:
            problem = diagnosis["problem"]
            label = problem["id"] if "id" in problem else problem["new"]
            details.extend((f"diagnosis {_plain(label)}", f"predictions {len(diagnosis['predicted'])}"))
        if screen := candidate["screen"]:
            details.append(f"screen {screen['verdict']} ({_plain(screen['reason'])})")
        if reason := candidate["dropReason"]:
            details.append(reason)
        details.append(f"evolve {_score(candidate['evolveScore'])}")
        lines[f"sample-{candidate['sample']}"] = f"  Sample {candidate['sample']} | " + " | ".join(details)
    if round_["decision"] or round_["endedAt"]:
        choice = round_["decision"] or round_["state"]
        if round_["adoptedSample"] is not None:
            choice += f" sample {round_['adoptedSample']}"
        selection = round_["selection"]
        reason = selection["reason"] if selection else round_["reason"]
        if reason:
            choice += f" ({_plain(reason)})"
        held_out = (f"error {_plain(round_['heldOutError'])}" if round_["heldOutError"]
                    else _score(round_["heldOutScore"]))
        lines["decision"] = f"  Selection {choice} | held-out {held_out}"
    return lines


def _serve_config(definition: LoopDefinition, filename: Path, once: bool) -> None:
    evolve, held_out = _load_cases(definition, filename.parent)
    acclimate = Acclimate.from_env()
    client, workspace = acclimate.client, acclimate.workspace
    validate_service_url(client.base_url)
    bundle = acclimate._bundle_id(definition.bundle)
    admin = None
    if token := os.getenv("ACCLIMATE_ENROLL_TOKEN"):
        admin = AcclimateClient(client.base_url, token, "learn-enrollment")
    loop = _enroll(client, workspace, bundle, definition, held_out, os.getenv("ACCLIMATE_APP_PRINCIPAL"), admin)
    _sync_cases(client, workspace, bundle, evolve)

    active = loop["activeRound"]
    finished = (active["number"] if active else loop["nextRound"]) - 1
    last_round = None
    displayed: dict[str, str] = {}

    def update_rounds() -> bool:
        nonlocal finished, last_round, displayed
        current = client.get_learning_loop(workspace, bundle)
        summaries = {summary["number"]: summary for summary in current["rounds"]}
        if active_round := current["activeRound"]:
            summaries[active_round["number"]] = active_round
        for number, summary in sorted(summaries.items()):
            if number <= finished:
                continue
            details = client.get_learning_round(workspace, bundle, summary["id"])
            if last_round != summary["id"]:
                displayed = {}
                last_round = summary["id"]
            for key, line in _round_lines(details).items():
                if displayed.get(key) != line:
                    print(f"\033[1m{line}\033[0m" if key == "round" and sys.stdout.isatty() else line, flush=True)
                    displayed[key] = line
            if details["endedAt"]:
                finished = number
                if once and details["state"] == "completed":
                    return True
        if once and current["status"] != "running" and not current["activeRound"]:
            status = current["status"]
            reason = current["pauseReason"]
            raise UsageError(f"The learning loop is {status}" + (f" ({reason})." if reason else "."))
        return False

    def diagnostic(error: AcclimateError) -> None:
        print(_diagnostic_message(error), file=sys.stderr)

    serve_learning_loop(
        client, workspace, bundle, execute=definition.execute, grade=definition.grade,
        held_out=held_out, stop=update_rounds, on_diagnostic=diagnostic,
    )


def _diagnostic_message(error: AcclimateError) -> str:
    if isinstance(error, ApiError):
        return f"Service request failed ({error.status} {_plain(error.code)})."
    return _plain(str(error))


def learn_main(args: list[str], directory: str | Path | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m acclimate learn")
    parser.add_argument("--config", default="acclimate_loop.py", help="Python file exporting loop")
    parser.add_argument("--once", action="store_true", help="exit after one completed round")
    options = parser.parse_args(args)
    filename = (Path(directory or Path.cwd()) / options.config).resolve()
    try:
        if filename.suffix != ".py" or not filename.is_file():
            raise UsageError("Pass a Python loop file with --config. The default is acclimate_loop.py.")
        with load_adapter(filename.parent, str(filename)) as (module, *_):
            definition = getattr(module, "loop", None)
            if not isinstance(definition, LoopDefinition):
                raise UsageError("The config must export loop = define_loop(...).")
            _serve_config(definition, filename, options.once)
    except KeyboardInterrupt:
        return 130
    except AcclimateError as error:
        print(_diagnostic_message(error), file=sys.stderr)
        return 1
    return 0
