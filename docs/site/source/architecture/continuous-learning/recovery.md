# Durable learning and recovery contract

**V1 recovery design, 2026-11-17.** The selected application-local profile is implemented; the broader record sketches below also describe future placement options. Use the [exported types](../../../packages/sdk/src/learning/types.ts) and [implementation record](implementation.md) for exact current behavior. There is no new campaign server endpoint. This follows the [second-pass recovery review](../../research/continuous-harness-review/second-pass/recovery.md).

## Ownership and supported deployment

One authoritative journal owns a campaign's policy, observation cursor, published baseline and selected candidate, decisions, external-operation intents, budget ledger, audit exposures and desired stop state. A campaign has exactly one controller writer. An integrating app owns native sessions, tool authority, execution cancellation, private artifacts and adapter credentials. Acclimate continues to own immutable content, request/attempt-bound evaluations, and transactional channel promotion.

V1 supports a single controller on one durable filesystem, one external operation active per campaign, one candidate against the current published baseline per round, and explicit human-authorized release. An OS process lock plus checkpoint revision check serializes `advance`. The authoritative checkpoint is one private, atomically replaced file containing state, durable operation keys, budgets and immutable-record references. Write/synchronize immutable artifacts first, then synchronize and atomically rename the new checkpoint; unreferenced artifacts after a crash are harmless orphans. There is no required SQLite database, multi-file transaction, or independently authoritative append log. A rebuildable progress JSON file is not the checkpoint. The private-write and file-lock patterns in the [existing evaluator journal](../../../packages/sdk/src/evaluation/journal.ts#L58) are implementation references.

The same contract can be implemented in a server transaction store later. Doing so requires an owner epoch on campaign writes and exclusive operation admission; a lease expiry must never be interpreted as stopping external work. Distributed controllers and parallel campaign operations are outside v1. The Rust service's [singleton queue lock](../../../src/main.rs#L151), drain discipline and atomic candidate/success transaction remain valid and unchanged.

## Public interface

The learner module hides operation planning, journal ordering, service reconciliation and recovery behind three proposed commands. Applications supply adapters during module construction, not on every state transition.

```ts
interface Learner {
  submit(command: LearnerCommand, commandId: string): Promise<CommandReceipt>;
  advance(options: { signal?: AbortSignal; deadline: number }): Promise<Progress>;
  inspect(): Promise<LearnerView>;
}

// Campaign scope is fixed at openLearner; commands cannot retarget it.
type LearnerCommand =
  | { kind: 'observe'; observation: TaskOutcome }
  | { kind: 'request-stop'; reason: string }
  | { kind: 'resume'; reason: string }
  | { kind: 'resolve-uncertainty'; resolution: WorkResolution };
```

`submit` durably appends a command to a private inbox using a short inbox lock and returns its sequence/digest; it does not claim that the learner has applied the command. It accepts only scoped evidence from configured trusted adapters or local operator inputs and rejects a changed body under the same command ID. An observation or arbitrary success claim does not become a trusted outcome/admission merely by submission. Stop requests also durably set the inbox admission barrier.

`advance` consumes submitted commands idempotently, settles an already-planned action, and admits at most one external operation per call. It may return `waiting` or `needs-reconciliation`; it does not imply a whole campaign ran. A resume command reopens admission only if the policy is unchanged, the stop condition permits it, no execution remains unsettled, and budget/audit guards pass. A policy change creates an explicit campaign epoch rather than silently reinterpreting prior decisions.

Example: a scheduled app submits an ordinary task outcome, then calls `advance({deadline})`. After a crash it calls `inspect` and `advance` again. The module reconciles the persisted evaluation request/report, then records one search decision. The scheduler does not reconstruct internal phases or issue a replacement evaluation merely because the process restarted.

**Inbox ordering:** `submit` never takes the long `advance` lock. `advance` persists its applied-inbox sequence and deduplication facts in the checkpoint before separately trimming applied inbox entries; a crash before trim simply replays and ignores those entries. Before persisting any new dispatch marker, `advance` takes the short inbox lock and checks stop/barrier commands. Stop submission and dispatch admission are therefore ordered under the same lock. Stop arriving after a dispatch marker cannot retract that admitted operation, but prevents the next one. Queue acknowledgement and campaign-state application are intentionally distinct facts.

## Identity and retained records

Identifiers are opaque and scoped by service identity, project, bundle and campaign. IDs are stable across retries; a deliberate new execution receives a new operation/attempt identity. Credentials and raw private task data are never part of public identity.

```ts
// 'release' dispatch belongs only to a future authorized bridge; v1 observes reviewer release.
type OperationKind =
  | 'propose' | 'evaluate-development' | 'evaluate-audit'
  | 'publish-candidate' | 'release' | 'verify-fresh-job';

type OperationState =
  | 'prepared'       // intent, exact input/body, identity and reservation durable
  | 'dispatching'    // durable marker: external work may have started
  | 'acknowledged'   // adapter/service handle durably retained
  | 'result-saved'   // immutable result plus digest retained
  | 'settled'        // corresponding campaign transition committed
  | 'unknown';      // work/result or usage cannot currently be reconciled

interface OperationIntent {
  operationId: string;
  attemptId: string;
  kind: OperationKind;
  inputDigest: string;
  policyDigest: string;
  parentHarnessDigest: string;
  candidateHarnessDigest?: string;
  experimentDigest?: string;
  bodyRef: { file: string; sha256: string; bytes: number };
  idempotencyKey?: string;
  reservationId: string;
  state: OperationState;
  handleRef?: string;
}
```

Each intent also binds the exact principal and relevant service request/attempt IDs. A changed candidate, evaluator protocol, principal, endpoint or body requires a new explicit operation; recovery never substitutes the latest values. Private artifact location may change only through an explicit verified migration, not an implicit root fallback.

`OutcomeReceipt` binds operation/attempt/input identities, result digest/reference, `executionSettled` certainty, `resultKnown`, and known/unknown usage. Execution settlement, result availability and cost settlement are separate facts: a finished process can lose its output, or return output without known provider cost. In the selected first profile, the reviewer releases through the existing console/operator path; the learner exports a bound review artifact and reconciles the exact promotion readback without holding promotion authority. A future release-authorization bridge must bind the frozen release body, audit/comparison IDs, policy digest, expected channel revision and authenticated authority. Reconciliation must state the supporting service/provider readback or adapter proof; it cannot be a guessed “probably stopped.”

## Campaign and round state

The checkpoint has `schemaVersion`, `campaignId`, `revision`, `policyDigest`, `appliedInboxSequence`, `publishedBaseline`, `round`, `operation`, `decisions`, `budget`, `audit`, and the following control facts. Record schemas reject unknown versions; migration is explicit and preserves old artifacts. Keep control state separate from work settlement:

- `desiredMode`: `running` or `stopped`.
- `admission`: `open` or `closed`.
- `phase`: `ready`, `working`, `awaiting-review`, `needs-reconciliation`, `stopping`, `stopped`, or `finished`.
- `termination`: absent, or a recorded reason such as objective met, budget exhausted, audit failed, user stopped, or policy expired.

A campaign is `stopped` only after admission is closed and all dispatched work has confirmed settlement. It can be `needs-reconciliation` with `desiredMode: stopped` when active work or its outcome remains unknown. A terminal completion with unresolved financial exposure must retain that uncertainty and cannot report a reconciled budget.

A round moves through:

```text
planned -> feedback-admitted -> candidate-saved -> development-recorded
        -> search-decided -> audit-recorded -> release-decided -> closed
```

Branches close a round with immutable reasons: no eligible feedback, invalid candidate, regression, indeterminate evidence, no measurable benefit, failed audit or declined release. A search-rejected candidate never advances to audit. Audit is needed only for a candidate the campaign seeks to release. V1 compares one candidate against the current published baseline; an accepted search candidate waits for audit/review and does not become the next round's parent before release. A new round starts only after the previous round's pending execution and decision are settled. Rejection keeps the published baseline; a confirmed release advances it. Multi-step search incumbents and release squashing are deferred.

A `SearchDecision` records accepted/rejected/indeterminate, parent/candidate identities, evidence IDs, selection-policy digest and rationale. The same atomic checkpoint update records the selected candidate and observation cursor. It advances the campaign baseline only after a release is confirmed. It does not promote a channel. An audit verdict and a release authorization are separate records; neither is inferred from an evaluation's `completed` status.

## Transition and commit ordering

1. **Plan.** Under campaign ownership and expected revision, choose exactly one next operation. Check desired mode, admitted feedback, exact artifact identities, budget, audit eligibility and lack of unsettled work.
2. **Prepare.** Write/synchronize immutable input artifacts. In one atomic checkpoint replacement, reserve budget, allocate operation/attempt and service idempotency keys, persist the exact request body/reference and next action, and increment the campaign revision. No external work has been admitted yet.
3. **Mark dispatch.** Persist `dispatching` before calling the adapter. This is the uncertainty barrier. A process dying after the marker cannot prove the call was never made.
4. **Dispatch.** Send only the retained bytes to the retained target/principal. Retain an acknowledged remote handle as soon as available. No checkpoint/inbox lock remains held across the model/tool call; the separate advance-ownership lock may remain held.
5. **Retain result.** Validate identity, privately write and synchronize the result/usage receipt, then commit `result-saved`. A lost response triggers reconciliation, not a fresh call under a new key.
6. **Settle.** In one atomic checkpoint replacement, consume the receipt, update the operation and budget ledger, reference the retained deterministic round/search decision where applicable, and advance the checkpoint. Repeating settlement is a no-op for that operation/result digest; a conflicting result stops reconciliation.
7. **Release.** In v1, export the immutable candidate/comparison/expected-revision review package; the existing reviewer owns the authorized promotion command and its recovery key. The learner reconciles the observed promotion and has no promotion credential. A future explicitly enabled release adapter must retain the exact authorized body and key before dispatch and reconcile lost acknowledgement using that same command. A stale current parent or channel revision requires a new review, never automatic retargeting.

For remote mutations, command idempotency and readback are used according to the existing service contract. They deduplicate that mutation, not arbitrary provider work. V1 releases the exact candidate already compared against the current published baseline. No reparent/squash is needed. The controller cannot reuse evidence for a different candidate or parent; a changed published baseline closes that release intent and requires a new round/review.

## Replay and reconciliation policy

Every adapter declares capabilities when the campaign is configured:

```ts
interface RecoveryCapabilities {
  dispatch: 'idempotent-with-key' | 'lookup-by-handle' | 'unrecoverable';
  stop: 'confirmed-settlement' | 'cooperative-only' | 'unsupported';
  usage: 'bounded-and-reconciled' | 'observed-only' | 'unavailable';
}
```

These declarations must be qualified against the actual adapter; a method's name is not proof of semantics. The controller persists the selected adapter revision/capabilities in the campaign policy.

- `prepared` can dispatch after reacquiring ownership and rechecking admission.
- `dispatching` without result uses the retained key/handle only if its declared capability can recover the same work. Otherwise transition to `unknown` and close admission.
- `acknowledged` is resumed or queried by its existing handle; do not create a replacement session.
- `result-saved` is settled without native execution or grading callbacks.
- `settled` is never executed again.
- `unknown` can be resolved by an identity-bound receipt, confirmed stop with explicit missing result, or an authorized abandon decision. Abandoning work records the loss; it does not assert no side effects or zero cost. V1 admits another attempt only after execution settlement is confirmed, under a recorded retry policy with sufficient additional reservation. Unknown financial outcome may remain as conservative liability; unknown active execution blocks new work. Abandoning a receipt does not override that execution guard.

The existing evaluator's [execution marker without report refusal](../../../packages/sdk/src/evaluation/runner.ts#L473) remains mandatory. V1 does not reconstruct a report from partial arm files or rerun just the missing arm. Trial-level restart is a future optional capability requiring retained trial/result identity, fixture isolation and evidence that each trial settled. Never remove `ExecutionUncertainError` to make a campaign appear resumable.

## Stop semantics

A submitted `StopRequest` sets the durable inbox admission barrier immediately; the next `advance` applies `desiredMode: stopped` in its checkpoint before sending cancellation to any adapter. Because stop submission and dispatch markers use the same short inbox lock, new admission is ordered even while `advance` awaits an external operation. A prepared but undispatched operation can be canceled locally and its reservation released. A dispatched operation is retained until the app adapter acknowledges settlement, a result arrives, or uncertainty is recorded.

Remote Acclimate evaluation `interrupted` means its lifecycle admission is closed; it does not mean a callback stopped. The [current runner checks remote state between callbacks](../../../packages/sdk/src/evaluation/runner.ts#L492), while an awaited callback can continue. A submitted stop is an admission barrier, not a claim that cooperative cancellation has already been delivered. The owning `advance` checks the inbox at its next adapter observation/checkpoint; an adapter awaiting one opaque SDK callback may not observe it until that callback settles. V1 promises no immediate cancellation latency for such adapters. Local abort, process termination, provider cancellation and confirmation of settlement are separate adapter facts. A controller must not admit replacement work or release its in-flight reservation based solely on remote interruption or a deadline passing.

A late result after stop may settle spend and retain artifacts but cannot reopen admission, select a candidate, or authorize release without the current desired-mode/revision guards. Retain it as stopped-round evidence if still valid.

## Budgets and unknown cost

The journal owns an append-only reservation/usage ledger covering proposal, execution, grading/reflection and audit work, not merely accepted candidates. Monetary values use integer micro-USD when known. Preserve provider units and their source; do not guess USD from token counts without an explicit versioned pricing policy.

V1 policy supports:

- **Hard admission-count budget:** finite logical dispatches and known bounded adapter sub-attempts. Counts are reserved before dispatch and survive restart. A Codex SDK turn can contain multiple requests; label the unit accurately.
- **Soft monetary budget:** observed cost plus conservative outstanding reservations; unavailable cost remains unknown and triggers the configured stop rule. This is not a guaranteed provider spending cap.
- **Hard monetary budget only for qualified adapters:** each adapter supplies an enforceable maximum liability for all underlying requests/tool/provider retries, with reconciliation. Unbounded/unknown underlying work cannot be admitted under this mode. The controller cannot manufacture such a bound from a timeout.

For hard monetary mode, require `knownSpent + outstandingMaximumLiability + proposedMaximumLiability <= cap` in the atomic reservation checkpoint update. Actual settled spend replaces that operation's reservation; no double-counting. A breach is retained as an adapter-cap violation and closes admission. Confirmed no-dispatch releases a reservation. Unknown outcome retains its maximum liability; with no valid maximum it closes hard-cap admission. Retry reserves additional liability without erasing the earlier unknown charge. Budget reset requires a new explicit epoch/allocation and preserves lifetime totals.

The [current Rust proposer](../../../src/lib.rs#L233) returns candidate/rationale without provider usage/identity and [can retry interrupted jobs](../../../src/improvement.rs#L295). V1 integration may use it with explicitly soft monetary policy and a conservative envelope for its up-to-three attempts. It cannot advertise a hard USD cap or precise provider-call count through this interface. Strict monetary campaigns require a qualified app-owned proposer or an additive server attempt/usage contract; this is an implementation gate, not an assumed feature.

## Audit exposure contract

Freeze the audit cohort and evaluation protocol before selecting a release candidate. The journal records audit epoch/cohort digest, eligible candidate identity, policy, reservation and exposure state:

```text
fresh -> reserved -> exposed -> decided -> retired
```

Reservation is exclusive for the epoch. Crossing the durable dispatch barrier conservatively marks the cohort exposed; uncertainty does not restore freshness. A confirmed pre-dispatch cancellation can return a reservation to `fresh`. Reconciliation of the same audit operation is not a new exposure and must not rerun it casually.

The frozen learner definition supplies a finite ordered roster of eligible audit cohorts/installed definitions. Reservation advances its durable allocation cursor; an exhausted roster produces `audit-refresh-required`. Refresh is an explicit definition/epoch migration preserving exposure, unsettled work and lifetime spend, never an ordinary resume. V1 consumes one release-candidate audit per cohort epoch. Detailed audit answers do not become proposal feedback in that epoch. A failed or indeterminate audit closes release for that epoch; additional search requires a fresh cohort/epoch under the retained audit-use policy. Revealing old audit results for development retires them from protected use. Policy retains both the exposure decision and the fact of any view/export used for feedback. Restrict artifact access to the owning app/authorized reviewer; metadata cannot by itself prevent an owner from inspecting private answers.

## Crash and recovery matrix

| Crash or race | Durable evidence | Required next action | Forbidden inference |
| --- | --- | --- | --- |
| Before prepare commit | No operation intent | Plan again under revision check | External work was authorized |
| After prepare, before dispatch marker | Exact intent and reservation | Dispatch that intent if admission remains open, or cancel undispatched | Allocate a second operation for the same plan |
| After dispatch marker, before handle | Work may have started | Same-work reconciliation or `unknown` | Safe fresh callback replay |
| After provider result, before durable artifact | Dispatch/handle only | Recover result by supported lookup; otherwise `unknown` | Failure means zero spend |
| Artifact durable, receipt/checkpoint not committed | Digest-bound artifact plus intent | Validate and commit receipt/settlement | Regenerate candidate/output |
| Report accepted remotely, local acknowledgement lost | Retained submit body/key/request/attempt | Reconcile the same report and finish mutation | Create a new evaluation request |
| Search decision committed, progress file absent | Journal decision and baseline revision | Rebuild view and advance next action | Repeat selection or promote again |
| Reviewer promotion committed, local observation absent | Exported exact target/audit/revision and service history; reviewer retains its key | Read/reconcile the matching promotion; a future bridge also reconciles its retained command | Rebase release to latest channel automatically |
| Remote interruption while native callback active | Closed lifecycle, unsettled app handle | Stop admission; request cancellation and await settlement | Compute is already stopped |
| Controller dies during audit | Exposed cohort and pending operation | Reconcile or close audit epoch | Cohort is fresh because no result was seen |
| Two controllers attempt advance | One owner/revision wins | Losing controller performs no dispatch | Lease loss retracts previous work |

## Acceptance checks through the learner interface

1. Restart after each crash-matrix barrier. The same immutable input, operation ID, principal, service body and key are retained; completed work is not executed again.
2. Inject a provider that accepts a call but loses its response. Without lookup/idempotency, inspect shows `needs-reconciliation`, unknown result/spend and closed admission. A retry needs its own retained authorization/reservation.
3. Crash after a service comparison is accepted but before local settlement. Resume reconciles it and records exactly one search decision without rerunning callbacks. Repeated command ID with altered body is rejected.
4. Run two controllers against one campaign revision. Exactly one advances and dispatches. Loss of ownership closes local admission, while a previously dispatched handle remains tracked as unsettled.
5. Interrupt an evaluation mid-callback. No later callback starts; the controller does not report confirmed stop or release spend until the adapter acknowledges settlement. A late result cannot release a stopped campaign.
6. Exhaust dispatch and soft-cost budgets across restart. Existing reservations and unknown costs remain charged/exposed; a new proposal or process cannot reset them. Hard monetary configuration rejects an adapter lacking enforceable liability bounds.
7. Fail the audit or crash after its dispatch marker. The same epoch cannot return to fresh or teach the proposer from detailed audit answers. A new epoch retains the prior history and requires a new cohort.
8. Commit a search acceptance, then fail release due to a changed current channel parent/revision. Search history remains intact; no automatic promotion/reparent occurs. An explicit revised release gets newly matching evidence.
9. Resolve a released version in a fresh consumer job while a prepared baseline job remains pinned. Restart the controller and admit a second ordinary-outcome batch in the same campaign, proving recurrence rather than a disposable one-shot run.

These are proposed meaningful implementation gates. No tests, model calls or application changes were performed to produce this design.
