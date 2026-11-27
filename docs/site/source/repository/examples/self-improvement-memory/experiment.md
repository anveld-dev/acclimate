# Self-improvement memory: experiment plan (pre-registration draft)

This file plans the paper-sized test of the main transfer claim of [arXiv 2611.18856](https://arxiv.org/abs/2611.18856) on the product loop itself (D10). It covers the conditions, splits, endpoints, statistics, power, the turn and token estimates, randomization, the integrity rules, the driver and its tests. Every product name comes from the [README](#names). The driver adds no product route, table, setting or mode.

The product loop is the experiment loop. The driver sets up bundles, starts and pauses loops, runs the evaluator with the right policy model, and reads the held-out curves. It never proposes, screens, selects, releases or writes memory. The service does all of that, as it would for any enrolled bundle.

Phase 5 tooling is complete. Phase 6, including the live pilot and paper-sized runs, has not started. The driver requires a frozen protocol and passing pilot report before S1 and S2. It follows the conventions of [the preregistration](https://github.com/anveld-dev/acclimate/blob/ab0d8d3b5ba7fd33a468d6526edcd5d87cb722ef/docs/research/real-app-learning-experiment/preregistration.md): frozen inputs with digests, zero-call checks, run order, turn accounting and a deviations log.

## 1. What the paper reports

Read in the HTML version on 2026-11-20.

| Item | Paper |
| --- | --- |
| Loop | N = 10 rounds and k = 5 candidates in every source and target run, five rollouts per task, "every rollout included in the score". "Only evolve-set feedback is available for proposing edits, selecting candidates, updating SIM, or deciding when to stop." |
| Conditions | Cold Start (H0, no memory), Harness Transfer (H_S, no memory), Problem-Only (root causes only) and Full SIM. "Each condition keeps its assigned memory condition throughout target RSI." Target runs keep "the ordinary target-run history", and "source history enters through SIM". |
| Paired study | Ten source runs on TB2.1, each continued twice on TB4, with SIM and without. Endpoint: the held-out TB4 score after ten target rounds. "The mean paired advantage is 2.36 points (95% CI [1.05, 3.68]; two-sided paired t(9) = 4.06, p = 0.003)", signed-rank p = 0.006, d_z = 1.28. |
| Transfer tables | Cross-dataset: Full SIM above Harness Transfer by 2.43 to 4.35 points. Cross-model (Claude Opus 5.5 source, Gemini 3.8 Flash target, same benchmark and split): by 3.60 to 11.33 points. No intervals are given. |
| Curves | "Held-out ... scores of retained harnesses after each target round". The text does not say whether a running maximum is used. This plan plots raw per-round scores (D10). |

The paper's paired study is cross-dataset. This plan's primary contrast is cross-model (D10), where the paper reports larger but unpaired differences.

## 2. Claims and contrasts

| ID | Claim | Contrast, paired by block | Role |
| --- | --- | --- | --- |
| T1 | After a policy-model change, continuing the source bundle beats starting the source harness on a new bundle | Full SIM − Harness Transfer, target-round-10 held-out score | **Primary** |
| T2 | The source harness beats a cold start on the target model | Harness Transfer − Cold Start, same endpoint | Secondary |
| T3 | Full SIM keeps the harness's source-model performance | Retention of Full SIM, non-inferiority at −3 pp | Secondary |
| — | Full SIM − Cold Start, retention of Harness Transfer, source-run gain, curves, mechanism metrics (§8.3) | Descriptive | Descriptive |

## 3. Conditions from bundle setup

A **block** b = 1…10 is one source run and its three target runs.

| Run | Bundle | Start harness | `setting.policyModel` | Memory at its first round | Run history at its first round |
| --- | --- | --- | --- | --- | --- |
| Source (S1) | New bundle B_S | H0 | `gpt-6-luna` | Empty | Empty |
| Full SIM | **B_S, continued** (rounds 11 to 20) | H_S, already on the learning channel | `gpt-6.2-sol` | The source run's memory | Empty. The source rounds have another `setting`, so `render_history` omits them, and source experience arrives only through memory, as in the paper. |
| Harness Transfer (HT) | New bundle B_HT | H_S, the same bytes | `gpt-6.2-sol` | Empty | Empty |
| Cold Start (CS) | New bundle B_CS | H0 | `gpt-6.2-sol` | Empty | Empty |

- **H_S** is the version on B_S's learning channel when the tenth completed source round ends. It is that round’s `adopted_version_id` on adopt or `parent_version_id` on keep. K1 rejects channel movement during a run.
- **H0** is `examples/self-improvement-memory/fixtures/w1/baseline.json`, adapted from the [pre-removal baseline](https://github.com/anveld-dev/acclimate/blob/4096ff1b60098554b0cb932866a338cadf29601c/examples/real-app-learning/baseline.json) for prompt-only W1. Its digest is frozen with the fixtures. Earlier calibration used the previous baseline and repository access (§9.1).
- **Memory** is per workspace + bundle (D6), so a new bundle starts empty. HT and CS build their own memory during the target run, where the paper's conditions have none (deviation V1).
- **Setting.** Every loop has `setting = {domain: "cli-support", benchmark: "llm-0.38-argv", policyModel}`. Only `policyModel` changes at the transition, so rules 2 and 4 see it in each attempt's `provenance`. The evolve split and the held-out split are the same in every run, so `evolve_revision` contents and `heldOut.digest` match across conditions.
- **Optimizer model.** `ACCLIMATE_MODEL=gpt-6.2-astra` and `ACCLIMATE_MODEL_REASONING_EFFORT=high` are frozen for `propose`, `screen` and `select` in every stage and condition. The study uses a separate, stronger optimizer, following the paper’s optimizer ablation (Appendix E.4.2). Both task models use low effort.
- **No condition names.** Bundles get random neutral slugs. The loop cannot see which condition it serves, because a condition is only which bundle and which start version.

Problem-Only is not run: it needs a memory view, which would be a mode (D2).

## 4. Workload and splits

All conditions use the same Codex-authenticated CLIProxyAPI endpoint. The driver reads its API key from `SIM_PROXY_API_KEY`. The source task model is `gpt-6-luna` and the target task model is `gpt-6.2-sol`, both at `low` effort. The optimizer is fixed at `gpt-6.2-astra` with `high` effort. Its loopback audit relay preserves the service’s OpenAI-compatible request.

### 4.1 Workload

| ID | Workload | Grader | Source |
| --- | --- | --- | --- |
| W1 | LLM CLI support: `llm` 0.38 at `46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f`, Click 8.5.1 | Exact Click route and parameters (`click-argv-v2`), binary ([grader](fixtures/w1/grade.py)) | `examples/self-improvement-memory/fixtures/w1/`, moved in phase 2 |

The task model receives two Chat Completions messages. The system message is the delivered harness rendered as instruction files, skills and memory files, in that order, each under a `# path` heading. The user message is the case input. The model returns a JSON object containing an `argv` array. The task model has no tools or repository access. The harness supplies the version-specific W1 knowledge, so the optimizer can learn which CLI details to write into skills. The pinned LLM package is used by the grader.

### 4.2 Splits

| Split | Product name | Size and origin | Reaches the optimizer? |
| --- | --- | --- | --- |
| E | The **evolve split**, rows of `learning_evolve_cases` with `source = setup` | 40: the 30 development cases from [tasks.py](fixtures/w1/tasks.py) plus the 10 development additions in `fixtures/w1/40-case-additions.json` | Yes, as `feedback` and through `history` and memory |
| H | The **held-out split**, in the driver's evaluator store, committed by `heldOut = {digest, cases: 60}` | 60 new cases | Never |

- **H is all new.** The 70 existing audit cases (30 original, 30 in `fixtures/w1/replication-audit.json`, 10 additions) informed earlier engineering, so none is reused. The 10 field cases are not used.
- Each H case has a reference argv and two negative controls, checked against every earlier case ID, input and parsed target, by [freeze.py](freeze.py#L37). H case IDs are opaque (`h-` plus eight lowercase hex digits) so a leak is detectable without content.
- **E is fixed for the whole experiment.** The driver seeds each new bundle once with `POST /evolve-cases` and never calls `POST /outcomes` or retires a case. Every round of every run therefore pins the same `evolve_revision` content, which is what the paper's fixed X_evo needs (D4 stays available to apps; the experiment does not use it).
- **Traces.** For W1 a rollout's `trace` is the argv JSON the agent returned and `error` is the turn or parse error message, if any. Held-out reports carry only `score` and `passed`. The pilot records trace sizes (§11).

### 4.3 Why 60 held-out cases

At five rollouts, measurement noise of one held-out difference is about 2.0 to 2.2 pp at 60 cases and 2.5 to 2.7 pp at 40 (§9.1). Held-out rollouts are 20% of a round's turns, so the extra precision is cheap.

## 5. Stages and topology

| Stage | What | Gate to the next stage |
| --- | --- | --- |
| S0a | Model-free dry run of the driver with a fake optimizer and a fake policy (§13) | All integrity checks pass |
| S0b | Validate and freeze the checked-in H fixture: zero-call checks, disjointness and digests | Preregistration committed |
| S0c | Live pilot: 2 source runs of 3 rounds, then 1 round of each target condition from one of them | Pilot gates (§10, K3), including the target round-zero ceiling check. Pilot data is excluded from efficacy analysis. |
| S1 | 10 independent source runs of 10 rounds | Harm stop only (K4 applies to S2) |
| S2 | For each block, the 3 target runs of 10 rounds, plus round-0 and retention scoring | none |
| C (optional) | Pre-change Flat control (§16) | none. Runs alongside S1 and S2. |

- **One cluster per source run.** Each block's S1 runs on its own disposable PostgreSQL cluster and service, owned by [run.py](run.py#L86) using [Harness.start_database](../../scripts/productization/qualify.py#L69).
- **Checkpoint.** When source round 10 has `completed` and the loop is `paused`, the driver stops the service and copies the stopped data directory. That copy is the block's checkpoint.
- **One copy per target condition.** Each target run gets its own service on a fresh checkpoint copy. Full SIM continues B_S in its copy. HT and CS create new bundles in theirs; B_S stays `paused` there and never runs. Separate copies keep the conditions from sharing a worker queue, and a restart (K5) needs only a new copy, because memory is never rewound.
- **Start order.** The three target runs are submitted concurrently in a seeded order (§7). Blocks are visited sequentially by one driver invocation.

## 6. Per-run protocol

### 6.1 Setup of a new bundle (Source, HT, CS)

1. Configure a private static app grant with the `evaluate` right on the isolated service. Keep the app principal ID across checkpoint copies. The public learning routes also accept a workspace machine token with this right.
2. Create the bundle with a neutral slug. Publish the start payload as its first version: H0 bytes for Source and CS, and H_S bytes for HT (resolved from B_S with the SDK, digest verified). Release it to the channel `learning` with the kept channel release route.
3. `PUT /v1/workspaces/{workspaceId}/bundles/{bundleId}/learning`:

   ```json
   {
     "channel": "learning",
     "appPrincipalId": "experiment-evaluator",
     "setting": {"domain": "cli-support", "benchmark": "llm-0.38-argv", "policyModel": "gpt-6.2-sol"},
     "heldOut": {"digest": "sha256:…", "cases": 60}
   }
   ```

4. `POST …/learning/evolve-cases` with the 40 E cases and `retire: []`. Record the returned `evolveRevision`.
5. Start the driver's evaluator for this bundle (§12) with the run's policy model.
6. Assert that round 1 pinned the step 4 revision (need N1, §11) and that HT's round-1 `parent_version_id` has the same digest as H_S.

### 6.2 Full SIM transition

On the Full SIM copy of the checkpoint, B_S is `paused` after round 10.

1. `POST …/learning/stop`. No round is active, so only the status changes.
2. Restart the evaluator with `gpt-6.2-sol`.
3. `PUT …/learning` with the same `channel`, `appPrincipalId` and `heldOut`, and `setting.policyModel = "gpt-6.2-sol"`. The loop goes `stopped` → `running`, and memory and history continue.
4. Assert that round 11's `parent_version_id` is H_S, its `memory_revision` equals the source run's final memory revision, its `evolve_revision` equals the source run's, and its rendered `history` is empty.

### 6.3 Counting rounds and stopping at 10

A run counts `completed` rounds. Failed rounds are logged separately. The driver pauses during the final counted round, including a pause from the evaluator's incumbent context lookup, so that round can finish without a successor. If it fails and the loop is paused without an active round, the driver resumes. On reaching the count it requires a paused loop, no active round and the next expected round number. A mismatch stops the loop and invalidates the run (K1). [Round counting](block.ts#L465)

The target index `r` counts completed rounds. Keep the separate bundle round number in the ledger. When no rounds fail, Full SIM's bundle rounds 11 to 20 are r = 1 to 10.

### 6.4 Each round

The driver does nothing inside a round except serve evaluations. After each round ends it:

1. Reads `GET …/learning/rounds/{roundId}` (candidates, evaluations, selection) and `GET …/learning/memory?revision=` at the round's `memory_revision`.
2. Matches the retained evaluation's version to the round's adopted or kept version and its score to the local log (§8.1). At the end, checks that the final retained version equals the learning channel head.
3. Writes the public round fields plus `block`, `code`, `r`, `parent`, `retained`, `memory`, `optimizer` and `turns` to `artifacts/sim-experiment/<stage>/b<block>/<code>/rounds.jsonl`. `r` is the counted index for a completed round and null otherwise. `optimizer` contains the request ledger entries for that round. `turns` is keyed by `incumbent`, `candidate`, `retained` and `rescore`.

When retained evidence fails or exceeds the per-evaluation infrastructure threshold, the driver measures the retained version offline and records it in `retained.replacement`. For a successful in-loop measurement, the driver reconciles the score against the local rollout log within 1e-9. `summary.json` records the final version, pins, round-zero measurement and counts. `ledger.json` hashes the run files and, for a source run, the stopped database checkpoint. [Evidence writing](block.ts#L540), [artifact verification](run.py#L133)

## 7. Randomization and blinding

No paired comparison exists in the loop, so there is no arm order to balance. The remaining sources of order effects are seeded.

| What | Rule |
| --- | --- |
| Target start order in a block | Sort the three conditions by SHA-256 of the JSON array `[seed, "start", block, originalIndex]`. Submit them in that order to separate services. |
| Rollout order in every evaluation | Offline evaluations sort case/rollout pairs by SHA-256 of `[seed, block, code, number, role, sample, originalIndex]`. The SDK owns the in-loop case schedule. Apply the seed with case ID added to assign local rollout labels within each case. |
| Condition labels | Coded A, B, C per block by sorting conditions on SHA-256 of `[seed, "codes", block, originalIndex]`. The driver writes the private mapping to `artifacts/sim-experiment/key.json`. It uses the key for the harm check and retention. Final analysis writes `coded.json` before reading the key to label contrasts. |
| Case IDs | E keeps its fixture IDs. H IDs are opaque (§4.2). |

The assignment of condition to bundle is not random: Full SIM is by definition the continued bundle. Bundles, versions and requests carry no label, so the optimizer and graders cannot see it.

## 8. Endpoints

### 8.1 The score

`Y(c, b, r)` is the `held_out_score` of the `retained` held-out evaluation of target round r of condition c in block b: the mean over the 60 H cases, weighted equally, of each case's mean rollout `score` over its 5 rollouts, under `gpt-6.2-sol`. The driver reconciles scored evidence against its local rollout log. Analysis recomputes the endpoint from the rollout ledger and checks it against the recorded service score or offline replacement.

`Y(c, b, 0)` is the start harness's held-out score under the target model. The loop does not score a version before round 1, so the driver scores it with the same evaluator function outside the loop (deviation V4). H_S is scored once per block for both Full SIM and HT.

### 8.2 Endpoints

| Endpoint | Definition |
| --- | --- |
| Target final (primary) | `Y(c, b, 10)` |
| Jump start | `Y(c, b, 3) − Y(c, b, 0)` |
| Curve area | Mean over r = 1…10 of `Y(c, b, r) − Y(c, b, 0)`. The driver writes per-round means and 95% intervals across blocks to `curves.tsv` without a running maximum. |
| Retention | `R(c, b) = Y_luna(final harness of c) − Y_luna(H_S)`, all three scored by the driver on H under `gpt-6-luna` in one window after S2, for Full SIM and HT |
| Source gain | `Y(Source, b, 10) − Y(Source, b, 0)`, descriptive |

### 8.3 Mechanism metrics (descriptive)

| Metric | Definition, from rounds, evaluations and memory |
| --- | --- |
| Keep rate and reasons | Share of counted rounds with `kept`, by `reason` |
| Screening yield | `screened_out` share of `generated` samples, and `dropReason` counts |
| Problem reuse | Share of target samples whose `diagnosis.problem` names an existing ID. For Full SIM, the share naming a problem with `openedRound` at or before the source run’s `lastNumber`. |
| Prediction precision | Over adopted attempts, the number of `fixed` cases divided by the number of `predicted` cases. Null comparison: the fix rate among incumbent-failing E cases the attempt did not predict. Interpreted only with at least 100 pooled predictions. Cases with 1 to 4 passing incumbent rollouts are reported separately as flaky. |
| Unpredicted regressions | Per adopted attempt, E cases that pass on the incumbent and fail on the candidate (at least three passing rollouts) and were not predicted |
| Winner's curse | For each adopted round, the adopted candidate's `evolve_score` minus the next round's `incumbent_score`, which re-measures the same version with fresh rollouts. For the final adoption, use the offline final evolve measurement. This estimates best-of-five inflation using the loop’s fresh incumbent evaluation each round. |
| Overfitting gap | Evolve gain from the round-1 incumbent score to an offline remeasurement of the final retained harness, minus the held-out gain. The offline measurement runs after the loop is paused and creates no learning round. |
| Context growth | Rendered optimizer input bytes by prompt key, and total provider-reported tokens per request and round |
| Turns and tokens | Per condition and per adopted round. Information only. |

## 9. Statistics

All analysis is in `examples/self-improvement-memory/analyze.py`, frozen with the preregistration.

| Item | Rule |
| --- | --- |
| Unit | The block. One difference `D_b` per contrast. n = 10. |
| T1 | Two-sided paired t at α = 0.05, tested alone |
| T2 | Two-sided paired t |
| T3 | One-sided paired t at 0.05: the lower 95% bound of mean `R` above −3 pp |
| Multiplicity | Holm over T2 and T3. T1 is the single primary test. Unadjusted p values are also reported. |
| Robustness | Exact Wilcoxon signed-rank, two-sided, zero differences dropped (`zero_method="wilcox"`), with the count of zeros. At n = 10 the smallest attainable p is 2/1024. A claim needs the t test to pass and the signed-rank to agree in sign. A signed-rank p above 0.05 is reported as a qualification. |
| Interval | 95% t interval for the mean difference. Hodges-Lehmann median and its exact interval as a supplement. |
| Effect size | `d_z = mean(D) / sd(D)`, with a 95% interval from the noncentral t |
| Measurement precision | A case-bootstrap SE for each `Y` (2,000 seeded resamples). Reported, not tested. |
| Missing data | A held-out evaluation that is `failed` (`held_out_error`) or has more than 5% infrastructure-failed rollouts is rescored by the driver on the same bytes, outside the loop, and flagged. A run that cannot finish after 2 restarts drops its block from every contrast that uses it, and the drop is reported. |
| Sensitivity | (a) Exclude flaky H cases (H0's 5 luna rollouts disagree). (b) Exclude blocks whose source run adopted nothing (H_S = H0). (c) Curve area instead of the final score. |

| T1 result | Reading |
| --- | --- |
| Passes with mean ≥ +3.6 pp | Consistent with the paper's smallest cross-model gap |
| Passes with mean below +3.6 pp | A smaller effect than the paper's cross-model range |
| Does not pass | Inconclusive at n = 10 (§9.2). The blocks give `σ̂_D` for sizing a follow-up. |
| K4 fires | Evidence of harm. It goes to the maintainer. |

The loop ships before the experiment runs. The result does not change product behaviour by itself.

### 9.1 Measurement noise

S0c re-measures repeat-rollout noise and cost on the prompt-only task. Record the fraction of complete held-out evaluation/case groups with mixed pass/fail outcomes and estimate the noise of a difference between two held-out runs using their within-case variance and five repeats. Record token use and latency by model and update the precision and cost estimates before S1. Earlier Codex-agent runs had source access. Their A/A calibration below is historical context and cannot establish comparability or calibrate the new measurements.

| Source | Cases | Reps per arm | Paired SD of case means |
| --- | ---: | ---: | ---: |
| First experiment ([README.md](https://github.com/anveld-dev/acclimate/blob/ab0d8d3b5ba7fd33a468d6526edcd5d87cb722ef/docs/research/real-app-learning-experiment/README.md#L21)) | 30 | 1 | 0.43994 |
| 30-case replication ([replication.md](https://github.com/anveld-dev/acclimate/blob/ab0d8d3b5ba7fd33a468d6526edcd5d87cb722ef/docs/research/real-app-learning-experiment/replication.md#L26)) | 30 | 2 | 0.25400 |
| 40-case run ([40-case.md](https://github.com/anveld-dev/acclimate/blob/ab0d8d3b5ba7fd33a468d6526edcd5d87cb722ef/docs/research/real-app-learning-experiment/40-case.md#L22)) | 40 | 2 | 0.27050 |
| Five-admission rerun ([5-admission-rerun.md](https://github.com/anveld-dev/acclimate/blob/ab0d8d3b5ba7fd33a468d6526edcd5d87cb722ef/docs/research/real-app-learning-experiment/5-admission-rerun.md#L15)) | 40 | 2 | 0.24693 |

If the disagreement is trial noise, the SD of a case-mean difference scales as `sqrt(2/r)` from r = 2. From 0.247 to 0.271, one held-out difference between conditions has noise of:

| H cases | r = 5 |
| ---: | ---: |
| 30 | 2.9 to 3.1 pp |
| 40 | 2.5 to 2.7 pp |
| 60 | **2.0 to 2.2 pp** |

### 9.2 Power at n = 10

Each `D_b` also carries run-to-run variation of the loop, `σ_b`, which no existing data measures after 10 rounds. The only proxy is five candidates from one baseline in the five-admission rerun, with development gains +2.5, +2.5, 0, −1.25 and +15 pp ([5-admission-rerun.md](https://github.com/anveld-dev/acclimate/blob/ab0d8d3b5ba7fd33a468d6526edcd5d87cb722ef/docs/research/real-app-learning-experiment/5-admission-rerun.md#L48-L52)): SD 6.5 pp, about 5 pp after removing the 3.9 pp measurement SE. Full SIM and HT start from the same bytes, which may correlate them and shrink `σ_D`. The historical 2.1 pp noise gives the illustrative uncorrelated calculation `σ_D ≈ sqrt(2σ_b² + 2.1²)`. Update it with S0c measurements.

Two-sided paired t at α = 0.05, noncentral t, computed:

| `σ_D` | Power, +2.4 pp | Power, +3.6 pp | Power, +5 pp | n at 80%, +2.4 pp | n at 80%, +5 pp |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2.93 pp | 64% | 93% | > 99% | 14 | 5 |
| 4.64 pp | 31% | 59% | 86% | 32 | 9 |
| 5.52 pp | 23% | 45% | 72% | 44 | 12 |
| 6.00 pp | 20% | 40% | 65% | 52 | 14 |
| 8.00 pp | 14% | 25% | 42% | 90 | 23 |

The 4.64 pp row is the Astra planning figure. n = 10 detects d_z ≈ 1.0 with 80% power, and the paper's d_z = 1.28 with about 95%. It is underpowered for effects near +2.4 pp unless `σ_D` is under 3 pp. Fresh memory in HT (V1) may make the true difference smaller than the paper's.

There is no interim re-estimation. A larger study is a separate decision, sized from this study's `σ̂_D`, on fresh blocks under a new preregistration, and never pooled with these blocks.

## 10. Integrity rules and stops

These checks live in the driver and in read-only queries on the driver's own clusters. None is product code.

| ID | Trigger | Action |
| --- | --- | --- |
| K1 Integrity | Any of: an H case ID or the fingerprint of a whole H input appears in an optimizer request; a held-out report carries `trace` or `error`; the fenced data of an optimizer request holds a key outside its kind's set (`setting`, `harness`, `feedback`, `history` and `improvementMemory` for every kind, plus `candidates` for `screen` and `select`, plus `parserError` on a retry, as in [optimizer.md](https://github.com/anveld-dev/acclimate/blob/e636c0beef2d313b5116c226b156ee6624a81573/docs/architecture/self-improvement-memory/optimizer.md) "Data keys"); a condition code or bundle slug appears in an optimizer request or a delivered payload; memory JSON or a `P<n>` ID appears in a delivered payload or task prompt; a sample's evaluation appears in `GET /work` before the adapter returned that sample's `propose` reply, or the stored `diagnosis` differs from that reply; an adopted attempt's `predicted` differs from its candidate's `diagnosis.predicted`; Full SIM's round 11 does not pin the source run's final memory revision, or an HT or CS round 1 pins a nonzero one; Full SIM and HT start digests differ; `evolve_revision`, the E content digest or `heldOut.digest` differs within a block; the round’s optimizer model or reasoning effort differs from the frozen protocol, or task and optimizer call ledgers differ from the frozen Chat Completions endpoint, model or effort; an evaluation ran under a policy model other than its round's `setting.policyModel`; the rendered `history` lists fewer rounds than the earlier rounds with the same `setting`, or `improvementMemory` lists fewer attempts than `memory_revision`; any `POST /outcomes`, evolve-case change, manual channel release or `channel-moved` round during a run; the loop advanced beyond its counted round limit | Stop the stage. Fix. Restart every affected run (target runs from a fresh checkpoint copy). |
| K2 Context | Any round `failed` with `optimizer-context-too-large`. Memory and history only grow within a run, so the loop cannot continue on that bundle. Full SIM, which carries up to 20 attempts of memory beside 10 rounds of target history, is hit first. | Stop the stage for a maintainer decision. A larger-context optimizer model is an amendment and restarts every block. |
| K3 Pilot | Either target round-zero W1 held-out score (H0 or H_S under `gpt-6.2-sol`) is ≥ 85%; `format-rejected` above 20% of samples; no `adopted` round in the 6 pilot source rounds; the pilot's measured input growth projects Full SIM's round-20 input (10 rounds of history, up to 20 attempts) above 50% of the optimizer's context; missing token usage for either task model; any K1 event | Stop before S1 for a maintainer decision if either baseline reaches the ceiling threshold. For other failures, fix and repeat the pilot or pause for a maintainer decision. Pilot data is excluded from efficacy analysis. |
| K4 Harm | After 5 completed blocks, the upper 95% bound of mean T1 is below −5 pp. `analyze.py` reports only whether it fired. | Stop and report. Harm-only, so it does not inflate T1's type I error. |
| K5 Infrastructure | A service exit, a run stuck for 2 hours, a loop paused with `failed-rounds`, or more than 5% of a run's rollouts failing for infrastructure reasons (the evaluator retries such a rollout once before reporting it). The first experiment lost its lease under concurrent lint ([README.md](https://github.com/anveld-dev/acclimate/blob/ab0d8d3b5ba7fd33a468d6526edcd5d87cb722ef/docs/research/real-app-learning-experiment/README.md#L69)). | Restart the run with the same seeds, at most twice: a source run from scratch, a target run from a fresh checkpoint copy. No repository lint or builds during live stages. |
| K6 Drift | The provider announces a change to `gpt-6-luna`, `gpt-6.2-sol` or `gpt-6.2-astra` during a stage | Pause. Blocks from before and after are not mixed in one contrast without a recorded amendment. |

There is no efficacy stop and no efficacy peeking. Analysts see only integrity and infrastructure counts until every block is done.

In Appendix E.4.2, the stronger optimizer’s held-out edge shrank to 0.05 points on the higher-scoring seed. S0c records both target round-zero measurements in the pilot report. S1 requires a passing report in the final preregistration.

### 10.1 SQL integrity checks

The read-only checks validate the setting and evolve pins, optimizer model and effort, memory revision, retained version, held-out report fields, diagnosis presence and adopted predictions. `run.py` supplies the workspace and bundle, round range and frozen optimizer identity. Each row returned names a failed invariant. [Executable SQL](checks.sql)

## 11. What the driver needs from the product

Everything here is in the README names. N1 and N2 are specified by their owners.

| Need | Surface | Owner |
| --- | --- | --- |
| Enroll, pause, resume, stop, change the setting between rounds | `PUT`, `POST /pause`, `/resume`, `/stop` | loop.md, evaluator-and-contracts.md |
| A fixed evolve split | `POST /evolve-cases`, no outcomes | evaluator-and-contracts.md |
| Held-out cases that never leave the evaluator | `heldOut`, `retained` evaluations, the `400` for a held-out report with traces | evaluator-and-contracts.md |
| Per-round candidates, diagnoses, screens, evaluations and selection | `GET /rounds/{roundId}` | evaluator-and-contracts.md |
| Memory at the revision a round pinned | `GET /memory?revision=` | memory.md |
| The optimizer endpoint as a local adapter | `ACCLIMATE_MODEL_ENDPOINT`, `ACCLIMATE_MODEL_TOKEN` and the [audit relay](adapter.ts) | optimizer.md |
| A failure, never a trim, on overflow | `optimizer-context-too-large` | optimizer.md |
| **N1.** No round starts on an empty evolve split, so a new bundle's round 1 sees the setup cases | `start_round` precondition | loop.md |
| **N2.** A per-evaluation case concurrency, for wall clock only (§14 uses 8) | `serveLearningLoop` option `caseConcurrency`, default 1 | evaluator-and-contracts.md |

The driver verifies N1 (§6.1 step 6). The SDK exposes neither a per-evaluation case-order hook nor the evaluation ID and pinned setting in execution callbacks. The driver binds callback evidence through app-authorized `GET /work` and reader-authorized round details. Full in-loop case randomization would require a scheduler hook.

## 12. Driver

### 12.1 Responsibilities

The driver does:

- own the PostgreSQL clusters, services, checkpoints and copies;
- create workspaces, app principals, bundles, start versions and the learning channel, and enroll each loop;
- run one evaluator per bundle with `serveLearningLoop` and `caseConcurrency: 8`: call the frozen Chat Completions endpoint with the stage’s policy model, grade with `fixtures/w1/grade.py`, report evolve rollouts with `trace` and `error` and held-out rollouts with `score` and `passed` only, and log every rollout locally;
- hold H and compute `heldOut.digest`;
- proxy every optimizer request through the logging adapter and run the K1 request checks;
- pause each run after 10 counted rounds and perform the Full SIM transition;
- score round 0 and retention outside the loop with the same evaluator function;
- write round records, run the SQL checks, and run the analysis.

The SDK renders task prompts. The service constructs optimizer requests and owns candidate selection, version releases and memory writes. The old plan's trigger split, corrections, calibration settings, idle-flush settings and audit cohorts are gone with the machinery they fed.

### 12.2 Files

All files in this table live under `examples/self-improvement-memory/`. The driver uses `tsx` internally. Native TypeScript loading applies to the SDK’s `acclimate learn` configuration.

| File | Role |
| --- | --- |
| `run.py` | Entry point for `S0a`, `S0c`, `S1` and `S2`. Live stages require `--live`, `--freeze` and `--proxy-config`. Owns clusters through `qualify.Harness`, takes checkpoints and makes target copies. `--service-bin` selects the frozen service executable. Resumes by block and condition. Stage C needs its own pre-change driver. |
| `main.ts` | Node entry for a condition, freeze metadata or retention. |
| `fake_proxy.py` | OpenAI-compatible fixture for model-free runs. |
| `block.ts` | One condition: §6 setup, the Full SIM transition, round counting and pause, round records. The Python entry point submits targets in the seeded order. |
| `conditions.ts` | The §3 table as data |
| `evaluator.ts` | The `serveLearningLoop` handler: SDK OpenAI-compatible call, grading with the pinned Python grader, seeded offline rollout order and in-loop labels, the infrastructure retry, the local rollout log, the policy-model check |
| `heldout.ts` | The local H store, `heldOut.digest`, and round-0 and retention scoring |
| `adapter.ts` | The optimizer audit relay. Checks each service request and forwards the body unchanged to the same frozen CLIProxyAPI endpoint used by the task model. Logs endpoint, model, effort, bytes, digest and token usage. |
| `checks.sql` | Read-only integrity checks (§10.1) |
| `fixtures/w1/baseline.json`, `tasks.py`, `40-case-additions.json`, `grade.py`, `check-replication.py`, `replication-audit.json`, `SOURCES.json` | H0, E, the grader and the earlier audit cases, moved in phase 2. `SOURCES.json` holds each file's original path and SHA-256. |
| `fixtures/w1/held-out.json` | The 60 H cases with references and negative controls |
| `freeze.py` | Zero-call checks, disjointness by fingerprint, SHA-256 digests for the preregistration |
| `analyze.py` | §8 and §9, from `rounds.jsonl` and the rollout logs to `analysis/*.json` and tables |
| `tests/sim-experiment.test.ts` | The model-free driver test (§13), run by the `test:sim-experiment` npm script |
| `README.md` | How to reproduce |

Raw evidence stays under `artifacts/sim-experiment/` and is not published, as with earlier experiments.

## 13. Tests

| Test | Checks |
| --- | --- |
| `examples/self-improvement-memory/tests/sim-experiment.test.ts` (`npm run test:sim-experiment`, model-free, owned PostgreSQL) | A fake optimizer returns fixed edits, diagnoses, screens and selections, and a fake policy returns seeded argv. One block runs a 2-round source and the 3 target conditions for 2 rounds on tiny fixtures from a real checkpoint copy. Asserts: Astra at high effort in round provenance and optimizer requests; 5 samples per round; Full SIM's first target round pins the source memory revision and renders an empty history, and HT and CS start at 0; diagnoses predate their evaluations; Full SIM and HT start digests match; no H case ID is accepted by the relay; held-out reports carry no traces; the retained evaluation binds the channel head; the pause stops at exactly the planned count; the §10.1 queries return the expected rows. |
| `examples/self-improvement-memory/test_analyze.py` | Synthetic blocks with a known effect. The paired t, signed-rank, intervals, d_z and Holm results match SciPy references. |
| `examples/self-improvement-memory/test_freeze.py` | Disjointness rejects a duplicated input under a new ID. Each negative control fails the grader. |
| K1 unit tests in `tests/adapter.test.ts` | A request with an H case ID, a whole H input, a condition code or a key outside its kind's set is refused and aborts the stage. `setting` on every kind and `parserError` on a retry are not flagged. An input shared with E is not flagged. |

## 14. Turn and token estimates

Planning information only. No stage stops or pauses on spend (D9).

### 14.1 Anchors

| Anchor | Source | Input tokens per turn | Output tokens per turn | Seconds per turn |
| --- | --- | ---: | ---: | ---: |
| Main | Five-admission rerun: 1,304 turns, 22,174,986 input and 54,649 output tokens, 2 h 0 min 48 s ([5-admission-rerun.md](https://github.com/anveld-dev/acclimate/blob/ab0d8d3b5ba7fd33a468d6526edcd5d87cb722ef/docs/research/real-app-learning-experiment/5-admission-rerun.md#L111-L113)) | 17,005 | 42 | 5.56 |
| Slow | First experiment: 255 attempts in about 44 minutes, 6,329,265 input tokens over 253 ([README.md](https://github.com/anveld-dev/acclimate/blob/ab0d8d3b5ba7fd33a468d6526edcd5d87cb722ef/docs/research/real-app-learning-experiment/README.md#L40)) | 25,017 | — | 10.35 |

The earlier proposer averaged about 15,000 input tokens ([5-admission-rerun.md](https://github.com/anveld-dev/acclimate/blob/ab0d8d3b5ba7fd33a468d6526edcd5d87cb722ef/docs/research/real-app-learning-experiment/5-admission-rerun.md#L106)). The planning estimate reserves 60,000 input tokens per high-effort Astra optimizer call because full history, memory and five evaluated candidates can make requests larger. S0c measures Astra’s actual input, output and latency.

### 14.2 Per round and per run

A round's rollouts are `5·|E|` for the incumbent, up to `5·5·|E|` for the survivors and `5·|H|` for the retained version. With |E| = 40 and |H| = 60:

| Unit | Rollouts |
| --- | ---: |
| Incumbent on E | 200 |
| Survivors on E, worst case 5 | ≤ 1,000 |
| Retained on H | 300 |
| **Round** | **≤ 1,500**, plus 7 optimizer calls (5 `propose`, `screen`, `select`) and up to 7 format retries, plus any provider transport retries |
| **Run, 10 rounds** | **≤ 15,000** |

Per block: source 15,000 + H0 round 0 under luna 300; targets 3 × 15,000 + round 0 of H_S and H0 under sol 600 + retention 900. **62,400 rollouts**, including 600 offline evolve rollouts, and 280 optimizer calls.

### 14.3 Totals, worst case, main anchor

| Stage | Rollouts | Optimizer calls | Input tokens | Output tokens | Serial turn-hours |
| --- | ---: | ---: | ---: | ---: | ---: |
| S0c pilot | 14,700 | 63 | 0.25 B | 0.6 M | 22 |
| S1 + S2, 10 blocks | 624,000 | 2,800 | 10.8 B | 26 M | 964 |

- Input tokens include optimizer calls at 60,000 each (about 0.17 B for S1 and S2). Output-token and serial-hour totals use the task-policy anchor. Use S0c to add Astra’s output tokens and time, including high-effort reasoning. At the slow anchor the main stages use about 15.6 B input tokens and 1,777 serial turn-hours.
- **Critical path.** With case concurrency 8 (N2), a round takes about 17 minutes of rollouts (1,500 / 8 × 5.56 s) plus a provisional 10 minutes for high-effort Astra calls, so a run takes about 4.5 hours and a block about 9.5 hours (source, then the three targets together). At concurrency 1, a round takes about 2.5 hours and a block 50 to 55 hours.
- **Wall clock.** With all 10 blocks in parallel: about 30 hours at an account limit of 32 concurrent turns, and about 10 hours (the critical path) at 160.
- **Unknowns.** `gpt-6.2-sol` policy and high-effort `gpt-6.2-astra` optimizer tokens and latency are unmeasured. The pilot measures them, and the frozen estimates are updated before S1.

## 15. Deviations from the paper

| ID | Paper | This plan | Reason |
| --- | --- | --- | --- |
| V1 | HT and CS have no memory throughout the target run | They start empty and build their own memory. T1 measures inherited memory over fresh memory, which may be smaller than the paper's gap. | Memory is always on (D2, D6) |
| V2 | (Withdrawn.) Target runs keep only target-run history; source history enters through SIM | Now the same: `render_history` lists only earlier rounds with the round's `setting`, so Full SIM's target run starts with empty history | [decisions.md](https://github.com/anveld-dev/acclimate/blob/e636c0beef2d313b5116c226b156ee6624a81573/docs/architecture/self-improvement-memory/decisions.md#paper-readings-that-still-hold) |
| V3 | Four conditions | Full SIM, HT and CS | Problem-Only needs a memory view (D2) |
| V4 | The start harness's held-out score | Scored by the driver outside the loop | The loop scores held-out only after a decision |
| V5 | Paired study cross-dataset, transfer tables both | Cross-model only | D10. A second transition needs its own source runs. |
| V6 | Agent trajectories as traces | The returned argv and error | W1's agent returns one structured answer |
| V7 | Memory per run | Memory per workspace + bundle, one bundle per condition | D6. Full SIM continuing B_S has exactly the source memory. |

## 16. Optional descriptive control: pre-change Flat

The pre-removal product carried flat `priorAttempt` history: at most 12 rounds and 8,192 bytes. [Pre-removal implementation](https://github.com/anveld-dev/acclimate/blob/4096ff1b60098554b0cb932866a338cadf29601c/src/connected_learning_worker.rs#L538-L542) This optional control would run against the pre-change build identified by `pre-learning-loop`, with a separate driver. It is outside the implemented stage runner. Per block it runs one source leg (H0, `gpt-6-luna`, 10 rounds of connected learning with k = 1 and the pre-removal gates, triggered by corrections from the 10 field cases) and renews the same connection across the model change with the [pre-removal renewal route](https://github.com/anveld-dev/acclimate/blob/4096ff1b60098554b0cb932866a338cadf29601c/contracts/learning.md). The driver scores its released version on the same H after each round with its local evaluator.

It is unpaired and differs from the new loop in k, memory, gating, triggers and feedback at once, so it is descriptive only: how the pre-removal loop compares with the current one on the same workload and transition. Its exact protocol is frozen in the preregistration only if it runs (open question 1).

## 17. Threats to validity

| Threat | Handling |
| --- | --- |
| Best-of-5 selection inflates evolve gains, and no gate filters it | The endpoint is held-out and never reaches the optimizer. The winner's curse and overfitting gap (§8.3) report the inflation. |
| Every transfer condition inherits a harness optimized with memory | T1 measures memory's value at the target only |
| A fixed E is reused every round | H is fixed and never seen. The overfitting gap reports the difference. |
| Exact Click matching under-credits equivalent argv | The same grader applies to every condition, so it affects levels more than contrasts |
| Memory and history change token use | Tokens per condition and per adopted step are reported |
| Shared latent events across E and H families | H inputs are new and checked for disjointness by fingerprint. Families overlap by design. |
| Task performance depends on model priors and harness knowledge | All conditions use the same prompt-only interface. Re-measure repeat-rollout noise and cost in S0c. Historical repository-enabled Codex runs are a different workload setup. |
| Proxy translation can change provider semantics | Fix the CLIProxyAPI revision, configuration and Codex credential across conditions. Verify the requested model IDs and live behavior in S0c. The inspected Codex route does not enforce `json_object` mode. |
| Provider drift | One calendar window for every block, and K6 |
| Thin traces (V6) give the optimizer less to diagnose | The same for every condition. Mechanism metrics show whether diagnoses still predict fixes. |

## 18. Reused from earlier plans

| From | Kept | Dropped |
| --- | --- | --- |
| The earlier experiment.md | W1, H0, E = the 40-case development set, 60 new held-out cases, blocks and checkpoint copies, the statistics table, the measurement-noise derivation, K1 to K6, the driver layout and tests, the freeze checklist | The trigger split F, corrections, audit cohorts PA_S and PA_T, A/A calibration, the 99% step gate, idle and chain-age flush settings, renewal for Full SIM, carry-forward held-out scores, the memory byte cap |
| Astra's plan | Fresh held-out cases; held-out in the evaluator's own store; a distinct bundle per block and condition with identical start digests for the transfer conditions; no condition names in optimizer input; the integrity stop rules; no efficacy peeking; the power figures; the threats list | Full SIM − Flat as primary (D10 makes Full SIM − HT primary); 52 source runs and the cross-dataset transition; Problem-Only and `historyMode`; `seeded-balanced-v1` paired order and the v3 step rule; its paired-arm turn budget; checkpoint import and a private development-only path |

## 19. Freeze checklist

- The Acclimate service commit, and the Rust, Node, Python, PostgreSQL and Acclimate SDK versions. The pre-change build commit if stage C runs.
- CLIProxyAPI release or full commit, SHA-256 of the actual config file and the base URL (default `http://127.0.0.1:8317/v1`). Verify the config digest before each stage. The operator identifies the running proxy build and preserves the Codex OAuth routing.
- Model IDs and effort for both task models and the optimizer, and every nonsecret `ACCLIMATE_MODEL*` and `ACCLIMATE_LEARNING_*` setting. Task calls and forwarded optimizer calls use the frozen URL with `/chat/completions` appended. Record the requested identities, without credential values, and check them against the freeze before publishing each attempt, including retention. These checks cover the client-to-proxy boundary.
- SHA-256 of every fixture file, the grader, `baseline.json`, the driver files, `analyze.py`, `checks.sql`, and `EIGHT_RULES` as built.
- `heldOut.digest`, the E content digest, the `setting` values, and the seed rules in §7.
- n, N, |E|, |H| and the trace format.
- Zero-call and disjointness results.
- The pilot report tied to the pre-pilot freeze: repeated-case disagreement, tokens and latency for both policy models, trace sizes, input growth per round, keep rate and format-rejection rate, and the updated estimates.

## 20. Open questions

Shared questions are in the [README](https://github.com/anveld-dev/acclimate/blob/e636c0beef2d313b5116c226b156ee6624a81573/docs/architecture/self-improvement-memory/README.md#open-questions). These are owned here.

1. **Stage C.** Run the pre-change Flat control? It is descriptive only (§16).
2. **Codex model access through CLIProxyAPI.** Entitlement for the three exact model IDs, effective output limits, JSON validity, rate limits, latency and token use await live verification.
3. **Optimizer context.** Full SIM's round 20 carries 10 rounds of target history and up to 20 attempts. The pilot’s projection checks whether the frozen Astra configuration fits. A failing pilot stops progression before S1 (K2, K3).

## Names

The plan uses these names. In the database a workspace is `project_id`.

### Paper symbols

| Paper | Acclimate |
| --- | --- |
| Harness H_t | The bundle version at the head of the learning channel when round t starts (`learning_rounds.parent_version_id`) |
| Policy model M | `setting.policyModel` |
| Setting σ = (M, X) | The loop's `setting` (`{domain, benchmark, policyModel}`) alongside separately pinned evolve revision and held-out commitment |
| Evolve split X_evo | The **evolve split**: rows of `learning_evolve_cases` live at `evolve_revision` |
| Held-out split X_eval | The **held-out split**: cases in the evaluator's own store, committed by `heldOut.digest` |
| Feedback F_t | `feedback`: the incumbent's evolve evaluation |
| Run history D_t | `history`: the feedback summary, candidate diffs and decision of every earlier round of the bundle whose pinned `setting` equals the current round's. Rounds in another setting reach the optimizer only through memory. |
| SIM | **Improvement memory**: `learning_memory_problems` and `learning_memory_attempts`. Prompt key `improvementMemory`. |
| Proposer P and selector S | The **optimizer model** (`ACCLIMATE_MODEL`), called as `propose`, `screen` and `select` |
| k, rollouts | Samples 1–5 in the worker and SQL. `ROLLOUTS_PER_CASE = 5` in `evaluations.rs`. |

### Constants and identities

| Name | Meaning |
| --- | --- |
| Five samples | Fixed by the worker and SQL (D9). |
| `ROLLOUTS_PER_CASE = 5` | Rollouts per case in every evolve and held-out evaluation |
| `evaluations::case_passes` | A case **passes** in an evaluation when at least 3 of its 5 rollouts report `passed: true` |
| Sample | A candidate's position in its round, 1 to 5. The reviews call it a slot. |
| App principal | The one machine principal that submits outcomes and evolve cases and runs the evaluator for a loop: a machine-token principal (`machine:…`) or a static grant principal. It must hold the `evaluate` right. Stored as `learning_loops.app_principal`, with no prefix check. |
| `service:learning-loop` | The `promotions.reviewer` recorded for an adopt release |
| Problem ID | `P<n>`, numbered per workspace + bundle from `P1` |
| Round number | `learning_rounds.number`, 1, 2, … per bundle. Memory attempts store it in `round` and problems in `opened_round`. |
| Memory revision | `learning_loops.memory_revision`, the bundle's append counter. One per adopted round. |
| Evolve revision | `learning_loops.evolve_revision`, incremented once per effective mutation of the evolve split |

### Tables

Migration `0019_learning_loop.sql` adds the first four tables. Migration `0020_learning_optimizer.sql` adds the last four. Migration `0021_optimizer_effort.sql` adds the nullable round effort pin and an evolve-case paging index. [removal.md](https://github.com/anveld-dev/acclimate/blob/e636c0beef2d313b5116c226b156ee6624a81573/docs/architecture/self-improvement-memory/removal.md) owns `0017` and `0018`.

| Table | Key | Columns | Owner |
| --- | --- | --- | --- |
| `learning_loops` | `(project_id, bundle_id)` | `status`, `channel`, `app_principal`, `setting`, `held_out`, `evolve_revision`, `memory_revision`, `next_round`, `failed_rounds`, `pause_reason`, `enrolled_by`, `created_at`, `updated_at`. This row is the **bundle row lock**. | loop.md |
| `learning_evolve_cases` | `(project_id, bundle_id, case_id)`; unique `(project_id, bundle_id, outcome_id)` | `input`, `expected`, `source` (`setup` or `outcome`), `outcome_id`, `version_id`, `added_revision`, `retired_revision` | evaluator-and-contracts.md |
| `learning_rounds` | `id`; unique `(project_id, bundle_id, number)` and `(project_id, bundle_id, id)`. At most one active per loop (`learning_rounds_one_active`) | `number`, `state`, `decision`, `reason`, `parent_version_id`, `channel`, `channel_revision`, `evolve_revision`, `memory_revision`, `memory_digest`, `history_digest`, `setting`, `held_out`, `optimizer_model`, `optimizer_reasoning_effort`, `adopted_sample`, `adopted_version_id`, `selection`, `incumbent_score`, `held_out_score`, `held_out_error`, `created_at`, `ended_at` | loop.md |
| `learning_evaluations` | `id`; unique `(round_id, role, sample)` with NULLs considered equal; at most one open per round (`learning_evaluations_one_open`) | `round_id`, `role` (`incumbent`, `candidate`, `retained`), `sample`, `split` (`evolve`, `held_out`), `version_id`, `digest`, `evolve_revision`, `status`, `attempt_id`, `report`, `score`, `created_at`, `started_at`, `deadline_at`, `error` | evaluator-and-contracts.md |
| `learning_candidates` | `(round_id, sample)` | `status`, `drop_reason`, `rationale`, `changes`, `diagnosis`, `scan`, `screen`, `version_id`, `evaluation_id`, `evolve_score` | optimizer.md (the one definition), loop.md (the status machine) |
| `learning_optimizer_calls` | `(round_id, kind, sample)`, `sample = 0` for `screen` and `select`; at most one open per round (`learning_optimizer_calls_one_open`) | `kind` (`propose`, `screen`, `select`), `status`, `attempts`, `input_digest`, `output`, `error_code`, `error`, `claimed_at` | optimizer.md |
| `learning_memory_problems` | `(project_id, bundle_id, problem_id)`; unique `(project_id, bundle_id, root_cause_key)` and `(project_id, bundle_id, opened_revision)` | `root_cause`, `root_cause_key`, `opened_round`, `opened_revision` | memory.md |
| `learning_memory_attempts` | `(project_id, bundle_id, revision)`; unique `round_id` | `problem_id`, `round_id`, `round`, `sample`, `backfilled`, `what`, `files`, `predicted`, `fixed`, `missed`, `passed`, `total`, `domain`, `provenance`. No regression list, as in the paper. | memory.md |

Kept, 19 tables: `projects`, `users`, `project_memberships`, `workspace_invitations`, `workspace_adoptions`, `browser_sessions`, `machine_tokens`, `machine_token_events`, `bundles`, `versions` (minus `proposal_id`), `channels`, `promotions` (`comparison_id`, `policy_override` and `policy_approval_promotion_id` dropped; `unevaluated_reason` keeps its name), `integrations`, `integration_credentials`, `integration_receipts`, `idempotency`, `durable_commands` (connected-learning rows deleted; the loop's outcome receipts reuse it), `operation_records`, `mutation_audit`.

### Statuses, states and reasons

| Column | Values |
| --- | --- |
| `learning_loops.status` | `running`, `paused`, `stopped` |
| `learning_loops.pause_reason` | `operator`, `failed-rounds`, `optimizer-context-too-large`. `optimizer-context-too-large` replaces an operator reason. |
| `learning_rounds.state` | Active: `scoring_incumbent`, `proposing`, `screening`, `evaluating`, `selecting`, `scoring_held_out`. Terminal: `completed`, `failed`, `stopped`. |
| `learning_rounds.decision` | `adopted`, `kept`. NULL for `failed` rounds and rounds stopped before a decision. A round stopped in `scoring_held_out` keeps its decision. |
| `learning_rounds.reason` | With `kept`: `selector-kept`, `no-candidates`, `no-survivors`, `no-evaluated-candidates`, `channel-moved`. With `failed`: `incumbent-evaluation-failed`, `optimizer-unavailable`, `optimizer-context-too-large`, `selector-unavailable`. With `stopped` before a decision: `stopped`. After a decision it preserves the existing reason. |
| `learning_candidates.status` | `generating`, `generated`, `dropped`, `screened_out`, `evaluating`, `evaluated`, `evaluation_failed` |
| `learning_candidates.drop_reason` | `provider-failed`, `format-rejected`, `scanner-rejected`, `no-change`. Equivalent samples proceed independently. |
| `learning_evaluations.status` | `queued`, `running`, `scored`, `failed`, `cancelled` |
| `learning_optimizer_calls.status` | `queued`, `running`, `succeeded`, `failed` |
| `learning_optimizer_calls.error_code` | Set exactly when `failed`: `provider-failed` (including input drift, a model or reasoning-effort change and the attempt limit), `format-rejected`, `optimizer-context-too-large`, `scanner-rejected` (`propose` only), `cancelled` (closed by `cancel_children`). `error` is free text. |
| `learning_evolve_cases.source` | `setup`, `outcome` |
| Wire spelling | Wire values match the database values, except `held_out` is `heldOut` on the wire |

### JSON shapes

| Name | Shape |
| --- | --- |
| `setting` (loop, round, provenance) | `{domain, benchmark, policyModel}`, each a nonblank string of at most 256 bytes with no control characters |
| `held_out` / wire `heldOut` | `{digest, cases}`: the evaluator's commitment to its fixed held-out split and its case count (1–10,000). Case inputs and answers stay with the evaluator. |
| Proposer output | `{schemaVersion: 2, rationale, edits: [{path, oldText, newText}], files: [{op: "write", path, text} \| {op: "delete", path}], diagnosis}` |
| `diagnosis` | `{problem: {id: "P3"} \| {new: "<root cause>"}, predicted: [caseId]}`, stored on `learning_candidates.diagnosis` before evaluation |
| `learning_candidates.changes` | The validated `edits` and `files` from the proposer output |
| Scanner-rejected `propose` call output | `{scan, diagnosis}`, with `diagnosis` null when a finding is in the root cause. No other model text is stored. |
| `learning_candidates.scan` | `{clean, findings}` from the scanner. Findings carry `{rule, field, path}`. The path may be null. |
| Screen output | `{samples: [{sample, verdict: "evaluate" \| "skip", reason}]}`. Each entry is stored on `learning_candidates.screen` as `{verdict, reason}`. |
| Select output | `{decision: "adopt" \| "keep", sample, reason}`. `sample` is required with `adopt` and absent with `keep`. |
| `learning_rounds.selection` | `{decision, sample, versionId, digest, reason, model, inputDigest, reasoningEffort?}`. A selector keep uses null for `sample`, `versionId` and `digest`. |
| Evaluation report | `{cases: [{caseId, rollouts: [{score, passed, trace?, error?}]}]}`. `score` is in [0, 1]. Held-out rollouts carry only `score` and `passed`. |
| `provenance` | Stored: `{domain, benchmark, policyModel, round, evolveRevision, heldOutDigest, optimizerModel, optimizerReasoningEffort?}`. Rendered into `improvementMemory`: the paper's `{domain, benchmark, policyModel, round}` only. |
| Optimizer prompt keys | `setting`, `harness`, `feedback`, `history`, `improvementMemory` for every call; `candidates` for `screen` and `select`; `parserError` on the one format retry. The eight rules are trusted instruction, outside the fenced data. |
| `feedback` | `{versionId, evolveRevision, score, cases: [{caseId, input, passedRollouts, meanScore, rollouts: [{score, passed, trace?, error?}]}]}` |

### Routes

All loop routes use the prefix `/v1/workspaces/{workspaceId}/bundles/{bundleId}/learning`.

| Route | Caller | Purpose |
| --- | --- | --- |
| `PUT` | Caller with `promote`, including the app principal | Enroll the bundle or change `channel`, `appPrincipalId`, `setting` or `heldOut`. A change applies from the next round. While a round is active, a change to `channel`, `appPrincipalId` or `heldOut` is `409 learning_conflict`. A `setting` change is accepted at any time. |
| `GET` | Workspace reader | The loop, its active round and recent rounds |
| `POST /pause`, `POST /resume`, `POST /stop` | Caller with `promote` | Change `learning_loops.status` |
| `GET /rounds` | Workspace reader | Paged round summaries |
| `GET /rounds/{roundId}` | Workspace reader | Round pins, candidates, selection and evaluation summaries. `?evaluation=<evaluationId>` includes one evolve report. |
| `GET /memory` | Workspace reader other than the app principal (`403`) | The improvement memory at its current revision, or at `?revision=` |
| `GET /evolve-cases` | Signed-in workspace reader or app principal with `read` | Current live cases, ordered by case ID. `after` and `limit` paginate `{items, next, evolveRevision}`. |
| `POST /evolve-cases` | Signed-in writer or app principal with `evaluate` | `{cases: [{caseId, input, expected}], retire: [caseId]}`. Returns `{evolveRevision, added, retired, liveCases}`. |
| `POST /outcomes` | App principal | `{outcomeId, versionId, digest, input, expected}`. Adds evolve case `outcome:<outcomeId>`. |
| `GET /work` | App principal | Queued and running evaluations for this loop. A held-out item carries the round's pinned `heldOut`. |
| `POST /evaluations/{evaluationId}/start`, `POST /evaluations/{evaluationId}/report` | App principal | Claim an evaluation, then report its result |

The workspace principal route, `GET /v1/workspaces/{workspaceId}/principal`, returns `{principalId, kind, rights}` for the authenticated reader. Workspace, auth, invitation, membership, machine-token, bundle, version, payload and connection routes remain. Channel resolution uses an ETag of `"<revision>:<versionId>"`. The channel release route stays, and its request is `{versionId, expectedRevision, unevaluatedReason}` with `comparisonId` and `policyOverride` removed. Every route under `/connections/{connectionId}/learning`, and every proposal, comparison, draft, evaluation-request, progress and policy-receipt route, is removed ([removal.md](https://github.com/anveld-dev/acclimate/blob/e636c0beef2d313b5116c226b156ee6624a81573/docs/architecture/self-improvement-memory/removal.md)).

### Settings

| Setting | Status |
| --- | --- |
| `ACCLIMATE_MODEL`, `ACCLIMATE_MODEL_ENDPOINT`, `ACCLIMATE_MODEL_TOKEN` | Kept. The one optimizer model. The optimizer uses the configured OpenAI-compatible Chat Completions URL. No model ID is built in. |
| `ACCLIMATE_MODEL_TIMEOUT_SECONDS` | New, default 600. Replaces the fixed 60 s client timeout. |
| `ACCLIMATE_MODEL_REASONING_EFFORT` | Optional. Accepts `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. Omitted by default. The experiment pins `high`. |
| `ACCLIMATE_MODEL_MAX_COMPLETION_TOKENS` | New, default 32768 |
| `ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS`, `ACCLIMATE_LEARNING_EVALUATION_SECONDS` | Queue and run deadlines in seconds. Defaults are 604800 and 86400, respectively. |
| `ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` | New, default 3. Consecutive failed rounds before the loop pauses. A deliberate deviation ([decisions.md](https://github.com/anveld-dev/acclimate/blob/e636c0beef2d313b5116c226b156ee6624a81573/docs/architecture/self-improvement-memory/decisions.md#deliberate-deviations-from-the-paper)). |
| `ACCLIMATE_CRITIC_MODEL`, `ACCLIMATE_CRITIC_ENDPOINT`, `ACCLIMATE_CRITIC_TOKEN`, `ACCLIMATE_LEARNING_REVIEW_SECONDS`, `ACCLIMATE_LEARNING_PARENT_MAX_REUSES`, `ACCLIMATE_LEARNING_PARENT_MAX_AGE_SECONDS`, `ACCLIMATE_LEARNING_PAIR_BUDGET`, `ACCLIMATE_LEARNING_MAX_REPETITIONS`, `ACCLIMATE_LEARNING_MAX_STEPS_BETWEEN_AUDITS`, `ACCLIMATE_LEARNING_MAX_CHAIN_AGE_SECONDS`, `ACCLIMATE_LEARNING_CALIBRATION_REPETITIONS`, `ACCLIMATE_LEARNING_CALIBRATION_ATTEMPTS`, `ACCLIMATE_LEARNING_FAILURE_WINDOW_SECONDS`, `ACCLIMATE_PROPOSAL_GROWTH_FLOOR_BYTES`, `ACCLIMATE_EVALUATION_ABANDON_SECONDS` | Removed |

### Code

| Name | Contents | Owner |
| --- | --- | --- |
| [src/learning.rs](../../src/learning.rs) | `routes`, `enroll`, `inspect`, `pause`, `resume`, `stop`, `list_rounds`, `get_round`, `ACTIVE_ROUND_STATES` | evaluator-and-contracts.md |
| [src/learning/worker.rs](../../src/learning/worker.rs) | `learning_worker`, `tick`, `sweep`, `spawn_calls`, `advance_round`, `advance_locked`, `start_round`, `queue`, `fail_round`, `stop_round`, `cancel_children` | loop.md |
| [src/learning/worker/advance.rs](../../src/learning/worker/advance.rs) | `step`, `proposing`, `screening`, `queue_survivor`, `evaluating`, `selecting`, `adopt`, `keep` | loop.md |
| [src/learning/evaluations.rs](../../src/learning/evaluations.rs) | `work`, `start`, `report`, `authorize_evaluation`, `round_documents`, `case_passes`. Evaluation expiry runs in `worker::sweep`. | evaluator-and-contracts.md |
| [src/learning/evolve.rs](../../src/learning/evolve.rs) | `list_cases`, `submit_cases`, `submit_outcome`, `cases_at`, `live_count`, `add_case`, `retire_case` | evaluator-and-contracts.md |
| [src/learning/optimizer.rs](../../src/learning/optimizer.rs) | `OptimizerModel`, `render_feedback`, `validate_diagnosis`, `validate_screen`, `validate_select`, `run_call`, `call_with_retry`, `enqueue` | optimizer.md |
| [src/learning/optimizer/client.rs](../../src/learning/optimizer/client.rs) and [instructions.rs](../../src/learning/optimizer/instructions.rs) | `OpenAiModel`, `system_text`, `EIGHT_RULES` | optimizer.md |
| [src/learning/history.rs](../../src/learning/history.rs) | `render_history` | optimizer.md |
| [src/learning/memory.rs](../../src/learning/memory.rs) | `get`, `render_memory`, `write_back`, `resolve_problem`, `normalize_root_cause`, `root_cause_key`, `ROOT_CAUSE_MAX_BYTES`, `attempt_outcome` | memory.md |
| [src/proposal_edits.rs](../../src/proposal_edits.rs) | `reconstruct` applies anchored `edits` and whole-file `files` within payload and target limits. `changed_files` identifies touched paths for scanning and memory. | optimizer.md |
| [src/proposal_scanner.rs](../../src/proposal_scanner.rs) | `findings` reports named rules and fields for suspicious new content. | optimizer.md |
| [@anveld/acclimate-sdk/learning](../../packages/sdk/src/learning/index.ts) | `serveLearningLoop`, `createLearningOutcomeReporter`, `addEvolveCases`, `heldOutDigest`, `defineLoop`, `exact`, `tests`, `openai`, `OpenAIHttpError`. Bins are `acclimate-learning` and `acclimate learn`. | evaluator-and-contracts.md |
| [src/workspaces.rs](../../src/workspaces.rs) | `principal` resolves the caller's workspace identity and rights. | evaluator-and-contracts.md |
| Console | `apps/console/src/components/bundle-learning.tsx`, `apps/console/src/server/learning-loop.ts` | evaluator-and-contracts.md |
| Experiment | `examples/self-improvement-memory/`: `fixtures/w1/` from phase 2, the driver and `tests/` from phase 5 | experiment.md |
