# Changelog

## Breaking change — central learning

Learning now runs in the service. The application loop definitions, evaluation starters, evaluator commands and learning CLI have been removed. Configure a model provider, import and review tasks, and start learning in the bundle’s Learning tab. SDKs deliver releases and report production outcomes. Start and resume require a verified provider and 20 admitted tasks in each split. Both SDKs can list and remove blocked versions. The remaining command is `acclimate pull`.

Run the `acclimate-executor` container with a provisioned token mounted through `ACCLIMATE_EXECUTOR_TOKEN_FILE` and access to the Docker socket. Create the token with `acclimate-service --create-executor-token`. Build the chat runner image and configure gVisor (`runsc`) in production. Set `ACCLIMATE_PROVIDER_ENCRYPTION_KEY` on the service to a 64-character hex key so workspace provider credentials can be encrypted at rest. `npm run local:up` now creates the executor token and starts the executor. In production, follow the ordered [first start](deploy/README.md#first-start): the runner and executor have no published images. Start and resume return 409 `optimizer-required` when the service has no optimizer model, and the loop reports `optimizerConfigured`.

Migrations `0022` to `0024` stop active rounds, pause running loops with `tasks-required` and copy evolve cases into service-owned tasks. They turn each stored `evaluate` machine right into `read`; give outcome reporters `write`. Startup refuses a static grant that still lists `evaluate`. The service no longer reads `ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS` or `ACCLIMATE_LEARNING_EVALUATION_SECONDS`. [Upgrade steps](deploy/README.md#upgrade-to-the-learning-loop-schema)

Scores change meaning. An exact-match rollout scores 1 or 0. A judged rollout is judged three times, passes when at least two judgments pass every criterion, and scores the share of criteria met, averaged over the judgments. A task's score is the mean of its five rollouts, and a task passes when three of them pass. Evolve scores from earlier judged rounds are not comparable with new ones. The automatic revert judges on the held-out pass rate, the share of rollouts that pass, so partial credit does not hide a task that stopped passing. The loop alert adds `previousPassRate` and `passRate`, and the alert email reports the pass rate. Upgrade the service before the executor: the service accepts the 1-or-0 judged scores of an older executor, but an older service rejects a newer executor's fractional scores.

Other behavior to know:

- Import sets a row aside as `no-reference`, `not-converted` or `too-large` and converts the rest. Criteria already in a row are kept, and the judge drafts criteria only for a row with an answer and none of its own.
- For an exact-match task with a failing rollout, the optimizer's feedback includes the expected answer. The screen skips candidates that address the grader.
- The executor gateway retries provider errors and waits on `Retry-After` for up to seven minutes. It does not resend a request that ran for its full ten-minute timeout. With CLIProxyAPI and one Codex sign-in, turn the proxy's cooldown off. [Operator guide](deploy/README.md#cliproxyapi-with-codex-sign-in)
- An adopted round that loses its executor before the held-out check finishes keeps its release and raises the `regression-check-incomplete` alert.

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

- Enrolled bundles run five-sample optimization rounds with screening, evaluation, automatic release on adoption, and private held-out monitoring. The service owns the tasks and the `acclimate-executor` container runs each rollout in a sandbox. The console's Learning tab covers setup, task import and review, Try, round history, usage, rollback and revisioned improvement memory.
- Applications can pin a job to a verified version and feed back a known answer with `createAcclimate().job(...).expect(...)` in TypeScript or `Acclimate().job(...).expect(...)` in Python. The workspace principal route identifies the calling principal and its rights.
- Both SDKs deliver immutable bundles with verified caching. Channel preparation confirms the release online for each job. Exact-version reads can opt into verified cached content after eligible transport failures or HTTP 503.
- Native plugins prepare bundles for Codex, Claude, Pi and Cursor. The native repository starter retains partial diffs when an agent task fails.
- `acclimate pull` saves a released payload.
- Python errors share the `AcclimateError` base with a stable `code`. `ApiError.request_id` carries the HTTP error body's `requestId`. Invalid arguments raise `UsageError`, a `ValueError` subclass.
- `npm run local:up` picks free ports, prepares the `local-demo` workspace and writes `env.sh` and `ca-bundle.pem`. `npm run local:trust` trusts the local certificate.
- [OpenAPI](contracts/openapi.json) documents the workspace HTTP API. The [learning contract](contracts/learning.md) covers enrollment, tasks, trials, round history and improvement memory.
- The service runs migrations through `0024_learning_reliability.sql`. Follow the backup and upgrade procedure before migrating an existing database. [Deployment instructions](deploy/README.md#upgrade-to-the-learning-loop-schema)
- Added the `test:learning-e2e` check, which runs the service and a real executor against a scripted model endpoint. The self-improvement memory experiment is parked until it is ported to the executor. [Experiment](examples/self-improvement-memory/README.md)
