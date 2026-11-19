import base64
import errno
from contextlib import AbstractContextManager
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Literal
from .client import AcclimateClient, ApiError, TransportError
from .errors import AcclimateError, UsageError
from .types import BundlePayload, VerifiedVersion
from .receipts import BoundDeliveryReporter


DeliveryErrorCode = Literal["cache_miss", "collision", "digest_mismatch", "invalid_cache", "invalid_payload",
                           "invalid_response", "stale_resolution", "unsafe_cache", "unsafe_destination",
                           "unsafe_path", "unsupported_platform", "unsupported_schema"]


class DeliveryError(AcclimateError):
    """Delivered content could not be resolved, verified, cached or written safely."""

    code: DeliveryErrorCode

    def __init__(self, code: DeliveryErrorCode, message: str):
        super().__init__(code, message)


def validate_payload(value: Any) -> None:
    if (
        not isinstance(value, dict)
        or set(value) != {"schemaVersion", "files"}
        or type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != 1
        or not isinstance(value["files"], list)
        or not 1 <= len(value["files"]) <= 128
    ):
        raise DeliveryError(
            "unsupported_schema", "Unsupported or malformed bundle payload schema"
        )
    paths = set()
    total = 0
    for f in value["files"]:
        if (
            not isinstance(f, dict)
            or set(f) != {"path", "kind", "text"}
            or not isinstance(f["path"], str)
            or not isinstance(f["text"], str)
            or f["kind"] not in ("instruction", "skill", "memory")
        ):
            raise DeliveryError("invalid_payload", "Bundle contains an invalid file")
        p = f["path"]
        if (
            not p
            or len(p) > 240
            or not re.fullmatch(r"[-A-Za-z0-9._/]+", p)
            or any(
                not x
                or x in (".", "..")
                or re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", x)
                for x in p.split("/")
            )
        ):
            raise DeliveryError("invalid_payload", "Bundle contains an unsafe path")
        lower = p.lower()
        if lower in paths or any(
            lower.startswith(x + "/") or x.startswith(lower + "/") for x in paths
        ):
            raise DeliveryError("invalid_payload", "Bundle contains colliding paths")
        paths.add(lower)
        try:
            size = len(f["text"].encode("utf-8"))
        except UnicodeError as e:
            raise DeliveryError("invalid_payload", "Invalid text encoding") from e
        if size > 256 * 1024:
            raise DeliveryError("invalid_payload", "File exceeds size limit")
        total += size
    if total > 1048576:
        raise DeliveryError("invalid_payload", "Bundle exceeds size limit")


def _private_dir(path: str) -> int:
    if os.name != "posix":
        raise DeliveryError(
            "unsupported_platform", "Private filesystem helpers require POSIX"
        )
    path = os.path.abspath(path)
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:]:
            try:
                os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            try:
                child = os.open(
                    part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd
                )
            except OSError as e:
                raise DeliveryError(
                    "unsafe_destination", "Path contains a symlink or non-directory"
                ) from e
            os.close(fd)
            fd = child
        metadata = os.fstat(fd)
        if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077:
            raise DeliveryError(
                "unsafe_destination",
                "Existing directory must be private and owned by the current user",
            )
        return fd
    except BaseException:
        os.close(fd)
        raise


def _key(client: AcclimateClient, *parts: str) -> str:
    return hashlib.sha256(
        "\0".join((client.base_url, client.scope, *parts)).encode()
    ).hexdigest()


