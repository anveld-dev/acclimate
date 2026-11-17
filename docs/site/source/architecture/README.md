# Implementation architecture

Acclimate also [schedules continuous learning for enrolled connections](../../deploy/README.md#operate-connected-learning). The [application-owned learner](continuous-learning/README.md) provides a separate SDK-controlled profile for private evidence, admission and experiment state. Its [implementation record](continuous-learning/implementation.md) covers recovery and qualification.

The [deepening review](deepening-review.md) records the latest committee decisions, preserved behavior, and test surfaces.

Current work: [production-only plan](production-only/plan.md), [review](production-only/review.md), [parallel ownership](production-only/parallel-work.md) and [evidence](production-only/evidence.md). PostgreSQL and verified OIDC are the only app path.

**Implementation map.** This breaks the [small service design](../design/README.md) into modules and parallel work packages. The first implementation now exists; [run locally](../development.md) describes setup and validation. Codex is the live native test target; Claude and Pi have preparation checks.

The next work is the [console productization plan](productization/README.md): durable drafts, the improvement UI, real selection/access and optional delivery reports. The [SDK release milestone](../implementation/next-milestone.md) is an earlier implementation record.

## Start here

1. [Shared contracts](contracts.md): the wire format and fixtures that unblock parallel work.
2. [Rust server](server.md): module responsibilities, storage, transactions, and proposal jobs.
3. [SDK and native plugins](sdk.md): client/cache implementation and native SDK preparation.
4. [Parallel work plan](parallel-work.md): assignments, file ownership, dependencies, and integration gates.

## Repository layout

```text
apps/console/                 TanStack Start web console (separate Node app)
Cargo.toml                    one Rust server crate
src/
  main.rs                     config, migrations, singleton guard, worker and HTTP startup
  lib.rs                      composition, shared errors and model client
  types.rs                    matching wire DTOs
  auth.rs                     principals and project grants
  commands.rs                 atomic mutation + idempotency helper
  store.rs                    shared immutable version row mapping
  bundles.rs                  validation, publication and exact payload reads
  channels.rs                 resolve, promotion, rollback and decision history
  improvement.rs              reports, proposals and bounded model worker
migrations/                   owned PostgreSQL schema sequence
contracts/                    OpenAPI, JSON schema and exact-byte fixtures
packages/
  sdk/                        client, cache, safe preparation and paired comparisons
  codex-plugin/               native AGENTS.md and .agents/skills mapping
  claude-plugin/              native CLAUDE.md and .claude/skills mapping
  pi-plugin/                  files for an application-owned resource loader
  cursor-plugin/              native Cursor SDK preparation
examples/
  publish.ts                  publish and seed fixture content
  codex-agent.ts              fetch from service, then app calls Codex SDK
  codex-smoke.ts              live Luna-only resource-access check
  compare-review.ts           deterministic comparison wiring example
scripts/service-e2e.ts         real process/database flow with a local fixture model
```

The npm monorepo uses `apps/*` for applications and `packages/*` for reusable SDKs/plugins. The console has its own build and TypeScript config; the Rust crate and Python package stay in place.

Console cursor traversal lives in the internal [listing module](../../apps/console/src/server/listing.ts). Setup, navigation, channel, access, and connection reads share its opaque-cursor traversal and cycle detection; callers retain their existing page budgets, transport, field validation, and safe projections. Channel reads no longer borrow traversal from the setup module.

Canonical durable Operation result targets live in the browser-safe [target module](../../apps/console/src/lib/operation-target.ts). Browser recovery freezing and server replay share route grammar and scope comparison; authorization and command-specific retry restrictions remain with their existing owners. Bundle setup constructs one request body for validation and transmission.

Chronological evidence listing uses the existing [pagination module](../../src/pagination.rs) for shared query bounds, page types, truncation, and scoped continuation. Collection queries and authorization remain in their feature modules. Qualification runners use the existing [Harness](../../scripts/productization/qualify.py) for database-only startup or full startup with the Rust process.


Keep content delivery as one Rust server deployable. A folder is a module ownership seam, not a new network service or Rust crate. The thin Python SDK lives in `python/`.

## The modules that matter

| Module | Small interface | Owns internally |
| --- | --- | --- |
| Bundles | Publish/read a version and its payload | Authorization, validation, immutable bytes/digest, mutation deduplication, and persistence. |
| Channels | Resolve/promote a named channel | Conditional reads, revision checks, evidence binding, and promotion history in one transaction. |
| Improvement | Request/read a proposal; record/read a comparison | Allowed edits, bounded model attempts, candidate publication, report identity and completeness. |
| SDK delivery | Resolve and cache a verified bundle | HTTP behavior, digest checks, private atomic cache writes, freshness/offline policy. |
| Native plugin | Prepare native options/files from a verified bundle | Native resource mapping and job-local cleanup. The app runs the native SDK. |

Do not expose a series of caller-managed “check, then write” functions. A mutation command owns its authorization and transaction ordering. Use ordinary functions and concrete PostgreSQL access first; introduce a trait only for an implementation that actually varies, such as the proposal model client.

## Fastest route to useful code

Freeze the small shared contract, then split work by owned directories. Server and SDK agents use the same byte/digest fixtures; the SDK can use a fixture HTTP server while the Rust endpoints are being written. The Claude plugin can start with a verified fixture bundle instead of waiting for a live service.

The first integration gate is **publish → fetch/cache → prepare → app calls native SDK**. The next is **propose → app compares → reviewer promotes**. [The work plan](parallel-work.md) shows what can run together and what must wait.

## Scope guard

This plan implements content delivery and improvement. It does not add task execution, provider interception, a sandbox fleet, native session RPC, a workflow engine, or a plugin-hosting platform. Test those responsibilities only where the integrating application owns them.
