# Productization fixes

> Earlier implementation record. Evaluation completion now requires evidence bound to the exact request and attempt. Production startup, identity and evaluator setup now follow the [production-only plan](../../production-only/plan.md). Old local-launcher commands below are retired.

Reviewed implementation plan, 2026-11-14. This fixes local failures from the [current audit](../current-audit.md) without turning Acclimate into an agent runtime. Apps still execute agents and grade outputs. The service owns content, permissions, frozen evaluation intent, reported evidence and deliberate releases.

## The intended result

A developer can create a bundle for a known native integration, edit it, recover an interrupted write after reload, run an installed app evaluator through a copyable private helper, inspect meaningful results, publish, and prepare that exact release in a background worker. Members and optional delivery reports have usable inspection/recovery paths. A team can build installable release artifacts without guessing how the pieces fit.

No automatic promotion, hosted task execution, sandbox fleet, universal evaluator registry, invitation system or live session mutation. Generic bundles remain supported. Live provider/deployment evidence stays separate from deterministic tests.

## 1. Content that the selected plugin can consume

Keep generic payload validation unchanged. Add one immutable bundle setting `compatibilityTarget: generic|codex|claude|pi|cursor`. Existing bundles migrate to generic without changing immutable bytes. New console setup requires a visible choice; generic explicitly means native compatibility is unchecked. Adopt another target by copying/importing reviewed content into a new bundle. No policy-change endpoint, CAS revision or mutable-policy locking subsystem.

A small pure TS validator and matching Rust validator share fixtures. Native rules retain current supported instruction count, package paths, manifest/name/description grammar and target-specific naming. Plugins reuse that validator; generic content never inherits native rules. Memory approval stays with the application.

Generic validation gates saved versions/drafts. Incomplete native metadata remains saveable, with visible diagnostics, so users can save → reload → repair. Native compatibility gates initial publication/setup, provider-produced candidates, and every fresh promotion/rollback, including draft publication and unevaluated release. Validate the actual immutable payload against the bundle's stored target inside the existing transaction. The target cannot change, so no new policy locks or worker revision fencing are needed. Committed replay still precedes fresh checks. Historical content remains readable.

Console import, drafts and final review show the stored target and path-level errors. Initial import/setup publishes immediately and must pass; an editor import can remain an incomplete saved draft. Replace the final text-only diff with existing `ContentDiff`. Generate unique `new-skill[-N]` names before insertion.

For large bundles, change only the provider adapter response to bounded edits: `{schemaVersion:1, edits:[{path,oldText,newText}], rationale}`. Each path exists and is allowed; anchors match once in original text; same-file ranges cannot overlap; empty anchors only replace an empty file. Apply from the end and preserve file order, kinds, paths and untouched bytes. Cap content at 32 KiB, edits at 128, rationale at 4 KiB, and outer response at 256 KiB. Keep final payload and allowed-edit validation. Public `ProposalModel` still returns a reconstructed full payload. Check provider `finish_reason` before accepting output. No fuzzy patching or full-echo fallback. Multiple edits in one file are allowed only when their original ranges are disjoint; duplicate ranges are rejected.

## 2. Recover writes rather than guess

Use one allowlisted pending-command envelope for audited draft create/save/publish, proposal/evaluation creation and release/restore. Keep credential reconciliation separate. Connection creation, discard/interruption and optional cross-session text retention are outside this first recovery expansion. Freeze reviewed scope, action, normalized exact JSON body, key, actor/session scope, expected revisions/generation, pinned identities and proposal disclosure before sending. No credentials, arbitrary URLs, headers or remote code in envelopes.

Store retry text in same-tab session storage before the first write; do not add optional local text retention yet. Store minimal uncertainty metadata separately so forgetting/expiry never implies nonexecution. Quota/disabled storage sends nothing. Remove text after reconciliation, explicit forgetting, logout or account switch; preserve an unresolved fence/receipt path. Keep subsequent editor changes separate from the submitted snapshot.

Preserve current key namespaces: setup/drafts keep principal/project/key identity; newly covered actions keep principal/project/canonical-route/key identity. Use a small receipt/tombstone table for the new transport rather than changing legacy namespace rules. Console marks the new audited commands for durable result retention. Every affected route, marked or unmarked, acquires its existing namespace lock and consults matching committed/closed records. Unmarked requests without a retained receipt preserve legacy behavior. Marked adoption checks existing unexpired route receipts; it must never reinterpret another legal route's key reuse. Global setup/draft collisions remain conflicts. Freeze the marker and exact lock/namespace strings in contracts before editing callers.

