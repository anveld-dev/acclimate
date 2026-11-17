# Continuous learner implementation

The application-owned TypeScript profile uses `@acclimate/sdk/learning` to retain campaign state and compose the service's proposal and evaluation interfaces. The [learning contract](../../../contracts/learning.md), exported [types](../../../packages/sdk/src/learning/types.ts) and executable [starter](../../../examples/continuous-learning/README.md) describe this profile. See [connected learning setup](../../../deploy/README.md#operate-connected-learning) to let the service schedule rounds for an enrolled connection.

## Implemented ownership

| Component | Behavior |
| --- | --- |
| [Evidence and admission](../../../packages/sdk/src/learning/admission.ts) | Canonical immutable artifacts; exact scope; separate outcomes, feedback and teaching permission; host-authorized correction references; resolved experiment and job bindings. |
| [Private store](../../../packages/sdk/src/learning/store.ts) | Owner-only canonical local directory, verified artifacts, atomic revision-checked checkpoints, process locks, inbox compaction with durable receipt deduplication, and reserved capacity for stop, resume and uncertainty resolution. |
| [Controller](../../../packages/sdk/src/learning/controller.ts) | `submit`, `advance`, `inspect`. Retains admission provenance, policy-bound selection, operation identities, budget reservations, audit exposure, release observation and reviewer decline. |
| [Audit lineage](../../../packages/sdk/src/learning/audit-lineage.ts) | Records durable claims for audit dataset, task input and task family identities across enrolled campaigns for a project and bundle. |
| [Service adapter](../../../packages/sdk/src/learning/adapters/acclimate.ts) | Verified fixed-file proposal by default, opt-in structural mutation, full private treatment/control graphs, explicit public commitments, retained creation recovery and evaluator journal reuse. |
| [Mutation planner](../../../packages/sdk/src/learning/mutations.ts) | Pure bounded edits against the original parent with opt-in skill creation and retirement, final snapshot/native validation and explicit structural preflights. |
| [Evaluation collection](../../../packages/sdk/src/evaluation/collection.ts) | Opt-in seeded balanced arm order, frozen public schedule commitment and retained actual collection bindings. Default descriptors/order and native job-binding format remain compatible. |
| [Service operation recovery](../../../src/commands.rs) | Existing operation lookup/close supports version creation with current `write` authority and retained marked mutation semantics. Changed bytes conflict; closing prevents later dispatch. |

`openLearner` verifies frozen installation identity and retained policy artifacts. The app supplies its adapter, admission policy, trusted feedback references, persistent directory and scheduler. Opening and inspecting only access retained state. Changing the definition requires an explicit epoch migration.

Stop closes new admission immediately. A late result is retained without selection until resume; resume cannot erase a newer stop. Reopening reconciles existing work before starting another operation. A malformed recovery command is rejected without blocking a later stop, while failures after valid result retention preserve recoverable state and budget accounting.

A separate authorized reviewer uses the existing channel API. The learner checks the observed promotion against the audited candidate, baseline, comparison and revision. The app can also decline the exact pending review using `decline-release`. A superseding admission retires the replaced lesson from the queue and fences an active lesson from subsequent selection.

The Acclimate adapter binds each development or audit selection decision to the installed policy for that stage. An adapter that supplies a frozen development controls digest can receive a bounded history of aggregate failed, rejected or indeterminate development results when proposing under the same installation, baseline and sanitized teaching text. The history carries candidate identities and pair counts. The default service-proposer path reconstructs bounded excerpts from verified prior edits on allowed paths. The optional `maximumDevelopmentAttempts` permits another proposal under that baseline after a rejected development result, subject to the existing budget and stop barriers.

The opt-in mutation adapter verifies the retained admission and mutation-policy artifact before planning against the exact baseline. It checks each required preflight against the complete candidate and retains the mutation preparation privately before using the existing version creation operation. The default fixed-file path remains available. Candidate evaluation and release still use the normal comparison and channel interfaces.

## Audit registration and epoch migration

