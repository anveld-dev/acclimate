# Second review: continuous self-improving harness

Review date: 2026-11-17. Source baseline: `3de5ac433a5a6b3d1406efaa51e50283ec66d402`. This pass independently challenges the [first review](../README.md), using current Acclimate source and the pinned AgentRun/RRSI clones in `.repos.json`. It reviews concepts and implementation; no new benchmark or paid model run is implied.

The [continuous-learning architecture decision](../../../architecture/continuous-learning/README.md) records the move to service-managed learning.

## Updated verdict

The current substrate is not fundamentally incompatible with continuous improvement. A fixed set of instructions can improve over repeated jobs, and application-owned code can already orchestrate that process. The main design risk is collapsing different claims into one: **delivered content**, **completed execution**, **admissible lesson**, **measured improvement**, and **authorized release** are separate facts.

The production service supplies useful content, proposal, evidence and release records. A continuously operating learner still needs an application-owned, recoverable policy that connects them. That need does not automatically imply a new hosted runtime, workflow engine, server-side campaign schema, or public HarnessRevision resource.

## Corrections to the first pass

1. **Fixed-file proposals limit repertoire growth; they do not prevent all continuous improvement.** The restriction is concrete: existing allowed paths and identical file sets/kinds are enforced in [improvement.rs](../../../../src/improvement.rs#L239), [validate_edits](../../../../src/improvement.rs#L420) and the [edit envelope](../../../../src/proposal_edits.rs#L6). It matters when the learner needs to discover a new skill/helper or retire old knowledge. Fixed-file refinement remains a legitimate mode, and an app-owned proposer can submit an ordinary version through the existing authoring interface.
2. **A shared runtime descriptor does not prohibit different harnesses per arm.** The descriptor accepts application runtime keys ([definition.ts](../../../../packages/sdk/src/evaluation/definition.ts#L137)), and execution receives `context.side` ([types.ts](../../../../packages/sdk/src/evaluation/types.ts#L18)). An app can commit parent/candidate harness-manifest digests in that map and choose the corresponding frozen artifact. The missing feature is a shared convention and validation of treatment versus invariant experiment identity, not an inability to represent it at all.
3. **Structured provenance is necessary in some integrations but insufficient for lesson admission.** A typed source reference does not establish truth, authority, generality or freedom from planted instructions. An app must decide which observations may inform proposals and which changes may enter future context. Existing human release review already supplies a deliberate gate; unattended operation needs an explicit substitute policy.
4. **New server entities are optional implementation choices.** A private, durable app journal and immutable external artifacts can establish the required identities, campaign decisions and checkpoints first. Add shared server entities when there is a demonstrated multi-client or inspection need.
5. **Existing memory-selection and audit work must be credited.** The native repository starter records source/context/memory fingerprints and removes unselected memory from effective context ([starter contract](../../../../examples/native-repository/README.md#L90)). The twenty-round example uses a separate final audit. Neither feature is missing outright; what remains is a reusable continuous protocol around them.

## Findings that remain actionable

### 1. Define the learner's evidence and decision contract

Delivery receipts end at `started` and carry no logical task completion/outcome/feedback identity ([receipt schema](../../../../packages/sdk/src/types.ts#L300)). Keep their best-effort semantics. Feed the learner correlated app task outcomes or durable references to the application's existing telemetry. Distinguish confirmed task results, infrastructure failures and execution whose final state is unknown.

Proposals currently receive strings of evidence, and the provider gets parent/evidence/edit instructions in a single prompt ([proposal dispatch](../../../../src/lib.rs#L242)). Author permission to submit text does not make every claim in that text trustworthy. Introduce an app-owned admission policy for reviewed corrections, scope, applicability, secrets and conflicts. Preserve the raw observation separately from the approved learning view.

**Consequence:** generating more simulated starts or successful model responses is not evidence that a learner is improving.

### 2. Make the experiment's treatment explicit

Freeze two harness manifests and a separate invariant evaluation manifest. Content, executable/config artifact, native mapping, selected memory/context and tool contracts identify each treatment; task inventory, grader and collection protocol identify the experiment. Record relevant model/provider settings while acknowledging hosted behavior may change.

Use the existing runtime map and immutable artifact digests as a compatible first implementation. Verify the manifests at launch and on recovery; do not treat labels alone as measurement. Preserve app-reported evidence semantics rather than claiming remote execution attestation.

The SDK currently runs parent before candidate for every pair ([runner.ts](../../../../packages/sdk/src/evaluation/runner.ts#L537)). That is acceptable for deterministic isolated simulators. Live comparisons need controlled fixture state and a recorded, seeded balanced order to avoid systematic cache/time/order confounds.

### 3. Give uncertain work and spend explicit recovery policy

The proposer resets interrupted running jobs for a bounded retry ([improvement.rs](../../../../src/improvement.rs#L295)), while dispatch uses an ordinary provider POST ([lib.rs](../../../../src/lib.rs#L243)). A provider can accept or finish work before a process fails to persist the candidate. Database atomicity prevents a partial candidate write; it does not guarantee that a retry incurs no further external work or spend.

The SDK evaluator conservatively refuses callback replay when its journal says execution started but no final report exists ([runner.ts](../../../../packages/sdk/src/evaluation/runner.ts#L460)). Preserve that protection. A production learner must recover/reconcile that attempt or explicitly abandon it before starting another, with an unknown-cost allowance or stop rule. A logical interrupt must not be assumed to have killed already-running model work.

For recurring runs, retain campaign ID, current candidate/incumbent, completed decisions, pending operation IDs, budgets/reservations, terminal/uncertain states and the next recoverable action. This can begin in the application journal.

### 4. Separate admission, search acceptance and release

AgentRun's grader judges whether a lesson is suitable to retain; it does not run a paired behavioral experiment for each merge. RRSI's domain interface owns execution/scoring and its selection is an optimization policy. Neither establishes that an admitted reflection or an accepted candidate necessarily improves future production tasks. [AgentRun grading rubric](https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/grade.ts), [RRSI domain interface](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/domain.py).

Applicability and conflicts also need policy: a lesson can be sound for one customer, task or policy epoch and wrong for another. Supersession metadata and a model grader help inspect this; they cannot guarantee compatibility. Record the effective selected context, without conflating availability with an observed read or causal benefit.

Use explicit states or decisions for `admitted`, `searchAccepted`, `auditPassed` and `releaseAuthorized`; only the relevant ones need server storage. Existing promotion correctly binds evidence to the current parent and candidate; completeness deliberately does not enforce a global quality policy ([channels.rs](../../../../src/channels.rs#L198)). Keep this separation when introducing automation. Track audit exposure and replace/retire cohorts as they become development knowledge.

## Smallest coherent next step

Build one durable application-owned learner over the existing SDK and service. Start with fixed-file improvement and a frozen fictional task family, record actual outcomes and approved corrections, create a candidate, run a controlled paired comparison, and persist an explicit acceptance decision. Use the existing private artifact/journal conventions. Add bounded creation of new skill packages only when this workflow needs it.

The acceptance demonstration should:

1. Execute a baseline job and retain its pinned inputs, terminal result and feedback provenance.
2. Propose a candidate from development evidence only; retain rejected candidates and reasons.
3. Freeze treatment/evaluator manifests and run complete paired trials with independent task state.
4. Use a separate audit before the authorized release decision; retain the linkage from accepted search candidate to released content.
5. Start a fresh consumer job that receives the release, with a pinned-baseline control.
6. Crash/restart at one external-call uncertainty point and one committed-decision point; prove the controller reconciles rather than silently duplicating work or resetting its budget.

That is a stronger test of the concepts than adding more seeded data or rebuilding AgentRun's infrastructure.

## Specialist reports

- [Mutation and artifact model](mutation.md)
- [Experiment model](experiments.md)
- [Recovery and budgets](recovery.md)
- [Experience and memory](memory.md)
- [Skeptical minimal-design review](skeptic.md)

Five independent second-pass specialist reports were completed and reconciled. The overlapping upstream background task was canceled after this coverage was sufficient; it is not counted as a completed review. The completed [first-pass AgentRun audit](../agentrun.md), pinned upstream source inspection by the specialist reviewers, and the primary-source checks above inform the comparison.

## Validation

This was a read-only implementation and pinned-source review apart from documentation changes. Local report links and `git diff --check` were checked. No application tests, live model calls or upstream benchmarks were run; findings about crash windows and conflicts are source-derived failure scenarios rather than reproduced incidents.
