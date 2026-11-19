# Research and scope decisions

The current product is a small content-improvement service with application-side SDK plugins and caching. It does not own agent execution. Start with the [current design](../design/README.md).

## Current questions

- [Connected learning on LLM CLI support](real-app-learning-experiment/README.md) reports a paired development gain and a held-out tie. [Pre-registration](real-app-learning-experiment/preregistration.md) [Replication](real-app-learning-experiment/replication.md) and [replication pre-registration](real-app-learning-experiment/replication-preregistration.md).

- [Luna integration in Simon Willison’s LLM](luna-real-app-integration.md) follows the packaged SDK from a real Python app through native grading, CI and independent review.

- [Continuous harness concept review](continuous-harness-review/README.md): parallel AgentRun/RRSI and implementation review, including a [second-pass counter-review](continuous-harness-review/second-pass/README.md); distinguishes content delivery from durable harness learning and prioritizes the missing concepts.

- [Larger self-improvement tests](self-improvement-stress-test.md): twenty rounds, distributed evidence, failed audits and a qualified reusable helper.
- [Live self-improvement qualification](self-improvement-qualification.md): real Luna runs, failed candidates, file changes and later-job delivery checks.
- [Authentication setups](auth-setups.md): direct social login, Rust account libraries, Better Auth and self-hosted identity services, with PostgreSQL and migration tradeoffs.
- [Scope audit](service-scope-audit.md): where the earlier design became an execution platform, and what was cut.
- [SDK file delivery](sdk-file-delivery.md): native instructions/skills/context delivery in Claude, Codex, Cursor, and Pi, including local and remote limits.

## Source evidence

- [AgentRun](agentrun.md): runtime and learning patterns inspected in source. Its runtime machinery isn't an MVP requirement for this service.
- [RRSI](rrsi.md): versioned harness search and selection research. We borrow proposal/evidence history; its full optimization loop is deferred.
- [Source audit](source-audit.md): detailed observations and inspected test expectations from the original research.

The [.repos.json](../../.repos.json) manifest pins the five read-only reference clones. AgentRun and RRSI declare Apache-2.0 at the top level; added SDKs and vendored material have their own notices to check before copying code. These docs borrow ideas, not implementations.

SDK facts use the dated primary sources linked in their notes. The original source investigations did not run native sessions or paid experiments. Later local Luna runs are recorded separately in the qualification report above. No upstream builds or tests were run. Inspected test code is evidence of intent, not passing behavior.

## Earlier work

The [archived runtime-platform proposal](archive/README.md) preserves the earlier design and its integration/evaluation notes. It is historical context, outside the current product contract.
