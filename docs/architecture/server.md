# Rust service

The Rust service runs as one process per PostgreSQL database. Startup validates configuration, holds database ownership, applies migrations and starts the invitation worker.

| Module | Responsibility |
| --- | --- |
| `auth`, `workspaces`, `invitations`, `machine_tokens` | Browser and machine authority, workspace membership and access changes. |
| `bundles`, `types`, `store` | Bundle setup, validated uploads, immutable versions and exact payload bytes. |
| `channels` | Conditional resolution, revision-checked releases with reasons, and release history. |
| `integrations` | Connection settings, scoped credentials and delivery observations. |
| `commands` | Scoped replay, retained operation results and transactional mutations. |

A release changes only the channel selection. The target version and jobs pinned to it remain immutable. The invitation worker keeps readiness independent of application execution. The [learning loop design](self-improvement-memory/loop.md) describes the optimizer, worker and data model.
