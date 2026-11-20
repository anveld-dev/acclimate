# Self-improvement memory: experiment plan (pre-registration draft)

This file plans the paper-sized test of the main transfer claim of [arXiv 2611.18856](https://arxiv.org/abs/2611.18856) on the product loop itself (D10). It covers the conditions, splits, endpoints, statistics, power, the turn and token estimates, randomization, the integrity rules, the driver and its tests. Every product name comes from the [README](README.md#names). The driver adds no product route, table, setting or mode.

The product loop is the experiment loop. The driver sets up bundles, starts and pauses loops, runs the evaluator with the right policy model, and reads the held-out curves. It never proposes, screens, selects, releases or writes memory. The service does all of that, as it would for any enrolled bundle.

This is a draft. Before the pilot, freeze the protocol and inputs with SHA-256 digests. After the pilot passes, archive the final preregistration with its pilot results before S1. It follows the conventions of `docs/research/real-app-learning-experiment/preregistration.md`: frozen inputs with digests, zero-call checks, run order, turn accounting and a deviations log.

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

- **H_S** is the version on B_S's learning channel when source round 10 ends: round 10's `adopted_version_id` when it adopted, else its `parent_version_id`.
- **H0** is `examples/self-improvement-memory/fixtures/w1/baseline.json`, moved unchanged from `examples/real-app-learning/baseline.json` in phase 2 with its digest ([removal.md](removal.md)). Earlier calibration was measured with it (§9.1).
- **Memory** is per workspace + bundle (D6), so a new bundle starts empty. HT and CS build their own memory during the target run, where the paper's conditions have none (deviation V1).
- **Setting.** Every loop has `setting = {domain: "cli-support", benchmark: "llm-0.38-argv", policyModel}`. Only `policyModel` changes at the transition, so rules 2 and 4 see it in each attempt's `provenance`. The evolve split and the held-out split are the same in every run, so `evolve_revision` contents and `heldOut.digest` match across conditions.
- **Optimizer model.** `ACCLIMATE_MODEL = gpt-6-luna` in every stage and condition, for `propose`, `screen` and `select`. Earlier Acclimate experiments used the same model for the task agent and the optimizer (`examples/real-app-learning/run.ts:24`, `:261`, at tag `pre-learning-loop`).
- **No condition names.** Bundles get random neutral slugs. The loop cannot see which condition it serves, because a condition is only which bundle and which start version.

Problem-Only is not run: it needs a memory view, which would be a mode (D2).

## 4. Workload and splits

### 4.1 Workload

| ID | Workload | Grader | Source |
| --- | --- | --- | --- |
| W1 | LLM CLI support: `llm` 0.38 at `46f0461d…`, Click 8.5.1 | Exact Click route and parameters (`click-argv-v2`), binary (`fixtures/w1/grade.py`, from `examples/real-app-learning/grade.py:38-46` at 4096ff1b) | `examples/self-improvement-memory/fixtures/w1/`, moved in phase 2 |

The task agent is a Codex SDK turn that returns `{argv}` against the pinned source tree, ported from `examples/real-app-learning/run.ts:103-163` at tag `pre-learning-loop`.

### 4.2 Splits

| Split | Product name | Size and origin | Reaches the optimizer? |
| --- | --- | --- | --- |
| E | The **evolve split**, rows of `learning_evolve_cases` with `source = setup` | 40: the 30 development cases from `fixtures/w1/tasks.py` (`examples/real-app-learning/tasks.py:97-105` at 4096ff1b) plus the 10 development additions in `fixtures/w1/40-case-additions.json` | Yes, as `feedback` and through `history` and memory |
| H | The **held-out split**, in the driver's evaluator store, committed by `heldOut = {digest, cases: 60}` | 60 new cases | Never |

- **H is all new.** The 70 existing audit cases (30 original, 30 in `fixtures/w1/replication-audit.json`, 10 additions) informed earlier engineering, so none is reused. The 10 field cases are not used.
- Each H case has a reference argv and two negative controls, checked against every earlier case ID, input and parsed target, as `fixtures/w1/check-replication.py` does (`examples/real-app-learning/check-replication.py:11-36` at 4096ff1b). H case IDs are opaque (`h-` plus 8 random hex digits) so a leak is detectable without content.
- **E is fixed for the whole experiment.** The driver adds it once with `POST /evolve-cases` and never calls `POST /outcomes` or retires a case. Every round of every run therefore pins the same `evolve_revision` content, which is what the paper's fixed X_evo needs (D4 stays available to apps; the experiment does not use it).
- **Traces.** For W1 a rollout's `trace` is the argv JSON the agent returned and `error` is the turn or parse error message, if any. Held-out reports carry only `score` and `passed`. The pilot records trace sizes (§11).

### 4.3 Why 60 held-out cases

At five rollouts, measurement noise of one held-out difference is about 2.0 to 2.2 pp at 60 cases and 2.5 to 2.7 pp at 40 (§9.1). Held-out rollouts are 20% of a round's turns, so the extra precision is cheap.

## 5. Stages and topology

| Stage | What | Gate to the next stage |
| --- | --- | --- |
| S0a | Model-free dry run of the driver with a fake optimizer and a fake policy (§13) | All integrity checks pass |
| S0b | Author and freeze H: zero-call checks, disjointness, digests, the frozen preregistration | Preregistration committed |
| S0c | Live pilot: 2 source runs of 3 rounds, then 1 round of each target condition from one of them | Pilot gates (§10, K3). Pilot data is never analysed. |
| S1 | 10 independent source runs of 10 rounds | Harm stop only (K4 applies to S2) |
| S2 | For each block, the 3 target runs of 10 rounds, plus round-0 and retention scoring | none |
| C (optional) | Pre-change Flat control (§16) | none. Runs alongside S1 and S2. |

- **One cluster per source run.** Each block's S1 runs on its own disposable PostgreSQL cluster and service, owned by `scripts/productization/qualify.py` `Harness` (`:31`, `start_database` at `:55`), which phase 1 keeps ([removal.md](removal.md)), as `examples/real-app-learning/run.py:23-33` did at tag `pre-learning-loop`.
- **Checkpoint.** When source round 10 has `completed` and the loop is `paused`, the driver stops the service and copies the stopped data directory. That copy is the block's checkpoint.
- **One copy per target condition.** Each target run gets its own service on a fresh checkpoint copy. Full SIM continues B_S in its copy. HT and CS create new bundles in theirs; B_S stays `paused` there and never runs. Separate copies keep the conditions from sharing a worker queue, and a restart (K5) needs only a new copy, because memory is never rewound.
- **Start order.** The three target runs of a block start together in a seeded order (§7).

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

The loop runs rounds back to back, so the driver stops it. A run's **counted rounds** are its `completed` rounds. A `failed` round makes no decision and is not counted, and it is logged against K5. When the run has 9 counted rounds and a round is active, the driver calls `POST /pause`. That round runs to its end and no new round starts. If it fails, the driver calls `POST /resume` and repeats. If a round after the 10th counted round is ever observed, the driver calls `POST /stop` and the run is invalid if that round reached `selecting` (K1).

The target index `r` counts completed rounds. Keep the separate bundle round number in the ledger. When no rounds fail, Full SIM's bundle rounds 11 to 20 are r = 1 to 10.

### 6.4 Each round

The driver does nothing inside a round except serve evaluations. After each round ends it:

1. Reads `GET …/learning/rounds/{roundId}` (candidates, evaluations, selection) and `GET …/learning/memory?revision=` at the round's `memory_revision`.
2. Matches the retained evaluation's version to the round's adopted or kept version and its score to the local log (§8.1). At the end, checks that the final retained version equals the learning channel head.
3. Writes the public round document with its pinned memory, retained-evaluation identity, optimizer request records and turn counts to `artifacts/sim-experiment/<stage>/b<block>/<code>/rounds.jsonl`. `<code>` is the blinded condition code. The following illustrates the evidence represented by each row.

```json
{
  "block": 3, "code": "B", "number": 14, "r": 4, "state": "completed",
  "decision": "adopted", "reason": null,
  "parent": {"versionId": "…", "digest": "sha256:…"},
  "retained": {"versionId": "…", "digest": "sha256:…", "heldOutScore": 0.4133, "heldOutError": null,
               "cases": 60, "rollouts": 300, "infraFailures": 0},
  "incumbentScore": 0.3550, "evolveRevision": 1, "memoryRevision": 9,
  "memoryDigest": "sha256:…", "historyDigest": "sha256:…", "optimizerModel": "gpt-6-luna",
  "samples": [{"sample": 1, "status": "evaluated", "dropReason": null, "screen": "evaluate",
               "problem": "P3", "predicted": 4, "evolveScore": 0.39,
               "diagnosisBeforeEvaluation": true}],
  "selection": {"decision": "adopt", "sample": 2},
  "optimizer": {"calls": 7, "requests": 8, "inputBytes": 412233, "inputTokens": 0, "outputTokens": 0},
  "turns": {"incumbent": 200, "candidate": 800, "heldOut": 300}
}
```

`summary.json` per run holds the totals, the final retained version and the memory document at the end. `ledger.json` hashes the run files and, for each source, the stopped database checkpoint.

## 7. Randomization and blinding

No paired comparison exists in the loop, so there is no arm order to balance. The remaining sources of order effects are seeded.

| What | Rule |
| --- | --- |
| Target start order in a block | Sort the three conditions by SHA-256 of the JSON array `[preregDigest, "start", block, originalIndex]`. Submit them in that order to separate services. |
| Rollout order in every evaluation | Offline evaluations sort case/rollout pairs by SHA-256 of `[preregDigest, block, code, number, role, sample, originalIndex]`. The SDK owns the in-loop case schedule. Apply the seed with case ID added to assign local rollout labels within each case. |
| Condition labels | Coded A, B, C per block by sorting conditions on SHA-256 of `[preregDigest, "codes", block, originalIndex]`. The key is sealed in `artifacts/sim-experiment/key.json` and opened only after `analyze.py` is frozen and run on coded data. |
| Case IDs | E keeps its `cli-…` IDs. H IDs are random (§4.2). |

The assignment of condition to bundle is not random: Full SIM is by definition the continued bundle. Bundles, versions and requests carry no label, so the optimizer and graders cannot see it.

## 8. Endpoints

### 8.1 The score

`Y(c, b, r)` is the `held_out_score` of the `retained` held-out evaluation of target round r of condition c in block b: the mean over the 60 H cases, weighted equally, of each case's mean rollout `score` over its 5 rollouts, under `gpt-6.2-sol`. The analysis recomputes it from the evaluator's local rollout log and requires agreement with the service within 1e-9.

`Y(c, b, 0)` is the start harness's held-out score under the target model. The loop does not score a version before round 1, so the driver scores it with the same evaluator function outside the loop (deviation V4). H_S is scored once per block for both Full SIM and HT.

### 8.2 Endpoints

| Endpoint | Definition |
| --- | --- |
| Target final (primary) | `Y(c, b, 10)` |
| Jump start | `Y(c, b, 3) − Y(c, b, 0)` |
| Curve area | Mean over r = 1…10 of `Y(c, b, r) − Y(c, b, 0)`. Curves are plotted per round with 95% intervals across blocks and **no running maximum**. |
| Retention | `R(c, b) = Y_luna(final harness of c) − Y_luna(H_S)`, all three scored by the driver on H under `gpt-6-luna` in one window after S2, for Full SIM and HT |
| Source gain | `Y(Source, b, 10) − Y(Source, b, 0)`, descriptive |

### 8.3 Mechanism metrics (descriptive)

| Metric | Definition, from rounds, evaluations and memory |
| --- | --- |
| Keep rate and reasons | Share of counted rounds with `kept`, by `reason` |
| Screening yield | `screened_out` share of `generated` samples, and `drop_reason` counts |
| Problem reuse | Share of target samples whose `diagnosis.problem` names an existing ID. For Full SIM, the share naming a problem opened in the source run (`opened_round ≤ 10`). |
| Prediction precision | Over adopted attempts, the number of `fixed` cases divided by the number of `predicted` cases. Null comparison: the fix rate among incumbent-failing E cases the attempt did not predict. Interpreted only with at least 100 pooled predictions. Cases with 1 to 4 passing incumbent rollouts are reported separately as flaky. |
| Unpredicted regressions | Per adopted attempt, E cases that pass on the incumbent and fail on the candidate (`CASE_PASS_ROLLOUTS`) and were not predicted |
| Winner's curse | For each adopted round, the adopted candidate's `evolve_score` minus the next round's `incumbent_score`, which re-measures the same version with fresh rollouts. For the final adoption, use the offline final evolve measurement. This is the best-of-5 inflation. It needs the loop to keep re-scoring the incumbent every round ([loop.md](loop.md) open question 5). |
| Overfitting gap | Evolve gain from the round-1 incumbent score to an offline remeasurement of the final retained harness, minus the held-out gain. The offline measurement runs after the loop is paused and creates no learning round. |
| Context growth | Rendered optimizer input bytes by prompt key, and total provider-reported tokens per request and round |
| Turns and tokens | Per condition, and per adopted step still on the channel at round 10. Information only. |

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

From A/A calibrations in `docs/research/real-app-learning-experiment/`:

| Source | Cases | Reps per arm | Paired SD of case means |
| --- | ---: | ---: | ---: |
| First experiment (`README.md:21`) | 30 | 1 | 0.43994 |
| 30-case replication (`replication.md:26`) | 30 | 2 | 0.25400 |
| 40-case run (`40-case.md:22`) | 40 | 2 | 0.27050 |
| Five-admission rerun (`5-admission-rerun.md:15`) | 40 | 2 | 0.24693 |

If the disagreement is trial noise, the SD of a case-mean difference scales as `sqrt(2/r)` from r = 2. From 0.247 to 0.271, one held-out difference between conditions has noise of:

| H cases | r = 5 |
| ---: | ---: |
| 30 | 2.9 to 3.1 pp |
| 40 | 2.5 to 2.7 pp |
| 60 | **2.0 to 2.2 pp** |

### 9.2 Power at n = 10

Each `D_b` also carries run-to-run variation of the loop, `σ_b`, which no existing data measures after 10 rounds. The only proxy is five candidates from one baseline in the five-admission rerun, with development gains +2.5, +2.5, 0, −1.25 and +15 pp (`5-admission-rerun.md:48-52`): SD 6.5 pp, about 5 pp after removing the 3.9 pp measurement SE. Full SIM and HT start from the same bytes, which may correlate them and shrink `σ_D`. If uncorrelated, `σ_D ≈ sqrt(2σ_b² + 2.1²)`.

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
| K1 Integrity | Any of: an H case ID or the fingerprint of a whole H input appears in an optimizer request; a held-out report carries `trace` or `error`; the fenced data of an optimizer request holds a key outside its kind's set (`setting`, `harness`, `feedback`, `history` and `improvementMemory` for every kind, plus `candidates` for `screen` and `select`, plus `parserError` on a retry, as in [optimizer.md](optimizer.md) "Data keys"); a condition code or bundle slug appears in an optimizer request or a delivered payload; memory JSON or a `P<n>` ID appears in a delivered payload or task prompt; a sample's evaluation appears in `GET /work` before the adapter returned that sample's `propose` reply, or the stored `diagnosis` differs from that reply; an adopted attempt's `predicted` differs from its candidate's `diagnosis.predicted`; Full SIM's round 11 does not pin the source run's final memory revision, or an HT or CS round 1 pins a nonzero one; Full SIM and HT start digests differ; `evolve_revision`, the E content digest or `heldOut.digest` differs within a block; `optimizer_model` or the adapter's model differs from the frozen one; an evaluation ran under a policy model other than its round's `setting.policyModel`; the rendered `history` lists fewer rounds than the earlier rounds with the same `setting`, or `improvementMemory` lists fewer attempts than `memory_revision`; any `POST /outcomes`, evolve-case change, manual channel release or `channel-moved` round during a run; a round after the 10th counted round reached `selecting` | Stop the stage. Fix. Restart every affected run (target runs from a fresh checkpoint copy). |
| K2 Context | Any round `failed` with `optimizer-context-too-large`. Memory and history only grow within a run, so the loop cannot continue on that bundle. Full SIM, which carries up to 20 attempts of memory beside 10 rounds of target history, is hit first. | Stop the stage for a maintainer decision. A larger-context optimizer model is an amendment and restarts every block. |
| K3 Pilot | `format-rejected` above 20% of samples; no `adopted` round in the 6 pilot source rounds; the pilot's measured input growth projects Full SIM's round-20 input (10 rounds of history, up to 20 attempts) above 50% of the optimizer's context; any K1 event | Fix and repeat the pilot, or pause for a maintainer decision. Pilot data is discarded. |
| K4 Harm | After 5 completed blocks, the upper 95% bound of mean T1 is below −5 pp. `analyze.py` reports only whether it fired. | Stop and report. Harm-only, so it does not inflate T1's type I error. |
| K5 Infrastructure | A service exit, a run stuck for 2 hours, a loop paused with `failed-rounds`, or more than 5% of a run's rollouts failing for infrastructure reasons (the evaluator retries such a rollout once before reporting it). The first experiment lost its lease under concurrent lint (`docs/research/real-app-learning-experiment/README.md:69`). | Restart the run with the same seeds, at most twice: a source run from scratch, a target run from a fresh checkpoint copy. No repository lint or builds during live stages. |
| K6 Drift | The provider announces a change to `gpt-6-luna` or `gpt-6.2-sol` during a stage | Pause. Blocks from before and after are not mixed in one contrast without a recorded amendment. |

There is no efficacy stop and no efficacy peeking. Analysts see only integrity and infrastructure counts until every block is done.

### 10.1 SQL sketches

Run read-only after the service stops, while the private PostgreSQL instance is still available. `$1, $2` are the workspace and bundle, `$3, $4` the run's first and last round numbers.

```sql
-- One setting, evolve revision and optimizer model per run
SELECT count(DISTINCT setting) AS settings, count(DISTINCT evolve_revision) AS revisions,
       count(DISTINCT optimizer_model) AS models
FROM learning_rounds
WHERE (project_id, bundle_id) = ($1, $2) AND number BETWEEN $3 AND $4;   -- expect 1, 1, 1

-- Memory grows by exactly one attempt per adopted round and is never rewound
SELECT r.number, r.memory_revision,
       (SELECT count(*) FROM learning_rounds p
         WHERE (p.project_id, p.bundle_id) = (r.project_id, r.bundle_id)
           AND p.number < r.number AND p.decision = 'adopted') AS adopted_before,
       (SELECT count(*) FROM learning_memory_attempts a
         WHERE (a.project_id, a.bundle_id) = (r.project_id, r.bundle_id)
           AND a.revision <= r.memory_revision) AS attempts_visible
FROM learning_rounds r
WHERE (r.project_id, r.bundle_id) = ($1, $2)
  AND r.memory_revision IS DISTINCT FROM (SELECT count(*) FROM learning_rounds p
         WHERE (p.project_id, p.bundle_id) = (r.project_id, r.bundle_id)
           AND p.number < r.number AND p.decision = 'adopted');           -- expect no rows

-- The retained evaluation scored the channel head on the held-out split
SELECT r.number FROM learning_rounds r
JOIN learning_evaluations e ON e.round_id = r.id AND e.role = 'retained'
WHERE (r.project_id, r.bundle_id) = ($1, $2) AND r.state = 'completed'
  AND (e.split <> 'held_out'
       OR e.version_id IS DISTINCT FROM coalesce(r.adopted_version_id, r.parent_version_id));

-- Held-out reports carry no traces or errors
SELECT e.id FROM learning_evaluations e JOIN learning_rounds r ON r.id = e.round_id
WHERE (r.project_id, r.bundle_id) = ($1, $2) AND e.split = 'held_out'
  AND jsonb_path_exists(e.report, '$.cases[*].rollouts[*] ? (exists(@.trace) || exists(@.error))');

-- The adopted attempt keeps the prediction stored before evaluation
SELECT r.number FROM learning_rounds r
JOIN learning_candidates c ON c.round_id = r.id AND c.sample = r.adopted_sample
JOIN learning_memory_attempts a ON a.round_id = r.id
WHERE (r.project_id, r.bundle_id) = ($1, $2) AND r.decision = 'adopted'
  AND a.predicted IS DISTINCT FROM c.diagnosis -> 'predicted';
```

The column types are memory.md's and evaluator-and-contracts.md's. Adjust the sketches to them.

## 11. What the driver needs from the product

Everything here is in the README names. N1 and N2 are specified by their owners.

| Need | Surface | Owner |
| --- | --- | --- |
| Enroll, pause, resume, stop, change the setting between rounds | `PUT`, `POST /pause`, `/resume`, `/stop` | loop.md, evaluator-and-contracts.md |
| A fixed evolve split | `POST /evolve-cases`, no outcomes | evaluator-and-contracts.md |
| Held-out cases that never leave the evaluator | `heldOut`, `retained` evaluations, the `400` for a held-out report with traces | evaluator-and-contracts.md |
| Per-round candidates, diagnoses, screens, evaluations and selection | `GET /rounds/{roundId}` | evaluator-and-contracts.md |
| Memory at the revision a round pinned | `GET /memory?revision=` | memory.md |
| The optimizer endpoint as a local adapter | `ACCLIMATE_MODEL_ENDPOINT`, `ACCLIMATE_MODEL_TOKEN`, as `examples/real-app-learning/run.ts:198-229`, `:258-261` did at tag `pre-learning-loop` | optimizer.md |
| A failure, never a trim, on overflow | `optimizer-context-too-large` | optimizer.md |
| **N1.** No round starts on an empty evolve split, so a new bundle's round 1 sees the setup cases | `start_round` precondition | loop.md |
| **N2.** A per-evaluation case concurrency, for wall clock only (§14 uses 8) | `serveLearningLoop` option `caseConcurrency`, default 1 | evaluator-and-contracts.md |

The driver verifies N1 (§6.1 step 6). The SDK exposes neither a per-evaluation case-order hook nor the evaluation ID and pinned setting in execution callbacks. The driver binds callback evidence through app-authorized `GET /work` and reader-authorized round details. Full in-loop case randomization would require a scheduler hook.

## 12. Driver

### 12.1 Responsibilities

The driver does:

- own the PostgreSQL clusters, services, checkpoints and copies;
- create workspaces, app principals, bundles, start versions and the learning channel, and enroll each loop;
- run one evaluator per bundle with `serveLearningLoop` and `caseConcurrency: 8`: execute a Codex turn with the stage's policy model, grade with `fixtures/w1/grade.py`, report evolve rollouts with `trace` and `error` and held-out rollouts with `score` and `passed` only, and log every rollout locally;
- hold H and compute `heldOut.digest`;
- proxy every optimizer request through the logging adapter and run the K1 request checks;
- pause each run after 10 counted rounds and perform the Full SIM transition;
- score round 0 and retention outside the loop with the same evaluator function;
- write round records, run the SQL checks, and run the analysis.

The driver does not render prompts, call the optimizer itself, choose candidates, release versions, write memory or report outcomes. The old plan's trigger split, corrections, calibration settings, idle-flush settings and audit cohorts are gone with the machinery they fed.

### 12.2 Files

All in `examples/self-improvement-memory/`, following the layout of `examples/real-app-learning/` at tag `pre-learning-loop`. Phase 2 creates the folder with `fixtures/w1/`. Phase 5 adds the rest.

| File | Role |
| --- | --- |
| `run.py` | Entry point: `python3 examples/self-improvement-memory/run.py --stage S1 --blocks 1-10 --pg-bin …`. Owns clusters through `qualify.Harness`, takes checkpoints and makes target copies. `--service-bin` selects the frozen service executable. Resumes by block and condition. Stage C needs its own pre-change driver. |
| `block.ts` | One block: §6 setup, the Full SIM transition, round counting and pause, round records. The Python entry point submits targets in the seeded order. |
| `conditions.ts` | The §3 table as data |
| `evaluator.ts` | The `serveLearningLoop` handler: Codex turn (ported from `run.ts:103-163` at the tag), grading (from `run.ts:165-177`), seeded offline rollout order and in-loop labels, the infrastructure retry, the local rollout log, the policy-model check |
| `heldout.ts` | The local H store, `heldOut.digest`, and round-0 and retention scoring |
| `adapter.ts` | The optimizer proxy (ported from `run.ts:198-229` at the tag). Logs each request's bytes, digest and token usage and runs the K1 request checks before forwarding. |
| `checks.sql` | §10.1 |
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
| `examples/self-improvement-memory/tests/sim-experiment.test.ts` (`npm run test:sim-experiment`, model-free, owned PostgreSQL) | A fake optimizer returns fixed edits, diagnoses, screens and selections, and a fake policy returns seeded argv. One block runs a 2-round source and the 3 target conditions for 2 rounds on tiny fixtures from a real checkpoint copy. Asserts: 5 samples per round; Full SIM's first target round pins the source memory revision and renders an empty history, and HT and CS start at 0; diagnoses predate their evaluations; Full SIM and HT start digests match; no H ID reaches the adapter; held-out reports carry no traces; the retained evaluation binds the channel head; the pause stops at exactly the planned count; the §10.1 queries return the expected rows. |
| `examples/self-improvement-memory/test_analyze.py` | Synthetic blocks with a known effect. The paired t, signed-rank, intervals, d_z and Holm results match SciPy references. |
| `examples/self-improvement-memory/test_freeze.py` | Disjointness rejects a duplicated input under a new ID. Each negative control fails the grader. |
| K1 unit tests in `tests/adapter.test.ts` | A request with an H case ID, a whole H input, a condition code or a key outside its kind's set is refused and aborts the stage. `setting` on every kind and `parserError` on a retry are not flagged. An input shared with E is not flagged. |

## 14. Turn and token estimates

Planning information only. No stage stops or pauses on spend (D9).

### 14.1 Anchors

| Anchor | Source | Input tokens per turn | Output tokens per turn | Seconds per turn |
| --- | --- | ---: | ---: | ---: |
| Main | Five-admission rerun: 1,304 turns, 22,174,986 input and 54,649 output tokens, 2 h 0 min 48 s (`5-admission-rerun.md:111`, `:113`) | 17,005 | 42 | 5.56 |
| Slow | First experiment: 255 attempts in about 44 minutes, 6,329,265 input tokens over 253 (`README.md:40`) | 25,017 | — | 10.35 |

Proposer turns averaged about 15,000 input tokens (`5-admission-rerun.md:106`). Full history, memory and five evaluated candidates in `select` make calls larger, so the estimate uses 60,000 per optimizer call.

### 14.2 Per round and per run

A round's rollouts are `5·|E|` for the incumbent, up to `5·5·|E|` for the survivors and `5·|H|` for the retained version. With |E| = 40 and |H| = 60:

| Unit | Rollouts |
| --- | ---: |
| Incumbent on E | 200 |
| Survivors on E, worst case 5 | ≤ 1,000 |
| Retained on H | 300 |
| **Round** | **≤ 1,500**, plus 7 optimizer calls (5 `propose`, `screen`, `select`) and up to 5 format retries |
| **Run, 10 rounds** | **≤ 15,000** |

Per block: source 15,000 + H0 round 0 under luna 300; targets 3 × 15,000 + round 0 of H_S and H0 under sol 600 + retention 900. **62,400 rollouts**, including 600 offline evolve rollouts, and 280 optimizer calls.

### 14.3 Totals, worst case, main anchor

| Stage | Rollouts | Optimizer calls | Input tokens | Output tokens | Serial turn-hours |
| --- | ---: | ---: | ---: | ---: | ---: |
| S0c pilot | 14,700 | 63 | 0.25 B | 0.6 M | 22 |
| S1 + S2, 10 blocks | 624,000 | 2,800 | 10.8 B | 26 M | 964 |

- Input tokens include optimizer calls at 60,000 each (about 0.17 B). At the slow anchor the main stages use about 15.6 B input tokens and 1,777 serial turn-hours.
- **Critical path.** With case concurrency 8 (N2), a round takes about 17 minutes of rollouts (1,500 / 8 × 5.56 s) plus about 10 minutes of optimizer calls, so a run takes about 4.5 hours and a block about 9.5 hours (source, then the three targets together). At concurrency 1, a round takes about 2.5 hours and a block 50 to 55 hours.
- **Wall clock.** With all 10 blocks in parallel: about 30 hours at an account limit of 32 concurrent turns, and about 10 hours (the critical path) at 160.
- **Unknowns.** `gpt-6.2-sol` tokens and latency per turn are unmeasured. The pilot measures them, and the frozen estimates are updated before S1.

## 15. Deviations from the paper

| ID | Paper | This plan | Reason |
| --- | --- | --- | --- |
| V1 | HT and CS have no memory throughout the target run | They start empty and build their own memory. T1 measures inherited memory over fresh memory, which may be smaller than the paper's gap. | Memory is always on (D2, D6) |
| V2 | (Withdrawn.) Target runs keep only target-run history; source history enters through SIM | Now the same: `render_history` lists only earlier rounds with the round's `setting`, so Full SIM's target run starts with empty history | [decisions.md](decisions.md#paper-readings-that-still-hold) |
| V3 | Four conditions | Full SIM, HT and CS | Problem-Only needs a memory view (D2) |
| V4 | The start harness's held-out score | Scored by the driver outside the loop | The loop scores held-out only after a decision |
| V5 | Paired study cross-dataset, transfer tables both | Cross-model only | D10. A second transition needs its own source runs. |
| V6 | Agent trajectories as traces | The returned argv and error | W1's agent returns one structured answer |
| V7 | Memory per run | Memory per workspace + bundle, one bundle per condition | D6. Full SIM continuing B_S has exactly the source memory. |

## 16. Optional descriptive control: pre-change Flat

Today's product carries flat `priorAttempt` history: at most 12 rounds (`src/connected_learning_worker.rs:538`) and 8,192 bytes (`:542`). The new build has no second path, so this control runs on the **pre-change release build**: the last commit before phase 1 lands, pinned at freeze. Per block it runs one source leg (H0, `gpt-6-luna`, 10 rounds of today's connected learning, k = 1 with today's gates, triggered by corrections from the 10 field cases) and renews the same connection across the model change with `POST /renew` (`contracts/learning.md:23`, `:62`). The driver scores its released version on the same H after each round with its local evaluator.

It is unpaired and differs from the new loop in k, memory, gating, triggers and feedback at once, so it is descriptive only: how today's product compares with the new one on the same workload and transition. Its exact protocol is frozen in the preregistration only if it runs (open question 1).

## 17. Threats to validity

| Threat | Handling |
| --- | --- |
| Best-of-5 selection inflates evolve gains, and no gate filters it | The endpoint is held-out and never reaches the optimizer. The winner's curse and overfitting gap (§8.3) report the inflation. |
| Every transfer condition inherits a harness optimized with memory | T1 measures memory's value at the target only |
| A fixed E is reused every round | H is fixed and never seen. The overfitting gap reports the difference. |
| Exact Click matching under-credits equivalent argv | The same grader applies to every condition, so it affects levels more than contrasts |
| Memory and history change token use | Tokens per condition and per adopted step are reported |
| Shared latent events across E and H families | H inputs are new and checked for disjointness by fingerprint. Families overlap by design. |
| The optimizer is the source policy model | Fixed in every condition. Only the policy model changes. |
| Provider drift | One calendar window for every block, and K6 |
| Thin traces (V6) give the optimizer less to diagnose | The same for every condition. Mechanism metrics show whether diagnoses still predict fixes. |

## 18. Reused from earlier plans

| From | Kept | Dropped |
| --- | --- | --- |
| The earlier experiment.md | W1, H0, E = the 40-case development set, 60 new held-out cases, blocks and checkpoint copies, the statistics table, the measurement-noise derivation, K1 to K6, the driver layout and tests, the freeze checklist | The trigger split F, corrections, audit cohorts PA_S and PA_T, A/A calibration, the 99% step gate, idle and chain-age flush settings, renewal for Full SIM, carry-forward held-out scores, the memory byte cap |
| Astra's plan | Fresh held-out cases; held-out in the evaluator's own store; a distinct bundle per block and condition with identical start digests for the transfer conditions; no condition names in optimizer input; the integrity stop rules; no efficacy peeking; the power figures; the threats list | Full SIM − Flat as primary (D10 makes Full SIM − HT primary); 52 source runs and the cross-dataset transition; Problem-Only and `historyMode`; `seeded-balanced-v1` paired order and the v3 step rule; its paired-arm turn budget; checkpoint import and a private development-only path |

## 19. Freeze checklist

- The Acclimate service commit, and the Rust, Node, Python, PostgreSQL, Codex CLI and SDK versions. The pre-change build commit if stage C runs.
- Model IDs and effort for both policy models and for `ACCLIMATE_MODEL`, and every `ACCLIMATE_MODEL*` and `ACCLIMATE_LEARNING_*` value.
- SHA-256 of every fixture file, the grader, `baseline.json`, the driver files, `analyze.py`, `checks.sql`, and `EIGHT_RULES` as built.
- `heldOut.digest`, the E content digest, the `setting` values, and the seed rules in §7.
- n, N, |E|, |H| and the trace format.
- Zero-call and disjointness results.
- The pilot report: tokens and latency for both policy models, trace sizes, input growth per round, keep rate and format-rejection rate, and the updated estimates.

## 20. Open questions

Shared questions are in the [README](README.md#open-questions). These are owned here.

1. **Stage C.** Run the pre-change Flat control? It is descriptive only (§16).
2. **`gpt-6.2-sol` as a Codex task model.** The bundled Codex CLI catalog lists this task model. Entitlement for the pilot credentials, rate limits, latency and token use await live verification.
3. **Optimizer context.** Full SIM's round 20 carries 10 rounds of target history and up to 20 attempts. The pilot's projection decides whether `gpt-6-luna` fits, or whether the optimizer model must change before S1 (K2, K3).
