# Small service interface

[Design guide](README.md)

The service keeps [workspace records](../../CONTEXT.md#public-glossary) in PostgreSQL. Your application runs and grades the agent jobs that produce outcomes.

## The records

A workspace contains bundles and connections. Each bundle version has an ID and a SHA-256 digest of its exact UTF-8 JSON payload. A channel points to a version. Proposals track suggested changes, comparisons record results from the application, and releases record the decision that changed which version jobs receive.

## Proposed HTTP operations

- List workspaces at `/v1/workspaces` and connections at `/v1/workspaces/{workspaceId}/connections`.
- Create and read bundle versions, then download their exact bytes for verification.
- Read a channel to find the current version and revision.
- Submit proposals and comparisons for a bundle.
- Create or list releases at `/v1/workspaces/{workspaceId}/bundles/{bundleId}/channels/{channel}/releases`.

Each workspace grants read, edit and release access separately. A release checks the current revision and records its supporting comparison or the reason for releasing without one. When retrying a write after a lost response, send the same request bytes and key. The [HTTP contract](../../contracts/openapi.json) describes the routes and responses.

## The proposal job

The service saves a proposal before processing it and records the candidate version if it produces usable edits. The app runs the parent and candidate on the same cases and submits the comparison.

## Connected learning

A connection can use outcomes and their approved corrections to start proposals. The application compares each candidate with an existing version and checks it again on separate cases before release. A connection can require review or allow releases when its configured checks pass. After release, new jobs use the released version. Jobs already running keep the version they started with.

[Connection setup](../../deploy/README.md#operate-connected-learning) · [Service contract](../../contracts/learning.md)

## Production basics that stay

Use TLS and credentials scoped to the application’s needs. Keep secrets out of bundles and restrict access to private evidence. Back up the database and test restoring versions and release history.
