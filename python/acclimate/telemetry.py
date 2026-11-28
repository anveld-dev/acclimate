"""OpenTelemetry-compatible metadata helpers for Acclimate deliveries."""

from __future__ import annotations

from typing import Any, Protocol

from .types import VerifiedVersion


class _HasVersion(Protocol):
    version: VerifiedVersion


def extract_verified_version(source: VerifiedVersion | _HasVersion) -> VerifiedVersion:
    """Accept either a ``VerifiedVersion`` dict or a prepared delivery object."""
    if isinstance(source, dict):
        return source
    return source.version


def telemetry_attributes(source: VerifiedVersion | _HasVersion) -> dict[str, str | bool]:
    """Return OpenTelemetry-compatible attributes describing a delivered bundle version."""
    verified = extract_verified_version(source)
    meta = verified["version"]
    attrs: dict[str, str | bool] = {
        "acclimate.bundle_id": meta["bundleId"],
        "acclimate.version_id": meta["id"],
        "acclimate.digest": meta["digest"],
        "acclimate.stale": bool(verified.get("stale", False)),
    }
    resolution: Any = verified.get("resolution")
    if isinstance(resolution, dict):
        if isinstance(resolution.get("channel"), str):
            attrs["acclimate.channel"] = resolution["channel"]
        if isinstance(resolution.get("revision"), str):
            attrs["acclimate.revision"] = resolution["revision"]
    return attrs
