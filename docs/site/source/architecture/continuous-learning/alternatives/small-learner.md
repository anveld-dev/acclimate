# Alternative A: one durable application-owned learner

Status: proposed design, not an implemented interface. Date: 2026-11-17. This alternative minimizes the public interface to three operations and deliberately supports a fixed installed harness with content refinement first. It builds on the [second review](../../../research/continuous-harness-review/second-pass/README.md), the [existing evaluator](../../../../packages/sdk/src/evaluation/types.ts), and the [existing attempt journal](../../../../packages/sdk/src/evaluation/journal.ts).

## Decision

Add one application-side learner module with `submit`, `advance`, and `inspect`. It owns campaign recovery, immutable evidence selection, proposal/evaluation handoff, selection decisions, audit exposure, budget admission and release intent. It uses the existing Rust content/proposal/comparison/channel interfaces. The application continues to own task execution, graders, native SDK authentication, tools, private traces and the learner process itself.

The scheduler merely calls `advance`. It does not assemble state transitions. A developer integrating the learner does not manually call “create proposal, wait, compare, accept, promote” in the correct order on every round.

## Public interface

Illustrative TypeScript signatures below are **new proposed contracts**. Imported evaluation/SDK concepts refer to existing interfaces; the names here do not imply exports already exist.

```ts
type Digest = `sha256:${string}`;
type ArtifactRef = { digest: Digest; bytes: number; localArtifactId: string };
type VersionRef = { id: string; digest: Digest };

type LearnerCommand =
  | { kind: 'observe'; observation: TaskOutcome }
  | { kind: 'review-release'; decision: ReleaseReview }
  | { kind: 'request-stop'; reason: string }
  | { kind: 'resume'; reason: string }
  | { kind: 'resolve-uncertainty'; resolution: WorkResolution };

interface Learner {
  submit(command: LearnerCommand, commandId: string): Promise<CommandReceipt>;
  advance(options: { signal?: AbortSignal; deadline: number }): Promise<Progress>;
  inspect(): Promise<LearnerView>;
}

function openLearner(options: {
  directory: string;                    // canonical private persistent directory
  definition: LearnerDefinition;        // frozen installed policy and adapters
  service: AcclimateClient;             // existing supplied-authority transport
  evaluatorConfigPath: string;          // existing private evaluator configuration
}): Promise<Learner>;
```

The factory opens/reconciles configuration and ownership; it does not start paid work. `advance` performs at most one new external work admission per call, though it may reconcile previously admitted work and persist multiple local transitions. It returns promptly at input/review/uncertainty/budget stops. Only `advance` takes the worker lock; concurrent advances produce a typed busy result rather than concurrent dispatch. `submit` uses a separate short-lived inbox lock so stop and review commands can be durably queued during active external work. `inspect` reads the last atomic checkpoint and inbox projection. Worker ownership is released at method completion. This first design supports one worker on one durable local filesystem, not a distributed filesystem or multiple machines.

`submit` persists intent before acknowledging queue acceptance. `commandId` is scoped to the campaign; replaying the same exact command returns its first acceptance receipt, while different bytes under the same ID conflict. Application/validation results appear in the inspected command status after `advance` consumes the command; queue acceptance is not release authorization or operation completion. `inspect` returns a public projection with record IDs, reasons, usage completeness and next action; it excludes raw traces, credentials and private path details.

### Definition and experience

```ts
interface LearnerDefinition {
  schemaVersion: 1;
  campaignId: string;
  target: { projectId: string; bundleId: string; channel: string };
  policyManifest: ArtifactRef;
  installedHarness: ArtifactRef;
  admit: (outcome: TaskOutcome) => AdmissionDecision; // no external effects
  development: EvaluationApp;
  audit: EvaluationApp;
  selectionPolicy: ArtifactRef;
  proposer: { kind: 'service'; allowedPaths: readonly string[] };
  release: { kind: 'human-review' };
  limits: {
    maximumRounds: number;
    maximumOutstandingWork: 1;
    maximumPaidAdmissions: number;
    maximumReservedUsd?: number;
  };
}
interface TaskOutcome {
  runId: string;
  attemptId: string;
  harnessManifest: ArtifactRef;
  content: VersionRef;
  taskFamily: string;
  policyEpoch: string;
  terminal: 'completed' | 'task-failed' | 'infrastructure-failed' | 'unknown';
  result: ArtifactRef;
  trace?: ArtifactRef;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
  correction?: ArtifactRef;
}
type AdmissionDecision =
  | { verdict: 'eligible'; teachingView: ArtifactRef; authority: ArtifactRef;
      applicability: ArtifactRef; policyDigest: Digest }
  | { verdict: 'excluded'; reason: string; policyDigest: Digest };
```

