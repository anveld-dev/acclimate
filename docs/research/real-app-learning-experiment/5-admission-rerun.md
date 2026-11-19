# Five-admission rerun on 40-case LLM CLI cohorts

Can five proposal admissions yield a connected-learning candidate that passes a held-out audit at a 3 percentage point non-inferiority margin and one-sided 95% confidence? The fifth candidate passed with 23/80 exact matches against 13/80 for the baseline. Its paired gain was +12.50 percentage points, with a one-sided 95% lower bound of +3.58 points. [Pre-registration](5-admission-rerun-preregistration.md)

## Setup

The service ran from Acclimate source `668f47b02cdab71d75362c486f8ddaf88b5544bb` built with Rust 1.89.0 and a fresh disposable PostgreSQL 18.6 cluster. It included the lock-free enrollment reads and uncertainty-aware calibration guard. The grader used Python 3.13.1 and Click 8.5.1 against LLM 0.38 at `46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f`. Node v26.13.1 ran @openai/codex-sdk 0.169.0, and readiness used Codex CLI 0.169.1. All turns requested `gpt-6-luna` at low reasoning effort. Backend model identity was independently unverified.

The 40 development, 40 audit and 10 field tasks, grader, baseline payload, validator and upstream test matched their preregistered SHA-256 digests. All 70 original reference arrays and negative controls, 50 replication/addition references and their 100 negative controls, and both upstream encode/decode tests passed. The published baseline version was `64c80f1a-1cdb-4824-bc79-a9cc85aae545`, resolved digest `sha256:5ae11b8aedac22d0f849f9be2636c9aae891689f9c82858a05b155ee205b92b2`. The preregistration lists the fixture and runner digests.

Policy v3 used a 3-point development step margin at one-sided 90%, fresh cumulative superiority at one-sided 90% after each accepted development step, and audit non-inferiority with a 3-point margin at one-sided 95%. The power target was +10 points. The service allowed five proposal admissions, one correction per round, and one audit cohort. Automatic rollout was disabled.

## Calibration and power admission

The A/A request `2f4b9f95-638a-402c-b183-e7c24c5ce652` completed 80 pairs, two repetitions per arm on each of 40 cases. Case-mean flip rate was 20.00% (8/40), and 10 cases disagreed on at least one repetition. Paired SD was 0.24693, SE was 3.90 percentage points, and calibration MDE was 8.41 points. The guard used 40 observations from this A/A. Pooling did not apply because the cluster was fresh.

The plan assigned two repetitions per arm uniformly to each development, cumulative and audit case, for 80 pairs and 160 trials per comparison.

| Gate | Decision | Point 80%-power MDE | MDE at 95% SD interval endpoints | Power at +10 pp | Cases needed at +10 pp |
| --- | --- | ---: | ---: | ---: | ---: |
| Development step | Admit | 6.33 pp | 4.66 to 8.94 pp | 95.53% | 22 |
| Cumulative superiority | Admit | 9.33 pp | 7.66 to 11.94 pp | 84.27% | 35 |
| Audit non-inferiority | Admit | 7.98 pp | 6.02 to 11.05 pp | 90.61% | 29 |

The projected MDE cleared the 10-point target at every gate. No warning or stop was issued. This rerun observed the guard's admit path.

## Field outcomes and proposal admissions

The baseline passed 2/10 field tasks, `cli-07-1` and `cli-08-7`. All eight failures were submitted as corrections in frozen order.

| Admission | Field case | Proposal ID | Proposal and critic result | Round decision |
| ---: | --- | --- | --- | --- |
| 1 | `cli-01-7` | `e5d3504c-9024-4149-a511-02e35fec5701` | Clarified exact output and reference examples. Accepted with no objections. | Rejected in development |
| 2 | `cli-02-6` | `5fa94601-f837-4824-b848-353c6aa83bb2` | Clarified that references supply context unless explicitly requested. Accepted with no objections. | Rejected in development |
| 3 | `cli-03-5` | `8ba0583d-c697-4653-9f08-83b715666a11` | First attempt proposed no edit because the evidence did not establish a required argument order. The next distinguished a reference command from the requested output. Accepted with no objections. | Rejected in development |
| 4 | `cli-04-4` | `816673f2-6946-4666-b8fd-77b0abc3d50c` | First attempt proposed no edit because it found no reusable lesson. The next edited the output rule to treat reference commands as evidence. Accepted with no objections. | Rejected in development |
| 5 | `cli-05-3` | `2d5247ef-c863-492e-9c43-924f301f6012` | First attempt proposed no edit because it found no reusable change supported by the evidence. The next advised deriving commands from the request and local help or source. Accepted with no objections. | Development passed |

