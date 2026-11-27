"""Resolve and stage channel versions by bundle name."""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

from .client import AcclimateClient
from .delivery import PreparedDelivery, _stage_delivery, resolve_and_cache, validate_payload
from .errors import UsageError
from .types import BundlePayload, ReleaseResult, VerifiedVersion


def payload_digest(payload: BundlePayload) -> str:
    """The digest the service stores: SHA-256 of the payload's compact JSON, fields in schema order, and a newline."""
    canonical = {
        "schemaVersion": payload["schemaVersion"],
        "files": [{"path": f["path"], "kind": f["kind"], "text": f["text"]} for f in payload["files"]],
    }
    data = json.dumps(canonical, ensure_ascii=False, separators=(",", ":")) + "\n"
    return "sha256:" + hashlib.sha256(data.encode()).hexdigest()


def _reason(reason: str) -> str:
    if not isinstance(reason, str) or not reason.strip():
        raise UsageError("reason is required. It is recorded with the release.", "reason")
    return reason


def _setting(value: str | None, name: str) -> str:
    value = os.getenv(name) if value is None else value
    if not value:
        raise UsageError(f"Set {name}.", name)
    return value


class Acclimate:
    def __init__(
        self, url: str | None = None, workspace: str | None = None, token: str | None = None,
        *, cache_dir: str | Path | None = None,
    ):
        url = _setting(url, "ACCLIMATE_URL")
        workspace = _setting(workspace, "ACCLIMATE_WORKSPACE")
        token = _setting(token, "ACCLIMATE_TOKEN")
        scope = "python:" + hashlib.sha256(token.encode()).hexdigest()
        self.client = AcclimateClient(url, token, scope)
        self.workspace = workspace
        self.cache_dir = Path(cache_dir) if cache_dir is not None else (
            Path.home().resolve() / ".cache" / "acclimate" / "python"
        )

    @classmethod
    def from_env(cls, *, cache_dir: str | Path | None = None) -> "Acclimate":
        """Read ACCLIMATE_URL, ACCLIMATE_WORKSPACE and ACCLIMATE_TOKEN."""
        return cls(cache_dir=cache_dir)

    def _bundle_id(self, name: str) -> str:
        cursor = None
        while True:
            page = self.client.list_bundles(self.workspace, cursor=cursor)
            for bundle in page["items"]:
                if bundle["name"] == name:
                    return bundle["id"]
            cursor = page["nextCursor"]
            if cursor is None:
                raise UsageError(f"No bundle named {name!r} in workspace {self.workspace!r}.", "bundle")

    def release(self, bundle: str, payload: BundlePayload, *, channel: str = "stable",
                reason: str) -> ReleaseResult:
        """Upload ``payload`` as a new version of the named bundle and release it on ``channel``.

        A payload identical to the channel's current version changes nothing and returns it. A
        channel that moved during the call raises ``ApiError`` with code ``revision_conflict``.
        """
        _reason(reason)
        validate_payload(payload)
        bundle_id = self._bundle_id(bundle)
        current = self.client.inspect_source(self.workspace, bundle_id, channel)
        if current and current["version"]["digest"] == payload_digest(payload):
            return {"bundleId": bundle_id, "channel": channel, "revision": current["revision"],
                    "version": current["version"], "changed": False}
        version = self.client.create_version(
            self.workspace, bundle_id,
            {"parentVersionId": current["version"]["id"] if current else None, "payload": payload},
            str(uuid4()),
        )
        release = self.client.create_release(
            self.workspace, bundle_id, channel,
            {"versionId": version["id"], "expectedRevision": current["revision"] if current else "0",
             "unevaluatedReason": reason},
            str(uuid4()),
        )
        return {"bundleId": bundle_id, "channel": channel, "revision": release["revision"],
                "version": release["version"], "changed": True}

    def rollback(self, bundle: str, *, channel: str = "stable", reason: str) -> ReleaseResult:
        """Release the version the channel served before its latest release."""
        _reason(reason)
        bundle_id = self._bundle_id(bundle)
        items = self.client.list_releases(self.workspace, bundle_id, channel, limit=1)["items"]
        if not items or not items[0]["previousVersionId"]:
            raise UsageError("The channel has no earlier version to roll back to.", "channel")
        latest = items[0]
        release = self.client.create_release(
            self.workspace, bundle_id, channel,
            {"versionId": latest["previousVersionId"], "expectedRevision": latest["revision"],
             "unevaluatedReason": reason},
            str(uuid4()),
        )
        return {"bundleId": bundle_id, "channel": channel, "revision": release["revision"],
                "version": release["version"], "changed": True}

    def job(self, bundle: str, *, channel: str = "stable") -> "Job":
        """Pin a verified channel version for one production job."""
        bundle_id = self._bundle_id(bundle)
        version = resolve_and_cache(
            self.client, self.workspace, bundle_id, channel=channel, cache_dir=str(self.cache_dir)
        )
        return Job(version)


class Job:
    def __init__(self, version: VerifiedVersion):
        self._version = deepcopy(version)

    @property
    def version(self) -> VerifiedVersion:
        return deepcopy(self._version)

    def prepare(self, destination: str | Path | None = None) -> PreparedDelivery:
        """Stage the pinned payload using the SDK's delivery context manager."""
        return _stage_delivery(self.version, destination)
