# Alternative C: an immutable learning protocol for existing jobs

**Proposed design, not an implemented API.** Prepared 2026-11-17 against Acclimate `3de5ac433a5a6b3d1406efaa51e50283ec66d402`. This alternative uses an application's current CI scheduler, telemetry store and artifact store. No permanent learner process and no Acclimate campaign endpoint is introduced. A logical campaign is a chain of immutable application-owned records, with one atomic head pointer.

The caller is an existing scheduled job, CI workflow or operator command. Acclimate remains the content/evaluation/release substrate. The protocol determines the next admissible action from retained evidence; the scheduler decides when to invoke that action and the application supplies native execution.

## Small public interface

The proposed package exports record schemas and two pure functions. There is deliberately no `runForever`, runtime host, tool registry or general workflow language.

```ts
// Proposed @acclimate/learning-protocol, not a current package export.
type Digest = `sha256:${string}`;
type Ref = { digest: Digest; bytes: number; mediaType: string };
type Scope = { serviceOrigin: string; workspaceId: string; bundleId: string };

type ProtocolInput = {
  scope: Scope;
  head: Ref;
  records: readonly VerifiedRecord[]; // fetched and digest/schema checked
  event: LearningEvent;
};
type Transition = {
  expectedHead: Ref;
  records: readonly NewRecord[];     // canonical bytes + refs
  nextHead: Ref;
  action: Action | null;            // at most one proposed external effect
};

function advance(input: ProtocolInput): Transition;
function inspect(records: readonly VerifiedRecord[]): LearningView;
```

`advance` performs admission, manifest, lineage, budget and transition checks, then produces immutable records and at most one next action. It performs no filesystem, network, model or database work. `inspect` supplies a human/CI view: incumbent, unresolved actions, known/unknown spend, audit exposure, decisions and stop/review reasons. Validation/encoding helpers belong to this module's implementation; clients use one versioned codec rather than reimplementing hashing.

This is a **protocol module** with a small interface, not a claim that orchestration disappears. The caller must persist the returned transition atomically, dispatch its action using an application adapter, and submit the observed result as another event. The extra caller burden is the central tradeoff of this alternative.

### Action vocabulary

Only bounded learning actions are supported:

- `collect`: freeze a telemetry cursor/window into retained task outcomes.
- `admit`: apply the application's named feedback-admission policy; may require a human decision.
- `propose`: request a service proposal or run an installed app proposer against a frozen parent.
- `evaluate`: create/reconcile an exact request and invoke the installed evaluator.
- `audit`: consume a frozen audit allowance and run the same installed evaluator under the audit protocol.
- `release`: request an explicit human/policy authorization, then reconcile/promote the authorized snapshot.
- `reconcile`: resolve an already-dispatched action; never substitute a fresh operation implicitly.

An action is a typed, immutable intent with `operationId`, `attemptId`, scope, input refs, required adapter revision, deadline and budget reservation. It is not arbitrary executable code. Protocol version 1 has no user-defined graphs or steps.

## Records and identities

Every record contains `schemaVersion`, `campaignId`, scope, `sequence`, `previous` record ref, `kind` and its typed body. Hash canonical record bytes; signatures are optional transport/authentication additions and never replace app authorization. Private artifacts live behind the app's storage ACL. A digest establishes retained byte identity, not the truth or authority of a report.

The initial campaign record fixes policy, objective, baseline, allowed mutation/effect capabilities, audit regime, finite budgets and expiry. Later changes start an explicit new policy epoch; a scheduler rerun cannot silently reset limits. Proposed records are:

| Record | Required content and invariant |
| --- | --- |
| `taskOutcome` | App run/attempt IDs; task/cohort fingerprint; harness ref; confirmed completed/failed/uncertain state; output/trace refs; observed usage or explicit unknowns. Delivery `started` receipts are not terminal outcomes. |
| `feedbackAdmission` | Input outcome refs; sanitized teaching-view ref; principal/policy identity; allowed purpose, workspace/task/policy-epoch scope; accepted/rejected/held decision and rationale. The producing task cannot self-authorize its lesson. |
| `candidate` | Parent content ID/digest; proposed content ID/digest; parent/candidate harness refs; hypothesis; admitted-feedback refs; mutation policy; proposer operation identity. |
| `experiment` | Two treatment manifest refs plus invariant evaluation manifest ref, request/attempt/report IDs, exact expected inventory, actual trial observations, terminal/uncertain state and known/unknown usage. |
| `selectionDecision` | Frozen parent/candidate/report refs; policy ref; accepted/rejected/indeterminate decision; reason and next incumbent. Complete evidence alone cannot select a winner. |
| `auditExposure` | Protected cohort/epoch ref; candidate commitment; purpose; reservation before execution; exposure/consumption result. Results already used for development cannot remain untouched audit evidence. |
| `releaseDecision` | Search-accepted source ref; target content ref; independently appropriate audit/report ref; human/policy authority; target channel/current-parent/revision; decision. Search acceptance is not publication. |
| `effectIntent` / `effectObservation` | Exact body/input hashes, retained idempotency key, reservation, dispatched/acknowledged/settled/unknown states, external IDs when known, and result refs. |

