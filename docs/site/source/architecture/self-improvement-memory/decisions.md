# Self-improvement memory: decisions

This file records the binding maintainer decisions for the paper-first rewrite, what each decision of the earlier design became, the paper readings that still hold, the deliberate deviations from the paper, which findings of the three external reviews still apply, and how the review of this rewrite was resolved. The [README](README.md) has the reading order, the names and the round state machine.

Paper references are to arXiv 2611.18856 (<https://arxiv.org/abs/2611.18856>), read in its HTML version on 2026-11-20.

## Maintainer decisions (binding)

These supersede every earlier decision that conflicts with them.

| # | Decision |
| --- | --- |
| D1 | **Paper first.** Where the paper and today's Acclimate differ, the paper is right and today's system is wrong. Remove today's machinery that the paper does not need. |
| D2 | **Single path.** One loop, always on for an enrolled bundle. No modes, no flags and no legacy path. |
| D3 | **The loop is the paper's loop.** Rounds run continuously: the next round starts when the previous one ends, and an operator can pause or stop the loop. Each round: (1) score the incumbent on the evolve split, 5 rollouts per task, with per-case scores, traces and errors; (2) 5 proposer samples, each with a diagnosis `{problem: existing id \| new root cause}` and predicted evolve case IDs written before evaluation; (3) the secret and PII scanner; (4) a selector screen of all samples before execution; (5) evaluate the survivors on the evolve split, 5 rollouts; (6) the selector adopts one evaluated candidate or keeps; (7) **adopt is release**: the adopted version is published to the bundle's learning channel at once; (8) memory write-back of the adopted candidate only; (9) score the retained version on the fixed held-out split, for monitoring only. Held-out results are never shown to the optimizer and never gate. There is no statistical gate of any kind and no auto-revert (an open question). Serial generation and evaluation are fine for the MVP. |
| D4 | **Corrections become evolve cases.** App outcomes with an expected result are added to the evolve split as a new dataset revision. Lessons (app-written instructions) are removed as a concept. Corrections do not trigger rounds. |
| D5 | **Optimizer inputs.** The current harness (the whole bundle). Evolve feedback including traces and errors: the evaluator reports them for evolve cases, and held-out traces are never sent. The full run history: every prior round's feedback summary and diffs, with no 12-round or 8 KB truncation. The full SIM. The proposer may edit, create or delete any bundle file: no permitted paths, no skill-package authorization, no growth cap. One optimizer model serves the proposer and the selector. Untrusted-data fencing and the scanner stay, for secret and PII hygiene. Held-out data never reaches the optimizer. |
| D6 | **Memory.** Optimizer-only, per workspace + bundle, starts empty with no backfill, never delivered to jobs, pinned per round, appended under a bundle row lock, never rewound. Only the adopted candidate is written. Losing candidates keep their diagnosis on their own row. |
| D7 | **Removed from learning.** Calibration and A/A; repetition planning; power and MDE. Selection policies v1 to v3 and every statistical gate (step, cumulative, audit, 99%). Policy epochs and renewal: dataset, grader and model become provenance. Single-use audit cohorts and audit reservation. The development chain and its split from delivery, and the cumulative check. Field audits, field windows, requalification, restore targets and automatic field rollback. Incident replays and rechecks. Lessons. Delivery receipts used for field sampling. The parent cache. Admission allowances, correction attempts and refunds. Separate outcome and evaluator principals: there is one app principal, and the held-out split stays in the evaluator's own store. Permitted paths, skill-package authorization and the growth cap. The separate critic model configuration. Human review: `awaiting_review`, the review route and policy override receipts. Budget limits. |
| D8 | **Removed from the manual product.** The hand-made change workflow: the public proposals API, drafts, manual comparisons and evaluation requests, compare and `--policy` quality gating, the GitHub Action and CI wrapper, policy receipts, the operator CLI's compare and promote flow, and SDK evaluation code that exists only for manual comparison and gating (policy, statistics, planning, analysis). Acclimate becomes the self-improvement loop plus versioned delivery. Kept, because the loop and delivery need them: workspaces, auth, invitations, machine tokens, bundles, immutable versions, channels and delivery, SDK fetch, cache, verify and prepare, the native plugins, the evaluator runner (now scoring the evolve and held-out splits), the scanner, and a console for workspaces, bundles, connections and the loop. Whether an operator may still point a channel at an earlier version (a delivery primitive) is an open question. The default is to keep it. |
| D9 | **Budget is not a constraint.** k=5 always. |
| D10 | **Experiment.** The product loop is the experiment loop. Conditions come from bundle setup: Full SIM continues the source bundle; Harness Transfer is a new bundle with H_S and empty memory; Cold Start is a new bundle with H0. Paper-sized first: 10 source runs, a cross-model transition, primary contrast Full SIM − Harness Transfer on the held-out split. Optional descriptive control: today's flat history on the pre-change release build. |

### How the names follow from the decisions

| Decision | Consequence in the design |
| --- | --- |
| D2 | One `learning_loops` row per workspace + bundle. No column on it selects behaviour. `CANDIDATES_PER_ROUND` and `ROLLOUTS_PER_CASE` are constants. |
| D3 | The nine steps are the round states `scoring_incumbent`, `proposing`, `screening`, `evaluating`, `selecting` and `scoring_held_out`. The scanner runs inside each `propose` call, before its output is committed. The `select` output is committed first. Adopt, release and write-back then commit in one later transaction in `selecting`. |
| D3 | A held-out evaluation that fails sets `held_out_error` and still completes the round, because monitoring never gates. |
| D4 | `POST /learning/outcomes` takes `input` and `expected` and adds the evolve case `outcome:<outcomeId>` under a new `evolve_revision`. No correction, lesson or admission table exists. |
| D5 | The proposer output has `edits` (anchored replacements) and `files` (whole-file writes and deletes) with no path policy. `harness`, `feedback`, `history` and `improvementMemory` are rendered in full. `history` holds every earlier round in the current setting, which is the paper's run (see "Paper readings"). An input that does not fit fails the round with `optimizer-context-too-large` and pauses the loop. It is never trimmed. Traces and errors have no service-side cap beyond the 2 MiB request limit. |
| D6 | `learning_rounds.memory_revision` and `memory_digest` pin the memory read. `memory::write_back` runs once per adopted round while the `learning_loops` row is locked. Attempts are append-only. |
| D7 | `setting` and `provenance` replace policy epochs. The app principal (`learning_loops.app_principal`) is the only machine caller. |
| D8 | A version comes from a bundle upload or a loop candidate. `versions.proposal_id` is removed. |

## Superseded

The earlier design lived in this folder as `round-lifecycle.md`, `proposer-and-selector.md`, `data-model.md` and `contracts-and-surfaces.md`, with an older `README.md`, `decisions.md` and `experiment.md`. The four owner files are replaced by `loop.md`, `optimizer.md`, `memory.md`, `evaluator-and-contracts.md` and `removal.md`. The decision tables inside them (L1 to L13 and the like) are superseded as a whole. Where one of their ideas survives, it is listed under the review findings below.

### Maintainer decisions M1 to M8

| Earlier | What it said | Now |
| --- | --- | --- |
| M1 | Real experiments at paper scale, planned properly | Kept in D10: paper-sized first, with 10 source runs. |
| M2 | Memory shared across the connections on a bundle, scoped to workspace + bundle, with provenance for connection, model, runtime, dataset, grader and round | The workspace + bundle scope stays (D6). Connections no longer own learning, so connection provenance goes. Rendered provenance is the paper's domain, benchmark, policy model and round. The evolve revision, held-out digest and optimizer model are stored beside it for operators and are not rendered (D7: dataset, grader and model become provenance). |
| M3 | k=5, screen before evaluation, select among the evaluated, full memory to proposer and selector, the eight rules, write back only the chosen one | Kept in D3, D5 and D6 |
| M4 | Do not over-engineer, pass the full memory, change limits on purpose | Kept and widened by D5: the full history is passed too, and the 64 KiB request, 20-entry evidence and 12-round history limits go. Overflow is an error, never a trim. |
| M5 | Keep the lesson gate, untrusted-data fencing and held-out isolation | Fencing stays (D5). The lesson gate goes with lessons (D4). Held-out isolation becomes a fixed held-out split in the evaluator's own store, whose traces are never sent (D5, D7). |
| M6 | Single-path MVP. In-flight rounds closed at deploy. | The single path stays (D2). Closing in-flight rounds becomes removing connected learning in phase 2, so no round survives the switch. |
| M7 | Automatic release only, with field audits and automatic rollback kept | Automatic release stays in its strongest form: adopt is release (D3), with no audit before it. Field audits and automatic rollback are removed (D7). Auto-revert is an open question. |
| M8 | Budget is not a constraint | Kept as D9 |

### Resolved disagreements R1 to R28

| Earlier | Topic | Now |
| --- | --- | --- |
| R1 | Mode switch: none | Unchanged (D2) |
| R2 | Write-back once, in the choose transaction, only on adopt; `accepted` rendered `true` | Unchanged. `memory::write_back` runs in the adopt transaction, after the release on the same row lock. |
| R3 | Keep recorded as round decision `selector_kept` | Becomes `decision = kept` with `reason = selector-kept` |
| R4 | Selection record `{v, source, decision, chosen, ranking, reason, model, inputDigest}` | Becomes `learning_rounds.selection` = `{decision, sample, versionId, digest, reason, model, inputDigest}`. There is no fallback source: a failed `select` fails the round. |
| R5 | Samples numbered 1..5; single-candidate round fields NULL until choose | Samples 1..5. The round holds `adopted_sample` and `adopted_version_id` and has no other candidate projection. |
| R6 | Diagnosis `{problem: {id} \| {new}, predicted}` with a 600-byte root cause and a stored status | The proposer shape stays. Memory.md sets the root-cause limit (`ROOT_CAUSE_MAX_BYTES = 1024`). An invalid diagnosis is a format error with one retry inside the call, so no `valid`/`absent`/`invalid` status is stored. |
| R7 | Predicted IDs limited to IDs disclosed in the request | Predicted IDs must be evolve case IDs at the round's `evolve_revision`, all of which are in `feedback` |
| R8 | No retry for diagnosis-only problems | Replaced. The diagnosis is part of the required format and shares the one format retry. |
| R9 | `src/connected_learning/memory.rs`, `candidates.rs`, `src/selector.rs` | Replaced by `src/learning/memory.rs`, `src/learning/worker.rs` and `src/learning/optimizer.rs` |
| R10 | Prompt key `improvementMemory` | Unchanged |
| R11 | Memory cap `ACCLIMATE_LEARNING_MEMORY_MAX_BYTES`, admission rejection | No byte cap of Acclimate's own (D5). Only the model's context limits input, and exceeding it fails the round with `optimizer-context-too-large`. |
| R12 | Two counters: per-connection `round` and bundle-wide `revision` | Two counters: per-bundle round `number` and bundle-wide memory `revision` |
| R13 | Lesson names | Moot: lessons are removed (D4) |
| R14 | Fresh parents, no parent cache | Moot: evaluations score one version each, and no parent arm exists |
| R15 | Problem IDs `P<n>`, `P0` for unattributed attempts, no aliases | `P<n>` from `P1`. No `P0`, because an unattributed diagnosis is a format error. No aliases. |
| R16 | Migrations 0016 and 0017 for rounds and memory | Renumbered: `0016` and `0017` remove, `0018` and `0019` add (README, phased plan) |
| R17 | Fixes on today's loop first, then rounds and memory together | Removal first, then the loop skeleton, then the optimizer and memory |
| R18 | Screen job retries for crash recovery only | Unchanged for every optimizer call: `attempts` counts claims, and an invalid output fails the call with `error_code = 'format-rejected'` |
| R19 | `currentDevelopment` evolve feedback computed at admission | Becomes `feedback`, rendered from the round's `incumbent` evaluation |
| R20 | `CANDIDATE_STEP_CONFIDENCE = 0.99` | Removed with every statistical gate (D3, D7) |
| R21 | Screen record `repair` always 0, on the candidate row | The screen record is `{verdict, reason}` on `learning_candidates.screen`. There is no repair. |
| R22 | The screen ranks nothing | Unchanged. The select output's `reason` is the only ranking text. |
| R23 | No eligible survivor closes the round without a selection record | Becomes `kept` with `no-survivors` or `no-evaluated-candidates`, then held-out scoring as usual |
| R24 | Development-only optimizer status | Moot: no audit or release outcome exists separately from adoption |
| R25 | Development-only `priorAttempt` labels | Replaced by `history`, which carries each round's decision and each candidate's status |
| R26 | Wire `memoryRevision` and `round` | Unchanged |
| R27 | Round-level refund rule | Moot: no admissions or refunds (D7) |
| R28 | `sample` rather than slot | Unchanged |

### The 99% gate

The earlier design kept one statistical filter beyond the paper: a one-sided 99% step check per candidate, a Bonferroni-style answer to picking the best of five. It is removed (D3, D7). The paper's selector chooses by performance, complexity, domain specificity and regression risk, and so does this one. Best-of-five selection does inflate evolve-split gains. The fixed held-out curve, scored every round and never shown to the optimizer, is the measure that is not inflated, and the experiment reads it (D10).

### Review triggers

The earlier design mapped each of today's review triggers to allow, ineligible or reject. With human review removed (D7), each one becomes:

| Today's trigger | Now |
| --- | --- |
| Candidate derives from app lesson instructions | Moot: lessons are removed (D4) |
| Candidate adds or removes bundle files | Allowed. Any file can be created or deleted (D5). |
| No clean scanner result | The sample is `dropped` with `scanner-rejected` before the screen. The scanner stays. |
| Screen is not a low-risk accept | The `risky` flag is removed. The screen's `skip` keeps a sample from running. Nothing else follows from it. |
| Enrollment automatic rollout off, or authorizer not an admin | Moot. Enrolling a bundle authorizes releases on its learning channel. |
| Development or audit fixtures not committed | Moot. The evolve split is service-held, and the held-out split is committed by `heldOut.digest`. |
| Evaluation cost unknown | Moot: no cost policy (D7) |
| Blocking application-policy receipts | Moot: policy receipts are removed (D8) |
| Required field requalification replays | Moot: requalification is removed (D7) |

The pre-existing review-route panic that the earlier design found (a chain-promoted round with NULL `promotion_id`) goes with the route.

### Lesson gate

The lesson gate kept lesson-derived text out of optimizer input for rounds that could release automatically. Lessons are removed (D4), so the gate, `lesson_derived`, `textWithheld` and the `has_lesson` history filter go. An app's knowledge reaches the loop only as evolve cases with an expected result, and the optimizer sees it as data inside the fence.

### Single-use audits

Single-use audit cohorts, their reservation, the audit-rejected digest check and the "no runner-up after a failed audit" rule are removed (D7). In their place is one fixed held-out split per setting. The evaluator holds its cases and commits to them with `heldOut.digest`. The service queues one `retained` held-out evaluation each round, stores only scores, and never renders them into optimizer input. Because the split is used for monitoring only, reusing it every round leaks nothing into selection, which is what single use guarded against.

## Paper readings that still hold

| Question | Paper | Design |
| --- | --- | --- |
| Is anything written when the selector keeps? | "If no edit is accepted, e_t = ∅ and U(M_t, ∅) = M_t" (§3.2) | Nothing is written on keep |
| What does `accepted` mean? | "accepted means the selector chose the edit in that round, even if some predicted fixes failed" (App. D.3) | Only adopted candidates are written, so `accepted` renders `true` |
| What do `passed` and `total` count? | "the successful and total trials in that attempt's evolve-set evaluation" (App. D.3) | Passing rollouts and total rollouts in the candidate's evolve evaluation |
| Is run history kept beside SIM? | "All methods retain the ordinary target-run history D_t" (App. C.3) | `history` goes to every round, whatever the memory holds |
| What does D_t cover after a setting change? | The target run keeps only target-run history, and "source history enters through SIM" (App. C.3) | D_t is the run in the current setting. `render_history` lists every earlier round whose pinned `setting` equals the current round's, with no other cut. D5's "all prior rounds" is read as all prior rounds of that run: it forbids truncation, not this boundary. A Full SIM target run therefore starts with empty history and sees the source run only through memory. **Maintainer confirmation requested** (README question 11). |
| Rounds, candidates, rollouts | N=10 rounds, k=5 candidates, five rollouts per task | `CANDIDATES_PER_ROUND = 5`, `ROLLOUTS_PER_CASE = 5`. The experiment runs 10 rounds per run. |
| Do Cold Start and Harness Transfer build memory during the target run? | "Each condition keeps its assigned memory condition throughout target RSI" (App. C.3) | In the paper, no. Here a new bundle starts with empty memory and builds its own (D2, D10). Experiment.md records this deviation. |
| Problem-Only | "root causes only, omitting modifications, outcomes, and provenance" (App. C.3) | Not run: it needs a memory view, which would be a mode (D2) |

The paper does not define `backfilled`, say whether samples see their siblings, or give the selector prompt. These are open questions in the README.

## Deliberate deviations from the paper

Each of these is machinery the paper does not have. Each is kept on purpose, for the reason given. Anything not listed here follows the paper or is removed.

| Deviation | Where | Reason |
| --- | --- | --- |
| `SCREEN_INSTRUCTION` asks the selector to skip candidates that widen tool use, permissions, network or shell access, or spending without a need shown in the feedback | [optimizer.md](optimizer.md) | Adopt is release, with no review (D3, D7), and D5 removes every path and frontmatter policy. The screen is the only point where a model looks at a capability-widening change before jobs receive it. It is one sentence of model judgement, not a check (optimizer.md open question 4). |
| `ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` (default 3) pauses the loop with `failed-rounds` | [loop.md](loop.md) | The paper has no failing rounds to handle. Here every failed round spends a full incumbent evaluation, and a missing or broken optimizer endpoint would otherwise fail rounds back to back without end. It never reverts or gates a release. |
| `optimizer-context-too-large` pauses the loop at once | [loop.md](loop.md) | D5 forbids trimming, and every later round's input is at least as large, so continuing would only fail again |
| A candidate whose payload equals the parent's is dropped as `no-change` | [loop.md](loop.md), [optimizer.md](optimizer.md) | A candidate that changes nothing is not a change to the harness. Evaluating it would re-score the incumbent. |
| The SDK runner captures at most 16 KiB of trace and 4 KiB of error per rollout by default | [evaluator-and-contracts.md](evaluator-and-contracts.md) | An evaluator default, not a service limit. The service stores and forwards what it receives (D5). |
| Memory is per bundle and always on, so Harness Transfer and Cold Start build their own memory | [experiment.md](experiment.md) V1 | D2 and D6 allow no memory mode |

Removed after the review of this rewrite, because the paper does not have them: the `SELECT_INSTRUCTION` sentence warning that best-of-several gains may not hold up; deterministic `duplicate` drops of identical samples (identical samples are now screened and evaluated separately, as the paper's k samples are); rendering `evolveRevision` and `optimizerModel` in memory provenance (still stored); the `regressed` field on memory attempts (still computed for the `select` input); and the service-side 16 KiB trace and 4 KiB error checks on reports.

## External reviews (GPT-6.2 Astra)

Three independent reviews by GPT-6.2 Astra, at commit 4096ff1b, informed both designs: a SIM system design, a k=5 round-lifecycle red team and a paper-scale experiment plan. They were written against today's gated loop. Most of the red team's fixes protected audit, replay, refund and review machinery that D7 removes, so they are moot. The fixes for running five candidates and keeping memory consistent still apply.

### System design

Still applies:
- Five candidate rows per round, keyed `(round, sample)`: `learning_candidates`.
- Memory starts empty, because history cannot show what was predicted before evaluation (D6).
- Losing proposals create no problem. Only a selection appends to memory, and `accepted` means selected.
- The same complete memory goes to the proposer and the selector (D5).
- Overflow fails the round, without dropping content (`optimizer-context-too-large`).
- Model calls run outside any database lock. Each call commits only its own row under a claim guard, and `advance_round` applies the result under the bundle row lock.
- Ownership is resolved by child ID through the candidate and evaluation rows and fails closed (`authorize_evaluation`).
- The memory read is pinned per round and appended under a short bundle row lock.
- Predictions are frozen before any evaluation is queued.
- The scanner runs on new free text, including the root cause.
- The held-out split is scored by the evaluator, outside optimizer input.

Moot or superseded: the epoch-pinned `optimizer_method` (no epochs, no dual path), the lesson-gated memory (no lessons), the incident replay key (no replays), the always-fresh cumulative comparison (no gates), one admission charge per round (no admissions), and the `search_phase` column (new top-level states instead). Its open questions are answered: "fixed" uses the grader's per-rollout `passed` with a 3-of-5 case majority, and the domain, benchmark and policy model come from the round's pinned `setting`. Context capacity per endpoint stays open (README question 4).

### k=5 round-lifecycle red team

| Finding | Now |
| --- | --- |
| 1. One proposal per round baked into the schema | Applies: `learning_candidates` with `(round_id, sample)` |
| 2. Ownership checks succeed for unknown IDs | Applies: `authorize_evaluation` maps every evaluation ID to its round, sample and split and refuses unknown IDs and other principals |
| 3. Incident replays keyed per round | Moot: incident replays are removed |
| 4. Best-of-5 inflates the false-pass rate | Moot as a gate, because no gate exists. The observation still applies to reporting: evolve gains are optimistic, and the held-out curve is the reported measure. |
| 5. Auto-rollout reads the wrong screening record | Applies in reduced form. The screen result lives on its candidate row, and `selection` binds the sample, version and digest it adopted. |
| 6. Audit reservation and runner-up leakage | Moot: no audits |
| 7. Evaluate all siblings against one pinned parent and append one edge | Applies: every sample derives from `parent_version_id`, and one adopt moves the channel at most once per round |
| 8. Serial evaluation and its cost | Applies: serial is the MVP (D3). Cost is not a constraint (D9). |
| 9. Parent cache over-allocation | Moot: no parent cache |
| 10. Attempt counting, recovery requeues every running proposal | Applies: one format retry inside the call, and recovery per `learning_optimizer_calls` claim that requeues only calls no live task holds. Identical samples are no longer dropped (see "Deliberate deviations"). |
| 11. Failure accounting and the contract sentence | Applies: failures are recorded per candidate, per evaluation and per round. The contract is rewritten. |
| 12. Close must cancel every child and seal selector input | Applies: `stop_round` cancels every evaluation and invalidates every unfinished optimizer call |
| 13. Refund from any sibling | Moot: no refunds |
| 14. Durable selection, and the null `promotion_id` bug | Durable selection applies: the `select` call's output is committed once, and a later transaction applies it, writing `selection`, the release and the write-back together. The bug is moot with the review route. |
| 15. Lesson text crossing connections through shared memory | Moot: no lessons. Evolve inputs from every app on the bundle reach the optimizer by design. |
| 16. Predictions before evaluation, outcome-to-case mapping | Applies for predictions. The mapping is moot: an outcome becomes the evolve case `outcome:<outcomeId>`. |
| 17. Pinned revision, head-row lock, never rewind | Applies (D6) |
| 18. Memory cannot grow forever under today's limits | Superseded by D5: those limits go and nothing is compacted. The model's context is the remaining limit (README question 4). |
| 19. Inspection and console assume one candidate | Moot: the old surfaces are removed and the new ones list candidates from the start |

Its state-machine advice (keep the top-level states, add subphases) is superseded by the new states in the README.

### Paper-scale experiment plan

Still applies:
- Fresh held-out cases, because the existing audit sets informed earlier engineering.
- Held-out scoring in the evaluator's own store, with no feedback to the optimizer or to operators during a run.
- A distinct bundle per transition, seed and arm, with identical starting payload digests for the transfer arms.
- No condition names in optimizer input. Conditions come from bundle setup, so the loop cannot see them.
- Integrity stop rules: a held-out leak, a cross-arm memory read, a digest or grader mismatch, an unplanned model change, a prediction written after evaluation, any memory truncation, and infrastructure failures above 5%. No efficacy peeking.
- The power figures as planning input: at a 4.64 pp paired SD, 10 pairs have about 31% power for +2.4 pp and 86% for +5 pp.
- The threats list: fixed task inventories, exact grader matching, shared latent events, memory changing token cost, every transfer arm inheriting a memory-optimized source, provider drift, best-of-5 inflation.

Superseded:
- The primary contrast Full SIM − Flat. D10 makes Full SIM − Harness Transfer primary. Flat is the optional descriptive control on the pre-change release build.
- 52 source runs and the cross-dataset transition. D10 runs 10 source runs on the cross-model transition first.
- Problem-Only and `historyMode`. They need modes (D2).
- `seeded-balanced-v1` paired randomization and the v3 step rule in the round protocol. No paired comparison or gate exists. Experiment.md sets the rollout order.
- Its turn budget. Without paired arms, a round over the plan's 40 evolve and 60 held-out cases with five survivors is up to 200 incumbent, 1,000 candidate and 300 held-out rollouts, up to 1,500 in all, plus 7 optimizer calls ([experiment.md](experiment.md) §14). These are planning estimates only (D9).
- The product needs `historyMode`, a private development-only path and checkpoint import. Moot, because the product loop is the experiment loop. The pinned parent, predictions frozen before evaluation and an atomic adopt-or-keep still apply.

## Review of the rewrite

A review of the rewritten folder (paper fidelity, consistency, and code accuracy at 4096ff1b) raised 27 points. All were applied, some with a choice between the reviewer's options. This table records the choices and the one point applied only in part.

| # | Point | Resolution |
| --- | --- | --- |
| 1 | Call model in optimizer.md contradicted loop.md | Applied. `advance_round` creates calls one at a time. `run_call(s, key)` is the task and `call_with_retry` the format-retry helper. A call commits only its own row. `advance_round` writes screen verdicts and runs adopt or keep in a later transaction. `sweep` skips keys held by live tasks. |
| 2 | Scanner placement | Applied. The scanner runs in the call task before commit. A finding commits `failed` / `scanner-rejected` with `output = {scan, diagnosis}`. |
| 3 | Error vocabulary | Applied, with one addition. `learning_optimizer_calls.error_code` holds `provider-failed`, `format-rejected`, `optimizer-context-too-large` and `scanner-rejected`, as asked, plus `cancelled` for calls that `cancel_children` closes, so every `failed` row has a code. The loop never reads `cancelled`. |
| 4 | Mid-round `PUT` | Applied. `409` for `channel`, `appPrincipalId` and `heldOut`. `setting` is accepted. `learning_rounds.channel` and `held_out` stay as pins and are on `LearningRound`. |
| 5 | `durable_commands` | Applied. `0017` deletes the `learning/%` rows and keeps the table and `DurableCommand`, so the schema has 19 tables. `DurableCommand` has no caller in phase 2 and gets a phase-2-only `allow(dead_code)`. |
| 6, 10 | `promote_in_tx` and the `reason` rename | Applied by dropping the rename. `unevaluated_reason` and `unevaluatedReason` keep their names, and only `comparisonId` and `policyOverride` go. `adopt` passes a `PromoteRequest` with no publication argument. The missed callers are listed in removal.md. |
| 7 | Phase 1 build | Applied. `LearningSelectionPolicy` is inlined as `Record<string, unknown>`, `toReviewArtifact` goes with `artifacts.ts`, `parseCommandJson` moves into `local.ts`, and the two Rust `policy_override: None` sites are listed. |
| 8 | Phase 2 build | Applied with option (a): phase 2 deletes `ProposalModel`, `OpenAiModel` and `AppState.provider`, and phase 4 adds `OptimizerModel` and a new client. `reconstruct(parent, content)` stays `pub` without `ProposalRequest`. `proposal_scanner` becomes a `pub mod` with `pub fn scan`. `changed_files` is restored in phase 4. The `create_setup` call to `internal_channel` is listed. |
| 9 | OpenAPI ranges | Applied |
| 11 | Run history across a setting change | Applied paper-first: history is the run in the current setting. Recorded under "Paper readings" for maintainer confirmation (README question 11). Experiment V2 is withdrawn. |
| 12 | `regressed` in memory | Applied paper-first: removed from the attempt table, `AttemptOutcome` and the rendered attempt. Still computed for the `select` input. |
| 13 | Experiment K1 key check | Applied with per-kind key sets |
| 14 | Experiment fixtures | Applied. Phase 2 moves the W1 fixtures and grader to `examples/self-improvement-memory/fixtures/w1/` with digests. The test moves to `examples/self-improvement-memory/tests/` with `test:sim-experiment`. |
| 15 | `GET /memory` and the app principal | Applied. `403` for the app principal. memory.md open question 4 is closed. |
| 16 | `app_principal` prefix check | Applied by dropping the check. Static grant principals stay accepted (evaluator-and-contracts.md open question 4). |
| 17 | Worker start-up | Applied. Phase 3 moves `worker_started()` from `invitation_worker` to `learning_worker`. |
| 18 | Indexes and checks in their owners' SQL | Applied. One merged `learning_candidates` definition in optimizer.md. |
| 19 | README names and state machine | Applied |
| 20 | Service-side trace and error caps | Applied: removed. The SDK runner's capture default stays and is listed above as a deviation. |
| 21 | Machinery the paper lacks | Applied in part. Removed: the select caution sentence, `duplicate` drops and rendered provenance extras. Kept as deliberate deviations, with reasons above: the screen's capability-widening criteria and the `failed-rounds` auto-pause. The reviewer allowed either. |
| 22 | Case concurrency | Applied: `caseConcurrency`, default 1 |
| 23 | loop.md open question 2 wording | Applied |
| 24 | Round-0 held-out | Applied. loop.md open question 3 is closed by experiment V4, and open question 5 notes the winner's-curse dependency. |
| 25 | Turn estimate | Applied: cites experiment.md §14 |
| 26 | Citations | Applied |
| 27 | Context-too-large pause reason | Applied. It overwrites an operator pause reason. |

No point was rejected outright. The parts not applied as first proposed are point 3's code list (one code added), point 21's two kept deviations, and the options chosen for points 8, 10, 14 and 16.
