"""These application mistakes must remain static errors; never execute this file."""
from acclimate import (
    AcclimateClient, CreateReleaseRequest, VerifiedVersionConnection,
)
bad_release: CreateReleaseRequest = {"versionId": "v", "expectedRevision": "0"}  # reject: typeddict-item


def legacy_offline_option(client: AcclimateClient) -> None:
    client.prepare("p", "b", channel="stable", offline_max_age=60)  # reject: call-arg

# A connection names both its workspace and its connection, with the canonical keys.
partial_connection: VerifiedVersionConnection = {"workspaceId": "w"}  # reject: typeddict-item
