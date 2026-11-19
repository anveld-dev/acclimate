# Pre-registration for the 40-case LLM CLI experiment

Can service-managed connected learning release a candidate that is non-inferior to the baseline on unseen CLI support requests? The primary outcome is the audit decision. The secondary outcomes are audit paired gain and its one-sided 95% lower bound, with evidence of superiority when the bound exceeds zero.

## Frozen inputs and validation

Acclimate service source is `bf4f9726649ce72c37784ba33abaa03b54b06103`. Use LLM 0.38 at `46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f`, Click 8.5.1, Python 3.13.1, PostgreSQL 18.6 and Rust 1.89.0. Use Codex CLI 0.169.1 for readiness and @openai/codex-sdk 0.169.0 for live inference, all with `gpt-6-luna` at low reasoning effort.

Append ten new development cases to the original 30, and ten new audit cases to the replication's 30 previously unevaluated audit cases. Retain the ten original field cases in their original order. The corrected grader compares command routes and all parsed Click parameters. The resolved baseline bundle digest is expected to be `sha256:5ae11b8aedac22d0f849f9be2636c9aae891689f9c82858a05b155ee205b92b2`.

Zero-call checks passed for all 70 original references and negative controls, the 30 replication audit references and 20 additions with two negative controls each, and both upstream encode/decode tests. The validator checked IDs, request text, and parsed targets of the additions against all prior cases and each other.

```text
98ba61a7435fe79a90285a67effc0cec9bea0e303362ef232aece0b96615d3fe  examples/real-app-learning/tasks.py
219431880c0f5f12c61254c4d0eeb40e61ba14f5a5d9926841e71903e1f68b1c  examples/real-app-learning/replication-audit.json
004236e032a562e956e30da4f9d0282275000cfdf45de1004af0728e9904fd47  examples/real-app-learning/40-case-additions.json
6b65e6c8afe07d8a923ab5710c1693441a77a098a295cf436cde457de4b97f65  examples/real-app-learning/grade.py
1a760943b79185b7cff38cea52e06f67b8fe32cd090f560dd4453e0019db103b  examples/real-app-learning/baseline.json
575c6122089b4301e1540411f9a7d102afc64a073a3261500c6651829c141401  examples/real-app-learning/check-replication.py
b56eccc56527e80954605187bb53c4edddbb942a0506419a1cd241e5ca2b6ebf  examples/real-app-learning/run.ts
e58ddf81693245422a58900ef6ebd1b02bc539ae2975eac43af4d2012a6ac034  upstream:tests/test_encode_decode.py
```

## Policy and run order

Set `LLM_REPLICATION=40`. Use policy v3 defaults for the 3 percentage point development step margin, fresh cumulative superiority at 90% and audit non-inferiority at 95% with a 3 point margin. Use a 10 point target effect on both policies, two uniform repetitions per arm per case, an 80-pair per-evaluation budget, and a single A/A attempt with two repetitions per arm. The audit passes when its lower bound strictly exceeds −3 points. A calibration power stop is terminal and leaves the audit unevaluated.

Run a tool-free readiness turn, then use a fresh disposable PostgreSQL cluster. On calibration admission, run and grade all ten field tasks from the baseline and submit graded failures as corrections in frozen order within the single proposal admission. Wait for the round's terminal decision or operator review. Automatic rollout is disabled. If requested, approve through the operator endpoint only when the service passed the audit and the diff contains reusable guidance. Record the decision and rationale.

## Turn accounting

Project 1 readiness + 160 A/A (40 × 2 × 2) + 10 field + an allowance of 10 proposer and critic turns + 160 development + 160 fresh cumulative + 160 audit = **661 turns** for the full path. Count every attempt and all reported input and output tokens. The projection is for reporting. Per-request timeouts apply throughout.

[First experiment](README.md) · [30-case replication](replication.md)
