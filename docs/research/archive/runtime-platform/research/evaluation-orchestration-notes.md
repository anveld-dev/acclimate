# Evaluation orchestration notes

**Archived proposal — superseded by the smaller content service.** [Current overview](../../../../design/overview.md).
**Research input · Proposed design · No runtime built yet**

For example, compare a candidate agent with the current baseline on the same set of tasks. Workers produce outputs, a trusted grader scores them, and a recorded decision uses the complete inventory, including failed or missing trials. None of this orchestration is implemented yet.

These notes inform the [evaluation contracts](../design/evaluation/contracts.md) and [orchestration spec](../design/evaluation/workflow.md). The [production contract](../design/runtime/production.md) and [roadmap](../design/roadmap.md) set the boundaries. RRSI is a reference, not an implementation claim: its [loop](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/loop.py) analyzes the incumbent, drafts and screens variants, evaluates survivors, selects, records history, and advances a frontier. It reuses saved evaluation files on resume. The production design below needs stronger identity and transactional guarantees than file existence alone.

## Records and frozen inputs

- **Campaign:** owner, scope, budget, deadlines, split-access policy, and predeclared measurement and decision rules.
- **Candidate:** immutable AgentVersion and build provenance, linked to its parent and proposal. A repair creates a new candidate.
- **Evaluation:** immutable experiment manifest binding candidate and baseline versions, task/split digest, grader and adapter versions, worker image, model configuration, price catalog, policy, sampling plan, and measurement window.
- **Trial slot:** unique expected unit, keyed by evaluation, version, task and replicate; include pairing/block assignment. Create all slots before dispatch.
- **Execution attempt:** one leased worker episode for a slot, with generation, effects, resource usage and outcome. Attempts do not create extra samples.
- **Grading attempt:** trusted grader's versioned assessment of a particular immutable execution output. A retry is an attempt, not another task trial.
- **Aggregate:** immutable calculation over an explicit slot inventory and grading results, including missingness, uncertainty, costs and guards.
- **Decision:** versioned policy and inputs, result and reason, separate for search and release. Retain rejected and inconclusive decisions.

Give each manifest a canonical digest and schema version. Cache reuse requires exact identity and authorized access, not a matching job name. A changed task, grader, image or package means new evidence. A comparison must record both versions and their shared conditions; matching package digests alone cannot establish comparability.

## Stages and recovery

Persist transitions for freeze and validate → create slots → reserve resources → schedule execution → publish outputs → grade → aggregate → decide. Each stage consumes committed outputs from the previous stage, is idempotent, and records failure and ownership. Commit artifact references only after verified upload. A crash after upload may leave an orphan; a crash after a committed grade must not trigger a second sample. Aggregate only a declared snapshot of slot outcomes; late reconciliation creates a new aggregate and decision rather than silently rewriting evidence.

Use database-time leases and increasing generations for worker claims. A stale worker cannot commit results or admit new effects. Cancellation or deadline stops new admissions, requests shutdown, and records whether containment was confirmed. An already admitted call may still finish; retain its unknown effect and cost until reconciled. Retrying a nonrepeatable tool action after a lost response can duplicate a write: block that slot for reconciliation unless the downstream contract supports safe recovery. Record all attempts, including superseded and late results, while selecting at most one authorized result per slot.

Campaign and project quotas must include baseline, candidate, grader, build and orchestration work, plus in-flight reservations. Bound concurrency, wall time, tokens, money, storage and output separately; unknown usage keeps a conservative hold. Exhaustion leaves unscheduled slots visible and the evaluation incomplete. Evaluation capacity and budget must not steal production reservations.

## Comparison and grading

Schedule baseline and candidate in balanced, preferably paired blocks across tasks and time windows, with order randomized under a recorded seed. A provider outage affecting only one arm can otherwise look like a regression. Predeclare bounded infrastructure reruns and apply them symmetrically; never retry only candidate failures until they pass. Repeat unchanged versions to estimate noise, retain sample sizes and uncertainty, and set a positive minimum tolerance before selecting. Record model response metadata and timing; a material provider/model drift can invalidate a comparison even when the configured model name is unchanged.

Keep expected slots in the denominator. Candidate crashes and timeouts are task failures under the declared rules; verified infrastructure failures make release evidence inconclusive, not invisible. A missing or malformed score, unavailable judge, or grader timeout is a **grading failure**, not a candidate failure. Preserve the execution output so a trusted grader can retry without rerunning the candidate when appropriate. Missing cost cannot prove savings; reject non-finite scores and costs and define zero-cost behavior explicitly.

The candidate sandbox must not control grading code, labels, hidden tests, or evaluator-owned records. It can produce untrusted output and artifacts only. Separate evolve access from development validation and sealed audit; audit access is logged and exposure triggers the declared rotation policy. The [RRSI domain interface](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/domain.py) supplies domain-specific execution and scoring hooks; this proposal puts those hooks behind explicit trust and access boundaries.

## External benchmarks and evidence

Support Python benchmarks through a versioned out-of-process adapter with bounded requests and responses, explicit task IDs, input/output artifact references, cancellation, exit status, and resource accounting. Pin its environment and protocol; validate its output as untrusted data. The trusted grader must independently own the score. A subprocess exit code alone is not a valid completed trial. Capture bounded raw stdout/stderr and structured results separately, preserve digests and provenance, and apply access and retention policies to potentially sensitive traces. Truncation or failed artifact publication must be visible to grading and aggregation.

RRSI's [evaluation](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/evaluate.py), [selection](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/selection.py), and [history](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/history.py) illustrate separate measurement, selection and per-edit history; bundled edits share a measurement, so that record alone does not establish individual causation. Use ablations before attributing a gain.

A release decision must bind the exact candidate, build provenance, experiment and aggregate digests, grader identity, gate policy, approver, and expected deployment revision. Search acceptance is only an input. Changed bytes, incomplete evidence, failed guards, incompatible runtime or an obsolete deployment revision block promotion; rerunning a decision with new evidence creates a new record.
