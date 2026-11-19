# Changelog

All notable changes to Acclimate will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Initial open-source release under Apache-2.0. The service, TypeScript packages and Python SDK are versioned `0.1.0`.
- A GitHub composite action (`examples/ci/action.yml`) and example pull request and post-merge release workflows in the CI starter.
- `acclimate-operator`, the review and release CLI, now ships in `@acclimate/sdk`.

### Changed

- The CI wrapper forwards cancellation to the evaluator, always prints its summary, reuses unchanged results across commits, reports diagnostics for every phase, writes GitHub annotations and Markdown, and accepts the token from an environment variable or file. `--rerun-after` replaces the wrapper's `--retry-after`, which remains as a deprecated alias.
- `compare --retry-after` accepts an interrupted predecessor. A request against a channel without a release reports `request.channel_empty`.
- Quality policies declare an `inference` block (method, confidence, minimum cases and repetitions, SD floor, missing-trial cap), `metric.scale` and `perCaseChecks`. Verdicts, receipts and CLI text report the statistics behind the decision.
- `acclimate-eval plan` and `python -m acclimate plan` report the minimum detectable effect and simulated pass rates before a run; `doctor --policy` reports policy readiness.
- Analysis `paired-t` intervals answer "tasks like these"; every interval is labeled with its estimand.
- Evaluation requests accept `policyDigest`; receipts and `check` report whether the policy matches it.
- `repeatGrade`, `gradeAgreement` and `passAtK` (Python `repeat_grade`, `grade_agreement`, `pass_at_k`).
- `analyze.mjs` / `analyze.py --name RUN --config CONFIG` derive the evidence and trusted binding from the journal.

### Changed

- Policies of every schema version, including existing v1 files, run a one-sided 95% paired Student t test on the equal-case mean difference by default. Fewer than 10 cases, too few repetitions or zero variance without a floor make the verdict indeterminate (exit 3) instead of passing. Declare `"inference": {"method": "none"}` to keep point-estimate comparisons.
- Policy ids no longer change the calculation, and `connected-development` / `connected-audit` are reserved for connected learning. Per-case regression and task-failure checks are the same in every schema version.
- Rewards outside a declared `metric.scale` are invalid evidence (`evidence.reward_out_of_range`), not a policy failure.
- The fixed-case analysis bootstrap scales resampled deviations to fix undercoverage and needs three repetitions per case.
- Connected development confidence is configurable; v3 development names its step non-inferiority check and honors `minimumMeanImprovement` in the benefit check.
- The console shows the reward change in a neutral tone, counts cases rather than repetitions, and shows the policy bound or states that there is none.
