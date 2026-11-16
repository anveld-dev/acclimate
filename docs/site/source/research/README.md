# Research and scope decisions

The current product is a small content-improvement service with application-side SDK plugins and caching. It does not own agent execution. Start with the [current design](../design/README.md).

## Current questions

- [Authentication setups](auth-setups.md): direct social login, Rust account libraries, Better Auth and self-hosted identity services, with PostgreSQL and migration tradeoffs.
- [Scope audit](service-scope-audit.md): where the earlier design became an execution platform, and what was cut.
- [SDK file delivery](sdk-file-delivery.md): native instructions/skills/context delivery in Claude, Codex, Cursor, and Pi, including local and remote limits.

## Source evidence

- [AgentRun](agentrun.md): runtime and learning patterns inspected in source. Its runtime machinery isn't an MVP requirement for this service.
- [RRSI](rrsi.md): versioned harness search and selection research. We borrow proposal/evidence history; its full optimization loop is deferred.
- [Source audit](source-audit.md): detailed observations and inspected test expectations from the original research.

The [.repos.json](../../.repos.json) manifest pins the five read-only reference clones. AgentRun and RRSI declare Apache-2.0 at the top level; added SDKs and vendored material have their own notices to check before copying code. These docs borrow ideas, not implementations.

SDK facts use the dated primary sources linked in their notes. No native agent sessions, paid experiments, upstream builds, or upstream tests were run. Inspected test code is evidence of intent, not passing behavior.

## Earlier work

The [archived runtime-platform proposal](archive/README.md) preserves the earlier design and its integration/evaluation notes. It is historical context, outside the current product contract.
