# Persona review: evaluation researcher

This is a simulated, source-based developer review, not observed user research or a live product test. Reviewed on 2026-11-16. No model calls, service mutations, or browser sessions were performed.

## Persona and job

I own evaluation quality for an existing agent application. I need to compare a proposed instruction/skill change against its parent on saved tasks, separate behavior failures from infrastructure failures, inspect regressions with colleagues, and explain why a release is justified. I expect to keep execution and credentials in my application. I do not expect Acclimate to host my agent.

## Journey

1. Read `examples/evaluation/README.md`: understand that creating an evaluation request freezes intent and does not execute anything.
2. Select “My app's installed evaluator” in the console. Discover I must supply public JSON containing revision strings, runtime identity, and the expanded case/repetition inventory (`apps/console/src/components/improvement-workspace.tsx:861–897`).
3. Implement callbacks and a descriptor. The public SDK has `compare` and request lifecycle methods, while the complete `InstalledAdapter`/`runEvaluation` implementation lives under `examples/evaluation`.
4. Run paired executions with fixed snapshots and settings. The helper verifies parentage/digests and keeps missing grades and execution failures explicit.
5. Return to the console to inspect paired means, higher/lower reward cases, errors, and provenance. To inspect the actual saved responses, return to the evaluator machine and locate private output files.
6. Make the release decision myself. Completion describes evidence coverage, not whether the candidate passed a quality threshold.

## Findings

### 1. P1 — The durable custom-evaluator integration is not a packaged SDK capability

**Type:** integration/authoring friction.

The docs invite applications to supply an `InstalledAdapter` to `runEvaluation` (`examples/evaluation/README.md:46`), but those interfaces and the durable runner are implemented in `examples/evaluation/adapter.ts:6–13` and `examples/evaluation/runner.ts:50–152`. SDK exports contain the lower-level `compare`/`submitComparison`, not the runner or adapter (`packages/sdk/src/index.ts:11–18`); the SDK package ships only `dist` (`packages/sdk/package.json:19–21`). The checkout CLI allowlists three built-in adapters (`scripts/evaluate-app.ts:25–28`).

**Impact:** my first real evaluation requires copying repository internals, retaining a checkout dependency, or rebuilding lifecycle ownership/recovery around public API calls. The example with the most operational safeguards is the least directly reusable integration surface.

**Recommendation:** ship a supported evaluator package/subpath with adapter types, descriptor generation, durable run lifecycle, and an application-local CLI registration recipe. Keep execution selection under application control.

**Acceptance:** an external application installs the packaged SDK/evaluator, defines one custom executor and grader, creates and finishes a bound request, and recovers a lost submission response without importing Acclimate repository paths.

### 2. P1 — Saved output references do not provide a shared regression-debugging workflow

**Type:** missing collaboration/diagnosis capability.

The runner persists execution data locally and submits a `file://` reference (`examples/evaluation/runner.ts:123–127`; `examples/evaluation/journal.ts:113–118`). The case detail renders `outcome.outputRef` as text (`apps/console/src/components/evaluation-pair-row.tsx:40–43`). The wire outcome contains a scalar reward, statuses, error, usage and reference, not grader rationale or execution trace content (`packages/sdk/src/types.ts:81–88`).

**Impact:** a colleague sees “lower reward” but cannot inspect the response or grader reasoning from the review. A private path on a developer laptop or ephemeral CI runner is not a durable, portable evidence destination. This is particularly painful when the grader produces a valid low reward without an error string.

**Recommendation:** document and support an application-owned artifact manifest/export workflow with redaction, integrity metadata, and authorized retrieval. Local private files remain a valid default; do not silently upload them or make arbitrary supplied URLs executable.

**Acceptance:** a reviewer on another machine can inspect an explicitly shared parent/candidate response and grader explanation associated with the exact case and version, while private/unshared outputs remain unavailable and clearly identified.

### 3. P1 for long/expensive evals — Mid-run process loss strands already executed work

**Type:** operational limitation, not an unsafe replay bug.

The runner writes an execution marker before callbacks, then saves the report only after the full `compare` resolves (`examples/evaluation/runner.ts:116–132`). A subsequent invocation refuses to execute when the marker exists without a complete report (`examples/evaluation/runner.ts:98–99`). Individual execution outputs are retained, but the journal schema has no per-outcome graded checkpoint (`examples/evaluation/journal.ts:13–26`). The wrapper also fixes `concurrency: 1` and `gradeRetries: 0` (`examples/evaluation/runner.ts:122`), despite configurable primitives in `compare`.

**Impact:** a runner termination near the end of a large evaluation forces interruption and a new request. Completed paid work is not automatically turned into reviewable partial evidence or resumed from safe checkpoints. The recovery guarantee handles lost lifecycle responses, not arbitrary mid-execution restart.

**Recommendation:** expose progress and configurable concurrency/time limits; add durable per-outcome checkpoints and a conservative recovery path that can preserve completed grades without replaying ambiguous executions. Mark an in-flight unknown outcome explicitly rather than claiming exactly-once execution.

**Acceptance:** terminate a runner after several completed pairs; recovery retains and exposes those exact completed outcomes and does not silently rerun any execution whose completion is unknown.

### 4. P2 — A single unnamed reward makes realistic evaluation semantics application glue

**Type:** missing analysis metadata, not a demonstrated scoring bug.

