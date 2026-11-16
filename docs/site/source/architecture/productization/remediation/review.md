# Plan review and decisions

> Earlier implementation record. Production startup, identity and evaluator setup now follow the [production-only plan](../../production-only/plan.md). Old local-launcher commands below are retired.

Four fresh agents reviewed the initial five-agent plan against implementation and test code. These are the resolutions for implementation, not evidence that the fixes have landed.

| Review objection | Decision in the final plan |
| --- | --- |
| Mutable compatibility target/CAS adds a policy subsystem | Cut it. One immutable creation-time target; existing bundles remain generic. Adoption uses reviewed copy/import into a new bundle. |
| Native validation prevents saving an incomplete draft | Fix it. Generic saves remain durable; native diagnostics are visible; publication and provider candidates must pass selected-target checks. |
| Canonical descriptor hashes duplicate existing fields and lack portable encoding | Cut them. Existing frozen fields plus app config ID/opaque revision and structural installed-config comparison. |
| Payment simulator does not prove better harness instructions | Keep it only as orchestration regression. Adapt the existing native review dataset/grader to the same runnable interface; record real Luna evidence separately. |
| Bound finish would break old runners | Add `requireBoundEvidence`, default false for old/omitted legacy inputs; new console requests require it. Legacy completion stays labeled legacy. Bound reports always validate their request/attempt. No guessed backfill. |
| Direct promotion is not conditional on request completion/winning | Preserve that existing release contract and label state/completeness/reviewer decision separately. Current target compatibility still gates publication. |
| Close can be bypassed by unmarked delayed requests | All affected routes consult matching receipts/fences under the same namespace lock, regardless of marker. Marked retention cannot change legacy cross-route key reuse. Close first checks existing legacy receipts. |
| One stored required-right string misses effective permissions | Central action authorization covers execution/replay/lookup/close, including setup write+promote and current admin semantics. |
| New bundle locks can deadlock nested publication | Immutable targets remove the new locking subsystem. Preserve current transaction hierarchy and use existing mutation locks for receipt/close serialization. |
| Recovery expands into a public command framework | Narrow it to audited lanes, existing server actions and one internal helper. No public raw SDK gateway, broad migration of every action or cross-session text-retention feature. |
| Two evaluator helpers/principals conflict | One helper: `evaluate:local`, `scripts/evaluate-local.ts`, dedicated local read/write evaluator principal. Shipping consumes it. |
| Journal keys alone do not prevent duplicate concurrent execution | Exclusive per-request process ownership, atomic private files and execution-started marker. A crashed started attempt without a saved report requires interruption/new request. |
| Python close cannot cancel an arbitrary in-flight client | Bound close and process exit; stop claiming new events, allow already claimed calls to finish. Use daemon ownership and short real-client deadlines. |
| Existing fixtures would miss the new contracts | Update actual provider HTTP fixtures, strict bound report fixtures and copied-helper browser tests. Isolated database runner must exercise database tests rather than skip/use ambient state. |
| Local completion could overstate shipping readiness | Keep local implementation, installable artifacts, and external qualification/public availability as separate statuses. Blocked gates remain visible. |

## Review notes

[Contracts](../../../research/archive/remediation-planning/review-contracts.md) · [Recovery and security](../../../research/archive/remediation-planning/review-recovery.md) · [Scope](../../../research/archive/remediation-planning/review-scope.md) · [Acceptance](../../../research/archive/remediation-planning/review-acceptance.md)

No feature implementation or runtime qualification happened during this review. [The reviewed plan](plan.md) supersedes conflicting details in the initial input notes.
