# Evaluation policy conformance vectors

`vectors.json` is shared by the installed TypeScript and Python policy implementations. Each vector supplies a trusted public descriptor, explicit expected comparison binding, app policy and comparison, then fixes either the safe error category or the descriptive verdict/reason and selected exact numeric results.

The fixtures cover distinct-case weighting with unequal repetitions, both metric directions, inclusive thresholds, finite arithmetic overflow and rounding order, UTF-8 case ordering, missing/infrastructure/grading evidence, scored task failures, cost knownness, binding/inventory mistakes, and authoring schema errors. Public strings may contain escaped controls and are not interpreted as code. Private configuration, task contents and expected answers are absent.

Use the documented binary64 sum-then-divide recurrence. Do not substitute incremental means, Python `sum`/`fmean`, compensated reductions or pair-weighted aggregation. Nonfinite intermediate arithmetic is indeterminate. File hashes from policy parsers identify exact UTF-8 bytes, not canonicalized JSON or authenticated execution.

Focused checks from repository root:

```sh
node_modules/.bin/tsx --test packages/sdk/tests/evaluation/policy.test.ts
PYTHONPATH=python python3.11 -m unittest discover -s python/tests -p test_evaluation_policy.py -v
```

These are deterministic policy/contract checks. They do not run a service, model, release, or provider and make no statistical-confidence claim.
