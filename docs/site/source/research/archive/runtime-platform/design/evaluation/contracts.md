# Task and score contracts

**Archived proposal — superseded by the smaller content service.** [Current overview](../../../../../design/overview.md).
[Design guide](../README.md)

**Proposed implementation reference.** [How evals run](workflow.md) explains the sandbox and grading flow. This page defines the planned records and plugin interfaces.

## A concrete comparison

For a PR with one known retry bug, an illustrative rubric could award `1` for a correct, supported finding and `0` for missing it. False-positive limits and required checks are declared separately. The grader reads the saved review and private expected finding; the agent cannot read that answer key.

With two equally weighted PRs, scores `[1, 0]` give v1 a mean of `0.5`; `[1, 1]` give v2 `1.0`. Those are made-up examples, not benchmark results or enough samples to justify release. If a judge failed on the second PR, report a missing grade and an incomplete comparison—not a valid zero for the agent.

The domain author supplies the saved task and collects its output; a separate grader author supplies the rubric and private answer. Freeze rubric, weights, repetitions, limits, versions, and conditions before execution. Both versions start from identical file/service snapshots with separate writable state. If comparing harness families as well as prompts, declare that broader experiment question.

## The records

| Record | Required content |
| --- | --- |
| DatasetVersion | Task/split inventory, file/service fixture digests and reset recipe, expected weights, resource needs, access rules, and lineage. |
| TaskSpec | Candidate-visible input/fixture refs, private service-state recipe, output paths/schema, limits, weight, and required checks. |
| EvaluationManifest | Versions being compared; dataset, repetitions/pairs, image/adapter/plugin/model/config identities; policies, grader, prices, budgets, measurement window, and aggregation/decision revisions. |
| TrialSlot | Unique evaluation/version/task/repetition, pairing block, and expected weight. Created before scheduling. |
| ExecutionResult | Slot/attempt identity, actual runtime observations, status, output/log/checkpoint refs, usage/cost completeness, unresolved effects, timing, and provenance. |
| GradeResult | Exact execution-result digest, grader/rubric/runtime revision, reward, required-check results, supporting evidence, judge usage/cost, and status. |
| Aggregate | Explicit slot/result/grade snapshot, scores/costs/uncertainty, expected/missing counts, checks, completeness, and calculation revision. |

An **arm** is a label such as `baseline` or `candidate` mapped to an immutable AgentVersion. Retries change attempts, not slot identities or sample counts. References resolve only under the caller's scope.

## Domain and grader interfaces

| Plugin method | Responsibility |
| --- | --- |
| `domain.describe` | Declare task input/output schemas and supported profiles. |
| `domain.prepare` | Stage only task-visible files/services and return declared output paths/schema before execution. |
| `domain.collect` | Read scoped references to already host-captured bytes; return a submission manifest and structural findings. No direct trial-filesystem or answer-key access. |
| `grader.describe` | Declare score/check schemas and runtime requirements. |
| `grader.grade` | Score one saved execution result using authorized grading inputs. Return evidence, not a deployment decision. |

These operator-installed plugins use [the process envelope](../integrations/protocol.md#transport-and-identity), `plugin.initialize`, scoped contexts, and stable command IDs. Setup and grading jobs have separate identities/ownership. The host confirms the sandbox has stopped, captures declared paths with size/path checks, then invokes collection. It validates returned references and commits the ExecutionResult. Collection infrastructure failures retry over the same capture; invalid candidate output follows the failure rubric. Role checks reject unrelated session, grading, or deployment calls. Plugins cannot fan out their own untracked trials or change inventory/weights.

By default, a Python benchmark supplies case setup and grading while the harness adapter executes the agent. A benchmark-owned agent loop requires a qualified runner adapter in place of that execution step; it doesn't run alongside a second agent. Imported results without qualified provenance remain diagnostic.

### Trust and grading

The worker validates scores and commits them under grader identity. Candidate content cannot edit the grader, private labels, answer keys, or score records. Collection bounds paths, bytes, and parsing. Submitted code runs in a separate test sandbox, never in the trusted grading controller. [The walkthrough](workflow.md#setup-execution-and-grading) states what hidden tests can actually keep private.

A grader may use deterministic checks, a tool-free model judge, or a pinned composition. Treat candidate text as untrusted evidence in judge prompts. Validate structured output and test score-manipulation attempts; these controls do not prove injection resistance. Include all judge costs.

Model judges use job-scoped `host.request_model` through the gateway. Stable grading-job/step IDs survive attempts. Apply task-effect admission, holds, fencing, saved-outcome barriers, and usage reconciliation. A retry reuses recorded outcomes or reconciles uncertainty; it cannot silently resample. Planned independent judge samples get distinct IDs in the frozen grading plan. No production-session, tool, or release authority is granted by default.

## Execution versus grading failures

| Outcome | Treatment |
| --- | --- |
| Wrong answer, candidate crash, task timeout, or malformed submission | Grade under the declared failure rubric; keep the slot. |
| Verified worker/provider/fixture infrastructure failure | Inconclusive; bounded, balanced rerun policy. |
| Judge unavailable, timed out, or invalid | Preserve output; retry grading without rerunning the agent when safe. |
| Cancellation, exhausted budget, or campaign deadline | Incomplete; missing slots remain visible. |
| Unknown action or usage | Retain uncertainty and holds; no guessed success, free cost, or blind repeat. |

The trusted worker classifies failures from evidence, not a candidate-supplied label.

## Scoring and completeness

A valid quality aggregate requires every required reward to be resolved, including declared task-failure grades. It is weighted reward sum divided by full expected weight. A zero-filled calculation with missing grades is diagnostic and incomplete.

Example: weights `[1, 3]` and rewards `[1, missing]` do not produce a valid score. The diagnostic lower-bound value is `1/4 = 0.25`, with missing weight `3/4`; it cannot support selection or release. An outage cannot become a valid candidate-failure grade.

Validate finite rewards in `[0,1]`, required checks, nonnegative usage/cost, units, and matching identities. Track execution, grading, usage, and decision validity separately. Known zero cost is valid; unknown cost is not zero.

The manifest declares the selection cost metric. Keep runtime tokens/dollars/latency separate from campaign overhead; both still count toward spend. Critical check failures cannot be offset by a better average. Missing slots, unresolved grading, unknown required cost, and incompatible conditions block release evidence, apart from explicitly declared valid task-failure treatment.

## Data access and reuse

Search can read authorized development data and bounded traces. Audit data/results stay outside proposer access; log and limit probes, and rotate exposed cases.

V1 reuses execution only to resume the same slot in the same frozen evaluation. No cross-evaluation execution cache. Read-only fixture caches require matching identity/access rules.

A revised grader may regrade saved outputs under a new derived evaluation applying to all versions. Preserve lineage and old grades; this adds measurement evidence, not independent execution samples. Changing a rubric after seeing results is a new experiment, not an overwrite.
