# SDK and native plugins

[Architecture guide](README.md) · [Shared contracts](contracts.md)

**First implementation.** The TypeScript SDK delivers a verified version to an application. Small native plugin packages map that content into inputs supported by a particular native SDK. The application owns execution, credentials, sessions, and cleanup timing.

## File ownership and boundaries

| File | Responsibility |
| --- | --- |
| `packages/sdk/src/types.ts` | Shared DTOs, identifiers, and typed service errors matching R0. Coordinator owns this file and shared fixtures. |
| `packages/sdk/src/client.ts` | Raw project-scoped HTTP operations, authentication supplied by the app, conditional requests, and mutation retry behavior. |
| `packages/sdk/src/cache.ts` | Resolve, download and verify exact bytes; private atomic cache and caller-selected freshness/offline policy. |
| `packages/sdk/src/prepare.ts` | Safely materialize verified content in an app-selected job location with an explicit collision policy. |
| `packages/sdk/src/compare.ts` | Optional application-side paired comparison and report helper. I1, the improvement owner, owns this file. |
| `packages/sdk/src/index.ts` | Deliberate public exports for the SDK. |
| `packages/sdk/tests/delivery/` and `packages/sdk/tests/compare/` | S1 owns delivery tests and their fixture HTTP server; I1 owns compare tests and reads that server helper without editing it. |

The SDK owner owns `client.ts`, `cache.ts`, `prepare.ts`, and `index.ts`. Coordinate changes to public types and fixtures with the coordinator; do not independently redefine wire shapes. Plugin authors own `packages/claude-plugin` and, second, `packages/pi-plugin`, with their own tests. C0 retains package manifests and lockfiles; dependency requests go through that owner. Examples live under `examples/` and call the actual native SDK from application code.

## Small public surface

These sketches describe responsibilities; use the implemented TypeScript types for exact arguments:

```ts
client.resolveChannel(workspace, bundle, channel, options) // mapping or not-modified
client.getPayload(workspace, bundle, version)              // exact bytes
resolveAndCache(client, selection, cachePolicy)             // verified version + resolution metadata
prepareFiles(verifiedVersion, destination)                  // locations + cleanup
claudePlugin.prepare(verifiedVersion, appContext)           // native options + cleanup
compare(parent, candidate, cases, execute, grade)         // comparison report
```

The client also exposes the R0 version, proposal, comparison and release operations. It returns typed errors with service codes and request IDs. Mutations take an idempotency key; any permitted retry uses the same serialized request bytes and key within the contract's retention window. Keep raw HTTP separate from caching so callers can use either. Exact arguments and response shapes follow the shared contract when frozen.

A verified version view carries version ID, digest, parsed content and resolution metadata. Hash the downloaded bytes against the metadata **before** parsing and validating the schema. Never derive the digest from reserialized JSON. Channel revisions and version IDs are opaque strings. A conditional `304` confirms the cached mapping; it does not create a version.

The Node-side [verification module](../../packages/sdk/src/verification.ts) owns this exact-byte verification sequence behind `verifyPayloadBytes`: digest, strict UTF-8 decoding, JSON parsing, then payload validation. Cache reads, console channel/version reads, and operator review use the same interface. Transport, metadata identity, download limits, freshness, cache repair, and caller-facing error messages remain with their existing callers. Browser content validation uses the separate browser-safe validation entry point.

## Cache and preparation

Scope cache keys by service origin, authenticated scope, project, bundle and digest. Create private directories and files from the first write; never store credentials in payloads. Write to a temporary directory on the same filesystem and atomically rename only after digest and schema validation. A failed or partial download leaves the previous entry intact. Bound cache size and age without removing files needed by active preparations.

Require a fresh resolution by default. An app may explicitly permit bounded stale content or pin a cached version offline. Return the selected version, digest, resolution age and stale status so the app can record them. A cache miss, stale mapping outside policy, integrity failure and unsupported schema are distinct errors. Never turn `401`, `403`, or known revocation into offline success.

Preparation makes job-local copies or native inputs, leaving cached bytes immutable. Reject absolute or escaping paths, traversal, duplicate or case-colliding paths, symlinks and content beyond contract limits. The destination is app-selected. Default collisions to failure; an app can explicitly select a supported merge or replacement policy. Never silently overwrite existing instructions or skills. Cleanup removes only files owned by that preparation, and the app calls it when the job is finished.

## Native mapping and comparison

Use Codex for the live check, with Claude/Pi mappings to test whether the same verified version boundary is useful. Each plugin validates what it can map, returns prepared locations and native options, and reports unsupported content. It must not claim a skill was invoked merely because it was delivered. Memory is bundle content, not an assumed native memory option. Prompt replacement requires explicit app policy.

The shared [native preparation module](../../packages/sdk/src/native-files.ts) owns staging and the common instruction, skill-manifest, and original-memory-path projections. Each native adapter retains its harness-specific mapping and policy: Claude/Cursor settings, Cursor's approved-memory selection, and Pi's resource list. Plugin result shapes and application-owned cleanup remain unchanged.

Consult the current [native SDK research](../research/sdk-file-delivery.md) for discovery and configuration routes; pin and validate the actual native SDK version in each example. Do not invent native option fields. Test fresh and resumed sessions separately: refresh affects future preparations, while a running session changes only through an explicit app action supported by its SDK. Paths with spaces and existing files deserve separate checks.

The optional comparison helper accepts ordinary app `execute` and `grade` functions. It creates the expected case/repetition inventory first, pairs parent and candidate on the same inputs and settings, and produces the shared comparison report. Preserve task failures, infrastructure or judge failures, missing grades and unknown costs distinctly. The app supplies isolation and credentials; the helper does not run a hosted agent. Grading a saved output again must not create another execution sample. The helper captures report identities before callbacks and gives every grade attempt a fresh clone of the captured output. Outputs must be structured-cloneable data; otherwise grading fails without rerunning execution. These retries retain data in memory, not durable storage.

## Parallel work and integration

The coordinator first freezes R0 schemas, TypeScript types and exact-byte/digest fixtures. While Rust endpoints are under construction, the SDK owner runs a fixture HTTP server implementing those responses, conditional reads and errors. Plugin authors start from the same verified version fixture and can test preparation without a server. Contract changes go through the coordinator and update schemas, types and fixtures together.

Tests should observe user-visible behavior: fixture bytes verify across languages; an unchanged channel reuses cached content; interrupted downloads leave a usable prior entry; denial cannot fall back offline; malformed paths and collisions fail without overwriting files; retries preserve key and bytes. Comparison tests use complete and incomplete shared reports rather than reproducing helper internals. Native integration tests verify actual resource discovery, not just generated options.

The first integration gate is publish an explicit version → fetch/cache by that version → prepare → app calls the Codex SDK and records the version. It does not wait for channel promotion. Next, exercise Pi and the parent/candidate comparison flow. A thin Python client with cache/preparation helpers now lives under `python/`; it uses the same R0 fixtures.


## Distribution and native helpers

`npm run build` emits each package's JavaScript and declarations. `npm run pack:verify` installs tarballs in an external app and checks preparation without native peers. SDK-dependent Claude/Pi helpers are separate `/native` entry points, so their optional peers do not affect preparation-only consumers. The Python wheel has a separate isolated-install check. See the [milestone](../implementation/next-milestone.md) for evidence and limits.
