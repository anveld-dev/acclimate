# Continuous improvement lifecycle audit

Reviewed 2026-11-17. Static review of this checkout, the pinned AgentRun clone (`077b2fa1c831bdd2bbcb7ed7a0435914f48486b5`) and pinned RRSI clone (`be50316e1db05914068a973f322770ef08ed7ba1`). No upstream experiments, model calls or runtime changes were made. Findings concern the requested continuous self-improving harness goal; several are deliberate current product limits, not defects in the advertised content platform.

## Assessment

The storage, proposal queue, evaluation records, controlled release and immutable job delivery are useful foundations. The absent concept is a persistent **improvement campaign** connecting observations, trusted feedback, candidate search, selection, release and future observations. The working qualifications demonstrate pieces of that loop; they do not provide an operating production learner. Keep host execution outside Acclimate if desired: the missing module can be an application-owned controller with durable state rather than a new central agent runtime.

## 1. High: the proposer cannot create the artifacts a learning harness needs

`allowedPaths` must name existing parent files (`src/improvement.rs:239-248`). Candidate validation requires identical path sets and unchanged kinds (`src/improvement.rs:420-435`). A successful proposal produces an immutable child and links its proposal (`src/improvement.rs:411-417`), but only after these restrictions.

**Failure scenario:** a run discovers a reusable procedure or a deterministic helper worth storing. It cannot add `skills/reconcile/SKILL.md`, a reference, or a helper script. It must overload a seeded file, rely on an operator to scaffold the new file first, or leave the proposer interface. Deletion, retirement by removing obsolete content, and splitting an overgrown skill are similarly unavailable. Repeated text-only edits are a narrower search space than continuous harness improvement implies.

**Counterargument:** existing-file text patches intentionally reduce authority. This is sensible for a first proposer and preserves compatibility. It becomes a design mismatch when this interface is presented as the general learning primitive.

**Remedy:** bounded typed mutations (`add`, `edit`, `remove`, `move`) with authorized path prefixes, operation/byte limits, compatibility checks and immutable snapshots. Treat executable skill helpers as a separate capability with qualification gates. Do not simply grant arbitrary filesystem writes.

