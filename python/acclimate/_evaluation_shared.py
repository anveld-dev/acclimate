"""Private evaluator contracts shared by runner, CLI and evidence helpers.

Importing this module performs no credential, filesystem or network operation.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import urllib.parse
import uuid
from typing import Any, Literal

from .client import AcclimateClient, ApiError, TransportError
from .errors import AcclimateError

MIB = 1024 * 1024
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
WORKSPACE_RE = re.compile(r"[A-Za-z0-9._-]{1,128}\Z")
DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")


_PATH_DIAGNOSTICS = {
    "configAlias": ("configPath", "Use the absolute realpath of the config file, including all parent directories. On macOS, /var is an alias for /private/var."),
    "journalAlias": ("journalRoot", "Set journalRoot to the absolute realpath of the journal directory, including all parents. On macOS, /var is an alias for /private/var."),
    "configMode": ("configPath", "Use a config owned by the current user with mode 0600 (chmod 600) in a private directory owned by that user with mode 0700 (chmod 700)."),
    "journalMode": ("journalRoot", "Use a journal directory owned by the current user with mode 0700 (chmod 700)."),
    "exportOverlap": ("outputDirectory", "Set --out to a new directory outside the config, journal and prepared workspace trees. Choose a separate private sibling of those trees."),
}


SafeCode = Literal[
    "usage.missing_command",
    "usage.unknown_command",
    "usage.unknown_flag",
    "usage.missing_flag",
    "usage.invalid_flag",
    "usage.conflicting_flags",
    "config.missing",
    "config.schema",
    "config.permissions",
    "config.url",
    "definition.invalid",
    "application.invalid",
    "application.import_failed",
    "learning.apps_invalid_export",
    "learning.held_out_mismatch",
    "output.invalid",
    "payload.incompatible",
    "runtime.unsupported",
    "bundle.missing",
    "guided_target_unsupported",
    "auth.denied",
    "descriptor.mismatch",
    "service.unavailable",
    "transport.response_too_large",
    "journal.busy",
    "journal.invalid",
    "journal.ownership_lost",
    "execution.uncertain",
    "evidence.identity_mismatch",
    "evidence.malformed",
    "evidence.incomplete",
    "internal.error",
]
SafeNextAction = Literal[
    "none", "fix_command", "fix_config", "fix_application", "check_service",
    "ask_operator", "retry_same_command", "inspect_external_app",
]
EvaluationPhase = Literal["configure", "preflight", "verify", "execute", "inspect"]
ExecutionState = Literal["not_started", "may_have_started", "report_saved", "finished"]

#: Evaluator CLI exit codes. Each names what to do next, so CI can tell a quality
#: decision from a broken pipeline. The TypeScript SDK uses the same values.
EXIT_CODES = {
    "ok": 0,              # The command succeeded. For a policy check, the candidate passed.
    "usage": 1,           # Fix the command line, config, application module or definition.
    "infrastructure": 4,  # The run or the service failed.
    "recovery": 5,        # Recovery is required before retrying.
}


def _usage(message: str) -> tuple[str, str, int]:
    return message, "fix_command", 1


def _config(message: str) -> tuple[str, str, int]:
    return message, "fix_config", 1


def _app(message: str) -> tuple[str, str, int]:
    return message, "fix_application", 1


def _recovery(message: str, action: str) -> tuple[str, str, int]:
    return message, action, 5


#: Message, default next action and CLI exit code for every diagnostic code.
#: Kept identical to EVALUATION_ERROR_CODES in the TypeScript SDK and checked
#: against the reference/error-codes docs page by both test suites.
ERROR_CODES: dict[str, tuple[str, str, int]] = {
    "usage.missing_command": _usage("No command given. Run with --help to list the commands."),
    "usage.unknown_command": _usage("Unknown command. Run with --help to list the commands."),
    "usage.unknown_flag": _usage("This command does not accept that flag."),
    "usage.missing_flag": _usage("A required flag is missing."),
    "usage.invalid_flag": _usage("A flag has an invalid or repeated value."),
    "usage.conflicting_flags": _usage("These flags cannot be used together."),
    "config.missing": _config("The evaluator config file does not exist."),
    "config.schema": _config("The evaluator config or command input has an invalid field."),
    "config.permissions": _config("A private file or directory has unsafe ownership, mode or path."),
    "config.url": _config("serviceUrl must be an https:// origin, or http:// on localhost, with no path, query or credentials."),
    "definition.invalid": _app("The evaluation definition is invalid."),
    "application.invalid": _app("The application module does not export a valid adapter."),
    "application.import_failed": _app("The application module could not be imported."),
    "learning.apps_invalid_export": _app("Default-export an object with execute, grade, heldOut and an execution mode."),
    "learning.held_out_mismatch": _app("The installed held-out cases do not match the loop's held-out commitment."),
    "output.invalid": _app("A callback returned a value that is not plain JSON."),
    "payload.incompatible": ("The payload breaks a compatibility rule of a native harness the application declares.", "fix_command", 1),
    "runtime.unsupported": _config("This platform cannot run the evaluator. Use Linux or macOS with python3 available."),
    "bundle.missing": _config("The bundle does not exist in this workspace or the evaluator cannot read it."),
    "guided_target_unsupported": _config("The workspace or bundle identifier is not in the supported format."),
    "auth.denied": ("The service denied this token. Check the evaluator token and its permissions.", "ask_operator", 1),
    "descriptor.mismatch": _app("The installed descriptor is invalid."),
    "service.unavailable": ("The Acclimate service is unreachable or returned a server error.", "check_service", 4),
    "transport.response_too_large": ("A service response exceeded the size limit.", "fix_config", 4),
    "journal.busy": _recovery("Another evaluator process holds the local evaluator lock. No execution started here.", "retry_same_command"),
    "journal.invalid": _recovery("The journal is corrupt or was edited.", "fix_config"),
    "journal.ownership_lost": _recovery("This process lost ownership of the journal during the run.", "inspect_external_app"),
    "execution.uncertain": _recovery("Callbacks may have started, and the evaluator cannot prove they stopped.", "inspect_external_app"),
    "evidence.identity_mismatch": _config("The version or digest does not match the expected identity."),
    "evidence.malformed": _config("The service returned evidence in an unexpected shape."),
    "evidence.incomplete": ("The bundle inventory exceeded the preflight read limit.", "fix_config", 1),
    "internal.error": ("An unexpected error occurred. Rerun with --verbose or ACCLIMATE_DEBUG=1 for details.", "fix_config", 4),
}


def _bounded(value: Any, limit: int) -> str | None:
    if type(value) is not str or not value:
        return None
    return re.sub(r"[\x00-\x1f\x7f]", " ", value)[:limit]


class EvaluationError(AcclimateError):
    """An evaluator error with a documented ``code``. ``diagnostic`` is safe to print locally."""

    code: SafeCode

    def __init__(self, code: SafeCode, *, phase: EvaluationPhase = "configure", next_action: SafeNextAction | None = None,
                 execution_state: ExecutionState = "not_started", evaluation_request_id: str | None = None,
                 correlation_id: str | None = None, http_status: int | None = None,
                 mismatch_fields: list[str] | None = None, path_issue: str | None = None,
                 field: str | None = None, reason: str | None = None, hint: str | None = None,
                 service_url: str | None = None, missing_fields: list[str] | None = None,
                 message: str | None = None):
        default_message, default_action, _ = ERROR_CODES.get(code, ERROR_CODES["internal.error"])
        field, reason = _bounded(field, 512), _bounded(reason, 1024)
        if message is None:
            message = default_message
            if field:
                message += " " + field + (": " + reason if reason else "")
            elif reason:
                message += " " + reason
        super().__init__(code, message)
        next_action = next_action or default_action  # type: ignore[assignment]
        self.phase, self.next_action, self.execution_state = phase, next_action, execution_state
        self.field, self.reason = field, reason
        self.diagnostic: dict[str, Any] = {"code": code, "phase": phase,
            "nextAction": next_action, "executionState": execution_state}
        if path_issue in _PATH_DIAGNOSTICS:
            path_field, path_hint = _PATH_DIAGNOSTICS[path_issue]
            self.diagnostic.update(pathIssue=path_issue, field=path_field, hint=path_hint)
        if field:
            self.diagnostic["field"] = field
        if reason:
            self.diagnostic["reason"] = reason
        if _bounded(hint, 2048):
            self.diagnostic["hint"] = _bounded(hint, 2048)
        if _bounded(service_url, 4096):
            self.diagnostic["serviceUrl"] = _bounded(service_url, 4096)
        if type(evaluation_request_id) is str and UUID_RE.fullmatch(evaluation_request_id):
            self.diagnostic["evaluationRequestId"] = evaluation_request_id
        if type(correlation_id) is str and re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", correlation_id):
            self.diagnostic["correlationId"] = correlation_id
        if type(http_status) is int and 100 <= http_status <= 599:
            self.diagnostic["httpStatus"] = http_status
        if mismatch_fields:
            allowed = {"datasetRevision", "graderRevision", "runtime.configId", "runtime.configRevision", "runtime", "expectedCases", "versions"}
            self.diagnostic["mismatchFields"] = [x for x in mismatch_fields if x in allowed]
        if missing_fields:
            self.diagnostic["missingFields"] = list(missing_fields)

    def __repr__(self):
        return f"EvaluationError({self.code!r})"


def exit_code_for(diagnostic: dict) -> int:
    """The CLI exit code for a diagnostic."""
    if diagnostic.get("executionState") in ("may_have_started", "report_saved"):
        return EXIT_CODES["recovery"]
    return ERROR_CODES.get(diagnostic.get("code", ""), ERROR_CODES["internal.error"])[2]


class ExecutionUncertainError(EvaluationError):
    def __init__(self):
        super().__init__("execution.uncertain", phase="execute", next_action="inspect_external_app",
                         execution_state="may_have_started")


class DefinitionError(EvaluationError):
    """define_evaluation received an invalid definition. ``field`` names the argument or case."""

    def __init__(self, field: str, reason: str):
        super().__init__("definition.invalid", field=field, reason=reason)


class EvaluationUsageError(EvaluationError):
    """The command line is invalid. The diagnostic names the flag or command."""


class CallbackCancelled(Exception):
    """The callback certifies its own external work is quiescent."""


class TaskExecutionError(AcclimateError):
    """A task failure without gradeable output. Its message remains private."""

    def __init__(self, message: str = "The task failed without gradeable output."):
        super().__init__("task.failed", message)


def safe_error(error: BaseException, *, phase="preflight", execution_state="not_started") -> EvaluationError:
    if isinstance(error, EvaluationError):
        return error
    code, action = "internal.error", None
    if isinstance(error, ApiError):
        code = ("auth.denied" if error.status in (401, 403) else
                "transport.response_too_large" if error.code == "response_too_large" else
                "evidence.malformed" if error.status == 404 and phase == "preflight" else
                "service.unavailable")
        action = ("ask_operator" if error.status in (401, 403) else
                  "fix_config" if error.status == 404 and phase == "preflight" else "retry_same_command")
    elif isinstance(error, TransportError):
        if execution_state == "not_started":
            url = getattr(error, "service_url", None)
            return EvaluationError("service.unavailable", phase=phase, execution_state=execution_state,
                service_url=url, hint=(f"Could not reach {url}. " if url else "") +
                "Check that the Acclimate service is running and that serviceUrl in the config is correct, then retry the same command.")
        code, action = "service.unavailable", "retry_same_command"
    if execution_state == "may_have_started":
        action = "inspect_external_app"
    return EvaluationError(code, phase=phase, next_action=action, execution_state=execution_state,
        correlation_id=getattr(error, "request_id", None), http_status=getattr(error, "status", None))


def _text(value: Any, maximum: int, *, trimmed=False) -> bool:
    if type(value) is not str or not value or (trimmed and value != value.strip()):
        return False
    try:
        return len(value.encode("utf-8")) <= maximum and not any(ord(x) < 32 or ord(x) == 127 for x in value)
    except UnicodeError:
        return False


class OutputValidationError(EvaluationError):
    """A value is not plain JSON. ``field`` and ``reason`` stay in the private job directory."""

    def __init__(self, field: str, reason: str):
        super().__init__("output.invalid", phase="execute", field=field, reason=reason,
                         message=f"{field}: {reason}")
        self.field = field
        self.reason = reason


PrivateJsonError = OutputValidationError


def validate_json(value: Any, _seen: set[int] | None = None, *, portable: bool = True,
                  field: str | None = None) -> None:
    def invalid(reason):
        if field is not None:
            raise PrivateJsonError(field, reason)
        raise EvaluationError("config.schema")

    if value is None or type(value) is bool:
        return
    if type(value) in (int, float):
        try:
            finite = math.isfinite(value)
        except OverflowError:
            finite = False
        if not finite or (portable and abs(value) > 2**53-1 and (type(value) is int or value.is_integer())):
            invalid("Use a finite JSON number or encode large integers as strings.")
        return
    if type(value) is str:
        try:
            value.encode("utf-8")
        except UnicodeError:
            invalid("Use a valid Unicode string.")
        return
    if type(value) not in (list, dict):
        from datetime import date
        if isinstance(value, date):
            invalid("Convert the date or datetime with isoformat() before returning it.")
        invalid("Convert this value to a plain JSON value before returning it.")
    seen = _seen if _seen is not None else set()
    if id(value) in seen:
        invalid("Remove the circular reference.")
    seen.add(id(value))
    try:
        for key, child in (value.items() if type(value) is dict else enumerate(value)):
            if type(value) is dict:
                if type(key) is not str:
                    invalid("Use string object keys.")
                validate_json(key, seen, portable=portable, field=field)
            child_field = None
            if field is not None:
                label = json.dumps(key[:100], ensure_ascii=True) if type(key) is str else str(key)
                child_field = (field + "[" + label + "]")[:512]
            validate_json(child, seen, portable=portable, field=child_field)
    finally:
        seen.remove(id(value))


def clone_json(value: Any, *, field: str | None = None) -> Any:
    validate_json(value, field=field)
    return copy.deepcopy(value)


def json_bytes(value: Any) -> bytes:
    # Wire reports permit every finite reward; private app inputs use clone_json's
    # narrower portable integer range. Both reject exotic objects/nonfinite data.
    validate_json(value,portable=False)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def parse_json(data: bytes | str, *, code="config.schema") -> Any:
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                raise ValueError("duplicate")
            out[key] = value
        return out
    try:
        value = json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        validate_json(value,portable=False)
        return value
    except (ValueError, UnicodeError, EvaluationError, RecursionError, OverflowError):
        raise EvaluationError(code) from None


def guided_workspace(value: Any) -> bool:
    return type(value) is str and bool(WORKSPACE_RE.fullmatch(value)) and value not in (".", "..")


def guided_uuid(value: Any) -> bool:
    return type(value) is str and bool(UUID_RE.fullmatch(value))


def validate_descriptor(value: Any) -> dict:
    def text(item, maximum):
        if type(item) is not str or not item.strip():
            return False
        try:
            return len(item.encode("utf-8"))<=maximum
        except UnicodeError:
            return False
    if type(value) is not dict or set(value) != {"datasetRevision", "graderRevision", "runtime", "expectedCases"}:
        raise EvaluationError("descriptor.mismatch")
    if not text(value["datasetRevision"], 1024) or not text(value["graderRevision"], 1024):
        raise EvaluationError("descriptor.mismatch")
    runtime = value["runtime"]
    if type(runtime) is not dict or not 1 <= len(runtime) <= 64 or any(not text(k,128) or not text(v,4096) for k,v in runtime.items()):
        raise EvaluationError("descriptor.mismatch")
    if not text(runtime.get("configId"),128) or not text(runtime.get("configRevision"),1024):
        raise EvaluationError("descriptor.mismatch")
    inventory = value["expectedCases"]
    if type(inventory) is not list or not 1 <= len(inventory) <= 1000:
        raise EvaluationError("descriptor.mismatch")
    seen = set()
    for row in inventory:
        if type(row) is not dict or set(row) != {"caseId","repetition"} or not text(row["caseId"],1024) or type(row["repetition"]) is not int or not 0 <= row["repetition"] <= 2**32-1:
            raise EvaluationError("descriptor.mismatch")
        key = (row["caseId"],row["repetition"])
        if key in seen:
            raise EvaluationError("descriptor.mismatch")
        seen.add(key)
    return clone_json(value)


def validate_service_url(value: Any) -> None:
    if not _text(value,4096,trimmed=True):
        raise EvaluationError("config.url")
    try:
        url = urllib.parse.urlsplit(value)
        if (url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("127.0.0.1","localhost","::1"))) or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise ValueError()
        _ = url.port  # Reading the port validates its syntax and range.
    except ValueError:
        raise EvaluationError("config.url") from None


def _canonical_path(path: str | Path, *, alias_issue: str | None = None) -> Path:
    try:
        candidate = Path(path)
        if not candidate.is_absolute():
            raise ValueError()
        if candidate.resolve() != candidate:
            raise EvaluationError("config.permissions", path_issue=alias_issue)
    except (OSError,ValueError,RuntimeError,TypeError):
        raise EvaluationError("config.permissions")
    return candidate


def ensure_private_directory(path: str | Path, *, journal_root=False) -> Path:
    directory = _canonical_path(path, alias_issue="journalAlias" if journal_root else None)
    created: list[Path] = []
    try:
        # mkdir(parents=True) does not make the ancestors' directory entries
        # durable. Track only entries created by this call, leaving existing
        # ancestor ownership/permissions unchanged.
        missing: list[Path] = []
        ancestor=directory
        while True:
            try:
                info=ancestor.lstat()
            except FileNotFoundError:
                missing.append(ancestor)
                ancestor=ancestor.parent
                continue
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise ValueError()
            break
        for candidate in reversed(missing):
            try:
                os.mkdir(candidate,0o700)
                created.append(candidate)
            except FileExistsError:
                # A concurrent cooperating creator is acceptable only if it
                # supplied the same private directory policy.
                raced=candidate.lstat()
                if not stat.S_ISDIR(raced.st_mode) or raced.st_mode&0o077 or raced.st_uid!=os.getuid():
                    raise ValueError()
            if candidate.resolve()!=candidate:
                raise ValueError()
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError()
        if info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise EvaluationError("config.permissions", path_issue="journalMode" if journal_root else None)
        # Flush children before their newly created ancestors, including each
        # parent that contains a new entry. A file's later fsync is not enough
        # to persist an otherwise unflushed ancestor link.
        synced: set[Path] = set()
        for candidate in reversed(created):
            for target in (candidate,candidate.parent):
                if target in synced:
                    continue
                fd=os.open(target,os.O_RDONLY|os.O_NOFOLLOW|getattr(os,"O_DIRECTORY",0))
                try:
                    if not stat.S_ISDIR(os.fstat(fd).st_mode):
                        raise ValueError()
                    os.fsync(fd)
                finally:
                    os.close(fd)
                synced.add(target)
    except (OSError, ValueError):
        raise EvaluationError("config.permissions") from None
    return directory


def read_private_bytes(path: str | Path, limit: int = 65536, *, config_file=False) -> bytes:
    filename = _canonical_path(path)
    fd = None
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise EvaluationError("config.permissions", path_issue="configMode" if config_file else None)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError()
        with os.fdopen(fd,"rb") as stream:
            fd = None
            data = stream.read(limit+1)
        if len(data) > limit:
            raise ValueError()
        return data
    except FileNotFoundError:
        raise EvaluationError("config.missing") from None
    except (OSError, ValueError):
        raise EvaluationError("config.permissions") from None
    finally:
        if fd is not None:
            os.close(fd)


def atomic_private_write(path: str | Path, data: bytes) -> None:
    filename = _canonical_path(path)
    parent = ensure_private_directory(filename.parent)
    temporary = parent / ("."+uuid.uuid4().hex+".tmp")
    try:
        if filename.exists() or filename.is_symlink():
            info = filename.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                raise EvaluationError("config.permissions")
        fd = os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,"wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary,filename)
        parent_fd=os.open(parent,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    except OSError:
        raise EvaluationError("config.permissions") from None
    finally:
        temporary.unlink(missing_ok=True)


EVALUATOR_TOKEN_ENV = "ACCLIMATE_EVALUATOR_TOKEN"


def _private_parent(filename: Path) -> None:
    # A credential-bearing file's parent, not just the file, must be owner-only.
    parent = filename.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode):
        raise EvaluationError("config.permissions")
    if parent.st_mode & 0o077 or parent.st_uid != os.getuid():
        raise EvaluationError("config.permissions", path_issue="configMode")


def _read_token_file(path: Any) -> str:
    """Read a token file with the config file's privacy checks; one trailing newline is allowed."""
    if not _text(path,4096,trimmed=True) or not Path(path).is_absolute():
        raise EvaluationError("config.schema")
    filename = _canonical_path(path, alias_issue="configAlias")
    _private_parent(filename)
    try:
        text = read_private_bytes(filename, 8192, config_file=True).decode("utf-8")
    except UnicodeDecodeError:
        raise EvaluationError("config.schema") from None
    token = text[:-2] if text.endswith("\r\n") else text[:-1] if text.endswith("\n") else text
    if not _text(token,4096,trimmed=True):
        raise EvaluationError("config.schema")
    return token


