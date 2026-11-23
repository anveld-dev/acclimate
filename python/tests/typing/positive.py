"""Consumer of the public delivery and outcome annotations."""
from typing import Literal, assert_type

from acclimate import (
    Acclimate,
    AcclimateClient,
    Job,
    LearningJson,
    LearningOutcomeReceipt,
    ApiError,
    TransportError,
    DeliveryError,
    PreparedFiles,
    PreparedDelivery,
    prepare_files,
    resolve_and_cache,
    validate_payload,
    DeliveryReporter,
    BoundDeliveryReporter,
    FileKind,
    CompatibilityTarget,
    BundleFile,
    BundlePayload,
    CreateBundleRequest,
    Bundle,
    VersionMetadata,
    ChannelResolution,
    CreateVersionRequest,
    CreateReleaseRequest,
    Release,
    ReleasePage,
    VerifiedVersion,
    VerifiedVersionConnection,
    ConnectionLatestObservation,
    ConnectionObservation,
    ConnectionObservationPage,
    OperationCommitted,
    OperationNotObserved,
    OperationClosed,
    Operation,
    Page,
    Workspace,
    Channel,
    BundleSetup,
    BundleSetupRequest,
    Connection,
)
def release(client: AcclimateClient, request: CreateReleaseRequest) -> None:
    assert_type(client.create_release("p", "b", "stable", request, "key"), Release)


def delivery(client: AcclimateClient, api_error: ApiError) -> None:
    with client.prepare("p", "b", channel="stable") as job:
        assert_type(job, PreparedDelivery)
        assert_type(job.version, VerifiedVersion)
        assert_type(job.version["version"], VersionMetadata)
        assert_type(job.instructions, str)
    assert_type(api_error.status, int)
    version = resolve_and_cache(client, "workspace", "bundle", channel="stable", cache_dir="/private/cache")
    assert_type(version, VerifiedVersion)
    assert_type(version["payload"], BundlePayload)
    assert_type(prepare_files(version, "/private/workspace"), PreparedFiles)
    validate_payload(version["payload"])
    stale = resolve_and_cache(client, "workspace", "bundle", version_id="v1", cache_dir="/private/cache",
                              offline={"pinned_version_id": "v1"})
    assert_type(stale["stale"], bool)
    connection = version.get("connection")
    if connection is not None:
        assert_type(connection, VerifiedVersionConnection)
        assert_type(connection["workspaceId"], str)
        assert_type(connection["connectionId"], str)
    pinned = client.prepare("p", "b", version_id="v", offline={"pinned_version_id": "v"})
    pinned.cleanup()
    assert_type(api_error.request_id, str)


def listings(client: AcclimateClient, setup: BundleSetupRequest) -> None:
    workspaces = client.list_workspaces(limit=10)
    assert_type(workspaces, Page[Workspace])
    assert_type(workspaces["nextCursor"], str | None)
    assert_type(client.list_channels("p", "b")["items"], list[Channel])
    assert_type(client.list_connections("p")["items"], list[Connection])
    assert_type(client.create_bundle_setup("p", setup, "key"), BundleSetup)


def learning(client: AcclimateClient, input: LearningJson) -> None:
    job = Acclimate.from_env().job("support", channel="stable", input=input)
    assert_type(job, Job)
    assert_type(job.version, VerifiedVersion)
    assert_type(job.outcome_id, str)
    assert_type(job.prepare(), PreparedDelivery)
    assert_type(job.expect({"action": "refund"}), LearningOutcomeReceipt)