Configure the same private local `auditLineageDirectory` for all campaigns that share a project and bundle, and register each cohort's task input digests and task family fingerprints. The Acclimate adapter verifies the frozen dataset digest and its task input digests. The ledger claims each exposure before dispatch and prevents reuse across enrolled campaigns, channels and epochs. A failure during pre-dispatch persistence may leave the exposure consumed. The app assigns families and controls prior exposure beyond the ledger.

To install a new policy and roster in an enrolled campaign, call `openLearner` with the same lineage, a previously unused policy epoch and `startEpoch: { previousDefinitionDigest }` from the retained view. First settle existing work, reviews and inbox commands. Migration is available while waiting or when audit refresh is required. It keeps the ledger, cumulative budget, audit exposures, operation and decision history, command cursor and stop state. It discards queued teaching from the previous policy and starts a new per-epoch round allowance. Old handles are fenced by the new definition digest.

Legacy journals with unchanged custom adapters that omit selection policies can continue with campaign-local audit history. Already-dispatched work uses its original operation identity. On advance the controller applies retained admission replacements and binds provenance to prepared work. The current Acclimate adapter fails closed with `definition-conflict` for legacy journals whose selection thresholds were never bound. Preserve the checkpoint and evidence and settle or reconcile outstanding work under the original installation. Epoch migration requires preexisting shared lineage enrollment.

## Qualification

The qualification uses a disposable Rust service and PostgreSQL cluster. The runner creates its own scoped credentials and fresh workspace. It writes a `summary.json` and detailed evidence to the requested output directory.

- Two campaigns start from identical published bytes. They receive different approved corrections and their first releases improve different kinds of incidents on the same fresh inputs.
- The primary campaign retains a rejected development candidate, uses aggregate development results to revise the proposal under the same parent, and completes two separately audited reviewer releases. Its second release creates a new skill and updates the root instructions to reference it. The alternate campaign completes one separately audited reviewer release.
- The alternate roster offers a newly encoded cohort from a task family already exposed by the primary campaign. The runner verifies that the shared ledger skips it and claims a fresh family.
- A worker exits after its development report is accepted. Reopening reconciles the retained operation. The runner checks for seven service evaluations and seven comparisons across both campaigns.
- Duplicate observations deduplicate. The runner checks changed-definition, learner-promotion and stale-reviewer-revision refusals, and verifies that planted feedback stays outside teaching.
- Fresh jobs execute the released behavior. Previously resolved baseline and intermediate content preserve their pinned bytes and earlier behavior.

The domain runner executes deterministic task logic and an independent fixed grader. It makes **zero model calls** and **zero payment writes**. These results qualify recurring state, service integration and the synthetic task behavior; they do not establish live Codex learning, generalization or indefinite improvement.

Reproduce the recurring service qualification with a fresh output directory:

```sh
npm run qualify:learning -- \
  --pg-bin /opt/homebrew/opt/postgresql@18/bin \
  --output artifacts/continuous-learning/my-run
```

## Explicit limits and remaining work

The controller supports one owner per journal on a persistent local volume, one active operation, and a finite audit roster per policy epoch. The audit ledger covers campaigns that share the configured root on that volume. Semantic freshness, family grouping and external prior exposure remain integration responsibilities. The fixture supplies distinct audit inputs and withholds all audit answers from development teaching.

Hard monetary mode requires an installed adapter with an enforceable all-in maximum liability. The controller retains reservations and unknown cost, but cannot independently enforce an opaque provider's spending. The default service proposer cannot claim a fabricated hard bound. Its logical operation count is not a count of individual model requests or retries.

The app remains responsible for truthful outcomes, executable harness/configuration identity, grading, fixture isolation, tool permissions and feedback authority. Digests and locally retained job bindings are evidence identities, not execution attestation. The SDK validates the experiment graph and actual installed case values; an installed executor remains a trusted dependency.

Live Codex qualification of this recurring learner, Python controller parity, hosted/shared campaigns, authenticated console campaign projections, automatic release and executable harness evolution remain future work. Current console pages continue to show service versions, evaluations and releases; they do not automatically receive private campaign state.
