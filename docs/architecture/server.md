# Rust server plan

[Architecture guide](README.md) · [Shared contracts](contracts.md) · [SDK and plugins](sdk.md) · [Parallel work](parallel-work.md)

This describes the first Rust implementation. One Rust crate and one PostgreSQL database serve content, improvement records, and channel decisions. The app runs and grades its own agents. Freeze R0 routes, DTOs, errors, limits, and fixtures before feature modules depend on them.

## Composition and shared code

- `src/main.rs` loads configuration, connects the PostgreSQL pool, starts the HTTP server and background workers, and shuts them down cleanly. `src/lib.rs` composes the router, pool, auth configuration, and proposer client.
- `src/types.rs` defines shared IDs, request/response DTOs, revision strings, and stable errors from [R0](contracts.md). HTTP adapters translate errors to the agreed status and request ID; do not let database errors leak as API contracts.
- `src/auth.rs` authenticates a principal and checks project grants. Commands require the appropriate read, proposal/evidence, or promotion right on every call; content cannot grant access.
- `src/commands.rs` provides the mutation-key transaction helper. It scopes a key to principal, project, operation and target resource. It fingerprints the method, normalized scoped route and exact request-body bytes, then stores the response with the mutation. A retry with identical bytes returns that response; different bytes conflict. Concurrent requests using the same key must serialize through the database. Define expiry in the contract; protection is bounded by that window.

The mutation-start interface returns either a replay response or a writable transaction, never both. The mutation module completes retained replay adoption before returning a response; only new execution exposes a transaction to the feature module. This keeps replay completion and authorization together and prevents callers from accidentally continuing a replay as a new write. Existing HTTP behavior against PostgreSQL is the test surface.

Feature modules use SQLx directly with the shared pool and transactions. Each feature module keeps its handlers, validation, and SQL together; its commands own authorization and transaction ordering. `store.rs` contains only shared version-row mapping. Split a feature into subfiles when its size makes that useful. Avoid a generic repository layer. The coordinator owns `migrations/` and the initial schema sequence; feature owners propose schema changes there through that owner so migration order and constraints remain coherent. Include scoped foreign keys, immutable record constraints where practical, and indexes for channel and proposal lookup.

## Bundles

`src/bundles.rs` exposes commands to create a bundle, publish a version, and read version metadata or payload. Its handlers map the R0 bundle routes and persist bundle metadata and immutable versions. Publish checks project access and optional parent membership, validates schema and configured byte/count limits, and rejects unsafe or colliding paths and unsupported kinds. Encode the accepted `payload` from `CreateVersionRequest` once under the frozen fixture policy, store those UTF-8 JSON bytes, and compute SHA-256 over them. The HTTP request wrapper is not the downloadable payload. Return those stored bytes on payload download, never a reserialized object. Metadata carries the digest and parent separately. The mutation helper commits publication and its replay response together.

## Channels

`src/channels.rs` exposes resolve and promote commands; It handles ETag and `If-None-Match`, and reads and updates channel pointers and history. Resolve returns the selected version, digest, and opaque decimal revision. A matching conditional read returns the contract's 304 response. Rollback uses the same promotion command and advances the revision.

Promotion takes a retained target, expected revision, and exactly one comparison reference or explicit unevaluated reason. In one transaction, authorize the reviewer, lock or conditionally update the channel, verify the revision and target, and bind cited evidence to the target candidate and its declared parent IDs and digests. For evidence-backed promotion, require an existing channel whose current version is the candidate’s parent; a fresh revision alone cannot make old-parent evidence valid. Seed and rollback use an explicit unevaluated reason. Write the pointer and history, including reviewer, prior version and revisions, along with the idempotency response. A stale revision or mismatched evidence leaves all writes unchanged. The comparison is an app report, not an execution attestation.

## Improvement

`src/improvement.rs` exposes request/read proposal and record/read comparison commands. It maps the R0 routes and persists proposal status, attempts, candidates, and immutable comparisons. Comparison validation checks project and bundle membership, version IDs and digests, dataset and grader identities, runtime/model settings, and the declared case/repetition inventory. Validate paired outcomes, references, finite scores, and explicit missing grades, failure classes, and unknown costs. Preserve incomplete reports without treating them as successful evidence or inventing zeroes.

`src/improvement.rs` runs a bounded in-process loop with one active proposer. Persist the accepted request and status before responding; polling reads subsequent status. Limit concurrency, attempts, output, and allowed edits. The model receives only selected authorized content and evidence; validate returned paths, kinds, sizes, and the complete bundle before publishing an immutable candidate. Persist attempts. Use shared bundle validation/encoding inside I1’s transaction so candidate creation, its unique proposal association, authorship, and job success commit together. On restart, recover interrupted jobs under the bounded retry policy or mark them for explicit retry; reuse completed candidates. The model-client interface has a configured real implementation and a deterministic fake for tests. A timeout may still incur provider cost: this is not exactly-once billing or distributed job execution.

## Connected learning

`src/connected_learning.rs` owns connection enrollment, outcome admission, and evaluator assignment access. `src/connected_learning_worker.rs` advances durable rounds through the existing proposal, evaluation and promotion operations. It checks current authorization and the exact delivery baseline before release. The connection and scoped content handlers route fresh reads to the enrolled delivery target. The evaluator runs outside the service and recovers execution using its private journal. Post-rollout verdicts bind a started delivery receipt and terminal job to the current managed promotion. The service records the verdict, updates the rolling window, and commits any matching connection rollback in one transaction. See the [operator workflow](../../deploy/README.md#operate-connected-learning).

## Build and verify in order

1. Land root build setup, shared DTOs, contract fixtures, initial migration, auth and mutation helper. Test scoped denial and same-key replay, changed-byte conflict, and concurrent duplicate requests against PostgreSQL.
2. Implement bundle commands and exact-byte fixture tests, including digest, invalid paths, parent scope, and unauthorized reads. In parallel, the channel owner implements resolution, conditional reads, promotion conflicts, evidence binding, and rollback history against seeded rows. Race two promotions at the same revision and assert only one commits. Also reject a current revision with evidence against a superseded parent.
3. Implement comparison validation using complete and incomplete shared fixtures, including mismatched identities, missing pairs, non-finite scores, and unknown cost. Add proposer tests with the fake client for limits, invalid edits, failure, restart recovery, and replay without a second job. Exercise the configured real client separately as an operator integration check.
4. Exercise public HTTP seams with a real test database: publish → resolve → fetch exact bytes, then propose → record comparison → promote. Check transaction rollback on failures and restore from a database backup before production use.

The shared types, migration, auth, mutation helper, and fixtures unblock feature work. Bundles must expose version lookup and publication before channels and proposer integration; C1 reads immutable comparison rows under the shared schema for evidence binding, so it does not compile against the I1 proposer or handlers. Live report/promotion integration still requires I1. SDK work can proceed against the same fixtures while server commands are built. Coordinate interface changes through the contract owner rather than independently changing DTOs. See [parallel work](parallel-work.md) for ownership and integration gates.
