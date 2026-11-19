# Pre-registration for the LLM CLI replication

Does connected learning on the current service release a candidate that is non-inferior to the published baseline on unseen CLI support requests?

## Frozen setup

Use Acclimate service source `ea81aed7cf4dc267473c603cfd02f85671a3fc71`, LLM 0.38 at upstream commit `46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f`, Click 8.5.1 and a fresh PostgreSQL 18 database. Reuse the original development and field splits, corrected grader and baseline. Replace the now-seen audit split with 30 fresh task IDs, requests and parsed targets. The connected evaluator grades an argv array by comparing Click command routes and all parsed parameters, without invoking command handlers.

Zero-call validation passed for the original 70 references and negative controls, all 30 new references, all 60 new negative controls, and both frozen upstream encode/decode tests. The validator also checks that the fresh parsed targets are distinct from each other and from all original parsed targets.

- [Fresh audit cohort](../../../examples/real-app-learning/replication-audit.json)
- [Zero-call validation](../../../examples/real-app-learning/check-replication.py)
- [Original protocol and grader correction](preregistration.md)

SHA-256 digests of frozen inputs follow.

```text
98ba61a7435fe79a90285a67effc0cec9bea0e303362ef232aece0b96615d3fe  examples/real-app-learning/tasks.py
6b65e6c8afe07d8a923ab5710c1693441a77a098a295cf436cde457de4b97f65  examples/real-app-learning/grade.py
1a760943b79185b7cff38cea52e06f67b8fe32cd090f560dd4453e0019db103b  examples/real-app-learning/baseline.json
219431880c0f5f12c61254c4d0eeb40e61ba14f5a5d9926841e71903e1f68b1c  examples/real-app-learning/replication-audit.json
27548979ee2811b430da5c7f894beb3ef4e9de0535aeadfe10bf440efcf65f96  examples/real-app-learning/check-replication.py
```

## Policy and decisions

Use policy schema 3 defaults with a 0.03 development step margin, fresh cumulative superiority against the published baseline, and audit non-inferiority with a 0.03 margin at one-sided 95% confidence. Set `targetEffect` to 0.10 on both policies. Set the repetition cap to two, the pair budget to 60 per comparison and A/A to two repetitions per arm, with a single calibration attempt. Configure one proposal admission and schedule an audit after one accepted step.

The primary outcome is the service's audit non-inferiority decision for the candidate (one-sided 95% lower bound strictly above −0.03). The secondary outcome is the held-out paired mean gain and the same 95% lower bound, with evidence of superiority only if that bound is strictly above zero. The service's Student t bound uses equal case means and its calibrated variance floor. Report an absent comparison as unevaluated.

Run one tool-free readiness turn before connecting the evaluator. Report a calibration power stop as the terminal result. Otherwise run all ten field requests on baseline delivery and submit validated corrections in frozen field order within available admission inventory. The automatic rollout flag is false. If review is requested, approve through the administrator endpoint only after verifying the audit passed and the diff contains reusable CLI guidance. Record the decision. End after the first admitted round completes or the service stops admission.

## Budget

Each inference selects `gpt-6-luna` at low reasoning effort. The original pre-call estimate was 1 readiness + 120 A/A + 10 field + up to 10 proposer and critic + 120 step + 120 cumulative + 120 audit = 501 turns. Adding a 10% contingency rounded up to 51 turns gave 552 projected turns. This is a planning estimate. Count every started call and record Codex-reported usage across attempts.

## Amendment during calibration

At the experimenter's request, remove the experiment-wide turn and wall-clock caps and all budget-driven reductions before observing any comparison result. The initial run was stopped during A/A after 18 started Luna turns, including one readiness turn. Codex reported 267,537 input and 639 output tokens across 17 turns. The final interrupted turn had no usage report. Restart A/A from a fresh PostgreSQL database using the completed readiness check. The scientific design retains uniform repetition cap two, a 60-pair plan, and calibration at two repetitions per arm.
