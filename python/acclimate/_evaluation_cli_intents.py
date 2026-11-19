"""Private exact-body command intents, separate from an evaluator's run lock."""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import os
from pathlib import Path
import stat
import uuid

from ._evaluation_shared import (
    EvaluationError, atomic_private_write, ensure_private_directory, json_bytes,
    make_client, mutate, mutation_path, parse_json, read_private_bytes,
    validate_handoff, assert_descriptor,
)
from .delivery import resolve_and_cache, validate_payload
from .client import ApiError


def read_command_bytes(filename: str | Path, limit: int = 2 * 1024 * 1024) -> bytes:
    """Read an explicitly chosen local input, rejecting links and unsafe writers."""
    target = Path(os.path.abspath(filename))
    if target.parent.resolve() != target.parent:
        raise EvaluationError("config.permissions")
    fd = None
    try:
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022 or info.st_size > limit:
            raise EvaluationError("config.permissions")
        with os.fdopen(fd, "rb") as stream:
            fd = None
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise EvaluationError("config.schema")
        data.decode("utf-8")
        return data
    except FileNotFoundError:
        raise EvaluationError("config.missing") from None
    except (OSError, UnicodeError):
        raise EvaluationError("config.permissions") from None
    finally:
        if fd is not None:
            os.close(fd)


def read_command_json(filename, limit=2 * 1024 * 1024):
    return parse_json(read_command_bytes(filename, limit))


