# Rust runtime options

**Archived proposal — superseded by the smaller content service.** [Current overview](../../../../design/overview.md).
**2026-11-13 · Proposed tools, not a working runtime**

For example, a worker running a coding agent may crash after sending a write but before receiving its response. The proposed Rust control plane must record that uncertain outcome and reconcile it before retrying; a database transaction cannot undo the external write.

## Evidence and scope

AgentRun separates adapters from effect recovery and model admission. RRSI separates search from domain execution/scoring. Keep those seams in Rust rather than rewriting every model loop. See the [AgentRun notes](../../../agentrun.md), [RRSI notes](../../../rrsi.md), and [source audit](../../../source-audit.md).

## Production baseline and development mode

The current target is a production Rust control plane, separate task/evaluation workers, PostgreSQL, and immutable object-storage artifacts. This supersedes the earlier local-first deployment assumption. See the [production contract](../design/runtime/production.md).

Local development can keep SQLite and local artifacts behind the same command contracts. SQLite WAL is for same-host access, not a distributed filesystem ([WAL docs](https://www.sqlite.org/wal.html)).

Keep state changes and journal events in one transaction. Use expected revisions, scoped command keys, stable effect IDs, and explicit retry classes. A database transaction can't make an external call exactly once.

For production workers, use PostgreSQL leases, database time, and increasing ownership generations. Fence every write and new admission. Old workers may still finish earlier admitted calls, so keep idempotency/reconciliation. Advisory locks alone aren't durable leases ([PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html)).

## Process and isolation

Drain stdout/stderr concurrently with bounded buffers. Save process creation identity. Cancel gracefully, then terminate the process group/container on a deadline and reap it. Don't signal a reused PID. Dropping a Tokio child doesn't kill it by default ([Tokio Child](https://docs.rs/tokio/latest/tokio/process/struct.Child.html)).

The adapter reports versions, event format, cancellation, checkpoint/resume, mediation, and telemetry. If a capability is missing, reject that guarantee rather than guess.

Trusted local execution and sandboxed execution are separate profiles. Containers need restricted mounts/network, non-root identity, resource limits, and isolated credentials. No Docker socket or host credentials in tasks. Rootless reduces daemon privilege; it doesn't make arbitrary mounts safe. See [rootless setup](https://docs.docker.com/engine/security/rootless/) and [Docker security](https://docs.docker.com/engine/security/).

## Offline improvement and artifacts

Freeze candidate content, parent version, config, binaries/images, and provenance. Publish bytes before their database references. Missing artifacts are integrity failures, never a reason to substitute latest. Cleanup follows live references and a grace period.

Evaluation pins splits, fixtures, harness, grader, model/config, seeds where useful, budgets, and concurrency. Hosted model seeds don't guarantee repeatability. Keep raw results and classify infrastructure failures separately from task failures.

Propose, evaluate, decide, and release are distinct recorded steps. The release pointer changes atomically against its expected old revision. Running jobs keep their pinned version. Candidates never get production secrets or release authority.

## Limits, approvals and interfaces

Reserve upper-bound spend before admission. Known usage settles it; missing usage keeps a conservative unresolved hold. A complete result may return once that state is saved. Hard caps need full credential/egress mediation and known request bounds; opaque harnesses may only offer advisory tracking.

Approval binds a principal, logical effect/action digest, scope, expiry, policy, and run/session. Attempts are audit context. Consume it with the durable intent after revalidation. Cancel blocks later admissions; an earlier committed intent may still send. See the [effects contract](../design/runtime/execution.md#effects-and-recovery).

Expose start, inspect, events, cancel, approve, and artifact retrieval. Production starts with identity, scope checks, quotas, TLS, and audit logs. Local transport remains owner-only.

## Concrete Rust choices to validate in the prototype

| Concern | Starting choice | What to prove |
| --- | --- | --- |
| Supervision | Tokio | Bounded I/O, deadlines, shutdown, and descendant containment. |
| SQL | SQLx | Explicit transactions and tested SQLite/PostgreSQL semantics. [Runtime docs](https://docs.rs/sqlx/latest/sqlx/). |
| SQLite settings | Explicit connection options | Journal mode, sync, foreign keys, and busy timeout. [Options](https://docs.rs/sqlx/latest/sqlx/sqlite/struct.SqliteConnectOptions.html). |
| Envelopes | Serde | Versioning and validation remain our job. [Docs](https://serde.rs/). |
| CLI | clap | Commands stay independent of transport. [Docs](https://docs.rs/clap/latest/clap/). |
| Production HTTP | Axum | Add auth deliberately; middleware isn't an authorization model. [Docs](https://docs.rs/axum/latest/axum/). |

Choose exact versions, platform support, and licenses in the spike. A dedicated blocking SQLite writer is worth considering if it makes ownership/durability clearer than the async integration.

In SQLite development mode, default intent writes to FULL sync. In WAL mode, SQLite documents an extra commit sync under FULL; NORMAL can lose committed transactions on power loss. Storage still has to honor sync. Read back settings and test failure behavior before trading durability for throughput. [SQLite sync modes](https://www.sqlite.org/pragma.html#pragma_synchronous).