def _read(fd: int, key: str) -> Any:
    try:
        f = os.open(key, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise DeliveryError("unsafe_cache", "Unsafe cache entry") from e
    try:
        if not stat.S_ISREG(os.fstat(f).st_mode):
            raise DeliveryError("unsafe_cache", "Unsafe cache entry")
        with os.fdopen(f, "rb", closefd=False) as stream:
            data = stream.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise DeliveryError("unsafe_cache", "Cache entry too large")
        try:
            return json.loads(data)
        except (ValueError, UnicodeError) as e:
            raise DeliveryError("invalid_cache", "Malformed cache entry") from e
    finally:
        os.close(f)


def _write(fd: int, key: str, value: Any) -> None:
    name = ".tmp-" + os.urandom(16).hex()
    f = os.open(
        name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd
    )
    try:
        with os.fdopen(f, "w", encoding="utf-8") as out:
            json.dump(value, out, separators=(",", ":"), ensure_ascii=True)
        os.replace(name, key, src_dir_fd=fd, dst_dir_fd=fd)
    finally:
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            pass


def _version(v: Any, bundle_id: str, version_id: str | None = None) -> None:
    if (
        not isinstance(v, dict)
        or not isinstance(v.get("id"), str)
        or not v["id"]
        or (version_id is not None and v["id"] != version_id)
        or v.get("bundleId") != bundle_id
        or not isinstance(v.get("digest"), str)
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", v["digest"])
        or not isinstance(v.get("createdAt"), str)
        or not (
            v.get("parentVersionId") is None
            or isinstance(v.get("parentVersionId"), str)
        )
        or "parentVersionId" not in v
    ):
        raise DeliveryError("invalid_response", "Malformed version metadata")


def _fallback(exc: Exception) -> bool:
    return (
        isinstance(exc, TransportError)
        or isinstance(exc, ApiError)
        and exc.status == 503
    )


def resolve_and_cache(
    client: AcclimateClient,
    project_id: str,
    bundle_id: str,
    *,
    cache_dir: str,
    channel: str | None = None,
    version_id: str | None = None,
    offline_max_age: float | None = None,
    offline_pinned_version: str | None = None,
    max_cache_bytes: int = 20 * 1024 * 1024,
    reporter=None,
) -> VerifiedVersion:
    """Resolve online by default. Offline age is seconds; a pin permits that exact version."""
    if (channel is None) == (version_id is None):
        raise UsageError("Select exactly one channel or version_id", "selection")
    if offline_max_age is not None and (not 0 <= offline_max_age <= 30 * 86400):
        raise UsageError("offline_max_age must be between 0 and 30 days", "offline_max_age")
    if offline_max_age is not None and offline_pinned_version is not None:
        raise UsageError("Choose one offline policy", "offline_pinned_version")
    if not 1 <= max_cache_bytes <= 1024 * 1024 * 1024:
        raise UsageError("invalid max_cache_bytes", "max_cache_bytes")
    fd = _private_dir(cache_dir)
    now = time.time()
    stale = False
    resolved_at = now
    resolution = None
    try:
        if channel is not None:
            key = _key(client, project_id, bundle_id, "channel", channel)
            old = _read(fd, key)
            try:
                response, etag, not_modified = client.resolve_channel(
                    project_id,
                    bundle_id,
                    channel,
                    etag=old.get("etag") if isinstance(old, dict) else None,
                )
                if not_modified:
                    if not isinstance(old, dict) or not old.get("resolution"):
                        raise DeliveryError("cache_miss", "304 without cached mapping")
                    resolution = old["resolution"]
                    etag = etag or old.get("etag")
                else:
                    resolution = response
                if (
                    not isinstance(resolution, dict)
                    or resolution.get("channel") != channel
                    or not isinstance(resolution.get("revision"), str)
                    or not re.fullmatch(r"[0-9]+", resolution["revision"])
                ):
                    raise DeliveryError(
                        "invalid_response", "Malformed channel resolution"
                    )
                _version(resolution.get("version"), bundle_id)
                _write(
                    fd, key, {"resolution": resolution, "resolvedAt": now, "etag": etag}
                )
            except (TransportError, ApiError) as e:
                if (
                    not _fallback(e)
                    or not isinstance(old, dict)
                    or not isinstance(old.get("resolvedAt"), (int, float))
                    or not isinstance(old.get("resolution"), dict)
                ):
                    raise
                resolution = old["resolution"]
                _version(resolution.get("version"), bundle_id)
                if (
                    resolution.get("channel") != channel
                    or not isinstance(resolution.get("revision"), str)
                    or not re.fullmatch(r"[0-9]+", resolution["revision"])
                ):
                    raise DeliveryError("invalid_cache", "Malformed cached resolution")
                age = max(0, now - old["resolvedAt"])
                if not (
                    (offline_max_age is not None and age <= offline_max_age)
                    or (
                        offline_pinned_version is not None
                        and resolution["version"]["id"] == offline_pinned_version
                    )
                ):
                    raise
                stale = True
                resolved_at = old["resolvedAt"]
            version = resolution["version"]
        else:
            assert version_id is not None
            index_key = _key(client, project_id, bundle_id, "version", version_id)
            try:
                version = client.get_version(project_id, bundle_id, version_id)
            except (TransportError, ApiError) as e:
                if not _fallback(e) or offline_pinned_version != version_id:
                    raise
                old = _read(fd, index_key)
                if not isinstance(old, dict) or not isinstance(
                    old.get("cachedAt"), (int, float)
                ):
                    raise DeliveryError(
                        "cache_miss", "Pinned version is not cached"
                    ) from e
                version = old.get("version")
                stale = True
                resolved_at = old["cachedAt"]
            _version(version, bundle_id, version_id)
        payload_key = _key(
            client, project_id, bundle_id, version["id"], version["digest"]
        )
        cached = _read(fd, payload_key)
        data = None
        if isinstance(cached, dict):
            try:
                data = base64.b64decode(cached["payloadBytes"], validate=True)
            except (ValueError, KeyError, TypeError):
                raise DeliveryError("invalid_cache", "Malformed cached payload")
            if (
                len(data) > 1048576
                or "sha256:" + hashlib.sha256(data).hexdigest() != version["digest"]
            ):
                raise DeliveryError("digest_mismatch", "Cached payload digest mismatch")
        downloaded = data is None
        if data is None:
            data = client.get_payload(project_id, bundle_id, version["id"])
            if len(data) > 1048576:
                raise DeliveryError("invalid_payload", "Payload exceeds size limit")
            if "sha256:" + hashlib.sha256(data).hexdigest() != version["digest"]:
                raise DeliveryError(
                    "digest_mismatch", "Downloaded payload digest mismatch"
                )
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeError, ValueError) as e:
            raise DeliveryError("invalid_payload", "Payload is not UTF-8 JSON") from e
        validate_payload(payload)
        if cached is None:
            _write(
                fd,
                payload_key,
                {"payloadBytes": base64.b64encode(data).decode("ascii")},
            )
        if not stale:
            _write(
                fd,
                _key(client, project_id, bundle_id, "version", version["id"]),
                {"version": version, "cachedAt": now},
            )
        # Evict oldest regular entries without following symlinks; preserve the payload just used.
        entries = []
        for name in os.listdir(fd):
            if not re.fullmatch("[a-f0-9]{64}", name):
                continue
            s = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(s.st_mode):
                raise DeliveryError("unsafe_cache", "Unsafe cache entry")
            entries.append((s.st_mtime, name, s.st_size))
        total = sum(x[2] for x in entries)
        for _, name, size in sorted(entries):
            if total <= max_cache_bytes:
                break
            if name == payload_key:
                continue
            os.unlink(name, dir_fd=fd)
            total -= size
        result: VerifiedVersion = {
            "version": version,
            "payload": payload,
            "resolvedAt": resolved_at * 1000,
            "stale": stale,
        }
        if resolution is not None:
            result["resolution"] = resolution
        if reporter is not None:
            try:
                source = "network" if downloaded else "offline" if stale else "cache"
                bound = reporter.bind(bundle_id, result, source)
                if resolution is not None:
                    bound.report("resolved")
                if downloaded:
                    bound.report("downloaded")
                bound.report("verified")
                result["reporter"] = bound
            except Exception:
                pass
        return result
    finally:
        os.close(fd)