AgentRun explicitly permits a completed job to add/change a learned skill ([SPEC, lines 55–62](https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/SPEC.md#L55-L62)). Its broader authority is evidence that artifact creation is a distinct supported action, not evidence that our system should copy all of its runtime.

## 2. High: delivery observations cannot serve as learning observations

`DeliveryReceiptRequest` records event/integration/bundle/version/digest and a stage; stages end at `started` (`packages/sdk/src/types.ts:300-314`). Rust accepts exactly those stages (`src/integrations.rs:353-357`). There is no job execution ID, task reference, completion/failure event, result, grader feedback, correction authority or resource consumption in this interface. `eventId` identifies an observation; it does not group events into a job.

**Failure scenario:** ten observed starts can include repeated runs, failed runs and successful runs. None indicates whether a retry instruction helped. A future learner cannot reliably join a correction to the exact executed task and harness configuration, distinguish genuine failures from harness infrastructure errors, or decide what evidence it may safely teach from. The recent local delivery and Codex harness smoke runs show real execution, but the receipts by themselves are not a dataset of learning outcomes.

**Counterargument:** receipt semantics are intentionally honest and narrow. Expanding `started` to imply success would be wrong.

**Remedy:** keep delivery receipts as delivery facts. Add an app-owned run/outcome interface with stable job identity, exact delivered version, full harness/runtime identity, task/artifact references, terminal state, optional usage and explicitly authorized feedback. References can point to private host artifacts; raw transcripts need not enter Acclimate. Create proposal evidence from approved outcome records. Monitor outcome cohorts after release, not merely successful fetch/start counts.

AgentRun gives the end-of-run learning step explicit run/round identity and a journal behind the runner fence ([loop contract, lines 23–40 and 116–117](https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/runner/loop-contract.ts#L23-L40)). Its run-aware commit can recognize an already-merged learning result ([commit, lines 107–124](https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/commit.ts#L107-L124)). These are useful provenance/recovery ideas, not a requirement to centralize execution.

## 3. High capability gap: the durable queue executes one proposal, not the improvement loop

The service executes queued proposals serially and returns a candidate (`src/improvement.rs:295-319,411-417`). Feedback generation, incumbent tracking, selection, retries and release decisions are controller code. The twenty-round example initializes `incumbent`, `observations` and rejected findings in memory (`examples/self-improvement/twenty/run.ts:115-123`), selects from a new comparison (`276-295`), promotes a working channel (`297-309`), and writes round artifacts/progress (`336-344`). The basic runner always creates a new disposable project/bundle and starts its dataset and loop anew (`examples/self-improvement/run.ts:28-49,114-127`; `service.ts:47-51`). Neither should be described as a resumable production campaign.

**Failure scenario:** an operator installs SDK delivery and produces many usage receipts, expecting learning to continue. No production mechanism turns them into approved feedback or requests another candidate. A controller crash between completed evaluation and its local acceptance update leaves candidate evidence but no durable campaign transition; a generic rerun of the qualification starts a new experiment rather than settling that exact transition.

**Remedy:** a durable application controller with campaign ID, incumbent, objective/config revision, observation cursor, candidate/attempt IDs, evaluation references, selection decision with reason, next action, retry/uncertainty state and stop reason. Use an outbox/idempotent commands for each transition. Recover the existing round before issuing a new one. A scheduler is a client of this controller; it is not itself the lifecycle model.

RRSI writes per-candidate decisions/history, handles previously recorded candidates, and persists an incumbent and trajectory ([loop, lines 306–344](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/loop.py#L306-L344)). It verifies the branch matches the incumbent before a round ([231–240](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/loop.py#L231-L240)). Those concrete search-state concepts are useful; this audit does not claim upstream provides a production service or transactional campaign store.

## 4. Medium: search acceptance is persisted as a release on a working channel

The twenty-round example computes a separate search acceptance predicate, then invokes `promote('working', ...)` (`examples/self-improvement/twenty/run.ts:276-309`). This is useful example glue, but a channel promotion now carries both the meaning of search incumbent selection and consumer delivery/release. Keeping a specially named channel private is a caller convention.

**Failure scenario:** another integration resolves the working channel, or a UI/report treats every promotion as a production release. A development candidate selected on adaptively reused data becomes deliverable before its independent audit. Conversely, rejected candidates have reports but no first-class selection decision outside controller artifacts.

**Remedy:** persist selection decisions/campaign incumbent separately from delivery channels. Preserve explicit authorized release using independently appropriate evidence. Private development channels may remain useful; enforce visibility/consumer policy if they continue to encode campaign state.

**Counterargument:** the example deliberately isolates the working channel and never claims all promotions are production. This is a domain clarification needed when turning the example into a general continuous learner, not proof of an existing authorization bypass.

## 5. Medium capability gap: bounded calls are not a durable learning budget

The service imposes three proposal attempts and a 60-second proposal timeout (`src/improvement.rs:319,345-347`). The disposable proposer adapter has a process-local maximum proposal counter (`examples/self-improvement/service.ts:51,63-65`). The twenty-round runner caps round count (`twenty/run.ts:219`). Those limits bound qualification work, but do not express a campaign cost reservation, aggregate token/call cap across proposer/evaluator work, or restart-safe cumulative spend.

**Failure scenario:** recurring triggers or repeated controller restarts each stay within per-request limits but cumulatively exceed the intended daily search budget. A failed model call can still incur provider usage; a timed-out request is not evidence of zero cost.

**Remedy:** campaign-wide durable reservations before external work, observed usage reconciliation afterward, concurrency admission and explicit unknown-cost handling. Keep per-call deadlines and attempt limits. Stop on insufficient budget rather than silently beginning a new campaign.

## Preserve the reliable existing pieces

- PostgreSQL singleton queue ownership is intentional and sufficient for this deployment. Startup acquires an advisory lock before migrations/recovery and resets interrupted proposals with an attempt cap (`src/main.rs:151-178`). The worker uses one slot (`src/improvement.rs:309-319`). Missing distributed leases is not itself a bug: do not copy AgentRun fencing without first changing the deployment model.
- Candidate insertion and successful proposal update share a transaction (`src/improvement.rs:391-417`). Maintain this atomicity when broadening mutations.
- Qualifications explicitly separate training/selection/audit/future-job inputs (`examples/self-improvement/run.ts:28-39`) and test newly resolved jobs and stale release revision rejection (`run.ts:302-339`). Keep exact version pinning: continuous improvement should advance future jobs rather than mutate running jobs underneath them.
- The example README explicitly labels the controller opt-in, synthetic, disposable and supervised (`examples/self-improvement/README.md`, “Boundaries”). The central issue is moving from these useful qualifications to the newly requested product goal, not exposing a hidden existing claim of production autonomy.

## Recommended implementation order

1. Specify the full harness identity and app-owned job/outcome records; join observations to exact executed versions.
2. Implement a durable campaign controller and separate search selection from delivery release.
3. Expand proposer artifact mutations under explicit capabilities and retain all accepted/rejected evidence.
4. Add durable budget admission, objective-versioned triggers and post-release outcome monitoring.
5. Qualify repeated real Codex SDK jobs end to end: outcome -> approved correction -> proposal -> paired evaluation -> selection -> independent release gate -> new job -> outcome. Include crash recovery at each transition. A collection of `started` receipts is insufficient acceptance evidence for this loop.
