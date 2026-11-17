# Continuous learning architecture

This architecture describes the application-owned learner. See the [implementation status and validation](implementation.md) for supported behavior and the [connected learning operator guide](../../../deploy/README.md#operate-connected-learning) for the service-managed workflow. The [second concept review](../../research/continuous-harness-review/second-pass/README.md) records the earlier design alternatives.

## Decision

Introduce one **application-owned learner module** over the existing content, proposal, evaluation and release interfaces. The module owns the ordering, persistence and recovery of a recurring learning campaign. The integrating application supplies the native harness, task execution, graders, approved feedback, policy and private storage.

The public interface has three operations: `submit`, `advance`, and `inspect`. It hides the work that otherwise repeats across examples: evidence admission, frozen experiment identity, budget reservations, exact-body command recovery, selection decisions, audit exposure and release reconciliation. Keeping those facts together gives the module depth; moving each one into a separately deployed service would add coordination without improving the first application's interface.

The Rust service remains authoritative for immutable content, its own proposal/evaluation records, access, channel revisions and promotion history. The application remains authoritative for actual task outcomes, admitted corrections, executable harness artifacts, effective context, ongoing compute and campaign decisions. Delivery receipts remain delivery telemetry.

### Selected first profile

- One campaign owner on one retained canonical local volume; one active external operation and one unresolved candidate.
- Fixed installed executable harness and tool policy. Candidate proposals refine existing files by default. The installed adapter can opt into bounded structural skill changes.
- Each candidate is a direct child of the published baseline captured at round start. Rejected candidates never become the next baseline.
- Separate development and audit inventories. Each protected audit consumes a fresh cohort, with an explicit epoch migration when the roster needs replacement.
- Human release through the existing console/operator path. The learner's default service credential has no `promote` right.
- Operation/round bounds are supported. A hard dollar bound is accepted only for an adapter with an enforceable maximum liability; unknown cost remains unknown and reserved.
- Local status and explicit review export first. Shared console campaign status requires a later authenticated projection.

The installed controller supports bounded sequential development retry, optional structural mutations and a shared local audit ledger. Automated release, concurrent candidate search and shared campaign coordination remain broader profiles.

## Alternatives considered

### A. Small durable learner — selected

`openLearner(...)` returns `submit(command, commandId)`, `advance(options)`, and `inspect()`. The scheduler periodically calls `advance`; ordinary app jobs submit outcomes. The module owns the private campaign store, artifact validation, external operation ordering and recovery. This places complex invariants behind a small interface and gives a new integration one obvious owner. See the [complete alternative and usage example](alternatives/small-learner.md).

Its cost is an application-owned persistent volume and worker lifecycle. V1 deliberately supports one owner; it does not claim distributed ownership or a lossless integration with every telemetry system.

### B. Shared campaign service — deferred

A proposed server campaign interface would create/read campaigns, admit worker work, accept receipts/decisions and coordinate shared budgets and releases. Apps would execute tickets and retain private artifacts. The server would own transactions, fencing and cross-client inspection. See the [concrete routes, types and example](alternatives/shared-campaign.md).

This earns its complexity when several workers or applications must share one campaign. For one app it adds new authorization, migrations and failure relationships before they solve a demonstrated problem. It is a later placement option for the same identities and decisions, not the selected initial implementation.

### C. Immutable artifact protocol in existing CI — supported integration pattern

Pure `advance`/`inspect` functions would derive decisions or work descriptions from an immutable record chain and an atomically updated head. Existing CI jobs would supply scheduling, dispatch, storage, locks and reconciliation. See the [protocol and job usage example](alternatives/artifact-protocol.md).

This fits an app that already has durable orchestration. It exposes too much sequencing to a new adopter. Use its immutable artifact ideas inside A, and allow mature apps to implement compatible adapters; do not force every caller to become the controller.

A has the simplest correct-use path for the common case. B centralizes more coordination at the cost of a much larger shared interface. C has fewer protocol functions but a larger total caller interface because the caller must get dispatch, CAS, locks and recovery right. The selected design borrows C's immutable evidence and reserves B for demonstrated shared ownership.

## Ownership and module placement

**Learner module, proposed `@acclimate/sdk/learning`:** commands/inbox, campaign checkpoint, round state, evidence eligibility, immutable artifacts, experiment bindings, budgets, external intents, reconciliation and public status projection. These functions belong together because a decision, next action, evidence cursor and reservation must advance consistently.

**Installed application adapters:** domain execution, grader, task fixture reset, native resource mapping, observed usage, corrections/admission rules and optional proposer. Accept these dependencies; do not find credentials or download executable evaluators from a descriptor. Start with concrete installed adapters rather than a plugin registry.

**Existing evaluation module:** request/attempt lifecycle, exact binding, per-job private paths, retained outputs/report, completeness and execution uncertainty. The learner calls it rather than rebuilding its journal. Trial-level resume is a future capability that must preserve uncertainty semantics.

**Existing content/authoring modules:** immutable versions, safe path/payload validation, native compatibility and publication. An application-owned mutation planner may build a complete candidate and call ordinary `createVersion`; the current server proposer retains its fixed-file grammar until independently extended.

**Existing channels module and reviewer:** release authorization, current-parent evidence binding, expected revision, atomic promotion and history. The learner records what happened but does not make an unverified local approval string authoritative.

**Console:** current bundle Changes, evaluations, Releases and Connections. Private learner checkpoints do not become console state automatically. Later shared inspection uses a redacted, authenticated projection with explicit staleness, as specified in the [product flow](product-flow.md).

## Implemented interface

The Node-only `@acclimate/sdk/learning` export implements the following interface. The exported [types](../../../packages/sdk/src/learning/types.ts) and [starter](../../../examples/continuous-learning/README.md) describe construction and execution; the specialist documents retain broader design sketches.

```ts
interface Learner {
  submit(command: LearnerCommand, commandId: string): Promise<CommandReceipt>;
  advance(options: { signal?: AbortSignal; deadline: number }): Promise<Progress>;
  inspect(): Promise<LearnerView>;
}

type LearnerCommand =
  | { kind: 'observe'; observation: TaskOutcome }
  | { kind: 'request-stop'; reason: string }
  | { kind: 'resume'; reason: string }
  | { kind: 'resolve-uncertainty'; resolution: WorkResolution };

const learner = await openLearner({
  directory: configuredPrivateCampaignDirectory,
  definition: installedFrozenLearningDefinition,
  adapter: installedLearningAdapter,
  admit: installedAdmissionPolicy,
  authorizedFeedback: trustedFeedbackReferences,
});

// Called after an ordinary app task has a retained result.
await learner.submit({ kind: 'observe', observation }, stableObservationCommandId);

// Called by the app worker or its existing scheduler; no implicit daemon.
await learner.advance({ deadline: Date.now() + 30_000 });
const view = await learner.inspect();
```

`TaskOutcome` is the public ingestion view of `ExperienceV1` in the evidence contract; artifacts use its private `Ref<T> = {id, sha256, bytes}` shape. A submission receipt binds the campaign, command ID, exact command digest and durable inbox sequence. `Progress`/`LearnerView` expose checkpoint revision, desired mode, admission/work settlement, round/candidate IDs, retained decisions and the required next action; they never infer success from receipt count.

A `WorkResolution` binds the exact operation/attempt and checkpoint revision to a verified adapter/service readback or an authorized loss decision. Readback can recover a known result or prove no dispatch/confirmed settlement. An operator may acknowledge a lost result or unknown charge, but cannot erase evidence that execution may still be running. New work remains blocked until settlement/admission/budget guards permit it. Arbitrary caller-provided `stopped: true` or `costUsd: 0` fields are not resolution evidence.

`openLearner` validates/reconciles configuration without launching paid work. `submit` durably accepts a scoped command; acceptance is not admission of a lesson or completion of a requested action. Repeated exact bytes under the same campaign command ID return the same receipt; changed bytes conflict. `advance` reconciles existing work and admits at most one new external operation before returning. Its deadline closes new admission and requests cooperative cancellation; it never certifies external settlement solely because that deadline expired. `inspect` returns status, evidence/decision IDs, unknown-cost counts and the next required action, excluding secrets, private paths and raw traces.

The detailed alternative A includes an optional `review-release` command. It is **not part of the selected first profile**. V1 exports a bound review artifact for an existing authorized reviewer; `advance` reads/reconciles the exact promotion record. A future automated approval bridge must authenticate authority and be explicitly enabled by policy, using its own narrowly scoped promotion principal.

## Identity and evidence

Retain these facts separately:

1. **Task outcome:** logical run/attempt identity, task family/epoch, actual terminal or unknown result, content and harness identities, private result/trace references, observed usage.
2. **Admission decision:** which sanitized teaching view is authorized for which scope and purpose, with policy, applicability, provenance and exclusion reasons. An observation can be retained while excluded from learning.
3. **Harness treatment:** content plus runner/config/native mapping/tool/context-policy identities. Parent and candidate can have different treatment manifests when a later profile permits that variation.
4. **Experiment:** invariant task/grader/collection protocol, expected pairs, parent/candidate treatment commitments, actual trial identities and retained results.
5. **Search decision:** accept/reject/indeterminate under a frozen selection policy, preserving rejected attempts. The Acclimate adapter provides the development and audit policies. The controller stores their canonical bytes as private artifacts at creation, binds their digests into the campaign definition, and records the applicable digest in each selection verdict. Reopen requires the same policies and verifies that both artifacts remain readable. Custom adapters that omit policies manage selection policy themselves. A checkpoint created before policy binding cannot acquire a binding on reopen because it has no record of the original policy.
6. **Audit/release decision:** audit epoch/exposure, exact audited target and published baseline, reviewer/policy authority, expected channel revision and observed promotion result.

Store private manifests as immutable, digest-checked artifacts. Encode approved public commitments in namespaced keys in the existing runtime map; a wire migration is unnecessary for one installed learner. A digest establishes identity of retained bytes, not truthful execution, universal relevance or an immutable hosted model.

Recorded effective context is the actual selected/mapped content for one job. It is distinct from all stored memory, the policy that selected it, evidence that a resource was read, and evidence that it affected behavior. Preserve the existing native repository starter's selection controls.

## State and recovery

The steady flow is waiting for eligible outcomes -> admit bounded teaching evidence -> propose -> evaluate development -> reject or select -> reserve/run audit -> await review -> observe release -> wait for more outcomes. It is recurring only when a later batch creates another round in the same retained campaign.

Search acceptance never promotes a working channel in v1. A passed audit never grants publication rights. Complete evidence is permitted to lose. Stop request closes further admission but active work remains in-flight or uncertain until settled. Resume never clears a reservation, resets an audit or changes policy by itself.

One private authoritative checkpoint commits observation cursors, decision IDs, budget/exposure reservations, pending operation references and next action together. Immutable bodies/artifacts are durably written before the checkpoint refers to them. A worker lock protects `advance`. A separate short inbox lock permits commands during active work; the stop admission barrier and dispatch marker use that same short serialization point. A stop arriving after a dispatch marker cannot retract the already admitted operation.

Before every external effect, persist exact body/key/scope, operation identity and applicable reservation. On restart, reconcile the existing operation before considering a new one. Existing evaluator uncertainty refusal stays intact. Unknown external work is never inferred absent because the local process stopped, an SDK await rejected, or a service evaluation was marked interrupted. See [full transitions, budget rules and crash matrix](recovery.md).

### Audit supply across recurring rounds

The initial definition binds a finite ordered roster of private audit cohort manifests and installed evaluator definitions. Before a round can select a candidate for audit, `advance` reserves the next eligible unused cohort under the frozen evidence-use policy. The roster and allocation rule are part of the definition digest; selecting a cohort does not silently change policy. Each cohort must qualify as fresh under that policy, including retained task/exposure fingerprints rather than merely a new cohort name. A later batch can therefore drive another audited release in the same campaign while an unused eligible cohort remains.

When the roster is exhausted or exposure makes all remaining cohorts ineligible, the campaign stops at `audit-refresh-required`. A new roster requires an explicit definition/epoch migration under exclusive ownership, preserving campaign lineage, all prior exposure, unresolved work and lifetime spend. It is not a `resume` side effect or a reset of the campaign. A single static `audit: EvaluationApp` as sketched in alternative A supports only one audit opportunity; the selected recurring profile uses the finite roster instead.

## Release lineage and conflict rules

V1 selects one candidate directly under the published baseline, so development and final audit can bind the same candidate without reparenting. The learner reads the existing authorized promotion and verifies candidate, baseline, comparison and revision before marking the round released.

If a later search profile chains unpublished candidates, create an explicit release-child containing the accepted bytes under the actual published parent, retain search-to-release lineage, and run a new exact-ID final audit. Never overwrite search ancestry or relabel evidence. An external channel change invalidates the pending release intent and review: stop for a new baseline/audit/review path, preserving the old record.

A review export contains enough authorized metadata to find the existing evaluation and release target. It does not carry credentials or turn a private outcome into project-readable data without a disclosure decision.

## Mutation and behavior policy

Keep fixed-existing-file refinement as a supported policy. For artifact discovery, the proposed planner applies bounded create/edit/retire operations to an exact parent and publishes one complete immutable candidate. Skill package structure and references must be validated as a final snapshot. Reuse existing version publication; do not relax validators or add a multi-call mutation transaction engine. See [mutation contract](mutations.md).

Allowed paths constrain edit location, not executable effects. SKILL.md text and existing helper code can change behavior today. Bind the app's runtime capability policy independently: permitted tools/data, execution environment, deadlines, preflights and resource bounds. New file-kind semantics and arbitrary executable harness evolution require a separate compatibility/profile decision rather than slipping into the default learner.

## Implementation and qualification

The [migration plan](migration.md) gives phased ownership, compatibility, acceptance gates and rollback. Initial implementation requires no PostgreSQL migration or change to bundle schema v1. It adds a Node-only learning entry point, private durable state, installed adapters and one recurring fictional-domain qualification.

Acceptance must show actual outcomes and approved corrections, a retained losing candidate, an independent audit, a real existing authorized release, fresh-job improvement versus a pinned baseline, and a second round. Inject crashes after paid dispatch and after remote report acceptance. Prove command reconciliation, budget retention, audit exposure retention and uncertain-work handling. Deterministic fixtures establish state semantics; opt-in live Codex SDK checks establish the native integration and measured behavior on the chosen task family.

The [implementation record](implementation.md) separates deterministic state and service qualification from native model behavior. The recurring starter makes no model calls. A local delivery smoke run or one plausible model response does not establish broad continuous improvement.

## Design validation

Seven parallel design agents produced three alternative architectures and four focused contracts. The selected profile reconciles those proposals here; alternatives remain design explorations. Subsequent implementation and qualification are recorded separately in the [implementation record](implementation.md).
