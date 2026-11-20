"""Explicit, bounded review sidecars; never uploads or fetches output references.

The default shares scalar evidence only. Content release requires an installed
application mapper and explicit per-role selection. Verification establishes
local consistency, optionally authoritative scalar binding, not execution truth.
"""
from __future__ import annotations

import copy
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
from typing import Any, Callable, NotRequired, TypedDict, Literal

from ._evaluation_shared import (
    EvaluationError, json_bytes, make_client, read_evaluator_config,
    read_reader_config, scope_from, sha256, validate_handoff, validate_json,
    safe_error,
)
from ._evaluation_journal import Journal, journal_directory_key
from .client import ApiError, TransportError

MIB = 1024 * 1024
MAX_PRIVATE_FILE = MIB + 16 * 1024
MAX_MANIFEST = 2 * MIB
MAX_EXPORT = 64 * MIB
SIDES = ("parent", "candidate")
ROLES = ("output", "grader-explanation")
ArtifactRole = Literal["output", "grader-explanation"]


class ArtifactSelectionEntry(TypedDict):
    caseId: str
    repetition: int
    side: Literal["parent", "candidate"]
    role: ArtifactRole
    required: bool


class ArtifactSelectionV1(TypedDict):
    schemaVersion: Literal[1]
    entries: list[ArtifactSelectionEntry]


class ReviewMapperInput(TypedDict):
    identity: ReviewArtifactIdentity
    value: Any


class ReviewArtifactIdentity(TypedDict):
    requestId: str
    attemptId: str
    comparisonId: str
    versionId: str
    digest: str
    caseId: str
    repetition: int
    side: Literal["parent", "candidate"]
    role: ArtifactRole


class JsonReviewArtifact(TypedDict):
    mediaType: Literal["application/json"]
    value: Any


class TextReviewArtifact(TypedDict):
    mediaType: Literal["text/plain"]
    text: str


ReviewMapper = Callable[[ReviewMapperInput], JsonReviewArtifact | TextReviewArtifact | None]


class ReviewArtifactFile(TypedDict):
    path: str
    sha256: str
    bytes: int
    mediaType: Literal["application/json", "text/plain"]


class ReviewRoleAvailability(TypedDict):
    role: ArtifactRole
    selected: bool
    required: bool
    availability: Literal["exported", "not_shared", "missing", "unavailable"]
    file: NotRequired[ReviewArtifactFile]


class ReviewManifestEntry(TypedDict):
    caseId: str
    repetition: int
    side: Literal["parent", "candidate"]
    roles: list[ReviewRoleAvailability]


class ReviewManifestV1(TypedDict):
    schemaVersion: Literal[1]
    kind: Literal["acclimate-review-export"]
    workspaceId: str
    bundleId: str
    requestId: str
    attemptId: str
    comparisonId: str
    parent: dict[str, str]
    candidate: dict[str, str]
    localInspection: Literal["not_requested", "validated", "unavailable"]
    projection: dict[str, str | int]
    entries: list[ReviewManifestEntry]
    exporter: dict[str, str]


class ReviewExportResult(TypedDict):
    schemaVersion: Literal[1]
    status: Literal["exported"]
    manifestPath: str
    localInspection: Literal["not_requested", "validated", "unavailable"]
    selection: dict[str, int]


class ReviewVerificationResult(TypedDict):
    schemaVersion: Literal[1]
    status: Literal["verified"]
    provenance: Literal["self_consistent", "online_scalar_binding"]
    comparisonId: str
    executionAttested: Literal[False]


def _equal(a, b):
    if type(a) in (int, float) and type(b) in (int, float):
        return a == b
    if type(a) is not type(b):
        return False
    if type(a) is dict:
        return a.keys() == b.keys() and all(_equal(a[key], b[key]) for key in a)
    if type(a) is list:
        return len(a) == len(b) and all(_equal(x, y) for x, y in zip(a, b))
    return a == b


