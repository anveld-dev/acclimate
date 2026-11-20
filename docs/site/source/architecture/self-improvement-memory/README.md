# Self-improvement memory

This folder is the paper-first design for rebuilding Acclimate's learning around the loop in [arXiv 2611.18856, "Self-Improvement Memory Enables Continual Recursive Self-Improvement"](https://arxiv.org/abs/2611.18856). It replaces an earlier design that layered five candidates onto today's statistical gates. That design's research is kept in [decisions.md](decisions.md#superseded), and its conclusions are superseded where they conflict with the maintainer decisions D1 to D10.

The paper wraps a fixed policy model M in a harness H: the prompts, tools, control flow and memory that an Acclimate bundle delivers. A setting σ = (M, X) has an evolve split X_evo and a disjoint held-out split X_eval. Only evolve feedback reaches the optimizer. Each round, the proposer writes five candidates from the harness, the feedback, the run history and a **Self-Improvement Memory (SIM)**. The selector screens the candidates before any of them runs, the survivors are scored on the evolve split, and the selector adopts one of them or keeps the current harness. Only the adopted candidate is written back to memory. The version kept after the round is scored on the held-out split for reporting only.

Acclimate becomes two things: **this loop**, and **versioned delivery**. The loop is always on for an enrolled bundle (D2). An adopted candidate is released to the bundle's learning channel at once (D3). No statistical gate, audit, review or field check stands between the selector and the release.

## Today and paper-first

| Area | Today | Paper-first |
| --- | --- | --- |
| Scope | Connected learning per connection, with a private delivery channel per connection | One loop per workspace + bundle. Adopted versions release on the bundle's learning channel. |
| Trigger | A round is admitted when an app's correction is queued | Rounds run back to back while the loop is `running`. Corrections become evolve cases (D4) and never start a round. |
| Candidates | One proposal per round, a critic call and one repair | Five proposer samples per round, each with a diagnosis and predicted case IDs written before evaluation |
| Screening | Scanner, then a separate critic model on the one candidate | Scanner on every sample, then one selector screen over all samples before anything runs |
| Evaluation | Paired comparisons (candidate against parent) for the step, the cumulative check, A/A calibration and single-use audits | The incumbent and each survivor are each scored on the evolve split, 5 rollouts per case, with per-case scores, traces and errors |
| Decision | Statistical step, cumulative and audit gates, then automatic rollout or human review | The selector adopts one evaluated candidate or keeps the incumbent. Adopt is release. |
| Held-out data | Single-use audit cohorts reserved per release, gating it | One fixed held-out split in the evaluator's own store, scored every round for monitoring only |
| Optimizer input | Corrections, lessons and a bounded `priorAttempt` history (12 rounds, 8 KB) | The whole bundle, evolve feedback with traces and errors, the full run history in the current setting and the full SIM, with nothing truncated |
| Edit scope | `permittedPaths`, skill-package authorization, a growth cap | Any bundle file can be edited, created or deleted |
| Models | A proposer model and a separate critic model | One optimizer model for the proposer and the selector |
| Principals | Separate outcome and evaluator principals in separate trust domains | One app principal per loop |
| After release | Field audits, field windows, requalification, automatic rollback, restore targets | Nothing. Auto-revert is an open question. |
| Manual product | Drafts, public proposals, manual comparisons, policy receipts, compare and promote CLI, a GitHub Action | Removed (D8) |

## What is removed

[removal.md](removal.md) lists every file, table, route, setting, SDK entry and console surface that goes, and the order it goes in. In summary:

- **Statistical machinery (D7):** A/A calibration, repetition planning, power and MDE projections, selection policies v1 to v3, the step, cumulative, audit and 99% gates, policy epochs and renewals, the parent cache.
- **Held-out and field machinery (D7):** single-use audit cohorts and their reservation, the development chain and its delivery split, field audits and windows, requalification, restore targets, automatic field rollback, incident replays, rechecks, and delivery receipts used for field sampling.
- **Admission and authority (D7):** lessons, admission allowances, correction attempts and refunds, separate outcome and evaluator principals, `permittedPaths`, skill-package authorization, the growth cap, the separate critic model, human review (`awaiting_review`, the review route, policy override receipts) and budget limits.
- **Manual product (D8):** the public proposals API, drafts, manual comparisons and evaluation requests, compare and `--policy` quality gating, the GitHub Action and CI wrapper, policy receipts, the operator CLI, and SDK code that exists only for manual comparison and gating (policy, statistics, planning, analysis).

