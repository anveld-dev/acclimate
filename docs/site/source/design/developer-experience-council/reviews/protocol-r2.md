# Protocol council ratification — D2

Disposition: **APPROVE**.

Approved exact `PLAN.md` SHA-256:

`9bd400d28d8e07f1906273dd7ead095c9add3f273e5e33adc5045fe9e23462e1`

I checked that digest, reviewed the revised normative plan and resolution ledger, and revisited the affected current operation/auth/transition/transport behavior. No unresolved blocking objection remains from this review. This is approval of the design and its required implementation gates, not a claim that those gates have run or the product changes are implemented.

## Original findings

### PR-1 — Accepted resolution

Section 5 now explicitly treats retained responses as historical mutation results. It requires an authoritative request read after start/finish replay and before the marker/first callback, then current status/binding checks before each later execute or grade callback. Observed interruption stops scheduling and prevents submission/finish. It also correctly acknowledges the unavoidable race after the final observation and does not claim a lease or remote job termination.

G06/G08 cover the held-start-response/interruption scenario and conservative lifetime behavior. This resolves the missing reconciliation protocol without pretending an HTTP replay can certify current lifecycle state.

### PR-2 — Accepted resolution

Section 4 now freezes the guided target grammar, shares it with retained route generation/classification, rejects unsupported authorized project/principal targets, and forbids silent transient fallback on marked guided writes. Canonical UUID and channel rules are explicit. Legacy raw behavior is preserved without advertising retained-ready status for unsupported targets.

G03/G04/G06 cover guided target rejection and retained replay. This closes the gap between a capability snapshot and actual route eligibility.

### PR-3 — Accepted resolution

Section 5 now separates the 2 MiB request budget from a streamed 4 MiB JSON/retained-envelope response budget. Both language clients get the same explicit response bound; Python's default change and TypeScript's former unbounded behavior are documented. Raw bundle limits remain separate. The plan bounds wrapper metadata and requires maximum admitted report fixtures through create, get, operation lookup and replay, including safe over-budget failures that retain state.

G06 now checks the complete recovery envelope, not merely request admission. This resolves the inability of a valid admitted report to complete through a bounded Python response reader.

## Other checks on the revision

- The interrupt intent uses a separate short-held lock, so it need not wait for the runner's long-lived journal ownership or edit active attempt state.
- Headless request creation persists immutable local intent before mutation, uses existing durable draft/request operations, recovers those results before considering baseline drift, and does not rebase or replace keys after an unknown response.
- Legacy unknown submission remains inspection-required. Retained operations do not erase historical uncertainty or justify callback replay.
- Python's explicit cancellation and awaitable-misuse rules retain uncertain work and the exact-body journal contract; asynchronous cancellation is not represented as proof that external work stopped.
- The native recipe now has a private durable job locator/launch intent and a persistent owned workspace parent. Cleanup requires established stop plus marker/path checks; an age, PID or missing handle cannot authorize deletion.
- Artifact content release validates the local sealed report/index against authoritative binding before mapper invocation. Scalar-only export/read-only verification does not require evaluator write authority or a local journal. Neither local hashes nor a matching scalar projection attest redacted execution output.
- Effective authorization, immutable body fingerprints, shared lock exclusion, distinct operation results versus delivery receipts, and explicit promotion remain preserved.

No new blocking finding was established by these cross-lane changes. Performance and usability costs—including lifecycle reads before every callback, serial execution and static grant restarts—are stated tradeoffs rather than hidden promises.

## Ratification limits

This approval applies only to the exact digest above. A material later change to normative interfaces, authorization, recovery, execution lifetime or evidence semantics requires renewed review. Runtime security, OS durability, transport limits, model behavior and usability still require the plan's implementation and qualification work.
