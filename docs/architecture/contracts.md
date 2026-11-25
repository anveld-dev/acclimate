# Shared contracts

[OpenAPI](../../contracts/openapi.json) defines the workspace HTTP API and errors. The TypeScript SDK and Python SDK match its camelCase wire fields. [Bundle schema](../../contracts/bundle.schema.json) describes immutable payloads. Verify the digest on the exact downloaded bytes before parsing and preparing files.

The workspace contract includes bundles and versions, channel resolution and releases, access and machine credentials, and application connections and delivery receipts. Bundle setup and channel release support retained operation results. Use the same key and exact request bytes when retrying.

A release sends `versionId`, `expectedRevision` and `unevaluatedReason`. The expected revision prevents concurrent writers from silently overwriting a channel selection. See the [HTTP reference](../../apps/docs/content/docs/reference/http-api.mdx) for route examples and the [learning contract](../../contracts/learning.md) for enrollment, evaluation and round history.
