# Qualification checks

**Archived proposal — superseded by the smaller content service.** [Current overview](../../../../../design/overview.md).
[Design guide](../README.md)

**For:** plugin authors and production operators. **Owns:** the evidence behind an advertised capability. **Status:** proposed; no adapter is certified yet.

For example, an adapter might return reviews successfully but lose a pending approval after a restart. It must not advertise durable waiting until that recovery path passes its checks. A plugin can implement the wire protocol and still lack safe waiting, complete accounting, or reliable recovery. Qualification is per build, native runtime, worker image, execution profile, and feature—not a blanket “supported harness” badge.

## Three separate checks

| Check | Evidence required |
| --- | --- |
| Protocol conformance | Messages, lifecycle, artifacts, and errors obey the interface. |
| Native integration qualification | The pinned harness actually preserves the claimed ordering, mediation, and recovery behavior. |
| Production admission | This exact qualified profile meets the job's required policy and runtime constraints. |

SDK helpers reduce authoring work. They cannot manufacture a missing native hook or checkpoint guarantee.

## Harness test suite

Start with a deterministic fake harness and host, then apply the same external interface tests to each native adapter:

- Version/feature negotiation rejects incompatible requests and required fields.
- Bidirectional callbacks work while an `advance` request is pending; logs stay off stdout.
- Oversized frames, duplicate JSON keys, malformed events, conflicting source IDs, and slow readers fail safely under bounded resources.
- Open/start retries don't create a second active session after an uncertain response.
- Tool/model requests cannot bypass host admission, including builtin tools, auxiliary requests, background work, and SDK retries.
- Native durability/retry engines map to the same stable effects; they cannot independently redispatch an operation while host recovery does the same.
- The durable transcript/intent barrier fails before irreversible dispatch if storage fails.
- Waiting preserves the native pending action and exact arguments across a new process/attempt; changed arguments invalidate approval.
- Outcome saved before a crash is delivered without redispatch. Missing nonrepeatable outcomes stop for reconciliation.
- Fenced workers cannot write authoritative results or admit new work. Earlier admitted external effects retain their uncertainty.
- Cancel acceptance is distinct from confirmed containment. Reused PIDs don't target unrelated processes.
- Checkpoints reject mismatched package, adapter, runtime, and format identities.
- Missing usage stays unknown; concurrent requests and children share the authorized budget correctly.

A complete output can't hide an unresolved required action. Unknown usage alone may allow result delivery with a conservative hold; an unknown required nonrepeatable effect may require attention instead.

## Evaluation and grader test suite

Use fixture tasks with known outcomes, including adversarial outputs:

- Slot inventory stays fixed across retries, restarts, deadlines, and partial failures.
- Baseline/candidate blocks preserve their planned pairing, settings, and measurement window.
- Candidate failures count; verified infrastructure failures and judge failures stay distinguishable and incomplete where required.
- Judge retries don't rerun the candidate or create extra samples.
- A candidate cannot write labels, hidden tests, grader code, expected weights, or evaluator-owned score records.
- Trial containers have private file/service state, deny live writes and bypass egress, and leave no reusable workspace after cleanup. Missing controls reject admission.
- Symlink/path traversal and oversized output cannot escape collection limits. Submitted code executes outside the trusted grader, without answer-key mounts or credentials.
- Pin a finite adversarial judge fixture set, expected score ranges, and repetition count before testing. Require schema/authority checks to reject every invalid response and zero score-threshold breaches on designated critical injection cases. Record results and limits: passing this suite does not prove injection immunity.
- Nonfinite/out-of-range scores, missing required guards, unknown cost, and mismatched digests invalidate decisions as specified.
- Deadline/budget exhaustion never removes unscheduled slots from the denominator.
- Aggregation and decisions consume immutable snapshots. Late evidence creates a new recorded decision, not a rewritten one.
- Imported benchmark results aren't upgraded to certified evidence without identity, trust, and completeness checks.
- Proposer/analyst access to sealed audit data is denied; repeat probes are logged and limited.

Test pure score/noise/selection rules using independently specified fixtures. Native smoke runs and load/restore drills add evidence; passing unit tests alone doesn't establish production reliability.

## Qualification record

Store plugin/native/image/schema digests, enabled features, disabled/default resources, tested configuration, suite revision, results, unresolved limitations, authorizing identity, and revocation state. Required experimental native features/transports are explicit. An upstream experimental label isn't removed by passing our tests.

Changing any relevant native runtime, sandbox policy, tool world, adapter, checkpoint format, or gateway integration invalidates affected evidence. Run the relevant checks again before broadening admission. Existing runs stay pinned to a compatible retained profile.

Operator-installed plugins and candidate content have different trust. Don't let a candidate edit its adapter, qualification record, grader, or host policies to make itself pass.

## Delivery plan

Publish one cross-language protocol fixture set and fake adapter first. Qualify one real integration end to end, then bring Claude, Codex, Pi, and fx through the same process. Track each feature's evidence and gaps in the plugin registry. Current native surface facts live in [integration research](../../research/harness-integrations.md).

If a native SDK only supports starting jobs and observing results, expose that honestly for compatible use. Jobs needing stronger mediation or durable waiting are rejected until a managed integration qualifies.

**Next:** [adapter protocol](../integrations/protocol.md), [evaluation contracts](../evaluation/contracts.md), and the [production readiness bar](production.md#operations-and-production-readiness).