Canonicalization is one published codec with exact-byte fixtures: JSON-compatible values, deterministic key ordering, UTF-8, no secrets, finite values, and decimal strings for money/token reservations. Arrays whose order is meaningful retain it. The envelope's own hash is not embedded into its hashed body. Private raw outputs may use another media type but retain exact byte length/digest. Consumers refuse unknown protocol versions and unknown critical record kinds.

### Treatment versus evaluation manifests

A **treatment manifest** commits content ID/digest, application runner/source artifact, SDK/native mapping, effective tool contract, relevant model settings, selected-memory/context-policy identity and environment fixtures. The parent and candidate have separate manifests; an unchanged executable can be referenced by both. Credentials and ephemeral host handles are excluded. Per-job effective-context selection is retained as an execution artifact bound back to the treatment policy and inputs.

An **evaluation manifest** commits task inventory/content, expected outputs or private commitments, grader implementation/configuration, paired collection order/seed, fixture-reset policy, repetition plan, metric/decision policy and domain checks. These controls remain invariant within a comparison. The manifests record when model/provider behavior cannot be made immutable.

The current descriptor's string runtime map can carry `learningProtocol`, `parentHarnessManifest`, `candidateHarnessManifest` and `evaluationManifest` digest references. The application validates their bytes and chooses the matching treatment from `context.side` before launch. These conventions are **proposed**, but the map and per-arm callback context already exist ([descriptor construction](../../../../packages/sdk/src/evaluation/definition.ts#L137), [execution context](../../../../packages/sdk/src/evaluation/types.ts#L18)). No claim of server-side artifact verification or remote execution attestation is added.

## Persistence without a campaign service

Use the app's existing transactional store for a tiny control entry:

```ts
type HeadPointer = {
  revision: string;
  head: Ref;
  admittedPendingOperation: string | null;
  stopped: boolean;
};
```

The entry is an application storage concern, not a new Acclimate entity. The artifact chain itself contains authoritative budget reservations, decisions and operation identities. A cached view is rebuildable. A local installation may use a lock plus fsync/atomic replacement on one persistent private volume. A CI installation should use its database or object store's conditional update. A portable artifact upload followed by a nonconditional file overwrite is insufficient.

For each transition, write content-addressed artifacts first, then compare-and-swap the head to `nextHead` while checking `expectedHead` and the stop/admission condition. Unreferenced objects left by a losing CAS are harmless and eligible for delayed garbage collection. Only the successful transition may dispatch its recorded action. A subsequent invocation discovers that pending operation and reconciles it rather than creating another one.

The initial implementation permits one unresolved external action per campaign. Different campaigns may run in parallel subject to the application's aggregate admission limit. Do not add distributed leases inside the protocol merely because CI may schedule duplicate jobs. Scheduler concurrency controls and CAS prevent duplicate logical admission; uncertain dispatched work remains a separate reconciliation problem.

## A recurring CI usage example

The following is proposed pseudocode. `store` and `dispatch` are the app's existing infrastructure, with the semantics above.

```ts
// Scheduled by the app's normal CI; exits after one bounded action.
const current = await store.loadVerifiedChain(campaignId);
const transition = advance({
  scope,
  head: current.head,
  records: current.records,
  event: await app.nextObservation(current),
});
await store.putImmutable(transition.records);
const won = await store.compareAndSwapHead(
  campaignId, transition.expectedHead, transition.nextHead,
);
if (!won || !transition.action) return;

// Intent + budget reservation are durable before this point.
const observed = await dispatchOrReconcile(transition.action, app.adapters);
await store.commitObservation(campaignId, observed); // another checked advance/CAS
// Existing CI schedules another invocation; the campaign never starts over implicitly.
```

An hourly collection job freezes new normal task outcomes from telemetry. If there are eligible corrections, a later job proposes a bounded fixed-file update. Evaluation jobs use the existing installed app runner and retain private artifacts. Selection records keep winners and losers. An audit job runs only against a frozen selected candidate and consumes its reserved audit allowance. A reviewer or deliberately configured policy authorizes release. A new batch of normal tasks starts the next round in the same chain; no daemon is needed.

The scheduler may choose to process several bounded actions per invocation, but each uses the same commit-before-dispatch discipline and stops on deadline, budget, pending review or uncertain work.

## Unknown execution and budget policy

A persisted intent with no dispatch acknowledgment means **possibly dispatched**, not safe to repeat. A CI timeout or expired lock does not prove the native process or provider request stopped. Recovery uses the stable operation/attempt ID, existing evaluator journal and adapter-specific result/handle lookup. If a retained result exists, ingest it without executing again. If active work is known, wait for a future scheduled reconciliation. If outcome cannot be established, record `outcome_unknown`, retain its reservation and require a configured abandonment/retry decision with a new attempt identity.

