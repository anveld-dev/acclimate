# Application-owned continuous learning

The Node-only `@acclimate/sdk/learning` entry provides the [application-owned learner](../docs/architecture/continuous-learning/README.md) and the app-side evaluator driver for service-managed connected learning. The application-owned learner composes the service's existing content and evaluation interfaces while keeping campaign state private.

## Public interface and ownership

`openLearner` installs a frozen campaign definition, explicit app adapters and private persistent directory. `submit(command, commandId)` durably queues evidence or control input; `advance({deadline, signal})` reconciles and admits bounded work; `inspect()` reads the retained state. Opening or inspecting a learner does not start a model. Campaign schema and evidence schemas are versioned independently of content bundle schema 1.

The app owns task outcomes, native execution, grader, correction authority and tool permissions. The learner owns durable admission/selection state, operation reservations and reconciliation. Acclimate owns immutable content/evaluation records and authorized channel promotion. The learner adapter observes a reviewer's exact promotion; it has no promotion operation and should be provisioned without the `promote` right.

## Private identities and disclosure

An adapter can supply separate development and audit `selectionPolicies`. The learner retains the exact policy artifacts, binds their digests to the installation, and checks that a selection verdict identifies the policy for its stage. The Acclimate adapter applies these policies. Generic adapters that omit them continue to own their selection decisions.

Immutable references identify exact canonical retained bytes using `{id, sha256, bytes}`. The private store validates ownership, regular files, canonical paths, artifact size/hash and checkpoint revision. Physical file paths and bearer credentials do not become public identities. Public experiment commitments require an explicit disclosure scheme; even a digest can disclose information about a low-entropy secret.

An experience, a host admission decision, a sanitized teaching view, a harness treatment, invariant controls and a comparison are separate records. Source labels inside a task are not admission authority. Both scope and configured feedback authority must match before a correction may teach. Full experiment graphs bind per-arm content and fixed installed runtime artifacts to invariant dataset/grader/collection controls. Evidence remains application-reported; storing a digest does not attest remote execution or prove causal benefit from a memory read.

## Durable service operations

Candidate publication (`POST /v1/projects/{p}/bundles/{b}/versions`) participates in operation lookup/close under the current `write` right, including retained marked mutations. A committed result is `VersionMetadata`; operation lookup does not grant extra content or promotion authority. Replays with changed bytes conflict; closed operations cannot dispatch; current authority is rechecked. This is additive support on the existing operation interface, with no new PostgreSQL schema.

The installed learner uses retained operation mutation transport for candidate/proposal/evaluation creation and the existing evaluator journals for execution/report recovery. A missing or closed recorded operation, an unknown external result, or a replay outside a supported retention contract cannot justify blind replacement model/native work.

## Candidate search and release

With `maximumDevelopmentAttempts` configured, a rejected development result can be followed by another proposal for the same admitted observation and baseline. The default is one development evaluation per observation. An adapter with a frozen `developmentControlsDigest` can receive up to five aggregate failed, rejected or indeterminate development results in proposal work. The history is scoped to the installation, sanitized teaching text, development controls, baseline version and channel revision. It carries candidate identities and pair counts. The service proposer also receives bounded before/after excerpts of prior verified edits on allowed paths. Case identities, raw grades, audit results and reviewer outcomes stay outside this feedback.

New operations and release reviews bind the original admission decision, teaching view, authorized use, mutation policy, compatibility obligations and replacement references. A validated replacement retires queued lessons and fences a superseded active lesson from future selection. A `decline-release` command binds the exact pending review and records the reason. Late results and spent audit exposures remain retained.

The fixed-file proposal remains the default. The Acclimate adapter's optional `mutation` profile accepts a pure deterministic `MutationV1` proposer and installed preflight checks. It verifies the admitted policy artifact, plans against the exact verified parent bytes, and checks the complete candidate before issuing the existing version creation request. Structural operations require an explicit reference review preflight. Successful receipts retain a reference to the private preparation artifact for the exact mutation and plan.

## Budget and stop

Logical operation admission is not a count of raw model API requests: a service proposer may retry and a native turn may contain multiple calls. Hard monetary mode requires a qualified adapter's enforceable all-in maximum liability. Otherwise use explicit count/soft monetary policy and retain unknown cost; never infer zero cost from a rejected await.

Stop closes new admission before acknowledging its durable command. It does not claim already-admitted external work stopped. Resume cannot clear a newer stop, reset a reservation, or erase uncertainty. Invalid input is retained/rejected without granting authority or permanently blocking subsequent inbox commands.

Applied inbox entries can be compacted after their receipts are archived. A duplicate command ID with identical bytes still returns the original receipt. Changed bytes under that ID conflict. Stop, resume and uncertainty resolution have separate retained inbox capacity so ordinary evidence submissions cannot exhaust it.

## Audit exposure and policy epochs

The campaign retains a finite roster of audit cohorts and consumes exposure before launch. Set `auditLineageDirectory` to the same private local root for all campaigns sharing a project and bundle. Each shared-lineage cohort registers canonical task input digests and application-assigned family fingerprints. The Acclimate adapter verifies the dataset and registered task input digests against the resolved experiment. The ledger prevents reuse of a cohort, case or family across enrolled campaigns, channels and policy epochs. An interruption after the claim can consume exposure even if the audit never runs. The application remains responsible for consistent family assignment and exposure outside that ledger.