A shared action allowlist derives canonical routes and effective authorization for fresh execution, replay, lookup and close: setup needs write + promote; proposals need propose; evaluation create needs write; promotion needs promote; draft actions retain their actual rights. Preserve browser-admin semantics for any connection lookup. The initial actor's single `required_right` is insufficient where an action checks more. Reauthorize in the same transaction before returning a retained result.

Use existing server actions plus one internal bounded exact-body transport/pending helper, not a public raw SDK or prepare/submit gateway. Receipt lookup is explicit about action/resource/route; legacy operation lookup keeps its setup/draft behavior. Check committed outcomes before stale UI preflight. If none exists, an exact retry retains body/key and every fresh generation/revision/parent/evidence check. `not_observed` is still uncertainty, not proof of failure.

An explicit authenticated close operation takes allowlisted action/scope, serializes on the same namespace lock, and first consults retained plus unexpired legacy receipts. Return a known commit; otherwise persist a tombstone rejecting late marked **and unmarked** requests in that namespace. A route-scoped close never blocks a legacy caller's unrelated route key. Legacy key-only and forgotten-text records can then be safely fenced before a newly reviewed command. Close never cancels a commit, and a historical expired legacy operation may remain unprovable; disclose that limit. A close timeout remains uncertain.

A new evaluation is a new intent/key; an uncertain retry is the old one. Credential secrets remain memory-only and are never replayed or persisted. A typed already-issued result identifies the original credential without its secret; explicit confirmed revocation enables replacement under a new key. Lost revoke responses keep replacement unavailable until reconciled.

## 3. Make app-owned evaluation useful

Retain current request routes/state transitions and existing frozen dataset/runtime/grader/case fields. New comparison reports can carry `{requestId,attemptId}`. Add request flag `requireBoundEvidence`: old stored requests and omitted legacy inputs default false; new console/helper requests always set true. A strict request cannot finish with an unbound or differently bound report. Legacy completion remains explicitly labeled legacy/unbound for compatibility. Bound submissions always validate running request, principal, attempt, versions/digests and declared settings; finish repeats current checks. Never guess historical associations.

Direct evidence-backed promotion keeps its existing independent rule: a complete matching report plus current parent/revision/digests and reviewer authority. A request need not be completed or the candidate win; interruption prevents finish but does not erase inspectable evidence or silently create a new release policy. UI distinguishes request state, comparison completeness and review decision.

Use an app-supplied configuration ID and opaque revision in the existing frozen `runtime` map, alongside app/model/sampling/write-policy and declared limits. Dataset/grader revisions and inventory remain existing fields. The installed adapter describes these values; runner comparison is structural, not a service-standardized canonical hash protocol. App digests may be opaque revision identifiers. Console can select a public local default or accept a bounded descriptor from an app. No request can select executable code, modules, URLs or credentials, and no registry service is needed.

Provide an explicit installed adapter seam (`describe` plus app execution/grading callbacks), a model-free behavioral example with observable outcomes, and a runnable Codex/Luna adapter using the existing native review example. The deterministic payment retry example reads declarative policy data and grades simulated charge traces; it is orchestration regression evidence only. The usable native path adapts existing service-proposer cases/grader and Codex/Luna execution to the same interface, with copied-command, per-case output and explicit review support. A fake model can verify the seam; live native improvement remains unqualified until the opt-in run actually passes. Presence checks remain a named contract option. A real app can substitute its own installed adapter without editing console code.

Standardize on `npm run evaluate:local -- --bundleID UUID --requestID UUID`, implemented by `scripts/evaluate-local.ts`. A private local helper accepts explicit bundle/request IDs, reads this launcher's private configuration, uses a dedicated evaluator principal with read/write but no promote/propose, and never prints tokens. The copied command works for any selected local bundle. A private attempt journal is scoped to service/project/bundle/request/evaluator, uses atomic owner-only writes, and has exclusive per-request process ownership held through recovery/execution/finish. Concurrent invocation inspects/exits without executing. Persist an execution-started marker before callbacks and the exact report before submission. Recover a saved report; a started attempt with no saved complete report requires explicit interruption/new request, never automatic reexecution. Do not use a PID file as proof that execution never happened.

List requests/proposals/comparisons chronologically with `(created_at,id)` cursors. Console discovers the head page, inserts created records immediately and directly polls known active IDs across later pages, with bounded concurrency and stale-scope guards. Explicit reruns have a new request/key; omit retry lineage fields until a real consumer needs them.

## 4. Access, delivery and operations

