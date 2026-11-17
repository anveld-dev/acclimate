# Migration and qualification plan

Status: the selected TypeScript first profile is implemented in this checkout, 2026-11-17. This document retains the phased design and acceptance criteria; the [implementation record](implementation.md) identifies delivered pieces, validation and deferred capabilities. Existing content delivery, evaluation, authoring and release contracts remain usable throughout.

## Delivery sequence

### 1. Freeze private identity and decision artifacts

Implement the [evidence contract](evidence.md) as an application-side learning entry point. Its immutable references use `{id, sha256, bytes}`; physical locations stay private. The selected TypeScript interface is normative in the architecture README. Retain canonical private manifests and scoped teaching views; publish only explicitly approved commitments through the existing evaluation descriptor. Two arm identities may differ; the evaluator and collection protocol remain fixed for a comparison. Preserve existing descriptor behavior for applications that do not opt into learning.

Proposed ownership: `packages/sdk/src/learning/identity.ts`, `admission.ts`, and `types.ts`; expose a Node-only `@acclimate/sdk/learning` entry. Keep the current browser-safe validation entry free of storage/process dependencies. Version each learning artifact, separately from bundle schema version 1. The Python SDK can consume/export the artifact protocol after the TypeScript interface is qualified; cross-language controller parity is not implied by retaining wire compatibility.

**Gate I:** round-trip canonical artifacts, changed manifest rejection, sensitive-field exclusion, project/task applicability, duplicate outcome detection, and refusal to teach from unadmitted observations. A content digest plus an effective-context digest must not be displayed as proof that the model read or used those bytes.

### 2. Add the durable app-owned learner

Implement the selected small learner interface and [recovery contract](recovery.md) around the existing Acclimate client/evaluator. Put state transitions, reservations, external intents and reconciliation inside the learner. An application scheduler invokes the learner; it does not reconstruct an operation graph or own idempotency ordering.

Proposed ownership: `packages/sdk/src/learning/controller.ts`, `store.ts`, `operations.ts` and `adapters/`. Begin with one owning process on one retained local volume. Lock ownership, durable checkpoints, immutable artifact writes and budget accounting are mandatory. Distributed ownership and network-filesystem journals are separate deployment designs. Do not run two controllers against the same logical campaign using independent copies of its journal.

Reuse [SDK client operations](../../../packages/sdk/src/client.ts), [private evaluator journals](../../../packages/sdk/src/evaluation/journal.ts), [evaluation runner](../../../packages/sdk/src/evaluation/runner.ts), [policy calculation](../../../packages/sdk/src/evaluation/policy.ts), and the existing explicit channel promotion command. The learner must not import implementation files from examples. Extract genuinely reusable behavior from the twenty-round example behind the new public interface; preserve that example as evidence until replacement qualification passes.

**Gate R:** restart at every dispatch/commit boundary, reject duplicate campaign ownership, retain budgets/audit exposure across restart, refuse blind replay of uncertain native work, distinguish stop request from confirmed settlement, and reconcile a lost remote mutation response using its saved principal/body/key.

### 3. Ship one recurring fixed-file learner

Integrate one fictional task family and a single existing skill. Ordinary application executions create correlated terminal outcomes; approved development corrections can trigger a bounded proposal. Keep runtime/tool permissions fixed. Use the existing fixed-path service proposer when its spend semantics meet the configured policy, or an explicitly installed app-owned proposer with declared attempt/usage capabilities. Do not claim a strict dollar ceiling for an opaque provider adapter.

Proposed ownership: an installed `examples/continuous-learning/` starter with public package imports, explicit private configuration and retained state/artifacts. Tests use deterministic adapters first. A separate opt-in live qualification may use the Codex SDK under the repository's Luna restrictions. Scheduling is ordinary application infrastructure; successful content fetches never create improvement work automatically.

**Gate L:** ingest two distinct batches, run at least two rounds in one retained campaign, retain a rejected candidate, and demonstrate recovery without resetting the campaign budget. A planted task instruction must not become a reusable teaching correction. Both a fixed-file learner and a learner with no eligible new evidence must have meaningful steady states.

### 4. Qualify controlled evaluation and deliberate release

Extend the installed evaluator collection protocol for seeded balanced arm ordering and application-owned isolated/reset fixtures. Record the actual order. Existing deterministic simulators may explicitly retain fixed order; keep compatibility for non-learning clients. This is collection randomization, not the statistical-bootstrap seed.

Separate search comparison from release comparison. The selected v1 profile compares the candidate directly against the published baseline. A later multi-step search profile may compare against an unpublished incumbent. A released candidate must be reviewed against the actual published parent and current channel revision. If the current channel has advanced, stop the pending release; do not rewrite its parent or reuse stale evidence automatically.