Audit exhaustion stops further audited release work. Open an enrolled campaign with `startEpoch: { previousDefinitionDigest }`, a new policy epoch and a fresh roster to explicitly replace the frozen definition. The journal must have no outstanding operation, pending review or unapplied inbox command and must be waiting or blocked for audit refresh. The migration retains operation and decision history, budget totals, audit exposures, command cursor and stop state. It starts a new round allowance and clears queued teaching from the old policy epoch. The earlier installation can no longer submit or advance work. Resume only changes the stop state.

Legacy journals using unchanged custom adapters without bound selection policies can reopen and keep their retained operations, reviews and campaign-local exposure history. The current Acclimate adapter refuses legacy journals without verifiable selection thresholds with `definition-conflict`. Keep the checkpoint and evidence, and use the original installation to settle or reconcile outstanding work. Epoch migration requires existing enrollment in the same shared lineage. Each candidate is a direct child of its round's published baseline. The reviewer remains subject to the channel's current-parent and expected-revision requirements.

## Qualification

The [recurring learner starter](../examples/continuous-learning/README.md) exercises two independent feedback conditions from identical baseline bytes against a disposable Rust/PostgreSQL service. It includes a worker-process exit after report acceptance, bounded development retry, separately audited reviewer releases, and fresh-versus-pinned delivery checks. The task runner makes zero model calls and zero payment writes. The fixture covers deterministic application behavior and service integration. Live model behavior requires its own qualification.

## Service-managed connected learning

The service-managed workflow uses `/v1/projects/{project}/integrations/{integration}/learning` as its base resource. This enrollment provides the authority for the service to schedule recurring rounds while the installed application retains execution and grading.

| Method and suffix | Operation |
| --- | --- |
| `PUT` | Enroll the enabled connection with an installation ID, permitted existing paths, bounded proposal allowance, public development and audit descriptors, rollout mode, and separate outcome/evaluator principals. An update may change `automaticRollout` and `automaticRollback`. Other enrollment controls remain frozen. |
| `GET` | Read enrollment, remaining audits, delivery target, and recent round references. Each round exposes `fieldAudits` with `windowSize`, `regressions`, and `rollbackPromotionId`. Audit descriptors are available to authorized administrators. |
| `POST /outcomes` | Submit a terminal `completed` or `failed` outcome with stable UUID, delivered version ID, digest, and optional bounded teaching instruction or graded expected/observed discrepancy. The enrolled outcome principal owns the write. Identical outcome replay retains its original identity. Optionally supply both `startedReceiptId` and `deliveryRevision` for a field audit. |
| `GET /work` | Read outstanding evaluation request IDs and phases for the enrolled evaluator principal. The installed evaluator loads the normal request and executes its matching descriptor. |
| `POST /rounds/{round}/review` | Record an authorized approval or rejection of a qualifying audited candidate. An approval uses the exact audit comparison and the current enrolled delivery baseline. |
| `POST /field-audits` | Submit one independently graded verdict per served job for the current learned rollout. The enrolled evaluator principal owns the write. |
| `POST /renew` | Append independent audit cohorts or increase the proposal admission allowance using a stable renewal UUID and the current renewal revision. Prior cohorts and consumed exposure are retained. |
| `POST /stop` | Close admission, field auditing, and future rollout or automatic rollback while keeping the current delivery target. |

Connection-qualified content reads use `X-Acclimate-Integration-Id` with the integration UUID. A scoped content credential can identify its connection directly. Resolution returns the original logical channel, the enrolled delivery target's revision and version, and an opaque conditional ETag. An enrolled update only changes that connection's delivery target; other connections and existing prepared jobs retain their own content.

`automaticRollback` defaults to true for new enrollments, and migration initializes existing enrollments to true. Set it to false to opt out. Omitting the field on an enrollment update preserves the stored value.

An enrollment update may include `expectedAutomaticRollout` to check the current rollout setting. The service returns a conflict if that setting has changed since the caller read it.

A field-audit outcome requires a matching nonstale channel-started receipt that the service received within the previous 30 days. The service matches project, bundle, connection, version, digest, logical channel, and delivery revision. The receipt can come from a verified network or cache delivery. When the delivered version and revision match the current managed rollout, the outcome response includes `fieldAudit: { parentVersionId, parentDigest }`. Ordinary outcome eligibility for proposal scheduling is separate.

The evaluator submits `outcomeId`, `startedReceiptId`, `versionId`, `digest`, `revision`, `parentVersionId`, `parentDigest`, and `verdict` (`pass` or `regression`). `revision` is the same canonical decimal string as `deliveryRevision`. The service checks the exact managed promotion and its predecessor against the bound outcome. A response contains `outcomeId`, `accepted`, `windowSize`, and `regressions`, with `rollbackPromotionId` if the verdict triggered rollback. An identical retry returns the stored response. Changed verdicts, reused receipts, stale revisions, and disabled connection authority reject a new verdict.

The service counts the latest ten accepted verdicts in the current rollout's submission order. If automatic rollback is enabled and at least three are regressions, the verdict and connection-scoped promotion restoring the preceding version commit together. Disabling automatic rollback keeps recording verdicts. The restored version has a new delivery revision.

Run the application-side evaluator and terminal reporting hook as described in [Evaluator operations](../docs/evaluator-operations.md#serve-connected-learning). See the [operator guide](../deploy/README.md#monitor-and-roll-back-a-release) for sampling, evidence, and recovery.
