# Python and cross-language critique — round 2

Disposition: **APPROVE**.

Reviewed normative PLAN.md revision D2, SHA-256 `9bd400d28d8e07f1906273dd7ead095c9add3f273e5e33adc5045fe9e23462e1`, and the corresponding objection resolutions. I have no unresolved blocking objection to this exact revision within the Python/cross-language remit.

## Prior objections

| Finding | Disposition | Evidence in D2 |
| --- | --- | --- |
| PY-1 — verified-bundle mutation across callbacks | **Accepted as resolved** | Section 3 retains a module-owned immutable verified snapshot, supplies independent payload AND metadata copies per invocation, and keeps prepared/effective filtering separate from that canonical snapshot. G09 covers mutation isolation in both languages. The descriptor is also defensively copied in Python rather than exposing a mutable reference into its definition. |
| PY-2 — Python cancellation and awaitable-return contract | **Accepted as resolved** | Section 11 freezes `cancel_event`, `CancellationContext`, `CallbackCancelled`, and `ExecutionUncertainError` meanings. Static coroutine callbacks are rejected; returned awaitables/futures, including nested values, take the uncertain-execution path before ordinary invalid-JSON classification. The shielded worker loop drains through repeated outer cancellation without cancelling the thread task or authorizing early cleanup. G08/G17 cover the relevant lifetime/misuse scenarios. |

The cancellation context is an app cooperation contract, not an external-job termination attestation. D2 says that explicitly and requires uncertainty when quiescence cannot be established; that is the appropriate limit.

## Cross-lane recheck

- **Numeric conformance:** the explicit sum-then-divide IEEE-754 recurrence, operation order, intermediate-finiteness checks, UTF-8 case ordering, inclusive thresholds, and bool/count rules provide one implementable Python/TypeScript result contract. Overflow is deliberately indeterminate rather than language-dependent.
- **Transport and replay:** separate 4 MiB JSON response budgets accommodate comparison/retained-operation wrappers around admitted 2 MiB requests. Exact body bytes remain language-owned; shared scope encoding/flock excludes concurrent or foreign takeover. The plan does not require Python to recreate legacy JavaScript serialization.
- **Headless integration:** Python receives the same request → run → check → export command journey, with durable request intent and stable base/keys. The new CLI helper does not introduce a second public lifecycle protocol for Python callers to assemble.
- **Evidence and authorization:** reader configuration is separate from evaluator configuration; scalar-only verification does not require originating journal/write privileges. Selected content still requires original private integrity/binding checks and a statically registered mapper. No cross-language unfinished-journal portability or output-authenticity claim was added.
- **Resource lifetimes:** uncertainty escapes both execute and grade classification. The native helper's persistent private locator/effective-context filtering is compatible with Python's generic callback responsibility and does not add a Node requirement to the Python evaluator itself.

No new blocking finding was identified. Implementation must still execute the defined conformance, real-process locking, response-loss, and repeated-cancellation gates; agreement with the plan is not a test pass.

## Review limits

This was a document/source coherence review. Only this review file was added; no product implementation, private credential inspection, package installation, paid model call, browser session, service mutation, or runtime test was performed. A material change to the normative plan requires a new exact-revision check before this approval can count toward final consensus.
