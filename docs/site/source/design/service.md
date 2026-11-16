# Small service interface

[Design guide](README.md)

Use one Rust HTTP service and one database. Its job is content versions, proposals, comparison records, and channel updates. The agent application is a separate system.

## The records

| Record | Minimum fields |
| --- | --- |
| Bundle | Project/scope, ID, name, access policy. |
| Version | Bundle, immutable ID/payload/digest, parent, author, creation time. |
| Channel | Bundle, name, selected version, increasing revision. |
| Proposal | Parent, allowed edit scope, rationale, evidence refs, candidate, status. |
| Comparison | Version/dataset/grader identities, expected cases, results, completeness, submitter. |
| Promotion | Selected version, evidence or unevaluated reason, reviewer, previous version, old/new channel revisions. |

A version payload is a small UTF-8 JSON document containing a schema version and relative-path/kind/text entries. Store and return its exact bytes; the separate version record names their SHA-256 digest. Small file contents can live in the same PostgreSQL database as metadata, with project byte limits. Add external blob storage only when actual size or retention needs justify it.

## Proposed HTTP operations

R0 implements these operations. `contracts/openapi.yaml` and `contracts/IMPLEMENTATION.md` define the routes and limits. Content requests are authenticated and project-scoped; `/health` is public liveness.

| Operation | Result |
| --- | --- |
| Create/read a bundle version | Immutable content and version metadata. Reusing a mutation key with another payload conflicts. |
| Resolve a channel | Revision, version ID, and digest; supports conditional ETag reads. |
| Download version payload | Exact immutable bytes for SDK verification. |
| Create a proposal / ask for a proposed edit | Parent-bound candidate job, then a diff and rationale. |
| Upload/read a comparison | Application-reported evidence with explicit incomplete states. |
| Read decision history | Scoped pages in newest-revision-first order; an exclusive older-revision cursor. |
| Promote/rollback a channel | Authorized compare-and-swap update, candidate/parent evidence binding, and decision record. |

A reader only needs read access. Proposal/evidence submission and channel updates require separate rights. SDK or bundle fields cannot grant new rights. Return clear errors for denial, missing content, invalid schema, revision conflicts, and unavailable dependencies.

Mutations use caller-supplied idempotency keys scoped to identity/project/operation and target resource. Include the method, scoped route, and exact body bytes in the request fingerprint. Publish the retention window; duplicate protection isn't permanent after expiry. A lost HTTP response is a reason to retry the same key, not create another proposal.

## The proposal job

Persist the request and status before acknowledging it. A bounded in-process background loop handles proposal model calls; no broker or general-purpose workflow engine is required initially.

Record each attempt and any returned candidate before marking completion. After a restart, identify interrupted jobs and apply the bounded retry policy or mark them for explicit retry. A completed candidate is reused. This promises recoverable proposal records, not exactly-once model billing or recovery of the consuming agent's session.

The proposer uses its own configured provider access. It never needs the app's agent credentials or a gateway intercepting app traffic. Applications run evaluations where they already run their background agents and upload the results.

## Production basics that stay

Use TLS, scoped credentials, content/path/size validation, request and proposal concurrency limits, and retention rules for private evidence. Do not put secrets in bundles. Record sensitive writes and promotions. Restrict who can read private memory and evidence.

Back up the database, including version payloads and channel history, and test restore. Retain versions referenced by a channel or required rollback policy. Monitor delivery errors, proposal failures, queue age, and storage growth. Choose availability/restore targets appropriate to this service; do not inherit a worker-fleet SLO program.

The initial target is one trusted organization with project scopes. Hostile multi-tenancy, hosted plugin execution, a package-signing ecosystem, cache daemons, and agent deployment controllers are separate future decisions.