Kept: workspaces, auth, invitations, machine tokens, bundles, immutable versions, channels and delivery, SDK fetch, cache, verify and prepare, the native plugins, the evaluator runner (now scoring the evolve and held-out splits), the secret and PII scanner, untrusted-data fencing, and a console for workspaces, bundles, connections and the loop.

## Reading order

1. [decisions.md](decisions.md): D1 to D10, what each earlier decision became, the paper readings, the deliberate deviations from the paper, which external review findings still apply, and how the review of this rewrite was resolved.
2. [loop.md](loop.md): the round state machine, the worker, `advance_round`, the adopt transaction, pause and stop, cancellation, deadlines and crash recovery.
3. [optimizer.md](optimizer.md): the optimizer model, the call task and its error codes, proposer input and output, the eight rules, the selector's screen and select calls, run history, the scanner, fencing and the `learning_candidates` definition.
4. [memory.md](memory.md): the SIM tables, problem resolution, attempt outcomes, rendering, pinning and the append lock.
5. [evaluator-and-contracts.md](evaluator-and-contracts.md): the evolve and held-out splits, outcomes as evolve cases, the work feed and reports, routes, wire types, the SDK runner, the console and the contract text.
6. [removal.md](removal.md): everything removed, with migrations and the order that keeps the repository building.
7. [experiment.md](experiment.md): conditions from bundle setup, splits, the primary contrast, the driver and the paper-sized plan.

## Names

Every other file in this folder uses these names. A file that needs a new name adds it here first. In the database a workspace is `project_id`, as it is today.

### Paper symbols

| Paper | Acclimate |
| --- | --- |
| Harness H_t | The bundle version at the head of the learning channel when round t starts (`learning_rounds.parent_version_id`) |
| Policy model M | `setting.policyModel` |
| Setting σ = (M, X) | The loop's `setting` (`{domain, benchmark, policyModel}`) with its evolve revision and held-out digest |
| Evolve split X_evo | The **evolve split**: rows of `learning_evolve_cases` live at `evolve_revision` |
| Held-out split X_eval | The **held-out split**: cases in the evaluator's own store, committed by `heldOut.digest` |
| Feedback F_t | `feedback`: the incumbent's evolve evaluation |
| Run history D_t | `history`: the feedback summary, candidate diffs and decision of every earlier round of the bundle whose pinned `setting` equals the current round's. Rounds in another setting reach the optimizer only through memory. |
| SIM | **Improvement memory**: `learning_memory_problems` and `learning_memory_attempts`. Prompt key `improvementMemory`. |
| Proposer P and selector S | The **optimizer model** (`ACCLIMATE_MODEL`), called as `propose`, `screen` and `select` |
| k, rollouts | `CANDIDATES_PER_ROUND = 5`, `ROLLOUTS_PER_CASE = 5` |

### Constants and identities

| Name | Meaning |
| --- | --- |
| `CANDIDATES_PER_ROUND = 5` | Proposer samples per round (D9). Never configurable. |
| `ROLLOUTS_PER_CASE = 5` | Rollouts per case in every evolve and held-out evaluation |
| `CASE_PASS_ROLLOUTS = 3` | A case **passes** in an evaluation when at least 3 of its 5 rollouts report `passed: true` |
| Sample | A candidate's position in its round, 1 to 5. The reviews call it a slot. |
| App principal | The one machine principal that submits outcomes and evolve cases and runs the evaluator for a loop: a machine-token principal (`machine:…`) or a static grant principal. It must hold the `evaluate` right. Stored as `learning_loops.app_principal`, with no prefix check. |
| `service:learning-loop` | The `promotions.reviewer` recorded for an adopt release |
| Problem ID | `P<n>`, numbered per workspace + bundle from `P1` |
| Round number | `learning_rounds.number`, 1, 2, … per bundle. Attempt and problem fields named `round` hold this number. |
| Memory revision | `learning_loops.memory_revision`, the bundle's append counter. One per adopted round. |
| Evolve revision | `learning_loops.evolve_revision`, incremented by every change to the evolve split |

