# Pre-registration for the five-admission rerun on 40-case LLM CLI cohorts

Can service-managed connected learning release a candidate that is non-inferior to the baseline on unseen CLI support requests? The primary outcome is the audit non-inferiority decision at a 3 percentage point margin and one-sided 95% confidence. Report the number of admissions rejected by the critic and the number reaching development, with reasons. The secondary outcomes are audit paired gain and its one-sided 95% lower bound, with evidence of superiority when the bound exceeds zero.

## Frozen inputs and validation

Acclimate service source is `668f47b02cdab71d75362c486f8ddaf88b5544bb`. Use LLM 0.38 at `46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f`, Click 8.5.1, Python 3.13.1, PostgreSQL 18.6 and Rust 1.89.0. Use Codex CLI 0.169.1 for readiness and @openai/codex-sdk 0.169.0 for live inference, all with `gpt-6-luna` at low reasoning effort.

Append ten new development cases to the original 30, and ten new audit cases to the replication's 30 previously unevaluated audit cases. Retain the ten original field cases in their original order. The corrected grader compares command routes and all parsed Click parameters. The resolved baseline bundle digest is expected to be `sha256:5ae11b8aedac22d0f849f9be2636c9aae891689f9c82858a05b155ee205b92b2`.

Before readiness, rerun the zero-call checks that passed for all 70 original references and negative controls, the 30 replication audit references and 20 additions with two negative controls each, and both upstream encode/decode tests. The validator checked IDs, request text, and parsed targets of the additions against all prior cases and each other.

```text
98ba61a7435fe79a90285a67effc0cec9bea0e303362ef232aece0b96615d3fe  examples/real-app-learning/tasks.py
219431880c0f5f12c61254c4d0eeb40e61ba14f5a5d9926841e71903e1f68b1c  examples/real-app-learning/replication-audit.json
004236e032a562e956e30da4f9d0282275000cfdf45de1004af0728e9904fd47  examples/real-app-learning/40-case-additions.json
6b65e6c8afe07d8a923ab5710c1693441a77a098a295cf436cde457de4b97f65  examples/real-app-learning/grade.py
1a760943b79185b7cff38cea52e06f67b8fe32cd090f560dd4453e0019db103b  examples/real-app-learning/baseline.json
575c6122089b4301e1540411f9a7d102afc64a073a3261500c6651829c141401  examples/real-app-learning/check-replication.py
38614d62eae0d159524707328d875f4213ed8bda0ba9b0248ec457c745c1a09b  examples/real-app-learning/run.ts
e58ddf81693245422a58900ef6ebd1b02bc539ae2975eac43af4d2012a6ac034  upstream:tests/test_encode_decode.py
```

## Policy and run order

Set `LLM_REPLICATION=40` and `LLM_PROPOSAL_ADMISSIONS=5`. Use policy v3 defaults for the 3 percentage point development step margin, fresh cumulative superiority at 90% and audit non-inferiority at 95% with a 3 point margin. Use a 10 point target effect on both policies, two uniform repetitions per arm per case, an 80-pair per-evaluation budget, and a single A/A attempt with two repetitions per arm. The audit passes when its lower bound strictly exceeds −3 points. A calibration power stop is terminal and leaves the audit unevaluated.

Run a tool-free readiness turn, then use a fresh disposable PostgreSQL cluster. On calibration admission, run and grade all ten field tasks from the baseline. Submit every graded field failure as a correction in frozen order. Development and audit cases supply no corrections. Set `maxProposalAdmissions: 5` and `maxCorrectionsPerRound: 1`.

The earlier 40-case run rejected both edits for `cli-01-7`. The interrupted five-admission run rejected its first substantive edit for case specificity and accepted its repair. That repair reached development, where 121 of 160 turns completed without a finalized comparison. Its A/A SE and MDE were 4.28 and 9.22 percentage points. The fresh restart measured 5.52 and 11.90 points and stopped at calibration. No audit result on these audit tasks has ever been observed. If `cli-01-7` fails again, its correction is eligible in frozen order.

The fresh disposable database contains no prior calibrations, so pooling does not apply. Report each gate's admit, warn or stop decision, point MDE and MDE at the lower end of the 95% chi-square SD interval. A lower-end MDE above the target stops the run. A point MDE alone above target warns and admits. Measure all enrollment status GET attempts through response parsing or failure, including retries. Report count, failed count, nearest-rank p99 and maximum latency.

Use the service's incumbent chain and the previous harness's configured cumulative check cadence of one accepted development step. The service checks the cumulative head against the published baseline and, if eligible, uses the sole registered audit cohort. End the experiment when that cohort is consumed and the round has finished, and report unused admissions and corrections. If the audit stays unused, report the terminal state after available admissions or eligible corrections are exhausted.

Automatic rollout is disabled. Approve through the operator endpoint only if the service requests review, the audit passed and the diff contains reusable guidance. Record the decision and rationale.

## Turn accounting

Project 1 readiness + 160 A/A + 10 field + up to 5 × (4 proposer + 4 critic) + 160 development per step reaching development + 160 cumulative + 160 audit = **1,331 turns** if all five admissions reach development and a single cumulative check and audit run. These counts describe the projected work. Count every attempted turn and its reported input and output tokens. Per-request timeouts apply. The experiment has no aggregate turn or time cap.

[First experiment](README.md) · [30-case replication](replication.md) · [Previous 40-case experiment](40-case.md)

[Previous five-admission attempts](5-admission.md)
