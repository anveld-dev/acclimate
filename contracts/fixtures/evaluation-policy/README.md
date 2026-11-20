# Evaluation policy conformance vectors

`vectors.json` is shared by the installed TypeScript and Python policy implementations. Each vector supplies a trusted public descriptor, explicit expected comparison binding, app policy and comparison, then fixes either the safe error category or the descriptive verdict/reason and selected exact numeric results.

The fixtures cover distinct-case weighting with unequal repetitions, both metric directions, inclusive thresholds, finite arithmetic overflow and rounding order, UTF-8 case ordering, missing/infrastructure/grading evidence, scored task failures, cost knownness, binding/inventory mistakes, and authoring schema errors. Public strings may contain escaped controls and are not interpreted as code. Private configuration, task contents and expected answers are absent.

Use the documented binary64 sum-then-divide recurrence. Do not substitute incremental means, Python `sum`/`fmean`, compensated reductions or pair-weighted aggregation. Nonfinite intermediate arithmetic is indeterminate. File hashes from policy parsers identify exact UTF-8 bytes, not canonicalized JSON or authenticated execution.

Focused checks from repository root:

```sh
node_modules/.bin/tsx --test packages/sdk/tests/evaluation/policy.test.ts
PYTHONPATH=python python3.11 -m unittest discover -s python/tests -p test_evaluation_policy.py -v
```

`vectors.json` vectors declare `inference.method: "none"` because they test point-estimate arithmetic on one or two cases. `inference-vectors.json` covers the default paired Student t test: insufficient cases and repetitions (the default needs two repetitions per case), zero variance, the SD floor, declared confidence levels and reward scales, imputation, per-case scope across schema versions (the default `protected-cases` runs no per-case regression check when no case is protected), the net `maximumRegressedCases` allowance, reserved ids, and connected development and audit stages, which declare `minRepetitions: 1` as the service's connected defaults do. Each case lists per-repetition rewards; both test suites expand them the same way and compare the full `inference` block bit for bit. `plan-vectors.json` fixes the simulated plans from `planEvaluation`, which both SDKs must reproduce exactly. `../evaluation-analysis/student-t.json` is the Student t table every implementation embeds.

These are deterministic policy/contract checks. They do not run a service, model, release, or provider. The statistical properties of the default test are measured separately by `scripts/evaluation/policy-calibration.ts`.