When identical accepted content needs a release-child version under the published parent, create that immutable child, retain `sourceAcceptedVersionId` and both content digests in a release-lineage artifact, and run the final audit against the exact release-child identity. Do not relabel an existing search report as an audit of a different version ID. Existing server parent/evidence guards remain unchanged.

**Gate Q:** complete losing evidence remains unselected; incomplete/unknown grades cannot become wins; audit exposure is charged before execution, retained on failure, and never reset by reopening a campaign. A failed audit closes its release epoch. **Gate P:** human approval uses an explicit reviewer principal and current expected revision; fresh jobs resolve the release while prepared baseline jobs retain their pinned bytes.

### 5. Add bounded artifact discovery when needed

Implement [mutation planning](mutations.md) in the application using the existing full-version publication interface. V1 fixed-text refinement remains the default. Opt into atomic skill-package creation/retirement only for a campaign with explicit structural capabilities. A server proposer grammar extension is an independent later compatibility change; it is not necessary for an app-owned proposer.

Proposed ownership: `packages/sdk/src/learning/mutations.ts` and native-compatibility tests. Whole-payload reconstruction, byte/count limits, exact-parent preconditions, path validation and final native validation precede publication. Structural changes produce one candidate. Runtime tool/effect grants remain application-owned and are not inferred from safe paths or a compatible skill manifest.

**Gate M:** one new multi-file skill, one retirement, stale-parent rejection, orphan/reference failure, atomic validation failure, unchanged unrelated bytes, and native preparation of the exact published snapshot. Do not change draft editing rules globally or invent a neutral resource kind solely to make a misclassified fixture pass.

### 6. Project shared status into the console only with an explicit contract

Follow the staged [product flow](product-flow.md). Initial learner-local state appears in a local report/CLI and explicit review export. Existing console pages continue to show actual versions, evaluations, releases and delivery observations. They cannot display private campaign checkpoints they never receive.

Add a narrow authenticated, project-scoped read-model projection only when team visibility requires it. Projection events carry producer identity, campaign revision, observation time, availability/staleness and approved public references. They do not authorize execution or release and never upload raw private traces by default. A stale projection cannot imply current ownership or settled work.

**Gate U:** absent/stale producer state is visibly unknown; project readers cannot retrieve private artifacts or write admission/release decisions; no duplicate navigation for the same change/evaluation; stop control appears only when a connected owner can acknowledge it.

## Implementation acceptance suite

The initial learner is complete only when one installed application passes all of I/R/L/Q/P under deterministic fixtures. M and U gate optional structural and shared-console capabilities rather than blocking fixed-file learning. A bounded live Codex run then validates native integration and task behavior; it does not replace the deterministic recovery tests or establish broad transfer.

Required scenarios:

1. Baseline outcome -> authorized development correction -> immutable candidate -> development comparison -> search decision.
2. One known regression is retained and rejected; one complete but unaudited candidate cannot release.
3. Manifest drift, changed grader, cross-project evidence and altered teaching view are rejected before model work.
4. Crash after provider dispatch records uncertainty; restart neither silently repeats a native job nor clears reserved spend.
5. Crash after accepted remote comparison but before local search decision reconciles the same operation and records one decision.
6. Lost release response is reconciled with the same command; a concurrent channel update causes a conflict and a new review requirement.
7. Stop closes admission immediately, retains in-flight reservations, and shows settled only after evidence from the owner.
8. Audit exposure survives failures/restart; no audit answer is admitted to development within the same epoch.
9. Fresh released job and pinned-baseline control execute with retained exact identities; an older prepared job stays pinned.
10. A subsequent outcome batch starts a second round in the same campaign without resetting policy or budget. If another release is sought, reserve a different eligible cohort from the precommitted audit roster; roster exhaustion blocks audit until an explicit policy-preserving epoch migration.

## Compatibility and rollback

No initial PostgreSQL migration or bundle wire-schema change is required. Existing applications do not need the learning entry point. Stop the learner and retain its state to disable new learning work; existing delivery and current channel resolution continue normally. Channel rollback uses the existing authorized promotion operation and records its reason. It restores content only; an app executable/configuration rollback is an app deployment operation and must be coordinated separately if that artifact changed.

Never interpret deletion of a local journal, a fresh campaign ID, a lost SDK await, or an evaluation `interrupted` status as proof external work stopped. Imports and rollback of learner state must preserve operation IDs, unsettled work and reservations or be refused. Artifact schema upgrades run under exclusive ownership, retain a backup, and must reject unknown versions rather than infer missing authority.
