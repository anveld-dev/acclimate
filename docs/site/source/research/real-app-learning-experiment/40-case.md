# Connected learning on 40-case LLM CLI cohorts

Can service-managed connected learning produce a candidate that is non-inferior to the published baseline on unseen LLM CLI support requests? The 40-case design cleared the power guard, but critic screening blocked the proposal before a candidate version was created. Audit non-inferiority, paired gain, and the one-sided 95% lower bound are unevaluated. [Pre-registration](40-case-preregistration.md)

## Setup

Acclimate service source `bf4f9726649ce72c37784ba33abaa03b54b06103` was built with Rust 1.89.0 and run against disposable PostgreSQL 18.6. The grader used Python 3.13.1 and Click 8.5.1 with LLM 0.38 at `46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f`. The harness ran on Node v26.13.1, with Codex CLI 0.169.1 for readiness and @openai/codex-sdk 0.169.0 for the live run. Every inference requested `gpt-6-luna` at low reasoning effort. Backend model identity was independently unverified.

Development comprised the original 30 cases and ten additions. Audit comprised the replication's 30 unevaluated cases and ten additions. Field retained the original ten cases. Zero-call checks passed for all 120 reference argv arrays and their negative controls, including two controls per new case, and both upstream encode/decode tests. The pre-registration records the task, validator, grader, baseline, harness, and upstream test SHA-256 digests. The installed baseline version was `22f93330-caf8-4a81-8472-1d7e6aa4a178`, with resolved digest `sha256:5ae11b8aedac22d0f849f9be2636c9aae891689f9c82858a05b155ee205b92b2`, matching both prior studies.

Policy v3 used a 3-point development step margin, fresh cumulative superiority at 90% and audit non-inferiority with a 3-point margin at 95%, with a 10-point power target. The service had a single proposal admission and allocated 80 pairs per evaluation.

## Results

| Stage | Comparison ID | Parent | Candidate arm | Paired gain | One-sided lower bound | Decision |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| A/A calibration | `83966f7d-1175-40b0-abf3-03bb453434fc` | 26/80 | 22/80 (same baseline) | −5.00 pp | — | Power guard admitted |
| Development | — | — | — | — | — | Unevaluated after critic rejection |
| Fresh cumulative | — | — | — | — | — | Unevaluated |
| Independent audit | — | — | — | — | — | Unevaluated |

A/A request `884e3e41-608f-4def-936a-c18dcdb9cd85` completed all 80 pairs. The case-mean flip rate was **25.00%** (10/40), with 11 cases showing disagreement in at least one repetition. Paired SD was 0.27050 and SE was **4.28 pp**. The calibration MDE was **9.22 pp**. The plan assigned exactly two repetitions per arm for every development, cumulative, and audit case, for 80 pairs and 160 trials per comparison.

| Projected gate | 80%-power MDE | Power at +10 pp | Cases needed at +10 pp |
| --- | ---: | ---: | ---: |
| Development step | 6.33 pp | 95.53% | 22 |
| Cumulative superiority | 9.33 pp | 84.27% | 35 |
| Audit non-inferiority | 7.98 pp | 90.61% | 29 |

The baseline passed three field tasks (`cli-07-1`, `cli-08-7`, `cli-09-6`). The first failure in frozen order, `cli-01-7`, became correction `b549bd12-5557-43fb-9671-26a870d57339`. Round `1febc24e-77da-4953-822d-15ce326553c7` ended in `critic_rejected` after proposal `a9a4d885-8573-4f1a-b670-a50c4dbfcf36` and its repair both failed screening. The initial proposal added extraction guidance and a case-specific example to `context.md`. The repair replaced that addition with broader advice on verifying CLI behavior and formatting the answer. The critic cited duplication and task-specific guidance on the repair. There was no candidate bundle diff, operator review request, or promotion. The six other failures remained reported outcomes under the single-admission policy.

## Time, usage, and deviations

| Segment | Luna turns | Input tokens | Output tokens |
| --- | ---: | ---: | ---: |
| Readiness | 1 | 16,116 | 5 |
| A/A | 160 | 2,419,825 | 5,455 |
| Field | 10 | 167,910 | 352 |
| Proposer, including repair | 2 | 28,679 | 289 |
| Critic | 2 | 29,006 | 79 |
| Total | **175** | **2,661,536** | **6,180** |

Elapsed time from readiness through database cleanup was **16 min 53 sec**. Codex reported usage on every turn. The full-path projection was 661 turns.

There were no protocol deviations or observed service bugs. Readiness warned that Codex could not install PATH helper aliases because its isolated home was inside the designated temp directory. Readiness and all 174 live SDK turns completed with usage. Lint and builds ran outside the live interval.

## Comparison

| Measure | First experiment | 30-case replication | 40-case experiment |
| --- | --- | --- | --- |
| Development / audit cases | 30 / 30 | 30 / 30 | 40 / 40 |
| Repetitions per arm | 1 | 2 | 2 |
| A/A flip rate | 16.67% | 10.00% | 25.00% |
| A/A standard error | 8.03 pp | 4.64 pp | 4.28 pp |
| Calibration MDE | 17.05 pp | 10.04 pp | 9.22 pp |
| Projected cumulative / audit MDE | — | 11.41 / 10.46 pp | 9.33 / 7.98 pp |
| Development | +16.67 pp, +4.25 pp lower bound, passed | Unevaluated | Unevaluated |
| Audit | 0.00 pp, −13.66 pp lower bound, rejected | Unevaluated | Unevaluated |
| Terminal decision | Audit rejection | Cumulative power guard | Critic rejection |
| Candidate released | No | No | No |

[First experiment](README.md) · [30-case replication](replication.md)

## Conclusion

The larger design cleared the projected power threshold in this run. The experiment produced no candidate-level evidence for either audit hypothesis because the only proposal was rejected during screening. The comparisons across experiments combine changes in case inventory, realized calibration noise, and service version. The projections use baseline variation as a proxy for candidate comparison variation. The result is limited to one CLI, exact Click-parameter matching, one correction, and one model configuration shared by the task agent, proposer, and critic.