def _read_config(path: str | Path) -> dict:
    try:
        relative = not Path(path).is_absolute()
    except TypeError:
        relative = False
    if relative:
        raise EvaluationError("config.permissions", path_issue="configAlias")
    # Report an absent config before judging its directory, so a typo in the path
    # is not mistaken for a permissions problem.
    if type(path) in (str, Path) and not os.path.lexists(path):
        raise EvaluationError("config.missing", field="configPath",
                              hint="Check the config path. Relative CLI paths resolve against the current directory.")
    filename = _canonical_path(path, alias_issue="configAlias")
    _private_parent(filename)
    value = parse_json(read_private_bytes(filename, config_file=True))
    fields = {"schemaVersion","serviceUrl","workspaceId","evaluatorPrincipalId","journalRoot"}
    # The evaluator token is inline, in a private file, or in ACCLIMATE_EVALUATOR_TOKEN.
    optional = {"captureCallbackErrors","evaluatorToken","evaluatorTokenFile"}
    if (type(value) is not dict or not fields.issubset(value) or set(value) - fields - optional
            or type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1
            or type(value.get("captureCallbackErrors", False)) is not bool
            or ("evaluatorToken" in value and "evaluatorTokenFile" in value)):
        raise EvaluationError("config.schema")
    validate_service_url(value["serviceUrl"])
    if not guided_workspace(value["workspaceId"]):
        raise EvaluationError("guided_target_unsupported")
    if (not _text(value["evaluatorPrincipalId"],1024,trimmed=True) or not _text(value["journalRoot"],4096,trimmed=True) or not Path(value["journalRoot"]).is_absolute()):
        raise EvaluationError("config.schema")
    if "evaluatorTokenFile" in value:
        value = {k: v for k, v in value.items() if k != "evaluatorTokenFile"} | {"evaluatorToken": _read_token_file(value["evaluatorTokenFile"])}
    elif "evaluatorToken" not in value:
        value = value | {"evaluatorToken": os.environ.get(EVALUATOR_TOKEN_ENV)}
    if not _text(value["evaluatorToken"],4096,trimmed=True):
        raise EvaluationError("config.schema")
    return value


def read_evaluator_config(path: str | Path) -> dict:
    try:
        return _read_config(path)
    except EvaluationError:
        raise
    except (OSError, ValueError, TypeError):
        raise EvaluationError("config.schema") from None


def make_client(config: dict) -> AcclimateClient:
    return AcclimateClient(config["serviceUrl"],token=config["evaluatorToken"],
        scope=config["evaluatorPrincipalId"],max_json_response_bytes=4*MIB)


def sha256(data: bytes) -> str:
    return "sha256:"+hashlib.sha256(data).hexdigest()