Artifact references resolve only inside the configured private artifact store and must match their digest and size. They do not authorize network fetching or arbitrary file reads. The module verifies them at ingestion and before use. Admission can be a deterministic application policy over already reviewed corrections. A model judge can be added later as a separate journaled effect; an ostensibly pure callback must not hide a model call. Raw outcomes remain separate from the sanitized teaching view. Neither a successful task nor a trusted submitter makes embedded untrusted text an authorized standing rule.

The definition digest covers the policy/configuration artifact identities and adapter implementation fingerprints supplied by the app. It excludes credentials. Reopening the campaign requires the same digest. A changed policy starts a new explicit campaign epoch with lineage, rather than silently reinterpreting old decisions. An opaque hash remains an app assertion of installed artifacts, not attestation of execution or immutable hosted-model behavior.

`ReleaseReview` binds campaign/round, candidate content and harness digests, audit request/attempt/comparison IDs, policy digest, reviewed expected channel revision, reviewer identity and approve/reject reason. Approval is an input to the learner; existing service authorization still decides whether that principal may promote. The service records the effective authorized principal, not an unverified identity string supplied by the command. A service actor carrying a human approval must retain that approval artifact and policy while using its own granted authority.

`WorkResolution` identifies the exact pending operation and records one of: confirmed result with verifiable binding, confirmed terminal failure, confirmed stopped with usage/unknown usage, or abandonment with possible continuing work. It never means “safe to replay” merely because a status timed out. Abandonment does not close budget reservations or allow replacement work until policy accounts for still-active/unknown work.

## Usage example

```ts
const learner = await openLearner({
  directory: '/private/persistent/learning/payment-policy',
  definition: installedPaymentLearningPolicy,
  service,
  evaluatorConfigPath: '/private/config/evaluator.json',
});

// Called after the app's ordinary task has settled and artifacts are durable.
await learner.submit({ kind: 'observe', observation: completedTask }, outcomeCommandId);

// Called by the app's existing worker/timer; no separate workflow service.
const progress = await learner.advance({ deadline: Date.now() + 30_000, signal });
if (progress.nextAction === 'review-release') {
  showReview(progress.releaseReview); // IDs/digests and independently produced audit
}

// A restart reopens the same directory/definition and advances the pending work.
// It does not call the app's native SDK again for an uncertain execution.
```

A long-running installed evaluator can use a callback-specific deadline beyond one scheduler turn only if its owning adapter durably records an acknowledged handle before `advance` returns. The initial implementation can keep the call awaited and use a sufficiently long `advance` deadline. Expiration closes further admissions and records uncertainty; it does not erase an admitted operation or imply cancellation. The module must not spawn an untracked background model process merely to satisfy its call deadline.

## State machine and decisions

The first version permits one unresolved candidate and one outstanding paid operation per campaign. It deliberately does not accumulate a multi-candidate frontier while a release is awaiting review.

```text
waiting_for_evidence
  -> proposing
  -> evaluating_development
  -> selecting
     -> rejected -> waiting_for_evidence
     -> search_accepted -> freezing_audit -> evaluating_audit
        -> audit_failed -> audit_epoch_closed
        -> audit_passed -> awaiting_release_review
           -> rejected_by_reviewer -> waiting_for_evidence
           -> release_intent -> released -> waiting_for_evidence
```

Every state can retain `stop_requested`, `awaiting_external_result` or `outcome_unknown`. These are orthogonal work/stop facts, not terminal success states. A stopped campaign remains inspectable. Resume requires explicit input and reconciles unresolved work before admitting another operation.

A round captures a production baseline and expected channel revision. Development selection does not move a channel. A selected candidate remains an immutable child of that baseline. This avoids the twenty-round example's release-squash issue in the first implementation. If the production parent changes externally, the learner records `release_conflict` and requires a new comparison against the actual baseline; it does not silently rebase a passed audit or reuse a human approval for different bytes.

The distinct persisted decisions are: observation admission, development search acceptance/rejection, audit verdict, human release authorization and actual promotion result. Complete evidence alone never implies any later decision. Rejected candidates and failed/unknown trials remain part of the campaign ledger.

Audit cohorts have stable IDs/digests and an exposure ledger. Dispatch, rather than only a successful grade, conservatively consumes exposure. Once the audit has informed a release verdict, the epoch cannot retry candidates until one passes. Failed audit output is excluded from teaching views in that epoch. The controller stops for a fresh eligible audit epoch or explicit externally justified policy transition. The app retains ownership of task-private data.

## Hidden implementation

