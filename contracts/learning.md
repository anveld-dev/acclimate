# Application-owned continuous learning

The Node-only `@acclimate/sdk/learning` entry implements the first profile of the [continuous-learning architecture](../docs/architecture/continuous-learning/README.md). It composes existing service interfaces; it does not introduce a hosted executor or a campaign HTTP resource.

## Public interface and ownership

`openLearner` installs a frozen campaign definition, explicit app adapters and private persistent directory. `submit(command, commandId)` durably queues evidence or control input; `advance({deadline, signal})` reconciles and admits bounded work; `inspect()` reads the retained state. Opening or inspecting a learner does not start a model. Campaign schema and evidence schemas are versioned independently of content bundle schema 1.

The app owns task outcomes, native execution, grader, correction authority and tool permissions. The learner owns durable admission/selection state, operation reservations and reconciliation. Acclimate owns immutable content/evaluation records and authorized channel promotion. The learner adapter observes a reviewer's exact promotion; it has no promotion operation and should be provisioned without the `promote` right.

## Private identities and disclosure

Immutable references identify exact canonical retained bytes using `{id, sha256, bytes}`. The private store validates ownership, regular files, canonical paths, artifact size/hash and checkpoint revision. Physical file paths and bearer credentials do not become public identities. Public experiment commitments require an explicit disclosure scheme; even a digest can disclose information about a low-entropy secret.

An experience, a host admission decision, a sanitized teaching view, a harness treatment, invariant controls and a comparison are separate records. Source labels inside a task are not admission authority. Both scope and configured feedback authority must match before a correction may teach. Full experiment graphs bind per-arm content and fixed installed runtime artifacts to invariant dataset/grader/collection controls. Evidence remains application-reported; storing a digest does not attest remote execution or prove causal benefit from a memory read.

## Durable service operations

Candidate publication (`POST /v1/projects/{p}/bundles/{b}/versions`) participates in operation lookup/close under the current `write` right, including retained marked mutations. A committed result is `VersionMetadata`; operation lookup does not grant extra content or promotion authority. Replays with changed bytes conflict; closed operations cannot dispatch; current authority is rechecked. This is additive support on the existing operation interface, with no new PostgreSQL schema.

The installed learner uses retained operation mutation transport for candidate/proposal/evaluation creation and the existing evaluator journals for execution/report recovery. A missing or closed recorded operation, an unknown external result, or a replay outside a supported retention contract cannot justify blind replacement model/native work.

## Budgets, stop and audits

Logical operation admission is not a count of raw model API requests: a service proposer may retry and a native turn may contain multiple calls. Hard monetary mode requires a qualified adapter's enforceable all-in maximum liability. Otherwise use explicit count/soft monetary policy and retain unknown cost; never infer zero cost from a rejected await.

Stop closes new admission before acknowledging its durable command. It does not claim already-admitted external work stopped. Resume cannot clear a newer stop, reset a reservation, or erase uncertainty. Invalid input is retained/rejected without granting authority or permanently blocking subsequent inbox commands.

The campaign retains a finite roster of audit cohorts and consumes exposure before launch. Protected audit results are not development teaching input. Audit exhaustion stops further audited release work; fresh policy/roster installation requires an explicit migration rather than ordinary resume. Each first-profile candidate is a direct child of the round's published baseline. Search acceptance and audit completion never authorize release; current parent and expected channel revision still govern the reviewer's promotion.

## Qualification

The [recurring learner starter](../examples/continuous-learning/README.md) provides a deterministic, disposable Rust/PostgreSQL qualification with an actual worker-process exit after report acceptance, retained rejection, two separately audited releases, scoped reviewer credentials, and fresh-versus-pinned delivery checks. It makes no model calls and does not mutate an existing workspace. Native model behavior is an additional application qualification, not implied by these state-machine tests.
