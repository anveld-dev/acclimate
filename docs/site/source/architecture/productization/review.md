# Which review findings hold up?

Four Sol reviewers rechecked all 16 Terra findings against the code and the intended small-service scope. Most were future-plan details. Several proposed fixes added unnecessary infrastructure. The earlier review overstated full-bundle provider disclosure as a current privacy bug.

**Both confirmed SDK bugs are now fixed**, with model-free regression tests. The productization workflow was implemented afterward; see [current acceptance evidence](acceptance.md). The table below preserves the earlier plan-review verdicts.

## Confirmed SDK fixes

1. **Comparison reports keep the executed identities.** Previously a callback could change candidate `c` to `different-child` and dataset `before` to `after`; the report would name those changed values after executing `c`. The helper now uses its frozen versions and captures dataset/runtime/grader metadata before callbacks.
2. **Each grading attempt gets an isolated output copy.** Previously a grader could remove a finding, fail, then leave its retry grading the changed object. The helper now captures a private output snapshot and clones it for every attempt. Uncloneable outputs become grading failures without another execution.

See [the implementation](../../../packages/sdk/src/compare.ts) and [regression tests](../../../packages/sdk/tests/compare/compare.test.ts). Grading outputs must be structured-cloneable data; each attempt receives a separate clone. This is in-process isolation, not durable output storage.

There is also a real recovery limitation: browser reload loses the in-memory request key, and the service forgets cached results after 24 hours. That can duplicate creates. Existing generation/revision checks already prevent repeating committed saves/publications; a service restart alone does not erase the PostgreSQL cache. Keep compact content-command results and pending IDs, fix replay ordering, and avoid an automatic replacement while an outcome is unknown. See [commands.rs](../../../src/commands.rs), [draft-workspace.tsx](../../../apps/console/src/components/draft-workspace.tsx) and [edit-channel.ts](../../../apps/console/src/server/edit-channel.ts).

## Verdict on all 16 findings

Numbers preserve the earlier review's row order. “Future” describes the feature at review time. Use the acceptance record for its current implementation status.

| # | Earlier finding | Sol verdict and smallest response |
| --- | --- | --- |
| 1 | Draft acceptance evaluated a different proposal. | **Keep: plan gap.** Test the reopened draft's exact evaluated snapshot and a newer-generation rejection. Existing promotion already checks evidence identities. |
| 2 | Receipts/Python parity blocked first qualification. | **Keep the scope cut.** Clean SDK resolve/verify/prepare is enough for the first gate. Reporting support qualifies separately. |
| 3 | Frozen evaluation settings were not bound. | **SDK fix complete.** Report identities are captured before callbacks. Matching request fields remains future work. No byte-manifest service is needed. |
| 4 | Old sibling snapshots lost their draft association. | **Simplify.** Keep `(draft, generation, version)` rows. Publish/discard already have state; no event-sourcing layer. |
| 5 | Requested work could not be interrupted. | **Future; keep the small rule.** Permit conditional requested/running → interrupted, without remote cancellation claims. |
| 6 | `sourceLabel` was absent from setup. | **Keep: minor contract mismatch.** Add the optional bounded field or remove its promise. |
| 7 | Proposer sent unselected memory. | **Accept the existing bundle-level contract.** Code sends the full selected bundle, as originally designed. Disclose that clearly and obtain authorization. File-level filtering is optional new scope. |
| 8 | Another evaluator could finish an attempt. | **Future; keep authorization.** Bind principal and attempt at start; verify both, current rights and comparison submitter at finish. |
| 9 | Regrading output identity was weak. | **SDK fix complete.** Grade attempts receive isolated clones. Apps own durable outputs/digests; no service output-index subsystem. |
| 10 | Output refs might become unsafe links. | **Currently fine.** No console navigation/fetch/HTML sink exists. Render future refs as escaped text; defer preview infrastructure. |
| 11 | Old receipts might return after retention. | **Simplify the guarantee.** Bounded cooperative retries, stable IDs and retained deduplication suffice. No server-issued report windows or exactly-once claim. |
| 12 | Unknown writes lacked durable recovery. | **Keep a smaller recovery fix.** Retain content outcomes and reconcile after restart/expiry. Defer generic abandon endpoints, permanent tombstones and universal mutation orchestration. |
| 13 | A request ID was not an evaluator integration. | **Keep the runnable example; drop the registry.** Adapt the existing app workflow with fetch/start/finish. Configuration and fixtures stay local. |
| 14 | Empty-workspace import had no path. | **Keep: plan dead end.** Initial import uses atomic bundle setup and an explicitly unevaluated seed; later imports update drafts. |
| 15 | Integration history access was ambiguous. | **Future; keep the boundary.** Define separate credential rights when opt-in integrations ship. Existing project read grants remain unchanged. |
| 16 | Hosted login/bootstrap was incomplete. | **Hosted-only gate.** Choose a maintained adapter and initial-operator policy before hosted access. Custom session storage/transport are design choices, not local-release requirements. |

## Provider consent, precisely

The worker passes the full parent bundle at [improvement.rs:324](../../../src/improvement.rs); [lib.rs:204](../../../src/lib.rs) serializes it for the configured provider. Returned edits are constrained by `allowedPaths`. The [original design](../../design/improvement.md) says the proposer reads the selected bundle and evidence, so edit restrictions never promised read restrictions.

The UI should explain that existing disclosure before asking for a proposal. If users need to authorize only selected files, implement filtering and server-side reconstruction, and test the actual provider input. That would strengthen the product's disclosure boundary; it does not establish that the original bundle-level contract was violated.

## Scope removed from the first slice

The plans no longer require server-side evaluation profiles, exact-byte manifest distribution, service-owned output indexes, receipt windows, an abandonment protocol or event sourcing. Keep the durable draft → app evaluation → review → release loop, a runnable fixture consumer, and honest error states. Hosted identity and optional receipts remain separate later slices.

Verification: all 10 focused comparison tests and 37 package tests passed, including three new regression cases. Package typechecking, build and formatting checks passed. The generated docs passed static checks. No provider calls or hosted/runtime qualification ran. The [acceptance plan](acceptance.md) describes future implementation checks.

## Implementation review — resolved

Three Sol reviewers checked the new service, authorization/delivery and console code. The final implementation fixes the concrete findings:

- Authorization and data reads share one transaction, preventing a second-connection pool deadlock. Membership writers serialize before caller/target locks, preventing crossed-admin deadlocks.
- Hosted draft actions require a session. Stale/revoked cookies can complete a fresh verified login, and configured machine credentials keep working in hosted mode.
- Draft browser edits stay bound to their original release; pristine new drafts refresh with the release. Definitive setup validation errors clear pending IDs, while ambiguous writes retain them.
- Folder imports keep relative skill/memory paths. Credential and content reads retain authorization locks through their transaction; integration secrets cannot be duplicated by a same-key issuance retry.

[PostgreSQL regressions](../../../tests/productization_regressions.rs), [integration tests](../../../tests/integrations.rs), console tests and the [real browser runner](../../../scripts/test_productization_browser.py) cover these fixes. This records resolved code issues, not a claim of live hosted qualification.