All five admissions reached development. The critic accepted all five nonempty edits on first screening and raised no objections. The proposer returned three empty edits before retrying within their respective admissions. Four candidates failed development with the service reason “Minimum mean improvement was not reached.” The fifth passed development and cumulative evaluation, used the sole audit cohort, and was promoted after operator review. The last three submitted corrections, `cli-06-2`, `cli-09-6` and `cli-10-5`, went unadmitted.

## Comparisons and decisions

The counts are exact matches out of 80 scored trials per arm. The paired estimate averages repetition differences within each case, then weights the 40 cases equally. The one-sided 90% development bounds use the service's Student-t critical value and calibrated SD floor. A development step needed a lower bound strictly above −3 points and evidence of benefit. The A/A comparison supplied noise calibration.

| Stage | Comparison ID | Parent | Candidate version and score | Paired gain | Lower bound | Decision |
| --- | --- | --- | --- | ---: | ---: | --- |
| A/A | `7bae66d7-cf71-4dbd-b16e-ebc56888a06a` | Baseline 25/80 | Same baseline 25/80 | 0.00 pp | — | Admitted at every power gate |
| Development 1 | `50385252-7d4b-496a-9f4e-9536609643be` | Baseline 20/80 | `d5b6c89b-7254-4798-9ef8-82d8423c710f` 22/80 | +2.50 pp | −3.19 pp | Rejected |
| Development 2 | `7589d8c4-1e62-4b9a-ae7b-981c21c50098` | Baseline 25/80 | `92c7d947-1ae8-436d-ac28-262074b02404` 27/80 | +2.50 pp | −3.65 pp | Rejected |
| Development 3 | `d980d55f-326e-4874-8c38-86032b72ed8f` | Baseline 22/80 | `b03f7c82-c0ea-4d2c-ac2d-4133009521ea` 22/80 | 0.00 pp | −5.09 pp | Rejected |
| Development 4 | `5b0d3ed3-550a-499e-a618-83f7b0ce5f90` | Baseline 24/80 | `cab2dc16-3ebe-4c4f-b915-de546df76c73` 23/80 | −1.25 pp | −6.34 pp | Rejected |
| Development 5 | `806a5dab-82ad-4c7c-b587-44448a74fab0` | Baseline 26/80 | `94ac50ab-255c-499b-9adb-045551d88ed9` 38/80 | +15.00 pp | +5.90 pp | Passed |
| Fresh cumulative | `0e0324b1-a75e-4566-a12e-00e5f39765f5` | Baseline 19/80 | `94ac50ab-255c-499b-9adb-045551d88ed9` 36/80 | +21.25 pp | +13.91 pp | Passed superiority gate |
| Held-out audit | `9da4d303-4901-4f13-bdd3-73c2074bf53e` | Baseline 13/80 | `94ac50ab-255c-499b-9adb-045551d88ed9` 23/80 | +12.50 pp | +3.58 pp (95%) | Passed non-inferiority |

The audit lower bound exceeded both −3 points and zero. The service requested operator review for round `08c1810e-4e2a-4f39-97d5-63294397a6c8`. I approved it through the harness's operator review endpoint after verifying the passed audit and inspecting the candidate diff. The edit gives reusable guidance for deriving a command from the request and local CLI documentation, without prescribing a specific command or case. The disposable service promoted candidate `94ac50ab-255c-499b-9adb-045551d88ed9`, digest `sha256:88345b82c388cc1d098671cc7c52d7fc7eb04aa12a4c9a5c69a5f9dca9d8ba4c`, under promotion `6011cfc2-b955-4622-a247-026c7934682b`. The operator readback confirmed delivery of that version.

## Candidate diffs

Each candidate edited only `AGENTS.md`. The excerpts show the changed sentences.

### Admission 1

```diff
-Return the requested command using the specified output format. Do not execute the suggested command.
+Return exactly what the request asks for in the specified output format; do not substitute a command mentioned as a reference example. Do not execute suggested commands.
```

### Admission 2

```diff
-Return the requested command using the specified output format.
+Return exactly what the request asks for in the specified output format; do not substitute a command mentioned as a reference unless requested.
```

### Admission 3

```diff
-Return the requested command using the specified output format. Do not execute the suggested command.
+Return exactly the output requested by the user, using the specified format. A command shown as a reference is context, not necessarily the requested output. Do not execute suggested commands.
```

