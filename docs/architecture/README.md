# Implementation architecture

Acclimate is a PostgreSQL-backed Rust service, an authenticated TanStack Start console and delivery SDKs for TypeScript and Python. Applications run their own agents using the version resolved from a channel. Enrolled bundles can run learning rounds and automatically release adopted versions.

- [Server modules](server.md) describes service ownership and transactions.
- [Shared contracts](contracts.md) describes the wire format and payload verification.
- [SDK and native plugins](sdk.md) covers client preparation, caching and native integration.
- [Run locally](../development.md) covers setup and verification.

The [central learning architecture](central-learning/README.md) covers tasks, executor isolation and release decisions. The [experiment plan](../../examples/self-improvement-memory/experiment.md) describes the parked W1 workload.
