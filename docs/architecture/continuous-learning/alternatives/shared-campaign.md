# Alternative B: a shared campaign coordinator

**Proposed design, 2026-11-17. No routes, grant rights, schemas or SDK methods in this document are implemented.** This alternative deliberately centralizes campaign state in Acclimate while leaving every harness, model/tool call, grader and provider credential in the integrating application. It differs from an application-local learner journal: independent application workers and the console share one authoritative campaign history.

Use this alternative when multiple workers or applications must inspect and advance the same campaign, operator intervention must survive loss of an application machine, and shared admission/budget decisions are a product requirement. A single application learner does not need this coordination tier merely to run repeatedly.

## Existing seams and invariants

Retain the existing immutable bundle snapshots, exact comparison/request/attempt bindings, complete-case validation, and conditional channel promotion. The [second review](../../../research/continuous-harness-review/second-pass/README.md) explains why content delivery, execution, lesson admission, search acceptance and release must remain distinct.

The implementation already owns mutation authorization/idempotency inside [commands.rs](../../../../src/commands.rs#L77), stores candidates transactionally in [improvement.rs](../../../../src/improvement.rs#L388), and protects promotion with current-parent and revision checks in [channels.rs](../../../../src/channels.rs#L157). New campaign commands should call extracted internal transaction functions at these seams; they must not orchestrate a series of HTTP self-calls and describe it as atomic.

The current singleton guard remains the server deployment model. External worker claim fencing coordinates app workers; it is not a reason to introduce multiple Rust servers or a general distributed workflow engine.

## Ownership

The **campaign module** owns immutable policy/manifest references, admitted experience references, rounds, incumbent, decision records, work admission, budget reservations, audit exposure and release intents. Its command handlers hide transaction ordering, deduplication, policy checks and resumable transitions.

The **application worker** owns provider authentication, executable artifacts, case contents, isolated fixtures, Codex/other native SDKs, execution handles, trace retention, outcome grading and reconciliation with providers. A worker cannot change campaign policy or publish a channel merely because it can execute work.

The **content/evaluation/channel modules** continue to own stored content, evidence validation and actual release mutations. Campaign state references them rather than duplicating their records.

The **console** reads campaign projections and submits explicit admission, stop, reconciliation and release commands using the current verified human identity. It does not run the evaluator.

## Core records

TypeScript-like notation below describes proposed wire contracts. IDs are canonical UUID strings; revision and integer amount fields are opaque decimal strings. No credentials or private dataset contents belong in manifests.

```ts
type ArtifactRef = {
  sha256: string; bytes: string; mediaType: string;
  locator: string; // opaque app-owned reference; server never fetches arbitrary URLs
};
type ContentRef = { bundleId: string; versionId: string; digest: string };
type HarnessRef = {
  content: ContentRef;
  manifest: ArtifactRef; // executable/config/tool/mapping/context identities
};
type ExperimentRef = {
  manifest: ArtifactRef; // fixed grader, inventory, fixtures, collection protocol
  parentHarness: HarnessRef;
  candidateHarness: HarnessRef;
};
type PolicyRefs = {
  admission: ArtifactRef; mutation: ArtifactRef;
  selection: ArtifactRef; audit: ArtifactRef; release: ArtifactRef;
};
type CampaignConfig = {
  bundleId: string; releaseChannel: string;
  initialIncumbent: HarnessRef; policies: PolicyRefs;
  workerProfile: string; // installed executor/profile identity, never downloadable code
  bounds: {
    maximumRounds: number; maximumConcurrentDispatches: number;
    maximumDispatches: number; deadline: string;
    maximumReservedUsdMicros?: string;
    unknownUsage: 'hold-reservation' | 'stop';
  };
};
type Experience = {
  sourceApp: string; runId: string; attemptId: string;
  harness: HarnessRef; cohort: string;
  status: 'completed' | 'task-failed' | 'infrastructure-failed' | 'unknown';
  outcome: ArtifactRef; trace?: ArtifactRef;
};
type Admission = {
  experienceId: string; teachingView: ArtifactRef;
  applicability: { taskFamily: string; policyEpoch: string; audience: string };
  decision: 'eligible' | 'rejected'; policy: ArtifactRef; reason: string;
};
type Decision = {
  kind: 'search' | 'audit' | 'release';
  roundId: string; candidate: HarnessRef; baseline: HarnessRef;
  comparisonId: string; policy: ArtifactRef;
  verdict: 'accepted' | 'rejected' | 'indeterminate';
  explanation: ArtifactRef;
};
```

A digest commits bytes; it does not attest that a worker ran them or make a hosted model immutable. The server validates ownership, digest syntax, configured reference limits and exact manifest equality; the app validates referenced bytes and their execution meaning. A readable summary accompanies opaque policy/manifest references for inspection. Enforcement-critical server fields such as bounds and permitted worker identities are stored directly, not hidden in an artifact the server cannot interpret.

Experience submission deduplicates by project, source application, run ID and attempt ID, with an immutable body fingerprint. Delivery event UUIDs are not execution identity. Admitting an experience creates a separate immutable, scoped teaching view: an observation may be accurate but ineligible to teach. Admission does not itself assert that a candidate improves behavior. Retraction creates a new eligibility event; it never rewrites history, and it invalidates not-yet-released decisions that depend on the retracted evidence until reviewed again.

Campaign configuration is immutable. Changed objective, authority policy, mutation rights or audit regime creates a new policy epoch/campaign derived from the previous one; it never silently changes an in-flight round.

## External interface

The proposed SDK has a management client and a worker adapter. Fixed typed commands cover this learning lifecycle; there are no arbitrary user-defined workflow nodes.

```ts
interface CampaignClient {
  create(config: CampaignConfig, operationId: string): Promise<Campaign>;
  read(id: string, afterEvent?: string): Promise<CampaignView>;
  command(id: string, envelope: {
    operationId: string; expectedRevision: string; command: CampaignCommand;
  }): Promise<CommandReceipt>;
}

type CampaignCommand =
  | { kind: 'recordExperience'; experience: Experience }
  | { kind: 'admitExperience'; admission: Admission }
  | { kind: 'planRound'; eligibleAdmissionIds: string[]; hypothesis: string }
  | { kind: 'decideSearch'; decision: Decision }
  | { kind: 'requestAudit'; roundId: string; cohortEpoch: string }
  | { kind: 'decideAudit'; decision: Decision }
  | { kind: 'authorizeRelease'; decision: Decision; expectedChannelRevision: string }
  | { kind: 'requestStop'; reason: string }
  | { kind: 'resume'; reason: string }
  | { kind: 'resolveUnknown'; dispatchId: string; resolution: Reconciliation };

interface CampaignWorker {
  claim(profile: string, operationId: string): Promise<Claim | null>;
  renew(claim: Claim): Promise<Claim>;
  admitDispatch(claim: Claim, operationId: string): Promise<DispatchTicket>;
  observe(dispatchId: string, observation: WorkObservation,
          operationId: string): Promise<ObservationReceipt>;
  settle(claim: Claim, dispatchId: string, result: WorkResult,
         operationId: string): Promise<CommandReceipt>;
}
```

`Decision.kind` and command must agree; search decisions cannot masquerade as release decisions. The implementation uses separate validated DTOs rather than relying on callers to obey the illustrative union. `resolveUnknown` requires an installed reconciliation policy or human authority and records its evidence; it is not a worker escape hatch for claiming an unobserved success.

Proposed routes under `/v1/projects/{project}`:

- `POST /learning/campaigns`: create one campaign.
- `GET /learning/campaigns` and `GET /learning/campaigns/{id}`: authorized projection/discovery.
- `GET /learning/campaigns/{id}/events?after={cursor}`: bounded ordered event pages.
- `POST /learning/campaigns/{id}/commands`: one typed management transition.
- `POST /learning/work/claims`: claim work from campaigns accessible to that worker/profile.
- `POST /learning/work/{id}/renew`: renew one current claim.
- `POST /learning/work/{id}/dispatches`: reserve and admit one external dispatch.
- `POST /learning/dispatches/{id}/observations`: retain immutable observed facts, including late ones.
- `POST /learning/work/{id}/settle`: fence and commit the acknowledged result.
- `GET /learning/operations/{operationId}`: recover the caller's exact command receipt.

Every mutation uses existing principal-bound idempotency conventions plus an exact body fingerprint. Reuse with another body conflicts. Management commands use campaign revision CAS; worker renew/settle uses claim epoch CAS. Independent observations need no stale campaign revision, but cannot advance the incumbent or release state. Events expose opaque private-artifact references only to authorized readers and never credential-bearing locators.

## Fixed lifecycle

Campaigns have `active`, `stopping`, `paused`, `needs-reconciliation` and `finished` status. The status is a projection; work, reservation and decision records retain the reason and outstanding operations.

A round pins the current search incumbent, a bounded admitted evidence set, mutation policy and hypothesis. One search round is active per campaign in the first implementation. Workers propose a full candidate snapshot under that mutation policy; the server validates the exact parent and final native-compatible payload. Candidate publication and its campaign linkage commit together using the existing version-store transaction seam. The search incumbent is a campaign pointer, never a delivery channel.

A proposal result creates development-evaluation work with frozen arm/evaluator references. The app may use the existing installed evaluator and retained journal. The campaign records the exact existing request, attempt and comparison identities. A worker cannot submit a whole comparison merely by naming an unrelated complete report; project, bundle, arm manifests, expected inventory, submitter and request/attempt binding must all match. Existing validation remains authoritative for report shape/completeness.

A selection-authorized app principal applies the configured policy and submits a search decision. The campaign validates the bindings and incumbent revision, stores the decision, and conditionally updates the incumbent in one transaction. The server only enforces policy predicates it implements or an explicitly trusted decision-authority identity; an artifact digest containing an arbitrary policy is not executable enforcement. A winning search decision does not make the candidate deliverable.

Audit work consumes a protected cohort epoch before dispatch. A failed or exposed audit cannot be reused as fresh evidence under a new request ID. The configured audit policy controls rotation/retirement; a simple first policy permits one final audit per epoch and stops on failure. Selection workers receive the approved development teaching view, not audit answers.

Release is a separate command, requiring promotion authority and an accepted audit under the applicable release policy. It invokes existing conditional promotion inside the same transaction as the release decision/outbox event. The original current-parent and expected-channel-revision checks remain in force. If cumulative search ancestry differs from the current release parent, create a release snapshot preserving identical accepted bytes and a `derivedFromSearchCandidate` reference, then audit that exact release-parent/candidate pair. Never reuse a comparison for a reparented identity. An external channel change makes the release intent stale; stop and re-evaluate against the actual parent rather than silently rebasing.

## Admission, fencing and uncertainty

A claim says which installed app may perform which bounded job. It pins job input and policy digests, worker principal, server-clock expiry and a monotonically increasing epoch. Renewals cannot revive expired ownership. A claim that has never received a dispatch ticket can be reassigned after expiry; no compliant worker had authority to call the provider yet.

Before external work, `admitDispatch` atomically checks campaign stop/deadline, current claim, active-dispatch limits and remaining budget, and writes a reservation plus a stable dispatch ID. The worker fsyncs its local ticket/intent before calling the provider and retains acknowledged handles and outputs. Provider idempotency/result lookup is used when available. Ticket admission does not prove dispatch occurred; a crash immediately afterward is conservatively uncertain.

After ticket admission, lease expiry never automatically redispatches the same work. It closes admission and marks that dispatch `outcome-unknown`. A replacement reconciler reads the existing local/provider operation identity first. If no conclusive result exists, policy explicitly decides whether to wait, abandon, or spend a second bounded reservation on a new dispatch. Record both; never call it exactly-once execution.

Late observations from the original authenticated worker are retained against their immutable dispatch identity even after claim expiry. They cannot mutate campaign state with an expired epoch. A current reconciler validates and adopts or rejects that evidence in a new fenced settlement. The server does not accept a stale worker's direct incumbent or release write.

`requestStop` prevents new tickets immediately and asks owners to cooperate. `stopping` remains until each active dispatch is confirmed settled or explicitly unresolved; it is not proof that provider compute stopped. Resume preserves unresolved reservations and identities. It does not erase them or reset spend.

## Budget semantics

The coordinator can strictly limit admitted dispatch counts, reservations, concurrency and its own deadlines for compliant workers. Record USD reservations as integer microdollars and observed usage as known or unknown; unknown is never zero. A reservation remains charged against availability until observed settlement or an explicit conservative reconciliation decision.

A hard dollar cap on external providers requires an enforceable per-dispatch upper bound or provider-side spending control. If the app cannot supply that bound, expose the campaign as count/time bounded with observed dollar usage, not as guaranteed dollar capped. This design does not add a provider proxy or assume a client timeout cancels billing. In-flight uncertainty can pause progress rather than release a reservation optimistically.

## Authorization and visibility

Proposed additional project capabilities are `learning-observe`, `learning-admit`, `learning-coordinate` and `learning-work`, with campaign/profile restrictions checked inside every transaction. These do not exist today: [auth.rs](../../../../src/auth.rs#L25) currently admits only `read`, `write`, `propose` and `promote`. Grant validation and the command route registry must be extended explicitly; absence of a new right denies access, with no fallback to ordinary `write`.

Human workspace administrators configure campaigns/policies and worker registration; authorized admission principals decide teaching eligibility; coordinator principals plan/select; registered worker principals execute only their claimed work. Content publication additionally requires the appropriate existing write authority, and a release requires existing `promote` authority. Worker capability never implies promotion. A release-policy digest does not grant authority.

Project readers may see campaign progress, safe summaries and decision history. Private source traces and audit answers remain app-owned; their locators are non-secret opaque references. Cross-project references are rejected even when the actor belongs to both projects. No new public cross-project analytics or transcript upload is introduced. Retention removes private artifact availability according to app policy while preserving immutable hashes and a tombstone; pending decisions whose required evidence becomes unavailable become indeterminate.

## Persistence and transactions

Use one PostgreSQL schema alongside existing content records: `learning_campaigns`, `learning_events`, `learning_experiences`, `learning_admissions`, `learning_rounds`, `learning_decisions`, `learning_work`, `learning_dispatches`, `learning_reservations`, `learning_audit_exposures` and command receipts. This is a conventional relational implementation, not a generic event-sourcing framework. Indexed current projections serve the console; ordered append-only events explain their transitions.

All records carry project/campaign ownership. Transactional commands lock the campaign (and target channel when releasing), verify the relevant revision/epoch, validate referenced immutable records, update the projection, append the event and persist the idempotent receipt. Round/decision linkage to existing versions/comparisons uses the same transaction. Lock order is documented as campaign before channel to avoid inversion. A database outbox carries notifications to external consumers; delivery is at least once, keyed by event ID, and is not part of correctness.

## Example caller

Illustrative proposed SDK, not executable repository code:

```ts
const campaign = await campaigns.create({
  bundleId, releaseChannel: 'stable', initialIncumbent,
  policies: approvedPolicyRefs, workerProfile: 'payments-codex-v1',
  bounds: { maximumRounds: 10, maximumConcurrentDispatches: 1,
    maximumDispatches: 80, deadline, unknownUsage: 'stop' },
}, createOperation);

// Outcomes come from actual app jobs; admission is a separate authorized call.
let view = await campaigns.read(campaign.id);
await campaigns.command(campaign.id, {
  operationId: outcomeOperation, expectedRevision: view.revision,
  command: { kind: 'recordExperience', experience: completedTask },
});
// A separately authorized admission/coordination path selects an eligible batch
// and plans one round. The console can inspect every retained decision.

const claim = await workers.claim('payments-codex-v1', claimOperation);
if (claim) {
  const ticket = await workers.admitDispatch(claim, dispatchOperation);
  const result = await installedExecutor.run(ticket, ownedLocalJournal);
  // This waits for confirmed terminal work or returns an explicit unknown result.
  await workers.settle(claim, ticket.dispatchId, result, settleOperation);
}
```

The installed executor is supplied by the app. Its interface is fixed around proposal/evaluation/reconciliation jobs and known profiles; the server never downloads code from `workerProfile` or a manifest locator.

## Depth and tradeoffs

The caller learns a larger interface than the local-learner alternative, but it no longer implements shared incumbent CAS, cross-worker admission, claim fencing, audit-consumption deduplication, central reservations, or a console projection. That is the module's depth: one campaign command owns those invariants instead of asking callers to sequence check/read/write calls correctly.

The cost is substantial: a protocol version, new database ownership, new project capabilities, worker compatibility negotiation, private-reference retention and server availability in the learning path. The content-delivery path remains independent so coordinator downtime does not stop pinned app jobs or verified cache delivery. It does pause new learning tickets and decisions. A central reservation store still cannot prevent an app with unrelated provider credentials from making calls outside the protocol.

This design is preferable when shared campaigns are the product. It is excessive for a single app that can retain its own journal and expose a review artifact. The migration should therefore start with the same immutable contracts in an app-owned learner, then promote shared coordination only after a real second worker/application demonstrates the need.

## Compatibility and implementation gates

Keep all existing content, evaluation, receipt and promotion endpoints operational. Campaign endpoints are additive and feature-negotiated. Do not reinterpret an old completed comparison as a policy pass, old delivery receipts as experiences, or a historical channel promotion as a search decision. Import a prior candidate only through an explicit linked starting incumbent; old records remain readable under their existing meaning.

Before enabling shared campaigns: freeze schemas/error codes/exact-byte fixtures; extract transaction functions without changing current behavior; add the new grant and command registry cases; implement single-round state transitions and projection; then add worker tickets, uncertainty reconciliation, budget reservations and audit exposure. Introduce console views last against real persisted records. No campaign is automatically created from existing workspaces.

Required acceptance checks are: duplicate command exact replay versus body conflict; two workers cannot receive concurrent authority for one dispatch; expiry after admission does not replay provider work; late results cannot write through stale fencing; stop closes admission without falsely claiming active compute stopped; restart preserves unknown reservations; retracted teaching evidence blocks dependent unreleased decisions; audit epoch reuse is rejected; rejected candidates remain visible; stale release-parent/revision conflicts preserve the channel; release decision and promotion commit atomically; and a fresh app job sees the released snapshot while an old prepared job stays pinned.

This alternative is a design proposal only. No implementation or validation run is represented by these acceptance criteria.
