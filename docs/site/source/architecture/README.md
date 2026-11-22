# Implementation architecture

Acclimate is a PostgreSQL-backed Rust service, an authenticated TanStack Start console and delivery SDKs for TypeScript and Python. Applications run their own agents using the version resolved from a channel. Enrolled bundles can run learning rounds and automatically release adopted versions.

- [Server modules](server.md) describes service ownership and transactions.
- [Shared contracts](contracts.md) describes the wire format and payload verification.
- [SDK and native plugins](sdk.md) covers client preparation, caching and native integration.
- [Run locally](../development.md) covers setup and verification.

The [learning contract](../../contracts/learning.md) describes the shipped loop, and [evaluator operations](../evaluator-operations.md) covers setup. The [central learning design](central-learning/README.md) is a proposal, not yet built, that moves rollouts into the service. The [experiment plan](../../examples/self-improvement-memory/experiment.md) sits with its driver.