The current evaluator already refuses callback replay after `executionStarted` without a final report ([runner recovery](../../../../packages/sdk/src/evaluation/runner.ts#L460), [attempt journal](../../../../packages/sdk/src/evaluation/journal.ts#L58)). This alternative preserves that behavior; per-trial restart is not advertised until a trial ledger can prove settlement.

Use separate budgets for calls/trials/tokens/time and optional monetary units. Reserve an enforceable upper bound before dispatch; reconcile known usage after settlement. Unknown cost is never zero. If an adapter cannot supply an upper bound, it may run only under an explicitly weaker call-count/time policy or a policy that stops further paid work on unknown spend. Do not promise a strict USD cap on an uncontrolled SDK session with no mediation. CI environment limits alone are not campaign-wide reservations.

A stop event atomically closes admission. It may trigger cooperative cancellation in app adapters, but the view distinguishes `stop_requested`, pending active work, confirmed settlement and unknown outcome. Release reservations only under the frozen settlement/abandonment policy.

## Admission, audit and release details

Feedback admission is an authority check performed by a trusted app adapter or reviewer, separate from model reflection and from behavioral scoring. Policy checks workspace/task applicability, policy epoch, source authority, redaction, contradictions/supersession and authorized mutation/effect scope. A model can recommend a lesson; it cannot manufacture an authorization fact by returning JSON. The retained teaching view, rather than arbitrary raw transcripts, is rendered into the current bounded string-evidence proposal interface.

Audit reservation precedes the first trial, so a crash cannot make an exposed cohort appear unused. The record distinguishes intent, known exposure and uncertain exposure; uncertainty is conservatively consumed under the initial policy. Audit failures are retained and block release; they do not become development corrections in the same audit epoch. Policy names when a cohort retires or a new one is frozen.

The existing service requires evidence-backed promotion to match the target's declared parent and the channel's current version ([channels.rs](../../../../src/channels.rs#L198)). A search may have accepted several descendants while the release channel remains at its old root. Therefore a release job must either evaluate the accepted content in a new immutable child of the actual published parent, or use a separately specified future service change. Version 1 chooses the existing-compatible reparented release child: verify identical payload bytes, retain both source-accepted and release-child identities, and run the final bound audit against the actual published parent. Never copy an earlier comparison ID to a differently bound release child. A channel conflict invalidates the release intent and requires fresh review against current state.

Application-owned executable changes are deployable artifacts, not effects of a content-channel promotion. Version 1 keeps runner/tool/effect contracts fixed while refining content. Later executable search requires the application's deployment adapter and an independently reviewed deployment manifest; it must not be described as supported by current content rollback.

## Existing interfaces reused, versus proposed work

Existing SDK methods already publish immutable versions, request bounded proposals, create evaluations and promote channels ([client](../../../../packages/sdk/src/client.ts#L293)). Private evaluation journals retain scoped request/attempt identities, exact operation keys and report artifacts ([journal](../../../../packages/sdk/src/evaluation/journal.ts#L58)). Native preparation and live harness calls remain installed app code. Delivery receipts remain optional observations ([receipt schema](../../../../packages/sdk/src/types.ts#L300)).

New work in this alternative is a record/codec/reducer module, one integration recipe, durable app-store commit semantics, adapter contracts and end-to-end qualification. It adds no HTTP endpoints, database migrations or public artifact browser to Acclimate initially. It does not reuse the existing evaluator's private internal journal as a generic store; the protocol store is separate and references its existing public results and retained app artifacts.

## What is hidden and what the caller still owns

The protocol hides legal event ordering, manifest-binding checks, budget/audit bookkeeping, stable intent generation, replay rejection, decision lineage and a rebuildable inspection view. Domain grading, lesson authority and native execution stay behind installed application adapters.

The caller still owns artifact availability/ACLs, atomic head updates, scheduler retries, telemetry collection, dispatch/reconciliation adapters, admission/release authority and operator handling for unknown work. Those are material interface obligations; two function names do not make them free. A shared transactional application database makes this convenient. A bare CI artifact bucket without conditional updates does not.

This alternative is best when one application already has telemetry, scheduled jobs, artifact retention and operational ownership, or when organizations need reviewable/exportable learning artifacts before committing to a permanent learner. It is weaker for consumers who expect one install-and-run module: they would rebuild too much orchestration and recovery glue. It also provides no central cross-app campaign list or shared authority without an application projection. If several clients must coordinate or humans need one hosted learning inbox, alternative B's shared coordinator becomes justified. If callers mostly lack these primitives, alternative A should hide them behind a durable learner interface instead.

## Qualification before adoption

Use deterministic app fixtures first, then bounded opt-in native SDK runs. Verify recurring outcome collection across at least two rounds; one rejected candidate; planted-feedback rejection; correct parent/candidate manifests; untouched audit consumption; retained source-to-release lineage; fresh jobs receiving release while pinned jobs remain unchanged; CAS loss; crash after dispatch; crash after report receipt; stop during active work; and budget/audit state preserved across CI restarts. A report chain is evidence of decisions, not proof of broad generalization or exactly-once provider billing.