def _fail(code="artifact.integrity"):
    raise EvaluationError(code, phase="export", execution_state="finished",
                          next_action="review_terminal_evidence")


def _keys(value, required, optional=()):
    return type(value) is dict and set(required) <= value.keys() and value.keys() <= set(required) | set(optional)


def _text(value, maximum):
    if type(value) is not str or not value:
        return False
    try:
        return len(value.encode("utf-8")) <= maximum
    except UnicodeError:
        return False


def _integer(value):
    return type(value) is int and 0 <= value <= 2**53 - 1


def _digest(value):
    return type(value) is str and bool(re.fullmatch(r"sha256:[a-f0-9]{64}", value))


def _hash_matches(data, expected):
    return type(expected) is str and sha256(data) == (expected if expected.startswith("sha256:") else "sha256:" + expected)


def _identity(value):
    # Exactly the JS JSON.stringify tuple used for portable exported filenames.
    return json.dumps([value["caseId"], value["repetition"], value.get("side"), value.get("role")],
                      ensure_ascii=False, separators=(",", ":"))


def _pair(value):
    return value["caseId"], value["repetition"]


def _sort_pair(value):
    return value["caseId"].encode("utf-8"), value["repetition"]


def _encode(value):
    # Wire rewards/usage are finite binary64 scalars, not private Json inputs:
    # an integral-valued reward such as 1e16 is legal even beyond safe int input.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"


