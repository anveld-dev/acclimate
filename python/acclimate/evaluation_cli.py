"""Commands for installed application adapters."""
from __future__ import annotations

import json
import os
import re
import sys
import traceback
from pathlib import Path

from .evaluation import preflight_evaluation
from ._evaluation_shared import ERROR_CODES, EXIT_CODES, EvaluationError, EvaluationUsageError, exit_code_for, json_bytes, safe_error

_FLAGS = {
    "try": {"case", "payload", "live", "case-timeout"},
    "coverage": set(),
    "describe": set(),
    "doctor": {"config", "bundle"},
    "pull": {"config", "bundle", "channel", "out"},
}
_GLOBAL_FLAGS = {"json", "verbose"}
_BOOLEAN_FLAGS = {"live", "json", "verbose"}
_PATH_FLAGS = {"config", "payload", "out"}
ADAPTER_FREE_COMMANDS = ("pull",)
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



def _usage_for(command):
    from .evaluation_app import _COMMAND_USAGE
    return _COMMAND_USAGE.get(command)


def _required(flags, name):
    value = flags.get(name)
    if type(value) is not str or not value:
        raise _usage_error("usage.missing_flag", field="--" + name)
    return value



def _dispatch(app, command, flags):
    if command == "pull":
        from ._evaluation_pull import pull_command
        return pull_command(flags)
    if command == "describe":
        return EXIT_CODES["ok"], app.descriptor
    if command == "try":
        from ._evaluation_local_cli import try_command
        return try_command(app, flags)
    if command == "doctor":
        result = preflight_evaluation(app=app, config_path=_required(flags, "config"),
                                      target={"bundleId": _required(flags, "bundle")})
        return EXIT_CODES["ok" if result["status"] == "ready" else "usage"], result
    raise _usage_error("usage.unknown_command", field=command,
                       hint="Run coverage through python -m acclimate.")


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
    safe = safe_error(error, phase="configure")
    diagnostic = dict(safe.diagnostic)
    hint = diagnostic.get("hint")
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



def evaluation_main(app, argv=None, *, cwd=None) -> int:
    """Run one evaluator command and return its exit status."""
    args = list(sys.argv[1:] if argv is None else argv)
    command = "invalid"
    try:
        if args in (["--version"], ["-V"]):
            sys.stdout.write(sdk_version() + "\n")
            return EXIT_CODES["ok"]
        command, flags = parse_evaluator_arguments(args, cwd)
        status, result = _dispatch(app, command, flags)
        if isinstance(result, str):
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
