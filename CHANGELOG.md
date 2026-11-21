# Changelog

All notable changes to Acclimate will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - Unreleased

The first release, open source under Apache-2.0. The service and console images, `@acclimate/sdk`, the four plugin packages, the `acclimate-sdk` Python package and the starter archives are all versioned `0.1.0`; the plugins peer-depend on `@acclimate/sdk` `^0.1.0`.

### Removed

- Removed HTTP routes for bundle drafts and their history, save, discard and publish operations, for proposals, comparisons and policy receipts, and for evaluation requests, their start, finish, interrupt, abandon and progress operations, and workspace evaluation capabilities.
- Removed the connection learning route and its stop, restore, renew, corrections, rechecks, outcome submission and lookup, work, incident replay, field audit, field requalification and round review subroutes.
- Removed the `propose` machine right and the release fields `comparisonId` and `policyOverride`. Bundle setup remains at `POST /v1/workspaces/{workspaceId}/bundle-setups`. Releases now require a reason in `unevaluatedReason`.
- Removed the GitHub Action and CI wrapper, the `acclimate-operator` command and the connected-learning driver, and the `acclimate-eval` and Python `acclimate` commands `compare`, `request`, `run`, `check`, `status`, `interrupt`, `export`, `verify-export` and `plan`, including `--policy`, `--handoff`, `--aa`, `--effects`, `--simulations` and `--seed`.
- Removed SDK exports for manual comparisons, policy, planning, analysis, evidence export, evaluation requests and progress, drafts, and the old learning driver. Removed TypeScript subpaths `@acclimate/sdk/evaluation/policy`, `@acclimate/sdk/evaluation/artifacts`, `@acclimate/sdk/evaluation/analysis` and `@acclimate/sdk/evaluation/progress`. The learning subpath now exposes the bundle learning loop.
- Removed startup settings `ACCLIMATE_CRITIC_MODEL`, `ACCLIMATE_CRITIC_ENDPOINT`, `ACCLIMATE_CRITIC_TOKEN`, `ACCLIMATE_LEARNING_REVIEW_SECONDS`, `ACCLIMATE_LEARNING_PARENT_MAX_REUSES`, `ACCLIMATE_LEARNING_PARENT_MAX_AGE_SECONDS`, `ACCLIMATE_LEARNING_PAIR_BUDGET`, `ACCLIMATE_LEARNING_MAX_REPETITIONS`, `ACCLIMATE_LEARNING_CALIBRATION_REPETITIONS`, `ACCLIMATE_LEARNING_MAX_STEPS_BETWEEN_AUDITS`, `ACCLIMATE_LEARNING_MAX_CHAIN_AGE_SECONDS`, `ACCLIMATE_LEARNING_CALIBRATION_ATTEMPTS`, `ACCLIMATE_LEARNING_FAILURE_WINDOW_SECONDS`, `ACCLIMATE_PROPOSAL_GROWTH_FLOOR_BYTES`, `ACCLIMATE_EVALUATION_ABANDON_SECONDS`.
- Removed Changes, draft, comparison and evaluation screens, along with connection learning, outcome lookup, review and field controls.

### Added

- Enrolled bundles run five-sample optimization rounds with screening, evaluation, automatic release on adoption, and private held-out monitoring. The console shows round history and revisioned improvement memory, and workspace writers can add and retire evolve cases.
- The TypeScript SDK ships `defineLoop` and `acclimate learn`, and the Python SDK ships `define_loop` and `python -m acclimate learn`. Both provide an `openai()` adapter for OpenAI-compatible Chat Completions endpoints. TypeScript also ships `acclimate-learning` for custom evaluators that manage their own split.
- Applications can pin a job to a verified version and feed back a known answer with `createAcclimate().job(...).expect(...)` in TypeScript or `Acclimate().job(...).expect(...)` in Python. The workspace principal route identifies the calling principal and its rights.
- Both SDKs deliver immutable bundles with verified caching. Channel preparation confirms the release online for each job. Exact-version reads can opt into verified cached content after eligible transport failures or HTTP 503.
- Native plugins prepare bundles for Codex, Claude, Pi and Cursor. The native repository starter retains partial diffs when an agent task fails.
- Local evaluator commands include `describe`, `coverage`, `try`, `doctor` and `pull`. Local graders can return up to 32 named numeric grade components alongside the reward.
- Python errors share the `AcclimateError` base with a stable `code`. `ApiError.request_id` carries the HTTP error body's `requestId`. Invalid arguments raise `UsageError`, a `ValueError` subclass.
- `npm run local:up` picks free ports, prepares the `local-demo` workspace and writes `env.sh` and `ca-bundle.pem`. `npm run local:trust` trusts the local certificate.
- [OpenAPI](contracts/openapi.json) documents the workspace HTTP API. The [learning contract](contracts/learning.md) covers enrollment, evaluator work, round history and improvement memory.
- The service runs migrations through `0021_optimizer_effort.sql`. Follow the backup and upgrade procedure before migrating an existing database. [Deployment instructions](deploy/README.md#upgrade-to-the-learning-loop-schema)
- Added the self-improvement memory experiment and the `test:learning-e2e`, `test:learn-cli` and `test:sim-experiment` checks. [Experiment](examples/self-improvement-memory/README.md)
