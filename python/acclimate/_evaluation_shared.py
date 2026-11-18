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
from typing import Any

from .client import AcclimateClient, ApiError, TransportError

MIB = 1024 * 1024
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
PROJECT_RE = re.compile(r"[A-Za-z0-9._-]{1,128}\Z")
DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")


_PATH_DIAGNOSTICS = {
    "configAlias": ("configPath", "Use the absolute realpath of the config file, including all parent directories. On macOS, /var is an alias for /private/var."),
    "journalAlias": ("journalRoot", "Set journalRoot to the absolute realpath of the journal directory, including all parents. On macOS, /var is an alias for /private/var."),
    "configMode": ("configPath", "Use a config owned by the current user with mode 0600 (chmod 600) in a private directory owned by that user with mode 0700 (chmod 700)."),
    "journalMode": ("journalRoot", "Use a journal directory owned by the current user with mode 0700 (chmod 700)."),
    "exportOverlap": ("outputDirectory", "Set --out to a new directory outside the config, journal and prepared workspace trees. Choose a separate private sibling of those trees."),
}


class EvaluationError(Exception):
    """A safe public category, never a wrapper around private exception prose."""

    def __init__(self, code: str, *, phase: str = "configure", next_action: str = "fix_config",
                 execution_state: str = "not_started", evaluation_request_id: str | None = None,
                 correlation_id: str | None = None, http_status: int | None = None,
                 mismatch_fields: list[str] | None = None, path_issue: str | None = None):
        super().__init__(code)
        self.code, self.phase, self.next_action, self.execution_state = code, phase, next_action, execution_state
        self.diagnostic: dict[str, Any] = {"code": code, "phase": phase,
            "nextAction": next_action, "executionState": execution_state}
        if path_issue in _PATH_DIAGNOSTICS:
            field, hint = _PATH_DIAGNOSTICS[path_issue]
            self.diagnostic.update(pathIssue=path_issue, field=field, hint=hint)
        if type(evaluation_request_id) is str and UUID_RE.fullmatch(evaluation_request_id):
            self.diagnostic["evaluationRequestId"] = evaluation_request_id
        if type(correlation_id) is str and re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", correlation_id):
            self.diagnostic["correlationId"] = correlation_id
        if type(http_status) is int and 100 <= http_status <= 599:
            self.diagnostic["httpStatus"] = http_status
        if mismatch_fields:
            allowed = {"datasetRevision", "graderRevision", "runtime.configId", "runtime.configRevision", "runtime", "expectedCases", "versions"}
            self.diagnostic["mismatchFields"] = [x for x in mismatch_fields if x in allowed]

    def __repr__(self):
        return f"EvaluationError({self.code!r})"


class ExecutionUncertainError(EvaluationError):
    def __init__(self):
        super().__init__("execution.uncertain", phase="execute", next_action="inspect_external_app",
                         execution_state="may_have_started")


class CallbackCancelled(Exception):
    """The callback certifies its own external work is quiescent."""


class TaskExecutionError(Exception):
    """A task failure without gradeable output. Its message remains private."""


def safe_error(error: BaseException, *, phase="preflight", execution_state="not_started") -> EvaluationError:
    if isinstance(error, EvaluationError):
        return error
    code, action = "internal.error", "fix_config"
    if isinstance(error, ApiError):
        code = ("auth.denied" if error.status in (401, 403) else
                "transport.response_too_large" if error.code == "response_too_large" else
                "evidence.malformed" if error.status == 404 and phase == "preflight" else
                "service.unavailable")
        action = ("ask_operator" if error.status in (401, 403) else
                  "fix_config" if error.status == 404 and phase == "preflight" else "retry_same_command")
    elif isinstance(error, TransportError):
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


class PrivateJsonError(EvaluationError):
    """Field diagnostics for the local job only. The public error contains no field names."""
    def __init__(self, field: str, reason: str):
        super().__init__("config.schema")
        self.field = field
        self.reason = reason


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


def guided_project(value: Any) -> bool:
    return type(value) is str and bool(PROJECT_RE.fullmatch(value)) and value not in (".", "..")


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


def descriptor_from(value: dict) -> dict:
    return {key: copy.deepcopy(value[key]) for key in ("datasetRevision","graderRevision","runtime","expectedCases")}


def assert_descriptor(actual: dict, expected: dict) -> None:
    fields = []
    for name in ("datasetRevision","graderRevision","runtime"):
        if actual.get(name) != expected.get(name):
            fields.append(name)
    try:
        inventory_a = {(x["caseId"],x["repetition"]) for x in actual["expectedCases"]}
        inventory_b = {(x["caseId"],x["repetition"]) for x in expected["expectedCases"]}
        if inventory_a != inventory_b or len(inventory_a) != len(actual["expectedCases"]):
            fields.append("expectedCases")
    except (KeyError, TypeError):
        fields.append("expectedCases")
    if fields:
        raise EvaluationError("descriptor.mismatch",phase="verify",mismatch_fields=fields)