class PreparedFiles:
    def __init__(
        self,
        root_fd: int,
        files: list[dict[str, str]],
        created: list[tuple[int, str, bool]],
    ):
        self.files, self._root_fd, self._created = files, root_fd, created

    def cleanup(self) -> None:
        if self._root_fd is None:
            return
        for fd, name, is_dir in reversed(self._created):
            try:
                if is_dir:
                    os.rmdir(name, dir_fd=fd)
                else:
                    os.unlink(name, dir_fd=fd)
            except FileNotFoundError:
                pass
            except OSError as error:
                if not is_dir or error.errno not in (errno.ENOTEMPTY, errno.EEXIST):
                    raise
            finally:
                os.close(fd)
        os.close(self._root_fd)
        self._root_fd = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.cleanup()


class PreparedDelivery(AbstractContextManager["PreparedDelivery"]):
    """Pinned instructions, staged skills and the complete file inventory for one job."""

    def __init__(self, bundle: VerifiedVersion, staged: PreparedFiles, directory: str, owned: bool):
        self.bundle = bundle
        self.version = bundle["version"]
        self.files = staged.files
        self.directory = directory
        self.instructions = "\n\n".join(f["text"] for f in bundle["payload"]["files"] if f["kind"] == "instruction")
        self.skill_files = [f for f in self.files if f["kind"] == "skill"]
        self._staged = staged
        self._owned = owned
        self._started = False
        self._started_receipt: dict[str, Any] | None = None
        self._refused_start: dict[str, Any] | None = None
        self._start_lock = threading.Lock()

    def report_started(self) -> dict[str, Any] | None:
        """Queue this job's start once and return a copy of its exact audit receipt."""
        with self._start_lock:
            if not self._started:
                self._started = True
                binding = self.bundle.get("reporter")
                if binding is not None:
                    try:
                        if isinstance(binding, BoundDeliveryReporter):
                            receipt, queued = binding._queue_prepared_start(self._refused_start)
                            if not queued:
                                self._refused_start = receipt
                                self._started = False
                                return None
                            self._refused_start = None
                        else:
                            receipt = binding.report_started()
                        if isinstance(receipt, dict):
                            self._started_receipt = receipt.copy()
                    except Exception:
                        pass
            return self._started_receipt.copy() if self._started_receipt is not None else None

    def cleanup(self) -> None:
        self._staged.cleanup()
        if self._owned:
            _remove_job_directory(self.directory)
            self._owned = False

    def __exit__(self, *args) -> None:
        self.cleanup()