### Tables

Migration `0018_learning_loop.sql` adds the first four tables. Migration `0019_learning_optimizer.sql` adds the last four. Migration `0020_optimizer_effort.sql` adds the nullable round effort pin and an evolve-case paging index. [removal.md](removal.md) owns `0016` and `0017`.

| Table | Key | Columns | Owner |
| --- | --- | --- | --- |
| `learning_loops` | `(project_id, bundle_id)` | `status`, `channel`, `app_principal`, `setting`, `held_out`, `evolve_revision`, `memory_revision`, `next_round`, `failed_rounds`, `pause_reason`, `enrolled_by`, `created_at`, `updated_at`. This row is the **bundle row lock**. | loop.md |
| `learning_evolve_cases` | `(project_id, bundle_id, case_id)` | `input`, `expected`, `source` (`setup` or `outcome`), `outcome_id`, `version_id`, `added_revision`, `retired_revision` | evaluator-and-contracts.md |
| `learning_rounds` | `id`; unique `(project_id, bundle_id, number)`; at most one active per loop (`learning_rounds_one_active`) | `number`, `state`, `decision`, `reason`, `parent_version_id`, `channel`, `channel_revision`, `evolve_revision`, `memory_revision`, `memory_digest`, `history_digest`, `setting`, `held_out`, `optimizer_model`, `optimizer_reasoning_effort`, `adopted_sample`, `adopted_version_id`, `selection`, `incumbent_score`, `held_out_score`, `held_out_error`, `created_at`, `ended_at` | loop.md |
| `learning_evaluations` | `id`; at most one open per round (`learning_evaluations_one_open`) | `round_id`, `role` (`incumbent`, `candidate`, `retained`), `sample`, `split` (`evolve`, `held_out`), `version_id`, `digest`, `evolve_revision`, `status`, `attempt_id`, `report`, `score`, `created_at`, `started_at`, `deadline_at`, `error` | evaluator-and-contracts.md |
| `learning_candidates` | `(round_id, sample)` | `status`, `drop_reason`, `rationale`, `changes`, `diagnosis`, `scan`, `screen`, `version_id`, `evaluation_id`, `evolve_score` | optimizer.md (the one definition), loop.md (the status machine) |
| `learning_optimizer_calls` | `(round_id, kind, sample)`, `sample = 0` for `screen` and `select`; at most one open per round (`learning_optimizer_calls_one_open`) | `kind` (`propose`, `screen`, `select`), `status`, `attempts`, `input_digest`, `output`, `error_code`, `error`, `claimed_at` | optimizer.md |
| `learning_memory_problems` | `(project_id, bundle_id, problem_id)`; unique `(project_id, bundle_id, root_cause_key)` | `root_cause`, `root_cause_key`, `opened_round`, `opened_revision` | memory.md |
| `learning_memory_attempts` | `(project_id, bundle_id, revision)`; unique `round_id` | `problem_id`, `round_id`, `round`, `sample`, `backfilled`, `what`, `files`, `predicted`, `fixed`, `missed`, `passed`, `total`, `domain`, `provenance`. No regression list, as in the paper. | memory.md |