- **Access:** inside the existing membership writer lock, reject demoting/removing the final admin with `409 last_admin`. Add an admin-only bounded member list and nullable current role to identity lookup. No machine-admin bypass or invitation system.
- **TS cache:** use one transport-failure classifier accepting native `TimeoutError` in both fallback branches. Explicit offline permission, private cache verification, denial and integrity rules remain authoritative.
- **Python reporting:** replace executor shutdown dependence with one lazy daemon worker, bounded queue, bounded public wait/close and no automatic spin on failed events. Fresh arrivals must drain. Close stops claiming additional events; an already claimed/in-flight call may return after close. A stuck injected client must not prevent interpreter exit. Verify actual subprocess exit with a stuck client. Real recipe clients use short reporting deadlines and no retries.
- **Recipes:** model-free TS/Python examples use separate read and optional receipt clients. Report prepared only after preparation, started only after an actual observed app start. Delivery remains successful when optional reports fail. Codex uses the actual `turn.started` event, not lazy thread construction.
- **Setup:** known port/tool/database/private-path/configuration failures get allowlisted actionable diagnostics. Preserve private config, database ownership recovery and existing data. Keep the native launcher path; document a complete manual Compose service + console bridge rather than silently changing database routing.
- **Distribution:** retain versioned tarballs/wheel plus checksums/manifest and isolated consumer checks. Produce a local release directory and upload-ready workflow; do not publish to registries or deploy as an incidental test.

## Coverage of the audit

| ID | Audited gap | Planned result |
| --- | --- | --- |
| A01 | Native compatibility | Immutable target, shared validators and authoritative publication checks |
| A02 | Timeout offline fallback | Actual timeout handled without weakening denials |
| A03 | Last-admin lockout | Transactional invariant |
| A04 | Draft reload recovery | Frozen command, durable outcome and safe close |
| A05 | Fixture-only evaluation | Installed app adapter, descriptor and behavioral example |
| A06 | Local evaluator handoff | Private, copyable helper with dedicated rights |
| A07 | Evaluation retry | Explicit new intent versus exact replay |
| A08 | Evidence attribution | Request/attempt-bound report validation |
| A09 | Pagination/polling | Chronological cursors and direct active-ID refresh |
| A10 | Full-echo proposal limit | Bounded deterministic patch reconstruction |
| A11 | Final review diff | Existing complete diff reused |
| A12 | Lost suggestion/release responses | Durable outcomes before stale checks |
| A13 | Duplicate new skills | Unique package allocation |
| A14 | Credential replacement | Typed original issuance, confirmed revoke, fresh replacement |
| A15 | Existing membership visibility | Bounded list and current role |
| A16 | Python receipt race/shutdown | Fresh queue draining and actual bounded exit |
| A17 | Receipt adoption workflow | Runnable optional-reporting examples in both languages |
| A18 | Setup diagnostics | Safe actionable errors |
| A19 | Compose/console bridge | Complete manual path with separate data ownership |
| A20 | Native-provider qualification | Runnable opt-in checks and honest dated evidence |
| A21 | Distribution | Retained installable versioned artifacts, verified consumers |
| A22 | Hosted qualification | Reproducible OIDC/HTTPS/container checks and evidence ledger |

## Qualification and finish line

Default tests use no paid models and own disposable databases/files/processes. Keep the user’s live database/configuration and running app untouched. Model-backed development uses Luna only, with explicit opt-in and bounded runs. Do not use other provider models to fill a qualification gap.

Local completion requires regression evidence for every fixed failure and a real-service/browser path: create native-target content → save → reload/recover → request app evaluation → run copied helper → inspect bound report → deliberately release → prepare with an installed package → optional receipt observation → rollback. Include a losing-but-complete evaluation and preserve existing pinned workspaces.

External claims require real evidence: compatible Claude/Pi/Cursor provider sessions, real configured OIDC/HTTPS, direct remote model TLS, working container/host lifecycle and public artifact availability. Implement their opt-in harnesses and keep `passed | blocked | not run` records with exact blockers; do not call them passed based on fixtures. Existing narrower Codex/Luna evidence is historical until rerun. Publication/deployment are separate actions.

Service/API rollout precedes new clients; old JSON rows and legacy completion behavior have explicit defaults. No historical record is silently relabeled bound. Centralize migration numbering, shared DTOs, cursor/command contracts, manifests and generated docs. [Review resolutions](review.md) record the changes. The final parallel plan assigns sole file owners and dependency gates. Test acceptance must update the provider HTTP fixtures to patches, strict evaluation fixtures to bound evidence, and browser handoff to invoke the actual copied helper against test-owned private state. Use the isolated Rust database runner, not ambient DATABASE_URL or silently skipped database tests.

## Planning inputs (superseded where the reviewed plan differs)

[Content](../../../research/archive/remediation-planning/input-content.md) · [Recovery](../../../research/archive/remediation-planning/input-recovery.md) · [Evaluation](../../../research/archive/remediation-planning/input-evaluation.md) · [Access and delivery](../../../research/archive/remediation-planning/input-access-delivery.md) · [Shipping](../../../research/archive/remediation-planning/input-shipping.md)