def _remove_job_directory(directory: str) -> None:
    try:
        os.rmdir(directory)
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ENOTEMPTY, errno.EEXIST):
            raise


def prepare_files(bundle: VerifiedVersion, destination: str) -> PreparedFiles:
    validate_payload(bundle["payload"])
    root = os.path.abspath(destination)
    root_fd = _private_dir(root)
    result = PreparedFiles(root_fd, [], [])
    try:
        for item in bundle["payload"]["files"]:
            parts = item["path"].split("/")
            current = os.dup(root_fd)
            try:
                for segment in parts[:-1]:
                    names = os.listdir(current)
                    if any(
                        n.lower() == segment.lower() and n != segment for n in names
                    ):
                        raise DeliveryError(
                            "collision", "Destination has case collision"
                        )
                    try:
                        os.mkdir(segment, 0o700, dir_fd=current)
                        result._created.append((os.dup(current), segment, True))
                    except FileExistsError:
                        pass
                    try:
                        child = os.open(
                            segment,
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=current,
                        )
                    except OSError as e:
                        raise DeliveryError(
                            "unsafe_destination", "Unsafe destination path"
                        ) from e
                    os.close(current)
                    current = child
                name = parts[-1]
                if any(n.lower() == name.lower() for n in os.listdir(current)):
                    raise DeliveryError(
                        "collision", "Destination file already exists or case collides"
                    )
                f = os.open(
                    name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600,
                    dir_fd=current,
                )
                result._created.append((os.dup(current), name, False))
                with os.fdopen(f, "w", encoding="utf-8", newline="") as out:
                    out.write(item["text"])
                result.files.append(
                    {
                        "path": item["path"],
                        "kind": item["kind"],
                        "absolutePath": os.path.join(root, *parts),
                    }
                )
            finally:
                os.close(current)
        reporter = bundle.get("reporter")
        if reporter is not None:
            try:
                reporter.report_prepared()
            except Exception:
                pass
        return result
    except BaseException:
        result.cleanup()
        raise