Kept, 19 tables: `projects`, `users`, `project_memberships`, `workspace_invitations`, `workspace_adoptions`, `browser_sessions`, `machine_tokens`, `machine_token_events`, `bundles`, `versions` (minus `proposal_id`), `channels`, `promotions` (`comparison_id`, `policy_override` and `policy_approval_promotion_id` dropped; `unevaluated_reason` keeps its name), `integrations`, `integration_credentials`, `integration_receipts`, `idempotency`, `durable_commands` (connected-learning rows deleted; the loop's outcome receipts reuse it), `operation_records`, `mutation_audit`.

### Statuses, states and reasons

| Column | Values |
| --- | --- |
| `learning_loops.status` | `running`, `paused`, `stopped` |
| `learning_loops.pause_reason` | `operator`, `failed-rounds`, `optimizer-context-too-large`. `optimizer-context-too-large` replaces an operator reason. |
| `learning_rounds.state` | Active: `scoring_incumbent`, `proposing`, `screening`, `evaluating`, `selecting`, `scoring_held_out`. Terminal: `completed`, `failed`, `stopped`. |
| `learning_rounds.decision` | `adopted`, `kept`. NULL for `failed` rounds and rounds stopped before a decision. A round stopped in `scoring_held_out` keeps its decision. |
| `learning_rounds.reason` | With `kept`: `selector-kept`, `no-candidates`, `no-survivors`, `no-evaluated-candidates`, `channel-moved`. With `failed`: `incumbent-evaluation-failed`, `optimizer-unavailable`, `optimizer-context-too-large`, `selector-unavailable`. With `stopped`: `stopped`. |
| `learning_candidates.status` | `generating`, `generated`, `dropped`, `screened_out`, `evaluating`, `evaluated`, `evaluation_failed` |
| `learning_candidates.drop_reason` | `provider-failed`, `format-rejected`, `scanner-rejected`, `no-change`. Identical samples are both kept. |
| `learning_evaluations.status` | `queued`, `running`, `scored`, `failed`, `cancelled` |
| `learning_optimizer_calls.status` | `queued`, `running`, `succeeded`, `failed` |
| `learning_optimizer_calls.error_code` | Set exactly when `failed`: `provider-failed` (including input drift, a model change and the attempt limit), `format-rejected`, `optimizer-context-too-large`, `scanner-rejected` (`propose` only), `cancelled` (closed by `cancel_children`). `error` is free text. |
| `learning_evolve_cases.source` | `setup`, `outcome` |
| Wire spelling | Wire values match the database values, except `held_out` is `heldOut` on the wire |

### JSON shapes

| Name | Shape |
| --- | --- |
| `setting` (loop, round, provenance) | `{domain, benchmark, policyModel}`, each a nonempty string of at most 256 bytes |
| `held_out` / wire `heldOut` | `{digest, cases}`: the evaluator's commitment to its fixed held-out split and its case count. The cases never leave the evaluator. |
| Proposer output | `{schemaVersion: 2, rationale, edits: [{path, oldText, newText}], files: [{op: "write", path, text} \| {op: "delete", path}], diagnosis}` |
| `diagnosis` | `{problem: {id: "P3"} \| {new: "<root cause>"}, predicted: [caseId]}`, stored on `learning_candidates.diagnosis` before evaluation |
| `learning_candidates.changes` | The validated `edits` and `files` from the proposer output |
| Scanner-rejected `propose` call output | `{scan, diagnosis}`, with `diagnosis` null when a finding is in the root cause. No other model text is stored. |
| `learning_candidates.scan` | `{clean, findings}` from the scanner. Findings name the rule and path, never the matched text. |
| Screen output | `{samples: [{sample, verdict: "evaluate" \| "skip", reason}]}`. Each entry is stored on `learning_candidates.screen` as `{verdict, reason}`. |
| Select output | `{decision: "adopt" \| "keep", sample, reason}`. `sample` is required with `adopt` and absent with `keep`. |
| `learning_rounds.selection` | `{decision, sample, versionId, digest, reason, model, inputDigest}` |
| Evaluation report | `{cases: [{caseId, rollouts: [{score, passed, trace, error}]}]}`. `score` is in [0, 1]. A held-out report carries only `score` and `passed`. |
| `provenance` | Stored: `{domain, benchmark, policyModel, round, evolveRevision, heldOutDigest, optimizerModel}`. Rendered into `improvementMemory`: the paper's `{domain, benchmark, policyModel, round}` only. |
| Optimizer prompt keys | `setting`, `harness`, `feedback`, `history`, `improvementMemory` for every call; `candidates` for `screen` and `select`; `parserError` on the one format retry. The eight rules are trusted instruction, outside the fenced data. |
| `feedback` | `{versionId, evolveRevision, score, cases: [{caseId, input, passedRollouts, meanScore, rollouts: [{score, passed, trace, error}]}]}` |

### Routes

All loop routes use the prefix `/v1/workspaces/{workspaceId}/bundles/{bundleId}/learning`.

| Route | Caller | Purpose |
| --- | --- | --- |
| `PUT` | Workspace administrator | Enroll the bundle or change `channel`, `appPrincipalId`, `setting` or `heldOut`. A change applies from the next round. While a round is active, a change to `channel`, `appPrincipalId` or `heldOut` is `409 learning_conflict`. A `setting` change is accepted at any time. |
| `GET` | Workspace reader | The loop, its active round and recent rounds |
| `POST /pause`, `POST /resume`, `POST /stop` | Workspace administrator | Change `learning_loops.status` |
| `GET /rounds`, `GET /rounds/{roundId}` | Workspace reader | Rounds with their candidates, evaluations and selection |
| `GET /memory` | Workspace reader other than the app principal (`403`) | The improvement memory at its current revision, or at `?revision=` |
| `POST /evolve-cases` | App principal | `{cases: [{caseId, input, expected}], retire: [caseId]}`. Returns the new `evolveRevision`. |
| `POST /outcomes` | App principal | `{outcomeId, versionId, digest, input, expected}`. Adds evolve case `outcome:<outcomeId>`. |
| `GET /work` | App principal | Queued and running evaluations for this loop. A held-out item carries the round's pinned `heldOut`. |
| `POST /evaluations/{evaluationId}/start`, `POST /evaluations/{evaluationId}/report` | App principal | Claim an evaluation, then report its result |

Kept unchanged: workspace, auth, invitation, membership, machine-token, bundle, version, payload, channel resolve and connection routes. The channel release route stays, and its request is `{versionId, expectedRevision, unevaluatedReason}` with `comparisonId` and `policyOverride` removed. Every route under `/connections/{connectionId}/learning`, and every proposal, comparison, draft, evaluation-request, progress and policy-receipt route, is removed ([removal.md](removal.md)).

### Settings

| Setting | Status |
| --- | --- |
| `ACCLIMATE_MODEL`, `ACCLIMATE_MODEL_ENDPOINT`, `ACCLIMATE_MODEL_TOKEN` | Kept. The one optimizer model. No reader in phases 2 and 3, and startup accepts them. |
| `ACCLIMATE_MODEL_TIMEOUT_SECONDS` | New, default 600. Replaces the fixed 60 s client timeout. |
| `ACCLIMATE_MODEL_MAX_COMPLETION_TOKENS` | New, default 32768 |
| `ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS`, `ACCLIMATE_LEARNING_EVALUATION_SECONDS` | Kept as the evaluation deadlines before and after start |
| `ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` | New, default 3. Consecutive failed rounds before the loop pauses. A deliberate deviation ([decisions.md](decisions.md#deliberate-deviations-from-the-paper)). |
| `ACCLIMATE_CRITIC_MODEL`, `ACCLIMATE_CRITIC_ENDPOINT`, `ACCLIMATE_CRITIC_TOKEN`, `ACCLIMATE_LEARNING_REVIEW_SECONDS`, `ACCLIMATE_LEARNING_PARENT_MAX_REUSES`, `ACCLIMATE_LEARNING_PARENT_MAX_AGE_SECONDS`, `ACCLIMATE_LEARNING_PAIR_BUDGET`, `ACCLIMATE_LEARNING_MAX_REPETITIONS`, `ACCLIMATE_LEARNING_MAX_STEPS_BETWEEN_AUDITS`, `ACCLIMATE_LEARNING_MAX_CHAIN_AGE_SECONDS`, `ACCLIMATE_LEARNING_CALIBRATION_REPETITIONS`, `ACCLIMATE_LEARNING_CALIBRATION_ATTEMPTS`, `ACCLIMATE_LEARNING_FAILURE_WINDOW_SECONDS`, `ACCLIMATE_PROPOSAL_GROWTH_FLOOR_BYTES`, `ACCLIMATE_EVALUATION_ABANDON_SECONDS` | Removed |

### Code

| Name | Contents | Owner |
| --- | --- | --- |
| `src/learning.rs` | Routes: enroll, inspect, pause, resume, stop, rounds, memory | evaluator-and-contracts.md |
| `src/learning/worker.rs` | `learning_worker`, `tick`, `advance_round`, `start_round`, `adopt`, `keep`, `fail_round`, `stop_round`, `cancel_children`, `sweep`, `ACTIVE_ROUND_STATES` (the six active states), `CallTasks` (the keys held by live call tasks) | loop.md |
| `src/learning/evaluations.rs` | `work`, `start`, `report`, `authorize_evaluation`, `expire`, `case_passes` | evaluator-and-contracts.md |
| `src/learning/evolve.rs` | `add_cases`, `retire_cases`, `submit_outcome`, `cases_at` | evaluator-and-contracts.md |
| `src/learning/optimizer.rs` | `OptimizerModel` trait (`propose`, `screen`, `select`), `EIGHT_RULES`, `render_feedback`, `validate_diagnosis`, `validate_screen`, `validate_select`, `run_call(s, key)` (the call task: claim, render, call, scan, commit), `call_with_retry` (the one format retry) | optimizer.md |
| `src/learning/history.rs` | `render_history` | optimizer.md |
| `src/learning/memory.rs` | `render_memory`, `write_back`, `resolve_problem`, `normalize_root_cause`, `root_cause_key`, `ROOT_CAUSE_MAX_BYTES` (1024), `attempt_outcome` | memory.md |
| `src/proposal_edits.rs` | Kept. Phase 2 leaves anchored edits only. Phase 4's `reconstruct` applies `edits` and `files` to the parent payload, with no path policy and no growth cap, and restores `changed_files`. | optimizer.md |
| `src/proposal_scanner.rs` | Kept. The secret and PII scanner, a `pub mod` from phase 2. Phase 4 adds named `findings`. | optimizer.md |
| `src/lib.rs` `OpenAiModel` | Deleted in phase 2 with `ProposalModel` and the critic. Phase 4 adds it back from the 4096ff1b client, implementing `OptimizerModel`. | optimizer.md, removal.md |
| `@acclimate/sdk/learning` | `serveLearningLoop` (with `caseConcurrency`), `createLearningOutcomeReporter`, `addEvolveCases`, `heldOutDigest`. The `acclimate-learning` bin runs `serveLearningLoop`. | evaluator-and-contracts.md |
| Console | `apps/console/src/components/bundle-learning.tsx`, `apps/console/src/server/learning-loop.ts` | evaluator-and-contracts.md |
| Experiment | `examples/self-improvement-memory/`: `fixtures/w1/` from phase 2, the driver and `tests/` from phase 5 | experiment.md |

## Round state machine

A loop has at most one active round. When the loop is `running` and its last round has ended, `tick` starts the next round at once. `stop` from any active state moves the round to `stopped`. It cancels the round's queued and running evaluations and marks its unfinished optimizer calls `failed` / `cancelled`, so a late model reply is discarded at commit. Each optimizer call commits only its own row. `advance_round` turns call and evaluation results into candidate and round state under the bundle row lock.

| State | Entered when | Work done in the state | Next state |
| --- | --- | --- | --- |
| `scoring_incumbent` | `start_round` under the bundle row lock. It pins `parent_version_id`, `channel` and `channel_revision` from the learning channel head, `evolve_revision`, `memory_revision`, `setting`, `held_out`, `optimizer_model` and `optimizer_reasoning_effort`. | One `incumbent` evolve evaluation of the parent | `proposing` when it is `scored`. `failed` (`incumbent-evaluation-failed`) when it is `failed`. |
| `proposing` | The incumbent evaluation is `scored` | Render `feedback`, `history` and `improvementMemory` once and store `history_digest` and `memory_digest`. Run 5 `propose` calls one at a time. Each call validates its output (one format retry), reconstructs it and scans it before it commits. `advance_round` then drops a `no-change` sample. | `screening` when every sample has left `generating` and at least one is `generated`. `scoring_held_out` with `kept` / `no-candidates` when every sample is `dropped` and at least one was not `provider-failed`. `failed` with `optimizer-context-too-large` when a call reports that the input does not fit the model, or with `optimizer-unavailable` when every sample is `provider-failed`. |
| `screening` | At least one sample is `generated` | One `screen` call over every `generated` sample. `advance_round` writes the verdicts from its stored output. | `evaluating` when at least one sample gets `evaluate`. `scoring_held_out` with `kept` / `no-survivors` when every sample gets `skip`. `failed` with `optimizer-context-too-large` when the input does not fit, and `selector-unavailable` when the call fails otherwise. |
| `evaluating` | At least one survivor | Create each survivor's version, then one `candidate` evolve evaluation per survivor, served one at a time | `selecting` when every survivor is `evaluated` or `evaluation_failed` and at least one is `evaluated`. `scoring_held_out` with `kept` / `no-evaluated-candidates` when none is. |
| `selecting` | At least one `evaluated` candidate | One `select` call over the `evaluated` candidates, whose output commits on its own. Then a later transaction under the bundle row lock reads the stored output: on adopt, `adopt` writes `selection`, releases the version to the learning channel and calls `memory::write_back`. On keep, `keep` writes `selection`. | `scoring_held_out` with `adopted`, or with `kept` / `selector-kept`. With `kept` / `channel-moved` when the channel head is no longer `channel_revision` at commit. `failed` with `optimizer-context-too-large` when the input does not fit, and `selector-unavailable` when the call fails otherwise. |
| `scoring_held_out` | A decision is recorded | One `retained` held-out evaluation of the version on the learning channel, against the round's pinned `held_out` | `completed` when it is `scored` (`held_out_score` set) or `failed` (`held_out_error` set). A held-out result never changes the decision. |
| `completed` | Terminal | | |
| `failed` | Terminal. Increments `failed_rounds`. | Reaching `ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` pauses a running loop with `failed-rounds`. `optimizer-context-too-large` pauses it at once and sets that `pause_reason` even over an operator pause. | |
| `stopped` | Terminal | | |

`completed` resets `failed_rounds` to 0. Loop status changes:

| From | Event | To |
| --- | --- | --- |
| (none) | `PUT` enrolls the bundle | `running` |
| `running` | `POST /pause`, or an automatic pause | `paused`. The active round runs to its end, and no new round starts. |
| `paused` | `POST /resume` | `running`. Clears `pause_reason` and `failed_rounds`. |
| `running`, `paused` | `POST /stop` | `stopped`. The active round becomes `stopped`. |
| `stopped` | `PUT` | `running`. Memory and history continue. |

Candidate and evaluation states:

| Machine | Transitions |
| --- | --- |
| Candidate | `generating` → `generated` or `dropped`. `generated` → `screened_out` when the screen verdict is `skip`, or `evaluating` when its turn comes after an `evaluate` verdict. `evaluating` → `evaluated` or `evaluation_failed`. |
| Evaluation | `queued` → `running` → `scored` or `failed`. `queued` or `running` → `cancelled` on stop. A queue or run deadline moves it to `failed`. |
| Optimizer call | `queued` → `running` → `succeeded` or `failed` (with `error_code`). `attempts` counts claims. `sweep` requeues a `running` call that no live task holds, up to 3 claims. A succeeded call's `output` is never replaced, so a retry after a crash returns the same result. |

## Phased plan

Every phase ends with `npm run lint`, `npm run typecheck` and the listed tests, and builds and ships on its own. Removal goes first, so the old and new loops never run side by side (D2). Phases 2 to 4 can ship as one release train when a release without learning is unacceptable. Each still builds and passes alone.

| Phase | Ships | Migration | Tests | Depends on |
| --- | --- | --- | --- | --- |
| 0. Design | This folder, with the superseded design files deleted. Regenerate the `docs/site` export with `python3 scripts/build_docs.py`. | none | `npm run lint:docs` | none |
| 1. Remove the manual product | Drafts, the public proposal create route, unbound comparisons, evaluation-request create, policy receipts, channel quality gating, the `propose` right, the GitHub Action and CI wrapper, the `acclimate-operator` CLI, `acclimate-eval compare` and `--policy`, the SDK and Python policy, statistics, planning and analysis code, and the console change, draft and evaluation pages. Bound `POST /comparisons`, and the tables and code that connected learning still uses, stay until phase 2. | `0016_remove_manual_changes.sql` | The remaining Rust, SDK, Python and console suites. The installed-consumer checks for the changed exports. | 0 |
| 2. Remove connected learning | Every `connected_learning_*` table, view, module, route, setting and console page. `proposals`, `comparisons`, `evaluation_requests` and `evaluation_progress`, and connected-learning `durable_commands` rows. The critic, `ProposalModel` and today's model client. The SDK learning driver and evaluation-request runner. The W1 fixtures move to `examples/self-improvement-memory/fixtures/w1/`. `contracts/learning.md` says learning is not available. Delivery keeps working. | `0017_remove_connected_learning.sql` | Delivery, auth, workspace and connection suites. `tests/production_schema.rs`. | 1 |
| 3. Loop skeleton | `learning_loops`, `learning_evolve_cases`, `learning_rounds`, `learning_evaluations`. Enroll, inspect, pause, resume, stop, evolve cases, outcomes, work, start and report. `serveLearningLoop`. Rounds run `scoring_incumbent` → `scoring_held_out` → `completed` with `kept` / `no-candidates`, which gives the H0 baseline curves. The console loop page. | `0018_learning_loop.sql` | Round and evaluation state tests, ownership denial, held-out trace refusal, outcome-to-case tests, the SDK runner tests | 2 |
| 4. Optimizer and memory | `learning_candidates`, `learning_optimizer_calls` and the memory tables. `OptimizerModel` and the new `OpenAiModel`, `reconstruct` with `files` and `changed_files`, `propose`, the scanner's findings, `screen`, survivor evaluation, `select`, adopt as release, write-back, run history, the memory route, and the console candidate and memory views. The loop is complete. | `0019_learning_optimizer.sql` | The full state machine, a crash at every commit, durable selection, the pinned memory revision, the append lock, the eight-rules prompt test, contract tests | 3 |
| 5. Experiment tooling | The driver, held-out fixtures, analysis and `tests/` in `examples/self-improvement-memory/`, with the `test:sim-experiment` script. No product change. | none | Driver tests | 4 |
| 6. Paper-sized experiment | 10 source runs, the cross-model transition, Full SIM, Harness Transfer and Cold Start, and the analysis | none | The integrity checks in experiment.md | 5 |

## Deferred after the MVP

The maintainer deferred these on 2026-11-20. The MVP ships without them; revisit after the paper-sized experiment.

| Topic | MVP behavior |
| --- | --- |
| **Auto-revert.** Revert the channel or pause the loop on a held-out drop or an app-reported failure rate. | The loop never reverts an adopted release (D3). The held-out curve is shown only. |
| **Trace privacy, size and retention.** Redaction and retention for evolve inputs, expected answers, traces and errors; what to do when full history and memory outgrow the optimizer's context. | No service cap beyond the 2 MiB request limit; the SDK runner captures 16 KiB of trace and 4 KiB of error per rollout by default. A round that does not fit pauses the loop with `optimizer-context-too-large`; nothing is truncated. |
| **Large responses.** Round details, memory snapshots and evolve assignments can exceed the SDK clients' 4 MiB JSON response limit. | Requests over the limit fail with the existing client error. |

## Open questions

Each design file lists the questions it owns. These need a maintainer answer.

1. **Pointing a channel at an earlier version.** The default keeps the channel release route as a delivery primitive. A manual release on the learning channel becomes the next round's parent, and an adopt that finds the channel moved records `kept` / `channel-moved`. Should the loop also record the manual move in run history, or forbid manual releases on the learning channel?
2. **Multiple loops per bundle.** One loop per workspace + bundle. Two apps with different settings on one bundle would share one memory and one learning channel. Should a loop be keyed per channel or per setting, and should memory stay per bundle?
3. **Data archive.** Phase 2 drops connected-learning rounds, proposals, comparisons and receipts. Should operators export them first, and should rounds, evaluations and traces from the new loop expire?
4. **Expected answers in optimizer input.** `feedback` carries each evolve case's input and rollouts, not its `expected` value. Should the proposer see expected answers, as some of the paper's benchmarks expose test results?
5. **Held-out on every round.** The retained version is scored on the held-out split every round, even after a keep, as the paper does. Should a keep reuse the previous score instead?
6. **`backfilled`.** The paper lists the field and does not define it. Memory starts empty and is never backfilled (D6), so every stored attempt has `backfilled = false`. Keep the field for paper fidelity?
7. **Sibling conditioning.** The five samples are independent and see the same input. The paper does not say whether later samples see earlier ones.
8. **Evolve split growth.** Every outcome with an expected result adds a case, and every case is scored 5 times on every evaluation. Should near-duplicate outcomes merge, or should the split have a size limit?
9. **Run history across a setting change.** The design follows the paper: `history` holds only earlier rounds in the current `setting`, so after a model or benchmark change the earlier rounds reach the optimizer only through memory. D5 says "all prior rounds", which this design reads as all prior rounds of the run, with no truncation ([decisions.md](decisions.md#paper-readings-that-still-hold)). Please confirm, or say that `history` should cross setting changes, in which case experiment.md's Full SIM arm measures inherited memory plus inherited history.