def validate_service_url(value: Any) -> None:
    if not _text(value,4096,trimmed=True):
        raise EvaluationError("config.url")
    try:
        url = urllib.parse.urlsplit(value)
        if (url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("127.0.0.1","localhost","::1"))) or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise ValueError()
        url.port
    except ValueError:
        raise EvaluationError("config.url") from None


def validate_handoff(value: Any) -> dict:
    if type(value) is not dict or set(value) != {"schemaVersion","serviceUrl","projectId","bundleId","requestId","configuration"} or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        raise EvaluationError("config.schema")
    validate_service_url(value["serviceUrl"])
    if not guided_project(value["projectId"]) or not guided_uuid(value["bundleId"]) or not guided_uuid(value["requestId"]):
        raise EvaluationError("guided_target_unsupported")
    validate_descriptor(value["configuration"])
    return clone_json(value)


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


def _read_config(path: str | Path, reader: bool) -> dict:
    filename = _canonical_path(path, alias_issue="configAlias")
    # Config parent, not just the credential-bearing file, must be owner-only.
    parent = filename.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode):
        raise EvaluationError("config.permissions")
    if parent.st_mode & 0o077 or parent.st_uid != os.getuid():
        raise EvaluationError("config.permissions", path_issue="configMode")
    value = parse_json(read_private_bytes(filename, config_file=True))
    fields = {"schemaVersion","serviceUrl","projectId","readToken"} if reader else {"schemaVersion","serviceUrl","projectId","evaluatorPrincipalId","evaluatorToken","journalRoot"}
    optional = set() if reader else {"captureCallbackErrors"}
    if (type(value) is not dict or not fields.issubset(value) or set(value) - fields - optional
            or type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1
            or type(value.get("captureCallbackErrors", False)) is not bool):
        raise EvaluationError("config.schema")
    validate_service_url(value["serviceUrl"])
    if not guided_project(value["projectId"]):
        raise EvaluationError("guided_target_unsupported")
    token_key = "readToken" if reader else "evaluatorToken"
    if not _text(value[token_key],4096,trimmed=True):
        raise EvaluationError("config.schema")
    if not reader and (not _text(value["evaluatorPrincipalId"],1024,trimmed=True) or not _text(value["journalRoot"],4096,trimmed=True) or not Path(value["journalRoot"]).is_absolute()):
        raise EvaluationError("config.schema")
    return value


def read_evaluator_config(path: str | Path) -> dict:
    try:
        return _read_config(path,False)
    except EvaluationError:
        raise
    except (OSError, ValueError, TypeError):
        raise EvaluationError("config.schema") from None


def read_reader_config(path: str | Path) -> dict:
    try:
        return _read_config(path,True)
    except EvaluationError:
        raise
    except (OSError, ValueError, TypeError):
        raise EvaluationError("config.schema") from None


def make_client(config: dict) -> AcclimateClient:
    return AcclimateClient(config["serviceUrl"],token=config.get("evaluatorToken",config.get("readToken")),
        scope=config.get("evaluatorPrincipalId","review-reader"),max_json_response_bytes=4*MIB)


def scope_from(config: dict, handoff: dict) -> dict:
    if handoff["serviceUrl"] != config["serviceUrl"] or handoff["projectId"] != config["projectId"]:
        raise EvaluationError("auth.principal_mismatch")
    return {"serviceUrl":config["serviceUrl"],"projectId":config["projectId"],
        "bundleId":handoff["bundleId"],"requestId":handoff["requestId"],
        "evaluatorPrincipalId":config["evaluatorPrincipalId"]}


def mutation_path(operation: str, scope: dict) -> str:
    if not guided_project(scope.get("projectId")) or not guided_uuid(scope.get("bundleId")):
        raise EvaluationError("guided_target_unsupported")
    base=f'/v1/projects/{scope["projectId"]}/bundles/{scope["bundleId"]}'
    if operation == "submit":
        return base+"/comparisons"
    if operation == "createRequest":
        return base+"/evaluation-requests"
    if operation == "createDraft":
        channel=scope.get("channel")
        if type(channel) is not str or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}",channel):
            raise EvaluationError("guided_target_unsupported")
        return base+f"/channels/{channel}/drafts"
    if operation in ("start","finish","interrupt") and guided_uuid(scope.get("requestId")):
        return base+f'/evaluation-requests/{scope["requestId"]}/{operation}'
    raise EvaluationError("guided_target_unsupported")


def mutate(client: AcclimateClient, operation: str, scope: dict, body_bytes: bytes, key: str) -> dict:
    if type(body_bytes) is not bytes or len(body_bytes)>2*MIB:
        raise EvaluationError("config.schema")
    parse_json(body_bytes)
    return client._request("POST",mutation_path(operation,scope),key=key,_body_bytes=body_bytes,_retained=True)


def sha256(data: bytes) -> str:
    return "sha256:"+hashlib.sha256(data).hexdigest()