### Admission 4

```diff
-Return the requested command using the specified output format. Do not execute the suggested command.
+Return exactly the command the user asks for, in the specified output format. A command included as a reference is evidence, not necessarily the requested command. Do not execute suggested commands.
```

### Admission 5

```diff
-Return the requested command using the specified output format. Do not execute the suggested command.
+Return exactly the output the user requests, in the specified format. When they ask for a command, derive it from their request and local CLI help or source; do not substitute a reference command unless it matches the request. Do not execute suggested commands.
```

## Status GETs, usage and deviations

The harness timed all 7,062 enrollment status GETs, including response parsing, at its preregistered polling cadence. The nearest-rank p99 was 17.03 ms and the maximum was 222.91 ms, with zero failed reads or retries. The run completed under ordinary evaluation traffic without the prior timeout. It did not deliberately hold an integration row lock to reproduce the controlled lock test.

| Segment | Luna turns | Input tokens | Output tokens |
| --- | ---: | ---: | ---: |
| Readiness | 1 | 16,116 | 5 |
| A/A | 160 | 2,399,914 | 5,146 |
| Field | 10 | 136,340 | 251 |
| Proposer | 8 | 120,592 | 834 |
| Critic | 5 | 70,928 | 95 |
| Development | 800 | 12,817,674 | 30,074 |
| Fresh cumulative | 160 | 3,569,107 | 10,119 |
| Audit | 160 | 3,044,315 | 8,125 |
| **Total** | **1,304** | **22,174,986** | **54,649** |

All attempted turns reported usage. Elapsed time from the preflight checks through database cleanup was 2 h 0 min 48 sec. The run followed the preregistered protocol with no live restart, service bugs or source workarounds. Local dependency setup recovered from a transient disk-space error and a missing upstream test dependency before readiness. Readiness emitted the same PATH-helper warning seen previously because its isolated Codex home was inside the temporary directory. Repository-wide lint and builds ran outside the live interval.

## Comparison with previous experiments

| Measure | First experiment | 30-case replication | Previous 40-case run | Five admissions, interrupted | Five admissions, restart | Rerun |
| --- | --- | --- | --- | --- | --- | --- |
| Development / audit cases | 30 / 30 | 30 / 30 | 40 / 40 | 40 / 40 | 40 / 40 | 40 / 40 |
| Repetitions per arm | 1 | 2 | 2 | 2 | 2 | 2 |
| A/A case-mean flip rate | 16.67% | 10.00% | 25.00% | 17.50% | 22.50% | 20.00% |
| A/A SE | 8.03 pp | 4.64 pp | 4.28 pp | 4.28 pp | 5.52 pp | 3.90 pp |
| Calibration MDE | 17.05 pp | 10.04 pp | 9.22 pp | 9.22 pp | 11.90 pp | 8.41 pp |
| Projected cumulative / audit MDE | — | 11.41 / 10.46 pp | 9.33 / 7.98 pp | 9.22 / 7.85 pp | 11.90 / 11.00 pp | 9.33 / 7.98 pp |
| Development | +16.67 pp, +4.25 pp bound, passed | Unevaluated | Unevaluated | Interrupted | Unevaluated | Four rejected. Fifth passed at +15.00 pp, +5.90 pp bound. |
| Audit | 0.00 pp, −13.66 pp bound, rejected | Unevaluated | Unevaluated | Unevaluated | Unevaluated | +12.50 pp, +3.58 pp bound, passed |
| Terminal event | Audit rejection | Cumulative power guard | Critic rejection | Harness timeout | Cumulative power guard | Operator approval after audit |
| Candidate released | No | No | No | No | No | Yes, in disposable service |

[First experiment](README.md) · [30-case replication](replication.md) · [Previous 40-case run](40-case.md) · [Previous five-admission attempts](5-admission.md)

## Conclusion

The fifth admission produced the only candidate to clear development and the fresh cumulative gate. Its held-out result passed the preregistered non-inferiority test and the lower bound also supported positive gain. Four similar edits cleared critic screening and fell short in development. Because each edit was evaluated against fresh baseline calls and each variant was run once, the results cannot isolate the effect of the wording or show that a five-admission budget will reliably yield an improvement.

The evidence covers one pinned CLI, one requested model and effort, an exact Click-parameter grader, and one holdout cohort. Exact matches remained below 30% in the candidate audit arm. The prior experiments varied in cohort, policy, budgets, service revision and realized baseline noise, so the historical results do not establish a causal effect of either service fix or the admission budget.
