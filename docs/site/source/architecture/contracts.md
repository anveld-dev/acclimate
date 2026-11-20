# Shared implementation contracts

[Architecture guide](README.md)

**R0 implementation contract.** Schemas, byte/digest fixtures, and matching Rust/TypeScript types now exist. The [internal implementation record](../internal/contracts/IMPLEMENTATION.md) settled the original route and limit details. [`contracts/openapi.json`](../../contracts/openapi.json) is now the source of truth. Update shared contracts before feature agents depend on changed shapes.

## What the first shared baseline contains

| File | Purpose |
| --- | --- |
| `contracts/openapi.json` | Exact routes, auth/header behavior, JSON field names, statuses, and error codes. |
| `contracts/bundle.schema.json` | UTF-8 file payload schema, supported kinds, and path/size validation rules. |
| `contracts/fixtures/bundle-v1.json` | Exact stored payload bytes, including its documented trailing-newline policy. |
| `contracts/fixtures/version-v1.json` | Version metadata and the actual SHA-256 of that payload fixture. |
| `contracts/fixtures/resolve-v1.json` | Channel revision, version ID/digest, and conditional-read example. |
| `contracts/fixtures/comparison-v1.json` | Complete parent/candidate case pairs, plus separate invalid/incomplete examples. |
| `src/types.rs`, `packages/sdk/src/types.ts` | Matching public DTOs and typed errors. Handwritten initially; checked against the fixtures. |

The coordinator also owns the initial migration and root build setup. These are small shared inputs, not separate services or a code-generation platform.

## Bundle payload and identity

Example payload shape; the fixture must use real expected bytes and a computed digest:

```json
{
  "schemaVersion": 1,
  "files": [
    {
      "path": "instructions/review.md",
      "kind": "instruction",
      "text": "Review the supplied diff and support every finding.\n"
    }
  ]
}
```

Kinds are `instruction`, `skill`, and `memory`. Paths are relative; duplicate/case-colliding paths, traversal, symlinks, unsupported content, and configured size/count excesses are rejected. The initial format contains text, not an executable package archive.

`Version` metadata names `id`, `bundleId`, `parentVersionId`, and `digest`. Payload bytes are stored once. A payload download returns those same bytes, not freshly serialized JSON. The SDK hashes the received bytes before parsing. IDs, scope, timestamps, and channel selection are metadata; the digest is not a hash of a TypeScript object.

Record channel revisions as opaque decimal strings on the wire, for example `"12"`. Callers compare equality, not arithmetic. Version IDs are opaque strings too.

The first concrete DTOs are:

| DTO | Required shape |
| --- | --- |
| `CreateVersionRequest` | `parentVersionId` (nullable) and `payload` (the validated bundle object). The server encodes/stores that accepted payload once. |
| `VersionMetadata` | `id`, `bundleId`, `parentVersionId`, `digest` (`sha256:` plus lowercase hex), and `createdAt`. |
| `ChannelResolution` | `channel`, `revision`, and `version: VersionMetadata`. Store the returned ETag separately; clients do not invent it from the revision. |
| `PromoteRequest` | `versionId`, `expectedRevision`, and exactly one of `comparisonId` or `unevaluatedReason`. `"0"` means create an absent channel; existing channels require their actual revision. |
| `ApiError` | `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`. |

A client may select an explicit version using the metadata/payload reads; it need not resolve a channel. Use that path for the first native integration demo.

## Proposed route set

All paths start with `/v1/workspaces/{workspaceId}`. Access is checked for that workspace on every operation.

| Route | Command / result |
| --- | --- |
| `POST /bundles` | Create a named bundle. |
| `POST /bundles/{bundleId}/versions` | Publish validated files against an optional parent; return immutable metadata. |
| `GET /bundles/{bundleId}/versions/{versionId}` | Read version metadata. |
| `GET /bundles/{bundleId}/versions/{versionId}/payload` | Return exact stored payload bytes. |
| `GET /bundles/{bundleId}/channels/{channel}` | Resolve revision/version/digest; ETag and `If-None-Match` support. |
| `POST /bundles/{bundleId}/channels/{channel}/releases` | Select a retained version using `expectedRevision`. Creates history; also handles rollback. |
| `POST /bundles/{bundleId}/proposals` | Accept a bounded proposal request; return a proposal ID and status. |
| `GET /bundles/{bundleId}/proposals/{proposalId}` | Read status, rationale, and candidate metadata when complete; the app can diff the immutable parent/candidate payloads. |
| `POST /bundles/{bundleId}/comparisons` | Record application-supplied comparison evidence. |
| `GET /bundles/{bundleId}/comparisons/{comparisonId}` | Read that immutable comparison. |

The baseline must settle exact success/error response shapes and limits. Feature agents do not add new endpoints or native agent lifecycle methods to get around an interface gap.

## Mutation and error rules

All mutations use `Idempotency-Key`, scoped to principal/project/operation and its target resource. The request fingerprint includes the HTTP method, normalized scoped route, and exact request-body bytes. The shared helper stores the request fingerprint and response with the command's database writes. Same key and identical request bytes return the original response; changed bytes conflict. SDK retries reuse the serialized bytes. The baseline records the supported retry/retention window; clients stop automatic retries outside it.

Errors have a stable code, message, and request ID. Required codes include denial, not-found, invalid content, unsupported schema, revision conflict, idempotency conflict, and temporary unavailability. The SDK adds local cache/integrity errors without disguising `401`/`403` as offline success.

Proposal submission returns an accepted ID. Polling its read operation is how the caller learns later status; resubmitting the same mutation key does not start another model job.

## Comparison and promotion

A comparison binds project/bundle, parent/candidate version IDs and digests, dataset revision, native runtime/model settings, grader revision, and the full expected case/repetition inventory. Each expected pair records both versions' outcomes: execution status, output refs, reward or missing grade, and optional known usage/cost. Fixtures must distinguish task failure, infrastructure/judge failure, and unknown cost. These are application reports, not remote execution attestations.

Promotion takes a target version, expected channel revision, and exactly one of a comparison reference or an explicit unevaluated reason. In one transaction, check access, retained version, revision, and cited evidence's parent/candidate identities and digests; write the new pointer and promotion record. For an evidence-backed promotion, the channel must already exist and its current version must equal the candidate’s parent. Reject stale-parent evidence even when the caller supplies the latest channel revision. A seed or rollback uses the explicit unevaluated-reason path. No caller can attach another candidate’s passing evidence.

## Two internal collaboration points

Bundle validation and exact-byte encoding are shared. I1 owns the completion transaction: insert the validated candidate with a unique `versions.proposal_id`, bind it to the proposal, and mark success together. Publication retains the requesting principal as author. This preserves one candidate per proposal across recovery. Do not call a separately committing HTTP-style publication command and then save job completion afterward. If feature work later separates candidate persistence behind a helper, that helper must accept the caller's transaction.

C1 validates comparison identities by reading immutable comparison rows under the frozen schema in its promotion transaction. It does not import I1's HTTP handlers or proposer loop. Seeded comparison fixtures allow C1 to compile and test before the live report-upload path lands.

## How agents use R0

The server owner implements these commands. The SDK owner implements their client behavior against a fixture HTTP server. Plugin owners consume the SDK's verified version view, not their own HTTP/parser copy. Report helpers use the same comparison fixture as the server validator.

A contract change has one owner: update schema/types/fixtures together, state which work packages are affected, then have those owners update. Don't silently fork the DTOs or generate code during every feature task.