One private campaign directory holds an atomically replaced checkpoint and content-addressed artifacts, reusing the SDK's private file/lock conventions. The checkpoint includes policy digest, event sequence, observation cursor, round and candidate identities, decisions, audit exposure, budgets, pending effects, retained request bodies/keys and next action. A single checkpoint is the authoritative state; any human-readable progress export is rebuildable.

Before an external mutation, the module durably stores exact request bytes/digest, stable command key and expected scope. Before paid work it additionally stores a work admission and reservation. It commits the outcome, decision and next action together in the next checkpoint. Artifacts are written and durably synchronized before a checkpoint references them; unreferenced artifacts after a crash are harmless and eligible for later owned cleanup.

The inbox stores immutable command files under a short-lived inbox lock. The worker commits consumed command IDs and outcomes in its checkpoint before considering inbox cleanup; a crash may leave a command file that is already consumed, which is skipped by identity. A queued stop closes new admission at the next safe observation; it cannot retract already dispatched work. The caller can use the local abort signal for cooperative cancellation while a callback is active, and settlement/unknown work remains tracked.

Directory ownership is one canonical physical volume, private permissions and a worker process lock. Atomic replacement must include the necessary file and parent-directory synchronization guarantees. The implementation must document supported filesystems and refuse unsupported ownership/storage guarantees. This is a campaign journal module, not an append-only line log whose final partial line callers must interpret.

The learner invokes the existing evaluator as a deep module and retains its request/attempt/journal references. It does not duplicate per-trial execution logic or weaken the current `executionStarted` uncertainty guard. A future trial-level ledger can improve recovery without changing these three public methods.

### Effect recovery table

| Effect | Stored before dispatch | Recovery |
| --- | --- | --- |
| Create proposal/version/evaluation | Exact body, scope, idempotency key | Reconcile/replay only within the service retention contract; an unknown aged-out operation stops for resolution |
| Service proposer generation | Proposal ID plus conservative paid-call reservation policy | Existing worker may regenerate up to its bounded attempts; reserve for the maximum admitted attempts or stop USD-bounded automation until the provider supplies reconciled usage |
| Native evaluator work | Request/attempt ID and existing evaluator journal | Recover saved reports; preserve `ExecutionUncertainError` when callbacks may already have executed |
| Selection/audit decisions | Bound evidence and policy inputs | Recompute pure calculation, then commit one decision for that input identity |
| Channel promotion | Candidate/comparison/review artifact, exact body, key and expected revision | Reconcile the recorded command; on real revision conflict create a new review path, never replay an approval against changed content |

A finite paid-admission counter is a durable bound on admissions, not on raw model API calls or dollars. Codex SDK turns can contain multiple requests. A hard USD limit requires mediated per-operation maximum reservations or provider enforcement; unknown usage remains reserved. The module must reject a purported hard-dollar configuration for an adapter whose maximum liability cannot be established. First qualification uses bounded operation counts and reports USD as unknown where necessary.

## What this design hides and exposes

The public interface hides request sequencing, exact-body recovery, campaign checkpoints, artifact integrity checks, service result reconciliation, attempt-journal references, baseline conflicts and decision persistence. These responsibilities currently reappear in application controllers and examples, so this module adds depth rather than wrapping three existing calls.

The app still supplies domain judgment: what task result means, what corrections are authorized, the execution/grader implementations, what changes may be proposed, which constraints matter and who can release. Hiding these judgments behind an implicit universal “improve” default would make misuse easier.

This design chooses human-reviewed releases, fixed-file mutation and one unresolved candidate. It sacrifices multi-frontier search throughput and centralized cross-app campaign inspection for a small interface and recoverable implementation. These constraints can relax behind the same interface, but changing policy semantics requires a new campaign epoch and explicit migration.

## Compatibility and staged delivery

1. Implement this module beside the SDK evaluator, without changing the Rust wire schema. Put parent/candidate harness-manifest digests and invariant evaluation-manifest digest in the existing runtime map. Keep raw artifacts private.
2. Replace disposable example controller sequencing with this module in a deterministic recurring-learning qualification. Prove crash/restart at request dispatch, report acceptance, local selection commit and promotion acknowledgement; require exactly one retained decision and preserved budgets/uncertainty.
3. Run bounded live SDK qualification after deterministic state/recovery checks pass. Require a baseline mistake, an admitted correction, retained rejected candidate, independent audit, explicit review, fresh released job and pinned-baseline control, followed by a second evidence batch in the same campaign.
4. Add structural mutation only when a new-skill acceptance case requires it, using an atomic parent-bound final-snapshot mutation policy. Add shared campaign server records only if independent readers/controllers require them.

No production code, tests or model calls were changed or executed by this design document.