`GradeResult` returns only `reward` and optional `error` (`packages/sdk/src/compare.ts:29–32`). The persisted outcome similarly has one reward (`packages/sdk/src/types.ts:81–88`). The scorecard averages all comparable expected case/repetition rows equally (`apps/console/src/lib/evaluation-score-summary.ts:8–19`); case labels describe higher/lower reward (`apps/console/src/lib/evaluation-pairs.ts:4–10,35–42`).

**Impact:** my correctness, safety, rubric components and business-critical slices must be collapsed into one scalar or kept outside the product. There is no first-class description of the reward scale, aggregation weights, or rationale. More repetitions of one case also increase that case's contribution to the displayed mean. Developers must normalize metrics themselves; raw latency/error counts are not self-describing rewards.

**Recommendation:** initially add metric name, scale/direction documentation, aggregation semantics, and optional structured grader explanation/component metadata. Clearly state whether the summary is per repetition or per distinct case. Additional metrics can remain application-defined.

**Acceptance:** two evaluators with different reward scales disclose their semantics; a mixed-repetition dataset shows its aggregation rule; a reviewer can distinguish “higher scalar reward” from a specific safety or correctness pass.

### 5. P2 — Revision identity is asserted, but reproducibility depends on developer discipline

**Type:** provenance authoring burden, consistent with the app-owned trust boundary.

The descriptor carries dataset/grader revision strings, runtime strings and case identities (`examples/evaluation/descriptor.ts:2–7`). Structural matching checks those values (`examples/evaluation/adapter.ts:22–30`). `compare` clones snapshots/settings for paired isolation (`packages/sdk/src/compare.ts:130–156`) but emits revision strings, runtime, inventory and outcomes, not hashes of the snapshot/settings or grader code (`packages/sdk/src/compare.ts:277–287`). The sample dataset and grader use hand-written revision strings (`examples/service-proposer/dataset.ts:2`; `examples/service-proposer/grader.ts:1`). The contract explicitly calls reports immutable app assertions (`contracts/IMPLEMENTATION.md:13`).

**Impact:** changing a saved task or rubric without bumping a label can produce nominally identical experiment identities across materially different runs. Bundle bytes are verified strongly, while experiment-input reproducibility requires additional application conventions.

**Recommendation:** provide a helper that derives a canonical public descriptor and content digests from an application-retained case/settings manifest, plus a recommended grader/build revision convention. Keep private snapshots and expected answers in the application.

**Acceptance:** modifying a case snapshot, settings or grader revision changes the generated experiment identity; unchanged inputs produce the same identity; the private manifest can reconstruct what was evaluated.

### 6. P2 — Stochastic release decisions require external uncertainty analysis

**Type:** advanced research feature gap, not false statistical reporting.

The score summary calculates paired means and counts, with no uncertainty estimate or effect threshold (`apps/console/src/lib/evaluation-score-summary.ts:6–33`). The scorecard correctly reports its denominator, partial status and excluded outcomes, and explicitly warns that complete evidence alone is not a win or release approval (`apps/console/src/components/evaluation-scorecard.tsx:27,65–96`). History also surfaces higher/lower/same counts (`apps/console/src/components/evaluation-history-view.tsx:133–167`). The native sample contains two cases with one repetition each (`examples/evaluation/descriptor.ts:50`).

**Impact:** small stochastic mean changes need a separate notebook/export step before I can defend a quality claim. Case/repetition count is not equivalent to independent sample size: repetitions of the same task are clustered, so a naive per-row confidence interval would be misleading.

**Recommendation:** start with an explicit “descriptive observation; uncertainty not estimated” explanation and an analysis export. If adding intervals, make the statistical unit and clustered/paired method explicit, show distinct-task counts, and keep app-owned minimum-effect/release policies separate from evidence completeness.

**Acceptance:** a tiny stochastic run does not imply statistical confidence; an exported report supports paired, task-aware analysis; any future interval describes its assumptions and never converts missing outcomes to zeros.

## Strengths to preserve

- Frozen inventory, verified parent/candidate digests, isolated snapshot/settings clones, and exact attempt binding make paired evidence substantially more trustworthy than an unstructured before/after demo.
- Execution and grading failures are separate. Missing is not zero; gradeable task failures remain included. Partial evidence remains visible.
- Grader retries in the lower-level helper regrade cloned saved outputs instead of rerunning execution (`packages/sdk/src/compare.ts:230–258`).
- Public configuration contains identities rather than executable code or credentials; the application retains execution control.
- Idempotent lifecycle keys, exclusive journal ownership, and refusal to replay ambiguous executions are valuable safeguards. Improve recovery without weakening them.
- Completion is correctly defined as inventory/grading coverage, including a fully scored losing candidate. Release remains an explicit human decision.

## Verification and limits

Inspected current TypeScript SDK, installed runner/journal, descriptors, sample dataset/grader, Rust comparison validation, public contract, and console score/history/detail source. No applicable `AGENTS.md` was found by the repository search.

Attempted `node --import tsx --test packages/sdk/tests/compare/compare.test.ts examples/evaluation/runner.test.ts apps/console/tests/evaluation-score-summary.test.ts`. All three test files failed before execution because `tsx` is not installed in this checkout (`ERR_MODULE_NOT_FOUND`); this is not evidence that the tests or implementation fail. No dependencies were installed. Browser rendering, live quality, service lifecycle behavior, and a remote artifact store were not exercised. No scoring correctness defect was established by this review.

## First three changes I would request

1. Package and document the durable custom-evaluator path, including generated descriptors.
2. Make shared, authorized output/grader artifacts a supported review workflow.
3. Specify reward semantics and aggregation clearly, then support task-aware uncertainty analysis/export. Preserve the current honest completion and missingness language.