def _parse(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError()
            result[key] = value
        return result
    try:
        return json.loads(data.decode("utf-8", errors="strict"), object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError, OverflowError, RecursionError):
        _fail()


def parse_artifact_selection(value) -> ArtifactSelectionV1:
    if not _keys(value, ("schemaVersion", "entries")) or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1 or type(value["entries"]) is not list or len(value["entries"]) > 4000:
        _fail("artifact.selection_invalid")
    seen = set()
    for item in value["entries"]:
        if not _keys(item, ("caseId", "repetition", "side", "role", "required")) or not _text(item["caseId"], 1024) or not _integer(item["repetition"]) or item["side"] not in SIDES or item["role"] not in ROLES or type(item["required"]) is not bool:
            _fail("artifact.selection_invalid")
        identity = _identity(item)
        if identity in seen:
            _fail("artifact.selection_invalid")
        seen.add(identity)
    return copy.deepcopy(value)


validate_artifact_selection = parse_artifact_selection


def _no_symlinks(filename: Path):
    if not filename.is_absolute():
        filename = Path(os.path.abspath(filename))
    at = Path(filename.anchor)
    for piece in filename.parts[1:]:
        at = at / piece
        if stat.S_ISLNK(at.lstat().st_mode):
            _fail()


def _read_file(filename: Path, limit: int, private=False):
    _no_symlinks(filename)
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit or (private and (info.st_nlink != 1 or info.st_mode & 0o077 or info.st_uid != os.getuid())):
            _fail()
        with os.fdopen(fd, "rb") as stream:
            fd = None
            data = stream.read(limit + 1)
        if len(data) > limit:
            _fail()
        return data
    finally:
        if fd is not None:
            os.close(fd)


def _write_file(filename: Path, data: bytes):
    fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def _overlap(a: Path, b: Path):
    return a == b or a in b.parents or b in a.parents


def _output_overlap():
    raise EvaluationError("artifact.integrity", phase="export", execution_state="finished",
                          next_action="fix_config", path_issue="exportOverlap")


def _destination(output, roots):
    supplied = Path(output)
    if not supplied.is_absolute():
        _fail()
    # Inspect the supplied ancestry first: collapsing link/../ would otherwise
    # erase a symlink from the ancestry we promised not to traverse. Then apply
    # lexical normalization to BOTH sides before containment comparisons.
    _no_symlinks(supplied.parent)
    destination = Path(os.path.abspath(supplied))
    if any(_overlap(destination, Path(os.path.abspath(root))) for root in roots):
        _output_overlap()
    _no_symlinks(destination.parent)
    info = destination.parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        _fail()
    # The fixed native ownership marker reserves a prepared tree without any
    # journal access, including the scalar-only/read-token workflow.
    for ancestor in (destination.parent, *destination.parent.parents):
        control = ancestor / ".acclimate"
        try:
            info = control.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            _fail()
        if stat.S_ISDIR(info.st_mode):
            try:
                (control / "native-job-owner.json").lstat()
            except FileNotFoundError:
                continue
            _output_overlap()
    return destination


def _inventory(value):
    if type(value) is not list or not 1 <= len(value) <= 1000:
        _fail()
    seen = set()
    for item in value:
        if not _keys(item, ("caseId", "repetition")) or not _text(item["caseId"], 1024) or not _integer(item["repetition"]) or item["repetition"] > 0xffffffff:
            _fail()
        if _pair(item) in seen:
            _fail()
        seen.add(_pair(item))
    return sorted(copy.deepcopy(value), key=_sort_pair)


def _outcome(value):
    if type(value) is not dict or value.get("executionStatus") not in ("completed", "task_failed", "infrastructure_failed") or value.get("gradingStatus") not in ("scored", "missing", "failed"):
        _fail()
    reward = value.get("reward")
    if value["gradingStatus"] == "scored":
        if type(reward) not in (int, float) or not math.isfinite(reward):
            _fail()
    elif reward is not None:
        _fail()
    usage = value.get("usage")
    if usage is not None:
        if not _keys(usage, (), ("inputTokens", "outputTokens", "costUsd")):
            _fail()
        for number in usage.values():
            if type(number) not in (int, float) or not math.isfinite(number) or number < 0:
                _fail()
        usage = copy.deepcopy(usage)
    return {"executionStatus": value["executionStatus"], "gradingStatus": value["gradingStatus"], "reward": reward, "usage": usage}


def _body(comparison):
    return {**{key: comparison[key] for key in ("parentVersionId", "candidateVersionId", "parentDigest", "candidateDigest", "datasetRevision", "graderRevision", "runtime")},
            "evaluation": comparison.get("evaluation"), "expectedCases": _inventory(comparison["expectedCases"]),
            "results": sorted(comparison["results"], key=_sort_pair)}


def _projection(handoff, request, comparison):
    expected = _inventory(comparison["expectedCases"])
    identities = {_pair(item) for item in expected}
    rows = comparison.get("results")
    if type(rows) is not list or len(rows) > len(expected):
        _fail()
    seen, results = set(), []
    for row in rows:
        if type(row) is not dict or not _text(row.get("caseId"), 1024) or not _integer(row.get("repetition")) or _pair(row) not in identities or _pair(row) in seen:
            _fail()
        seen.add(_pair(row))
        results.append({"caseId": row["caseId"], "repetition": row["repetition"],
                        "parent": _outcome(row["parent"]), "candidate": _outcome(row["candidate"])})
    results.sort(key=_sort_pair)
    outcomes = [row[side] for row in results for side in SIDES]
    complete = len(seen) == len(identities) and all(outcome["executionStatus"] != "infrastructure_failed" and outcome["gradingStatus"] == "scored" for outcome in outcomes)
    if type(comparison.get("complete")) is not bool or comparison["complete"] != complete:
        _fail()
    return {"schemaVersion": 1, "kind": "acclimate-comparison-review", "workspaceId": handoff["workspaceId"],
            "bundleId": handoff["bundleId"], "requestId": request["id"], "attemptId": request["attemptId"], "comparisonId": comparison["id"],
            "parent": {"versionId": comparison["parentVersionId"], "digest": comparison["parentDigest"]},
            "candidate": {"versionId": comparison["candidateVersionId"], "digest": comparison["candidateDigest"]},
            "complete": complete, "expectedCases": expected, "results": results,
            "missingness": {"expectedPairs": len(expected), "presentPairs": len(results), "missingPairs": len(expected) - len(results),
                            "ungradedOutcomes": sum(x["gradingStatus"] != "scored" for x in outcomes),
                            "infrastructureFailures": sum(x["executionStatus"] == "infrastructure_failed" for x in outcomes)}}


def _descriptor(value):
    return {key: value[key] for key in ("datasetRevision", "graderRevision", "runtime")} | {"expectedCases": _inventory(value["expectedCases"])}


def _authority(config_path, read_config_path, supplied):
    if bool(config_path) == bool(read_config_path):
        _fail("config.schema")
    handoff = validate_handoff(supplied)
    config = read_evaluator_config(config_path) if config_path else read_reader_config(read_config_path)
    if config["serviceUrl"] != handoff["serviceUrl"] or config["workspaceId"] != handoff["workspaceId"]:
        _fail("evidence.identity_mismatch")
    client = make_client(config)
    try:
        request = client.get_evaluation(handoff["workspaceId"], handoff["bundleId"], handoff["requestId"])
    except (ApiError, TransportError) as error:
        raise safe_error(error, phase="export", execution_state="finished") from None
    if request.get("id") != handoff["requestId"] or _descriptor(request) != _descriptor(handoff["descriptor"]):
        _fail("evidence.identity_mismatch")
    if request.get("status") not in ("completed", "failed") or not request.get("comparisonId") or not request.get("attemptId") or not request.get("evaluatorPrincipal"):
        _fail("artifact.missing")
    try:
        comparison = client.get_comparison(handoff["workspaceId"], handoff["bundleId"], request["comparisonId"])
    except (ApiError, TransportError) as error:
        raise safe_error(error, phase="export", execution_state="finished") from None
    if comparison.get("id") != request["comparisonId"] or comparison.get("submitter") != request["evaluatorPrincipal"] or comparison.get("evaluation") != {"requestId": request["id"], "attemptId": request["attemptId"]} or _descriptor(comparison) != _descriptor(request) or any(comparison.get(key) != request.get(key) for key in ("parentVersionId", "candidateVersionId", "parentDigest", "candidateDigest")):
        _fail("evidence.identity_mismatch")
    if not all(_text(value, 128) for value in (comparison["id"], request["attemptId"], comparison["parentVersionId"], comparison["candidateVersionId"])) or not _digest(comparison["parentDigest"]) or not _digest(comparison["candidateDigest"]):
        _fail()
    return handoff, config, request, comparison, _projection(handoff, request, comparison)


def _index_entries(index, request, comparison, report_bytes):
    if type(index) is not dict or index.get("schemaVersion") != 1 or index.get("requestId") != request["id"] or index.get("attemptId") != request["attemptId"] or index.get("comparisonId") != comparison["id"] or not _hash_matches(report_bytes, index.get("reportSha256")) or type(index.get("entries")) is not list or len(index["entries"]) > 4000:
        _fail()
    expected, seen, files = {_pair(x) for x in _inventory(comparison["expectedCases"])}, set(), set()
    for row in index["entries"]:
        if not _keys(row, ("caseId", "repetition", "side", "versionId", "digest", "role", "file", "sha256", "bytes")) or not _text(row["caseId"], 1024) or not _integer(row["repetition"]) or row["side"] not in SIDES or row["role"] not in ROLES or not _text(row["file"], 128) or not re.fullmatch(r"artifact-(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json", row["file"]) or not _integer(row["bytes"]) or row["bytes"] > MAX_PRIVATE_FILE or not _digest(row["sha256"]) or _pair(row) not in expected:
            _fail()
        if row["versionId"] != comparison[row["side"] + "VersionId"] or row["digest"] != comparison[row["side"] + "Digest"] or _identity(row) in seen or row["file"] in files:
            _fail()
        seen.add(_identity(row))
        files.add(row["file"])
    return index["entries"]


def _prepared_roots(directory):
    jobs = directory / "jobs"
    try:
        _no_symlinks(jobs)
        entries = list(jobs.iterdir())
    except FileNotFoundError:
        return []
    if len(entries) > 2000:
        _fail()
    roots = []
    for entry in entries:
        if not stat.S_ISDIR(entry.lstat().st_mode) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", entry.name):
            _fail()
        try:
            record = _parse(_read_file(entry / "job.json", 65536, True))
        except FileNotFoundError:
            continue
        if type(record) is not dict or record.get("schemaVersion") != 1 or record.get("kind") != "acclimate-native-job":
            _fail()
        if record.get("cwd") is not None:
            if type(record["cwd"]) is not str or not Path(record["cwd"]).is_absolute():
                _fail()
            roots.append(record["cwd"])
    return roots


def export_review_evidence(*, handoff, output_directory, config_path=None, read_config_path=None,
                           selection=None, to_review_artifact: ReviewMapper | None = None) -> ReviewExportResult:
    journal = None
    try:
        selection = parse_artifact_selection(selection if selection is not None else {"schemaVersion": 1, "entries": []})
        if selection["entries"] and (not config_path or not callable(to_review_artifact)):
            _fail("artifact.selection_invalid")
        handoff, config, request, comparison, projection = _authority(config_path, read_config_path, handoff)
        expected = _inventory(comparison["expectedCases"])
        expected_ids = {_pair(x) for x in expected}
        if any(_pair(x) not in expected_ids for x in selection["entries"]):
            _fail("artifact.selection_invalid")
        choices = {_identity(x): x for x in selection["entries"]}
        forbidden = [str(Path(config_path or read_config_path).parent)]
        if "journalRoot" in config:
            forbidden.append(config["journalRoot"])
        inspection, index = ("unavailable" if selection["entries"] else "not_requested"), None
        if selection["entries"]:
            scope = scope_from(config, handoff)
            directory = Path(config["journalRoot"]) / journal_directory_key(scope)
            try:
                _no_symlinks(directory)
                exists = True
            except FileNotFoundError:
                exists = False
            if exists:
                journal = Journal(config["journalRoot"], scope).__enter__()
                state = journal.read()
                if state is not None:
                    if state.get("attemptId") != request["attemptId"] or state.get("comparisonId") != comparison["id"] or config["evaluatorPrincipalId"] != request["evaluatorPrincipal"]:
                        _fail()
                    report_available = bool(state.get("report")) or bool(state.get("wireBodies", {}).get("submit"))
                    ref = state.get("wireBodies", {}).get("submit")
                    if type(ref) is dict and ref.get("file") == "submit-body.json":
                        try:
                            (journal.directory / "submit-body.json").lstat()
                        except FileNotFoundError:
                            report_available = False
                    if report_available:
                        try:
                            report_bytes = journal.read_body("submit", state)
                        except EvaluationError:
                            _fail()
                        report = _parse(report_bytes)
                        if type(report) is not dict or not _equal(_body(report), _body(comparison)):
                            _fail()
                        local_index = journal.read_artifact_index()
                        if local_index is not None:
                            index = _index_entries(local_index, request, comparison, report_bytes)
                            inspection = "validated"
                forbidden.extend(_prepared_roots(journal.directory))
        # Validate the whole selected set before any app mapper receives data.
        registered_roles = {_identity(entry): entry for entry in index or []}
        def read_original(registered):
            try:
                original = _read_file(journal.directory / registered["file"], MAX_PRIVATE_FILE, True)
            except FileNotFoundError:
                return None
            if len(original) != registered["bytes"] or not _hash_matches(original, registered["sha256"]):
                _fail("artifact.hash_mismatch")
            envelope = _parse(original)
            artifact_identity = {"requestId": request["id"], "attemptId": request["attemptId"],
                                 **{key: registered[key] for key in ("caseId", "repetition", "side", "versionId", "digest", "role")}}
            if not _keys(envelope, ("schemaVersion", "identity", "value")) or type(envelope["schemaVersion"]) is not int or envelope["schemaVersion"] != 1 or not _equal(envelope["identity"], artifact_identity):
                _fail()
            role_value = envelope["value"]
            try:
                validate_json(role_value)
                if len(json_bytes(role_value)) > MIB:
                    _fail()
            except EvaluationError:
                _fail()
            return {"value": role_value}
        if index is not None:
            for choice in selection["entries"]:
                registered = registered_roles.get(_identity(choice))
                if registered is not None:
                    read_original(registered)
        destination = _destination(output_directory, forbidden)
        pending = []
        total = 0
        counts = {"required": sum(x["required"] for x in selection["entries"]), "exportedRequired": 0, "optionalMissing": 0}
        manifest = {"schemaVersion": 1, "kind": "acclimate-review-export", "workspaceId": handoff["workspaceId"],
                    "bundleId": handoff["bundleId"], "requestId": request["id"], "attemptId": request["attemptId"],
                    "comparisonId": comparison["id"], "parent": projection["parent"], "candidate": projection["candidate"],
                    "localInspection": inspection, "projection": None, "entries": [],
                    "exporter": {"name": "acclimate-evidence", "version": "1"}}
        for pair in expected:
            for side in SIDES:
                roles = []
                for role in ROLES:
                    identity = {**pair, "side": side, "role": role}
                    choice = choices.get(_identity(identity))
                    row = {"role": role, "selected": choice is not None, "required": choice["required"] if choice else False, "availability": "not_shared"}
                    if choice is not None:
                        registered = registered_roles.get(_identity(identity))
                        if index is None:
                            row["availability"] = "unavailable"
                        elif registered is None:
                            row["availability"] = "missing"
                        else:
                            # Re-read under the journal lock so preflight does
                            # not retain every private payload in memory.
                            original = read_original(registered)
                            if original is None:
                                row["availability"] = "missing"
                            if original is not None:
                                role_value = original["value"]
                                mapper_input = {"identity": {"requestId": request["id"], "attemptId": request["attemptId"], "comparisonId": comparison["id"],
                                                            "versionId": registered["versionId"], "digest": registered["digest"], **identity},
                                                "value": copy.deepcopy(role_value)}
                                try:
                                    mapped = to_review_artifact(mapper_input)
                                    if inspect.isawaitable(mapped):
                                        if inspect.iscoroutine(mapped):
                                            mapped.close()
                                        _fail("artifact.mapper_failed")
                                except BaseException:
                                    _fail("artifact.mapper_failed")
                                if mapped is not None:
                                    if _keys(mapped, ("mediaType", "value")) and mapped["mediaType"] == "application/json":
                                        try:
                                            validate_json(mapped["value"])
                                            data = json_bytes(mapped["value"]) + b"\n"
                                        except BaseException:
                                            _fail("artifact.mapper_failed")
                                    elif _keys(mapped, ("mediaType", "text")) and mapped["mediaType"] == "text/plain" and type(mapped["text"]) is str:
                                        try:
                                            data = mapped["text"].encode("utf-8")
                                        except UnicodeError:
                                            _fail("artifact.mapper_failed")
                                    else:
                                        _fail("artifact.mapper_failed")
                                    if len(data) > MIB:
                                        _fail("artifact.mapper_failed")
                                    filename = "artifact-" + hashlib.sha256(_identity(identity).encode("utf-8")).hexdigest() + (".json" if mapped["mediaType"] == "application/json" else ".txt")
                                    row.update(availability="exported", file={"path": filename, "sha256": sha256(data), "bytes": len(data), "mediaType": mapped["mediaType"]})
                                    pending.append((filename, data))
                                    total += len(data)
                                    if total > MAX_EXPORT:
                                        _fail()
                        if row["availability"] == "exported":
                            if choice["required"]:
                                counts["exportedRequired"] += 1
                        elif choice["required"]:
                            _fail("artifact.missing")
                        else:
                            counts["optionalMissing"] += 1
                    roles.append(row)
                manifest["entries"].append({**pair, "side": side, "roles": roles})
        projected_bytes = _encode(projection)
        manifest["projection"] = {"file": "comparison-review.json", "sha256": sha256(projected_bytes), "bytes": len(projected_bytes)}
        manifest_bytes = _encode(manifest)
        if len(projected_bytes) > MAX_MANIFEST or len(manifest_bytes) > MAX_MANIFEST or sum(len(data) for _, data in pending) + len(projected_bytes) + len(manifest_bytes) > MAX_EXPORT:
            _fail()
        destination.mkdir(mode=0o700)
        try:
            for filename, data in pending:
                _write_file(destination / filename, data)
            _write_file(destination / "comparison-review.json", projected_bytes)
            _write_file(destination / "manifest.json", manifest_bytes)
            fd = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except BaseException:
            shutil.rmtree(destination)
            raise
        return {"schemaVersion": 1, "status": "exported", "manifestPath": str(destination / "manifest.json"),
                "localInspection": inspection, "selection": counts}
    except EvaluationError:
        raise
    except (OSError, ValueError, KeyError, TypeError, OverflowError, RecursionError):
        _fail()
    finally:
        if journal is not None:
            journal.close()


def verify_review_export(*, manifest_path, online=None) -> ReviewVerificationResult:
    try:
        manifest_path = Path(manifest_path)
        manifest_bytes = _read_file(manifest_path, MAX_MANIFEST)
        m = _parse(manifest_bytes)
        fields = ("schemaVersion", "kind", "workspaceId", "bundleId", "requestId", "attemptId", "comparisonId", "parent", "candidate", "localInspection", "projection", "entries", "exporter")
        if not _keys(m, fields) or type(m["schemaVersion"]) is not int or m["schemaVersion"] != 1 or m["kind"] != "acclimate-review-export" or m["localInspection"] not in ("not_requested", "validated", "unavailable") or type(m["entries"]) is not list or len(m["entries"]) > 2000 or not _keys(m["exporter"], ("name", "version")) or m["exporter"]["name"] != "acclimate-evidence" or not _text(m["exporter"]["version"], 128):
            _fail()
        for field in ("workspaceId", "bundleId", "requestId", "attemptId", "comparisonId"):
            if not _text(m[field], 1024):
                _fail()
        for side in SIDES:
            if not _keys(m[side], ("versionId", "digest")) or not _text(m[side]["versionId"], 128) or not _digest(m[side]["digest"]):
                _fail()
        if not _keys(m["projection"], ("file", "sha256", "bytes")) or m["projection"]["file"] != "comparison-review.json" or not _digest(m["projection"]["sha256"]) or not _integer(m["projection"]["bytes"]) or m["projection"]["bytes"] > MAX_MANIFEST:
            _fail()
        directory = manifest_path.parent
        projected_bytes = _read_file(directory / "comparison-review.json", MAX_MANIFEST)
        if len(projected_bytes) != m["projection"]["bytes"] or not _hash_matches(projected_bytes, m["projection"]["sha256"]):
            _fail("artifact.hash_mismatch")
        p = _parse(projected_bytes)
        if not _keys(p, ("schemaVersion", "kind", "workspaceId", "bundleId", "requestId", "attemptId", "comparisonId", "parent", "candidate", "complete", "expectedCases", "results", "missingness")) or p["schemaVersion"] != 1 or p["kind"] != "acclimate-comparison-review" or type(p["complete"]) is not bool:
            _fail()
        if any(m[key] != p[key] for key in ("workspaceId", "bundleId", "requestId", "attemptId", "comparisonId", "parent", "candidate")):
            _fail()
        expected = _inventory(p["expectedCases"])
        fake = {"id": p["comparisonId"], "parentVersionId": p["parent"]["versionId"], "parentDigest": p["parent"]["digest"],
                "candidateVersionId": p["candidate"]["versionId"], "candidateDigest": p["candidate"]["digest"],
                "expectedCases": p["expectedCases"], "results": p["results"], "complete": p["complete"]}
        rebuilt = _projection({"workspaceId": p["workspaceId"], "bundleId": p["bundleId"]}, {"id": p["requestId"], "attemptId": p["attemptId"]}, fake)
        if not _equal(p, rebuilt):
            _fail()
        expected_rows = {_identity({**pair, "side": side}) for pair in expected for side in SIDES}
        seen, filenames = set(), {"manifest.json", "comparison-review.json"}
        has_selection = False
        total = len(manifest_bytes) + len(projected_bytes)
        for row in m["entries"]:
            if not _keys(row, ("caseId", "repetition", "side", "roles")) or type(row["roles"]) is not list or len(row["roles"]) != 2 or _identity(row) not in expected_rows or _identity(row) in seen:
                _fail()
            seen.add(_identity(row))
            seen_roles = set()
            for role in row["roles"]:
                if not _keys(role, ("role", "selected", "required", "availability"), ("file",)) or role["role"] not in ROLES or role["role"] in seen_roles or type(role["selected"]) is not bool or type(role["required"]) is not bool or role["required"] and not role["selected"] or role["availability"] not in ("exported", "not_shared", "missing", "unavailable"):
                    _fail()
                seen_roles.add(role["role"])
                if role["selected"]:
                    has_selection = True
                    if m["localInspection"] == "not_requested" or (m["localInspection"] == "unavailable") != (role["availability"] == "unavailable"):
                        _fail()
                if not role["selected"] and (role["required"] or role["availability"] != "not_shared"):
                    _fail()
                if role["required"] and role["availability"] != "exported":
                    _fail()
                if role["availability"] != "exported":
                    if "file" in role:
                        _fail()
                    continue
                file = role.get("file")
                if not role["selected"] or not _keys(file, ("path", "sha256", "bytes", "mediaType")) or type(file["path"]) is not str or not re.fullmatch(r"artifact-[a-f0-9]{64}\.(json|txt)", file["path"]) or not _digest(file["sha256"]) or not _integer(file["bytes"]) or file["bytes"] > MIB or file["mediaType"] not in ("application/json", "text/plain"):
                    _fail()
                filename = "artifact-" + hashlib.sha256(_identity({**row, "role": role["role"]}).encode("utf-8")).hexdigest() + (".json" if file["mediaType"] == "application/json" else ".txt")
                if file["path"] != filename or filename.lower() in filenames:
                    _fail()
                filenames.add(filename.lower())
                data = _read_file(directory / filename, MIB)
                if len(data) != file["bytes"] or not _hash_matches(data, file["sha256"]):
                    _fail("artifact.hash_mismatch")
                if file["mediaType"] == "application/json":
                    validate_json(_parse(data))
                else:
                    data.decode("utf-8", errors="strict")
                total += len(data)
        if seen != expected_rows or total > MAX_EXPORT or (not has_selection and m["localInspection"] != "not_requested"):
            _fail()
        actual = list(directory.iterdir())
        if len(actual) != len(filenames) or any(file.name.lower() not in filenames for file in actual):
            _fail()
        provenance = "self_consistent"
        if online is not None:
            if not _keys(online, ("readConfigPath", "expectedHandoff")):
                _fail("config.schema")
            remote = _authority(None, online["readConfigPath"], online["expectedHandoff"])
            if not _equal(remote[4], p):
                _fail("evidence.identity_mismatch")
            provenance = "online_scalar_binding"
        return {"schemaVersion": 1, "status": "verified", "provenance": provenance,
                "comparisonId": m["comparisonId"], "executionAttested": False}
    except EvaluationError:
        raise
    except (OSError, ValueError, KeyError, TypeError, OverflowError, RecursionError):
        _fail()
