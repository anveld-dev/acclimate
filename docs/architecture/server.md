# Rust service

The Rust service runs as one process per PostgreSQL database. Startup validates configuration, holds database ownership, applies migrations and starts the invitation and learning workers.

| Module | Responsibility |
| --- | --- |
| `auth`, `workspaces`, `invitations`, `machine_tokens` | Browser and machine authority, workspace membership and access changes. |
| `bundles`, `types`, `store` | Bundle setup, validated uploads, immutable versions and exact payload bytes. |
| `channels` | Conditional resolution, revision-checked releases with reasons, and release history. |
| `integrations` | Connection settings, scoped credentials and delivery observations. |
| `learning` | Bundle enrollment, tasks, rollout leases, optimizer calls, round history and improvement memory. |
| `commands` | Scoped replay, retained operation results and transactional mutations. |

A release changes only the channel selection. The target version and jobs pinned to it remain immutable. The learning worker pins each round’s inputs. On adoption it releases the selected version and appends a memory attempt in the same transaction. The [learning contract](../../contracts/learning.md) describes the executor and optimizer boundaries.
