# Continuous learner implementation

The selected application-owned TypeScript profile is implemented in this checkout. It adds the Node-only `@acclimate/sdk/learning` entry without a database migration or a campaign HTTP service. The [wire/private contract](../../../contracts/learning.md), exported [types](../../../packages/sdk/src/learning/types.ts) and executable [starter](../../../examples/continuous-learning/README.md) describe current behavior. Specialist design documents retain sketches for broader profiles; their example names are not all literal exports.

## Implemented ownership

| Component | Behavior |
| --- | --- |
| [Evidence and admission](../../../packages/sdk/src/learning/admission.ts) | Canonical immutable artifacts; exact scope; separate outcomes, feedback and teaching permission; host-authorized correction references; resolved experiment and job bindings. |
| [Private store](../../../packages/sdk/src/learning/store.ts) | Owner-only canonical local directory, verified artifacts, atomic revision-checked checkpoints, process locks, durable deduplicated inbox and a separately serialized stop barrier. |
| [Controller](../../../packages/sdk/src/learning/controller.ts) | `submit`, `advance`, `inspect`; retained decisions, operation identities, budget reservations and audit exposure; one candidate under the published baseline; explicit uncertainty and release observation. |
| [Service adapter](../../../packages/sdk/src/learning/adapters/acclimate.ts) | Verified fixed-file proposal/publication; full private treatment/control graph; explicitly disclosed public commitments; exact retained creation recovery; existing evaluator journal reuse; comparison policy; read-only authorized promotion observation. |
| [Mutation planner](../../../packages/sdk/src/learning/mutations.ts) | Pure bounded original-parent edits and opt-in skill creation/retirement; final snapshot/native validation and explicit structural preflights. Publication is separate. The default service adapter remains fixed-file. |
| [Evaluation collection](../../../packages/sdk/src/evaluation/collection.ts) | Opt-in seeded balanced arm order, frozen public schedule commitment and retained actual collection bindings. Default descriptors/order and native job-binding format remain compatible. |
| [Service operation recovery](../../../src/commands.rs) | Existing operation lookup/close supports version creation with current `write` authority and retained marked mutation semantics. Changed bytes conflict; closing prevents later dispatch. |

`openLearner` verifies frozen installation identity and retained policy artifacts. The app supplies its adapter, admission policy, trusted feedback references, persistent directory and scheduler. Neither opening nor inspecting launches work. A changed definition is refused; there is no implicit campaign reset or policy migration.

Stop closes new admission immediately. A late result is retained without selection until resume; resume cannot erase a newer stop. Reopening reconciles existing work before starting another operation. A malformed recovery command is rejected without blocking a later stop, while failures after valid result retention preserve recoverable state and budget accounting.

The learner cannot promote. A separate authorized reviewer uses the existing channel API; the learner checks the observed promotion against the audited candidate, baseline, comparison and revision. Losing and incomplete evidence cannot authorize a release.

## Qualification

The qualification ran against the rebuilt Rust service and a disposable PostgreSQL cluster. The runner creates its own scoped credentials and uses a fresh workspace. It writes a `summary.json` and detailed evidence to the requested output directory.

- Three rounds in one retained campaign, including one retained rejected candidate and two separately audited reviewer releases.
- Five actual service evaluations and comparisons, eight operation admissions, two distinct committed audit datasets and zero known spend.
- A worker exits after its development report is accepted. Reopening reconciles the same operation once; no replacement evaluation is created.
- Duplicate observations deduplicate; changed definitions, learner promotion and stale reviewer revision are refused. Planted feedback is retained but excluded from teaching.
- Fresh jobs execute the released behavior; prepared baseline/intermediate bundles preserve their pinned bytes and earlier behavior.

The domain runner executes deterministic task logic and an independent fixed grader. It makes **zero model calls** and **zero payment writes**. These results qualify recurring state, service integration and the synthetic task behavior; they do not establish live Codex learning, generalization or indefinite improvement.

Validation passed for 298 tests in the broad package suite and 48 tests in the final focused learner and collection suite. Package and console typechecks, package build and installed tarball verification, Rust clippy with warnings denied, and seven PostgreSQL operation recovery tests also passed.

Reproduce the recurring service qualification with a fresh output directory:

```sh
npm run qualify:learning -- \
  --pg-bin /opt/homebrew/opt/postgresql@18/bin \
  --output artifacts/continuous-learning/my-run
```

## Explicit limits and remaining work

The initial controller supports one owner on a local persistent volume, one active operation and a finite frozen audit roster. It does not support distributed ownership, journal copying, live definition migration or installing new audit cohorts through resume. Roster exhaustion requires an explicit future migration design that preserves lineage, exposure and spend.

The controller prevents reuse of the same audit dataset digest, and the service adapter verifies that the chosen dataset matches that commitment. The integrating application's policy must still establish semantic freshness and independence, including task overlap and prior exposure outside this journal; distinct hashes alone cannot prove that. The fixture supplies distinct audit inputs, with audit answers excluded from development teaching.

Hard monetary mode requires an installed adapter with an enforceable all-in maximum liability. The controller retains reservations and unknown cost, but cannot independently enforce an opaque provider's spending. The default service proposer cannot claim a fabricated hard bound. Its logical operation count is not a count of individual model requests or retries.

The app remains responsible for truthful outcomes, executable harness/configuration identity, grading, fixture isolation, tool permissions and feedback authority. Digests and locally retained job bindings are evidence identities, not execution attestation. The SDK validates the experiment graph and actual installed case values; an installed executor remains a trusted dependency.

Live Codex qualification of this recurring learner, Python controller parity, hosted/shared campaigns, authenticated console campaign projections, automatic release and executable harness evolution remain future work. Current console pages continue to show service versions, evaluations and releases; they do not automatically receive private campaign state.