@contextmanager
def command_lock(filename: str | Path):
    target = Path(filename)
    ensure_private_directory(target.parent)
    fd = None
    try:
        fd = os.open(target, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise EvaluationError("config.permissions")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise EvaluationError("journal.busy", next_action="retry_same_command") from None
        yield
    except OSError:
        raise EvaluationError("config.permissions") from None
    finally:
        if fd is not None:
            os.close(fd)


def _identity(config):
    return {key: config[key] for key in ("serviceUrl", "projectId", "evaluatorPrincipalId", "journalRoot")}


def _fail(code="request.intent_mismatch"):
    return EvaluationError(code, phase="claim", next_action=("retry_same_command" if code == "submission.unconfirmed" else "review_terminal_evidence" if code == "request.base_conflict" else "fix_config"))


def _command_failure(error):
    if isinstance(error, EvaluationError):
        return error
    if isinstance(error, ApiError):
        if error.status in (401, 403):
            return EvaluationError("auth.denied", phase="claim", next_action="ask_operator")
        if error.status == 409 and error.code == "base_conflict":
            return _fail("request.base_conflict")
        if error.status < 500 and error.code != "response_too_large":
            return EvaluationError("evidence.malformed", phase="claim")
    return _fail("submission.unconfirmed")


def _published_base(client, project_id, bundle_id, channel):
    """The channel's current release, or a diagnostic that names the missing baseline."""
    empty = EvaluationError("request.channel_empty", phase="claim", next_action="ask_operator")
    try:
        current = client.resolve_channel(project_id, bundle_id, channel)[0]
    except ApiError as error:
        # Preflight already found the bundle, so a missing resolution is an unpublished channel.
        if error.status == 404 and error.code == "not_found":
            raise empty from None
        raise
    if not current:
        raise empty
    return current


def assert_settled_predecessor(request):
    """A predecessor is settled with a bound comparison, or once the service records an interruption."""
    if request["status"] == "interrupted":
        return
    if request["status"] in ("completed", "failed") and request.get("attemptId") and request.get("comparisonId"):
        return
    raise EvaluationError("evidence.not_terminal", phase="inspect", next_action="inspect_external_app")


def _read_intent(filename):
    path = Path(filename)
    try:
        path.lstat()
    except FileNotFoundError:
        return None
    return parse_json(read_private_bytes(path, 4 * 1024 * 1024))


def _write_handoff(filename, handoff):
    target = Path(os.path.abspath(filename))
    content = json_bytes(handoff) + b"\n"
    try:
        target.lstat()
    except FileNotFoundError:
        pass
    else:
        if read_command_bytes(target) != content:
            raise _fail()
        return
    parent = target.parent
    info = parent.lstat()
    if parent.resolve() != parent or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise EvaluationError("config.permissions")
    temporary = parent / ("." + uuid.uuid4().hex + ".tmp")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, target, follow_symlinks=False)
        except FileExistsError:
            if read_command_bytes(target) != content:
                raise _fail()
        directory = os.open(parent, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def _recover(client, operation, scope, body, key):
    route = mutation_path(operation, scope)
    receipt = client.get_operation(scope["projectId"], key, operation_path=route)
    if receipt.get("status") == "closed":
        raise _fail()
    if receipt.get("status") != "committed":
        return None
    fingerprint = "sha256:" + hashlib.sha256(b"POST\0" + route.replace("/v1/workspaces/", "/v1/projects/", 1).encode() + b"\0" + body).hexdigest()
    if receipt.get("requestFingerprint") != fingerprint or not isinstance(receipt.get("result"), dict):
        raise _fail()
    return receipt["result"]


def _assert_request(request, state):
    body = parse_json(state["requestBody"])
    if not request.get("id") or any(request.get(key) != value for key, value in body.items()):
        raise _fail()


def create_request_from_intent(*, app, config, bundle_id, channel, payload_file, intent_path, output_file, predecessor=None):
    filename = Path(intent_path)
    if not filename.is_absolute() or filename.resolve() != filename:
        raise EvaluationError("config.permissions")
    output = os.path.abspath(output_file)
    payload = read_command_json(payload_file)
    validate_payload(payload)
    prior = None
    if predecessor:
        handoff_file, request = predecessor
        prior = _read_intent(handoff_file.parent / "intent.json")
        if (not prior or prior.get("schemaVersion") != 1 or prior.get("kind") != "acclimate-request-intent"
                or prior.get("identity") != _identity(config) or prior.get("output") != str(handoff_file)
                or prior.get("bundleId") != bundle_id or prior.get("channel") != channel or prior.get("payload") != payload
                or any((prior.get("request") or {}).get(key) != request[key] for key in ("id", "candidateVersionId", "candidateDigest"))
                or prior.get("base", {}).get("versionId") != request["parentVersionId"]
                or prior.get("base", {}).get("digest") != request["parentDigest"]):
            raise _fail()
    ensure_private_directory(filename.parent)
    client = make_client(config)
    scope = {"projectId": config["projectId"], "bundleId": bundle_id, "channel": channel}
    def save(state):
        content = json_bytes(state) + b"\n"
        if len(content) > 4 * 1024 * 1024:
            raise EvaluationError("definition.report_budget_exceeded", phase="claim")
        atomic_private_write(filename, content)
    try:
        with command_lock(str(filename) + ".lock"):
            state = _read_intent(filename)
            origin_file = Path(str(filename) + ".origin.json")
            if state is None and (origin_file.exists() or origin_file.is_symlink()):
                raise EvaluationError("journal.missing", phase="claim", next_action="inspect_external_app")
            if state is not None and prior and state.get("retryAfterRequestId") != prior["request"]["id"]:
                raise _fail()
            if state is not None and (state.get("schemaVersion") != 1 or state.get("kind") != "acclimate-request-intent" or state.get("identity") != _identity(config) or state.get("bundleId") != bundle_id or state.get("channel") != channel or state.get("output") != output or state.get("payload") != payload or state.get("descriptor") != app.descriptor):
                raise _fail()
            if state is None:
                current = _published_base(client, config["projectId"], bundle_id, channel)
                if prior and (current["version"]["id"] != prior["base"]["versionId"]
                              or current["version"]["digest"] != prior["base"]["digest"]
                              or current["revision"] != prior["base"]["revision"]):
                    raise _fail("request.base_conflict")
                state = {"schemaVersion": 1, "kind": "acclimate-request-intent", "identity": _identity(config), "bundleId": bundle_id, "channel": channel, "output": output, "payload": payload, "descriptor": app.descriptor,
                    "base": {"versionId": current["version"]["id"], "digest": current["version"]["digest"], "revision": current["revision"]},
                    "keys": {"draft": str(uuid.uuid4()), "request": str(uuid.uuid4())},
                    "draftBody": json_bytes({"baseVersionId": current["version"]["id"], "baseRevision": current["revision"], "payload": payload}).decode()}
                if prior:
                    state["retryAfterRequestId"] = prior["request"]["id"]
                atomic_private_write(origin_file, json_bytes({"schemaVersion": 1, "kind": "acclimate-request-intent-origin", "draftKey": state["keys"]["draft"]}) + b"\n")
                save(state)
            base = state["base"]
            draft_body = json_bytes({"baseVersionId": base["versionId"], "baseRevision": base["revision"], "payload": state["payload"]})
            if state.get("draftBody", "").encode() != draft_body or not state.get("keys", {}).get("draft") or not state["keys"].get("request"):
                raise _fail()
            # Recover the original request before considering a newer baseline.
            if not state.get("request") and state.get("requestBody"):
                request = _recover(client, "createRequest", scope, state["requestBody"].encode(), state["keys"]["request"])
                if request is not None:
                    _assert_request(request, state)
                    state["request"] = request
                    save(state)
            if not state.get("draft"):
                draft = _recover(client, "createDraft", scope, draft_body, state["keys"]["draft"])
                if draft is None:
                    current = client.resolve_channel(config["projectId"], bundle_id, channel)[0]
                    if not current or current["version"]["id"] != base["versionId"] or current["revision"] != base["revision"]:
                        raise _fail("request.base_conflict")
                    draft = mutate(client, "createDraft", scope, draft_body, state["keys"]["draft"])
                state["draft"] = draft
                save(state)
            draft = state["draft"]
            version = draft["snapshotVersion"]
            if not draft.get("id") or draft.get("channel") != channel or draft.get("baseVersionId") != base["versionId"] or draft.get("baseRevision") != base["revision"] or version.get("parentVersionId") != base["versionId"] or version.get("bundleId") != bundle_id or draft.get("generation") != 1:
                raise _fail()
            if not state.get("request"):
                current = client.resolve_channel(config["projectId"], bundle_id, channel)[0]
                if not current or current["version"]["id"] != base["versionId"] or current["revision"] != base["revision"]:
                    raise _fail("request.base_conflict")
                candidate = resolve_and_cache(client, config["projectId"], bundle_id, version_id=version["id"], cache_dir=str(Path(config["journalRoot"]) / "command-cache"))
                if candidate["version"]["digest"] != version["digest"] or candidate["version"]["parentVersionId"] != base["versionId"] or candidate["payload"] != payload:
                    raise _fail()
                body = json_bytes({"parentVersionId": base["versionId"], "parentDigest": base["digest"], "candidateVersionId": version["id"], "candidateDigest": version["digest"], **state["descriptor"], "requireBoundEvidence": True})
                if state.get("requestBody") and state["requestBody"].encode() != body:
                    raise _fail()
                state["requestBody"] = body.decode()
                save(state)
                request = mutate(client, "createRequest", scope, body, state["keys"]["request"])
                _assert_request(request, state)
                state["request"] = request
                save(state)
            _assert_request(state["request"], state)
            request = state["request"]
            handoff = validate_handoff({"schemaVersion": 1, "serviceUrl": config["serviceUrl"], "projectId": config["projectId"], "bundleId": bundle_id, "requestId": request["id"], "configuration": state["descriptor"]})
            _write_handoff(output, handoff)
            return {
                "schemaVersion": 1,
                "requestId": request["id"],
                "draftId": draft["id"],
                "generation": draft["generation"],
                "parentVersionId": base["versionId"],
                "candidateVersionId": version["id"],
                "candidateDigest": request["candidateDigest"],
                "status": request["status"],
            }
    except Exception as error:
        raise _command_failure(error) from None


def _assert_interrupt_request(request, handoff):
    if request.get("id") != handoff["requestId"] or request.get("requireBoundEvidence") is not True:
        raise EvaluationError("evidence.identity_mismatch", phase="inspect")
    assert_descriptor(request, handoff["configuration"])


def interrupt_from_intent(config, handoff, reason):
    if type(reason) is not str or not reason.strip() or len(reason.encode()) > 4096:
        raise EvaluationError("config.schema")
    root = ensure_private_directory(Path(config["journalRoot"]) / "command-intents")
    selection = {"identity": _identity(config), "bundleId": handoff["bundleId"], "requestId": handoff["requestId"], "reason": reason}
    digest = hashlib.sha256(json_bytes(selection)).hexdigest()
    filename = root / ("interrupt-" + digest + ".json")
    with command_lock(str(filename) + ".lock"):
        state = _read_intent(filename)
        if state is None:
            state = {"selection": selection, "key": str(uuid.uuid4()), "body": json_bytes({"reason": reason}).decode()}
            atomic_private_write(filename, json_bytes(state) + b"\n")
        if state.get("selection") != selection or state.get("body", "").encode() != json_bytes({"reason": reason}) or not state.get("key"):
            raise _fail()
        client = make_client(config)
        try:
            before = client.get_evaluation(config["projectId"], handoff["bundleId"], handoff["requestId"])
            _assert_interrupt_request(before, handoff)
            result = mutate(client, "interrupt", {"projectId": config["projectId"], "bundleId": handoff["bundleId"], "requestId": handoff["requestId"]}, state["body"].encode(), state["key"])
            current = client.get_evaluation(config["projectId"], handoff["bundleId"], handoff["requestId"])
        except Exception as error:
            raise _command_failure(error) from None
        _assert_interrupt_request(result, handoff)
        _assert_interrupt_request(current, handoff)
        if result.get("status") != "interrupted" or result.get("error") != reason or current.get("status") != "interrupted" or current.get("error") != reason:
            raise _fail("submission.unconfirmed")
        return current
