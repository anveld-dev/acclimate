"""HTTP request and response dictionaries.

Keys use the service's camelCase wire names. Python method arguments and
attributes use snake_case.
"""

from typing import Any, Generic, Literal, NotRequired, TypedDict, TypeVar

_T = TypeVar("_T")

FileKind = Literal["instruction", "skill", "memory"]
CompatibilityTarget = Literal["generic", "codex", "claude", "pi", "cursor"]


class BundleFile(TypedDict):
    path: str
    kind: FileKind
    text: str


class BundlePayload(TypedDict):
    schemaVersion: Literal[1]
    files: list[BundleFile]


class CreateBundleRequest(TypedDict):
    name: str
    compatibilityTarget: NotRequired[CompatibilityTarget]


class Bundle(TypedDict):
    id: str
    name: str
    workspaceId: str
    compatibilityTarget: CompatibilityTarget
    createdAt: str


class VersionMetadata(TypedDict):
    id: str
    bundleId: str
    parentVersionId: str | None
    digest: str
    createdAt: str


class ChannelResolution(TypedDict):
    channel: str
    revision: str
    version: VersionMetadata


class CreateVersionRequest(TypedDict):
    parentVersionId: str | None
    payload: BundlePayload


class CreateReleaseRequest(TypedDict):
    versionId: str
    expectedRevision: str
    unevaluatedReason: str


class Release(TypedDict):
    id: str
    channel: str
    revision: str
    version: VersionMetadata
    previousVersionId: str | None
    unevaluatedReason: str | None
    reviewer: str
    createdAt: str


class ReleasePage(TypedDict):
    items: list[Release]
    nextBeforeRevision: str | None


class VerifiedVersionConnection(TypedDict):
    workspaceId: str
    connectionId: str


class VerifiedVersion(TypedDict):
    version: VersionMetadata
    payload: BundlePayload
    resolution: NotRequired[ChannelResolution]
    resolvedAt: float
    stale: bool
    # Present when the SDK resolved the bundle for an explicitly scoped connection.
    connection: NotRequired[VerifiedVersionConnection]


class ConnectionLatestObservation(TypedDict):
    eventId: str
    stage: str
    versionId: str
    digest: str
    occurredAt: str
    receivedAt: str


class ConnectionObservation(TypedDict):
    id: str
    displayName: str
    bundleId: str
    channel: str
    enabled: bool
    latestObservation: ConnectionLatestObservation | None


class ConnectionObservationPage(TypedDict):
    items: list[ConnectionObservation]
    nextCursor: str | None


class Page(TypedDict, Generic[_T]):
    """A bounded service listing. Send ``nextCursor`` back unchanged as ``cursor``."""

    items: list[_T]
    nextCursor: str | None


class Workspace(TypedDict):
    id: str
    name: str
    role: str


class Channel(TypedDict):
    name: str
    revision: str
    versionId: str


BundleOrigin = Literal["created", "example", "imported", "unknown"]


class BundleSetupRequest(TypedDict):
    name: str
    origin: Literal["created", "example", "imported"]
    channel: str
    payload: BundlePayload
    reason: str
    compatibilityTarget: NotRequired[CompatibilityTarget]
    sourceLabel: NotRequired[str]


class BundleSetup(TypedDict):
    bundle: Bundle
    version: VersionMetadata
    resolution: ChannelResolution
    promotion: Release


ConnectionCredentialKind = Literal["content-read", "receipt-write"]


class ConnectionCredentialSummary(TypedDict):
    id: str
    kind: ConnectionCredentialKind
    createdAt: str
    revokedAt: str | None


class Connection(TypedDict):
    id: str
    workspaceId: str
    bundleId: str
    channel: str
    displayName: str
    enabled: bool
    createdAt: str
    credentials: NotRequired[list[ConnectionCredentialSummary]]


class CreateConnectionRequest(TypedDict):
    bundleId: str
    channel: str
    displayName: str


class ConnectionCredential(TypedDict):
    id: str
    kind: ConnectionCredentialKind
    secret: str


class DeliveryReceiptRequest(TypedDict):
    eventId: str
    connectionId: str
    workspaceId: str
    bundleId: str
    versionId: str
    digest: str
    stage: Literal["resolved", "downloaded", "verified", "prepared", "started"]
    occurredAt: str
    source: Literal["network", "cache", "offline"]
    channel: NotRequired[str | None]
    revision: NotRequired[str | None]
    resolvedAt: NotRequired[str | None]
    stale: NotRequired[bool | None]


class DeliveryReceipt(DeliveryReceiptRequest):
    receivedAt: str
    delayed: bool


class OfflineMaxAge(TypedDict):
    """Use a cached channel resolution up to this age after a transport failure or HTTP 503."""

    max_age_ms: int


class OfflinePinnedVersion(TypedDict):
    """Use the cached copy of this exact version after a transport failure or HTTP 503."""

    pinned_version_id: str


OfflinePolicy = OfflineMaxAge | OfflinePinnedVersion


class OperationCommitted(TypedDict):
    status: Literal["committed"]
    operationId: str
    path: str
    requestFingerprint: NotRequired[str]
    result: BundleSetup | Release | VersionMetadata | dict


class OperationNotObserved(TypedDict):
    status: Literal["not_observed"]
    operationId: str


class OperationClosed(TypedDict):
    status: Literal["closed"]
    operationId: str
    path: NotRequired[str]


Operation = OperationCommitted | OperationNotObserved | OperationClosed

__all__ = [
    "FileKind",
    "CompatibilityTarget",
    "BundleFile",
    "BundlePayload",
    "CreateBundleRequest",
    "Bundle",
    "VersionMetadata",
    "ChannelResolution",
    "CreateVersionRequest",
    "CreateReleaseRequest",
    "Release",
    "ReleasePage",
    "VerifiedVersion",
    "VerifiedVersionConnection",
    "ConnectionLatestObservation",
    "ConnectionObservation",
    "ConnectionObservationPage",
    "Page",
    "Workspace",
    "Channel",
    "BundleOrigin",
    "BundleSetupRequest",
    "BundleSetup",
    "ConnectionCredentialKind",
    "ConnectionCredentialSummary",
    "Connection",
    "CreateConnectionRequest",
    "ConnectionCredential",
    "DeliveryReceiptRequest",
    "DeliveryReceipt",
    "OfflineMaxAge",
    "OfflinePinnedVersion",
    "OfflinePolicy",
    "OperationCommitted",
    "OperationNotObserved",
    "OperationClosed",
    "Operation",
]
