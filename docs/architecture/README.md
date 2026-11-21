# Implementation architecture

Acclimate is a PostgreSQL-backed Rust service, an authenticated TanStack Start console and delivery SDKs for TypeScript and Python. Applications run their own agents using the version resolved from a channel.

- [Server modules](server.md) describes service ownership and transactions.
- [Shared contracts](contracts.md) describes the wire format and payload verification.
- [SDK and native plugins](sdk.md) covers client preparation, caching and native integration.
- [Run locally](../development.md) covers setup and verification.

The [self-improvement memory design](self-improvement-memory/README.md) describes the future always-on loop, its evaluator and optimizer contracts, removal phases and experiment plan. Versioned delivery ships in this release.

## Historical implementation records

The [production plan](production-only/plan.md), [productization plan](productization/README.md), [deepening review](deepening-review.md) and [SDK release milestone](../implementation/next-milestone.md) record earlier decisions and acceptance evidence.
