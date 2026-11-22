# Central learning: what is removed

> **Status: proposed, not built.** Nothing here has been deleted yet. The [learning contract](../../../contracts/learning.md) describes what ships today.

Central learning moves every rollout into the [executor](executor.md). The developer's machine no longer runs an evaluator, so the code that existed only to support one is deleted. This file lists each piece and whether it is deleted, moved or kept. Paths were checked against the tree at `e636c0be`.

The deletions ship in the same change as the executor cutover ([plan](plan.md#phase-4-cutover-and-deletions)). There is no period with two ways to evaluate. Removed routes, rights and schema are specified in [API and data](api-and-data.md), and this file only points at the code behind them.

## What stays

| Piece | Where | Note |
| --- | --- | --- |
| `job.expect()` and outcome reporting | `packages/sdk/src/jobs.ts`, `packages/sdk/src/learning/outcomes.ts`, `python/acclimate/_jobs.py` | The production source of tasks. Gains an optional `output`. `outcomes.ts` moves out of `learning/`. |
| Delivery, receipts, connections | `packages/sdk/src/prepare.ts`, `cache.ts`, `reporting.ts`, `verification.ts`, `python/acclimate/delivery.py`, `receipts.py`, `packages/*-plugin` | Unchanged. |
| Execution error types | `packages/sdk/src/compare.ts` | Keep. `index.ts` exports `TaskExecutionError`, `InfrastructureError` and two result types from it. |
| Round state machine | `src/learning/worker.rs`, `worker/advance.rs` | Kept. Scheduling changes are in [loop](loop.md). |
| Optimizer, scanner, memory, history | `src/learning/optimizer.rs`, `optimizer/`, `src/proposal_scanner.rs`, `src/proposal_edits.rs`, `src/learning/memory.rs`, `history.rs` | Kept. |
| Loop control routes | `PUT`/`GET` `…/learning`, `/pause`, `/resume`, `/stop`, `/rounds`, `/rounds/{round}`, `/memory` in `src/learning.rs` | Kept. The enrollment body changes. |
| Setting | `{domain, benchmark, policyModel}` in `src/learning.rs` | Kept. The service sets `policyModel` to the loop's task model. |

## Service

| Piece | Where | Action |
| --- | --- | --- |
| Evaluator work protocol | `work`, `start`, `report` in `src/learning/evaluations.rs`, and their routes in `src/learning.rs` | Delete. Rollout leases replace them. Score assembly stays and reads rollout rows. |
| Attempt IDs and deadlines | `learning_evaluations.attempt_id` and its `CHECK` in `migrations/0019_learning_loop.sql`; the run deadline (`ACCLIMATE_LEARNING_EVALUATION_SECONDS`, default 86400) in `evaluations.rs`; the seven-day queue deadline in `worker.rs` | Replace with deadlines derived from rollout leases. |
| Held-out commitment | `learning_loops.held_out` as `{digest, cases}`; enrollment validation and the work-moving check in `src/learning.rs` | Delete. Held-out tasks are stored in the service. |
| App principal | `learning_loops.app_principal`; the enrollment check that the principal holds `evaluate`; the `denied()` path for a different learning principal; the app-principal check in `list_cases` | Delete. |
| Principal lookup | `GET /v1/workspaces/{ws}/principal` in `src/workspaces.rs` | Delete. Only the learn CLI calls it. |
| `evaluate` right | `RIGHTS` and `rights_allow` in `src/auth.rs`; the default right and `valid_rights` in `src/machine_tokens.rs`; the list in `src/commands.rs`; `machine_tokens_rights_check` from `migrations/0017_remove_manual_changes.sql` | Delete. Rights become `read`, `write` and `promote`. |
| Outcome and case authorization | `actor(…, "evaluate")` in `src/learning/evolve.rs` for `submit_outcome` and `submit_cases`; `list_cases` needs `read` plus the app-principal check | Change. `/outcomes` moves to `write`. The case routes become the task routes. |
| Evolve-case storage | `…/learning/evolve-cases` in `src/learning/evolve.rs`; `learning_evolve_cases` | Replace with the task routes. Rows are copied to `learning_tasks` first, then the table is dropped at cutover. |
| Evaluator token migration | `migrations/0015_evaluator_machine_tokens.sql` | Keep the file. A new migration rewrites the rights. |

## TypeScript SDK

| Piece | Where | Action |
| --- | --- | --- |
| Loop definition and callbacks | `packages/sdk/src/learning/define.ts` (including `live`, `caseConcurrency` and the app's `execution` field), `grade.ts` (`exact`, `tests`), `openai.ts` | Delete. Harnesses and graders are built into the executor. |
| App-side runner | `packages/sdk/src/learning/loop.ts` (`serveLearningLoop`), `serve-cli.ts`, `progress.ts` | Delete, with the journal and `evaluator.json` handling they use. |
| Learn CLI and setup | `packages/sdk/src/learning/learn-cli.ts`, `setup.ts` | Delete. |
| Held-out split and digest | `packages/sdk/src/learning/held-out.ts` | Delete. The service assigns the split. |
| `transcriptTail` | `packages/sdk/src/learning/trace.ts`, re-exported by `packages/sdk/src/native-files.ts` | Move next to `native-files.ts`. The plugins use it. |
| Learning entry | `packages/sdk/src/learning/index.ts`, export `./learning` in `packages/sdk/package.json` | Delete the export. |
| Evaluator toolkit | `packages/sdk/src/evaluation/`: `application.ts`, `application-modules.ts`, `app-cli.ts`, `bin.ts`, `cli.ts`, `local.ts`, `local-cli.ts`, `runner.ts`, `controls.ts`, `collection.ts`, `grading.ts`, `usage.ts`, `journal.ts`, `private-state.ts`, `compatibility-check.ts`, `manifest.ts`, `definition.ts`, `index.ts` | Delete, except the moves below. |
| Guided validation | `packages/sdk/src/evaluation-validation.ts`, re-exported by `validation.ts` through the public `./validation` entry | Delete the evaluator targets and their re-exports. Keep what delivery validation uses. |
| JSON helpers | `assertJson` in `evaluation/definition.ts`, the `Json` type in `evaluation/types.ts`; imported by `jobs.ts` and `learning/outcomes.ts` | Move to a new `packages/sdk/src/json.ts`. |
| `Usage` type | `evaluation/types.ts`, imported by `compare.ts` | Move into `compare.ts`. |
| `pull` | `evaluation/pull.ts`, which imports `createEvaluatorClient` from `internal/evaluation-transport.ts`, `readEvaluatorConfig` from `evaluation/config.ts`, and `EvaluationError` and `EvaluationUsageError` from `evaluation/errors.ts` | Move to `packages/sdk/src/pull.ts` together with the config reader, the transport and those two error classes, renamed away from "evaluator". Delete the rest of `errors.ts` (diagnostics and exit codes). It becomes the only command of the `acclimate` bin. |
| Bins | `acclimate` → `dist/learning/learn-cli.js`, `acclimate-eval`, `acclimate-learning` in `packages/sdk/package.json` | Delete `acclimate-eval` and `acclimate-learning`. Point `acclimate` at the `pull` entry. |
| Exports and paths | `./evaluation`, `./evaluation/cli`, `./evaluation/manifest`, `./evaluation/app-cli` and `./learning` in `packages/sdk/package.json`; the matching root `package.json` exports and `tsconfig.json` paths | Delete. |
| Client methods and types | Work, start, report, evolve-case and principal methods in `packages/sdk/src/client.ts` and `types.ts` | Delete. Add the calls listed in [API and data](api-and-data.md). |
| Tests | `packages/sdk/tests/evaluation/`, `tests/contracts/evaluation-contracts.test.ts`, `tests/learning/` except `outcomes.test.ts` | Delete. Keep `pull.test.ts` and `outcomes.test.ts`, moved with their code. |

`packages/sdk/src/errors.ts` already exists and holds the delivery errors. `jobs.ts` and the delivery modules import nothing from `evaluation/errors.ts`, so nothing else moves.

## Python SDK

| Piece | Where | Action |
| --- | --- | --- |
| Loop definition and runner | `python/acclimate/learning.py` (`define_loop`, enrollment, sync), `_learning_runner.py`, `_learning_cli.py`, `_learning_openai.py` | Delete. |
| Evaluator toolkit | `evaluation.py`, `evaluation_app.py`, `evaluation_cli.py`, `evaluation_grading.py`, `evaluation_local.py`, `evaluation_manifest.py`, `_evaluation_controls.py`, `_evaluation_local_cli.py`, `_evaluation_types.py`, `_evaluation_usage.py`, `_application_imports.py` | Delete. |
| `pull` | `_evaluation_pull.py`, which imports `EvaluationError`, `EvaluationUsageError`, `make_client` and `read_evaluator_config` from `_evaluation_shared.py` | Move to `python/acclimate/pull.py` with those four names. Delete the rest of `_evaluation_shared.py`. |
| Entry points | `python/acclimate/__main__.py` and the `acclimate = "acclimate.evaluation_app:main"` script in `python/pyproject.toml` | Point both at `pull`. |
| Client methods and types | Evaluator and evolve-case methods in `client.py`; their types in `types.py` | Same cut as TypeScript. |
| Tests and checks | `python/tests/test_evaluation_*.py`, `test_evaluator_token_sources.py`, `test_learning.py`, `test_learning_openai.py`; `python/tests/typing/{positive,negative,check_installed}.py`; `scripts/check-python-package.py` | Delete the evaluator and learning tests. Keep `test_evaluation_pull.py`, renamed. Update the typing files, the package check, `test_client_parity.py` and `test_python_examples.py`. |

`_jobs.py`, `client.py` and `delivery.py` do not use `EvaluationError`. `job.expect()` stays.

## Console

| Piece | Where | Action |
| --- | --- | --- |
| Enrollment guidance | `apps/console/src/components/bundle-learning.tsx` (the `acclimate-learning held-out --app` text, the app principal and held-out digest fields) | Replace with the setup flow in [experience](experience.md). |
| Principal filter | `apps/console/src/server/learning-core.ts`, which filters principals on `evaluate`; `apps/console/tests/bundle-learning.test.ts` | Delete the filter. Update the test. |
| Round details | `apps/console/src/components/learning-details.tsx`, `apps/console/src/lib/learning.ts`, `server/learning-loop.ts` | Keep and extend for tasks, trials, usage and rollback. |
| Evaluate right in token forms | `apps/console/src/lib/machine-token-rights.ts`, `components/workspace-machine-tokens.tsx` | Remove the right and its copy. |
| SDK recipes | `apps/console/src/components/sdk-setup-recipes.ts` | Remove the evaluator recipes. |

## Examples, scripts and checks

| Piece | Where | Action |
| --- | --- | --- |
| Evaluator examples and starters | `examples/evaluation/`, `examples/evaluation-starter/`, `examples/python-evaluation-starter/`, `examples/native-repository/application.mjs` and `harness-template.mjs`, `examples/python-support-agent/application.py` | Delete. Keep the delivery parts of `native-repository` and `python-support-agent`. |
| Examples that import deleted modules | `examples/native-session-lifetime.ts`, `examples/claude-agent.ts`, `examples/native-repository/repository-job.mjs` | Update their imports. |
| Old repair example | `examples/self-improvement/repair/` | Delete. |
| W1 experiment | `examples/self-improvement-memory/`. `block.ts`, `evaluator.ts` and `heldout.ts` import `@acclimate/sdk/learning`, and `block.ts` mints `['read','evaluate']` tokens and sends `appPrincipalId`. | Park at cutover: exclude it from the root `tsconfig.json` and drop the `test:sim-experiment` script until the port ([plan](plan.md#the-w1-experiment)). Its plan, `experiment.md`, already sits next to the driver, and `freeze.py` reads it there. |
| Learn CLI end-to-end | `scripts/learn_cli_e2e.py`, `scripts/learn-cli-e2e.ts`, npm script `test:learn-cli` | Delete. |
| Learning end-to-end | `scripts/productization/learning_loop_e2e.py`, `learning-loop-fixture.ts`, `scripts/learning-loop-e2e.ts`, npm script `test:learning-e2e` | Rewrite to drive the API and a real executor. This is the cutover gate. |
| Script tests | `scripts/error-codes.ts`, `scripts/sdk-docs.test.ts`, `scripts/native-session-lifetime.test.ts` | Update. They import deleted modules. |
| Packaging fixtures | `scripts/packaging/fixtures/evaluator/`, `fixture_application.py`, `fixtures/learn-consumer.mjs`, the evaluator parts of `qualify-dx.mjs`, `qualify_dx.py`, `verify.mjs`, `verify-wheel.py`, `starter-files.json`, `starter-artifacts.mjs` and its test | Delete the evaluator and learn consumers. `pack:verify` keeps the delivery and `pull` consumers. Drop `test:starters` if no starter remains. |
| CI | `.github/workflows/ci.yaml` runs `test:starters` and `pack:verify` | Update those two jobs. Add the executor build and its tests. |
| Behavior features | Steps under `features/steps/` that enroll with an app principal or grant Evaluate, and `features/setup.feature` | Update. |

## Docs and contracts

| Piece | Where | Action |
| --- | --- | --- |
| Evaluator runbook | `docs/evaluator-operations.md` | Delete. Executor operations go in `deploy/README.md`. |
| Old design folder | `docs/architecture/self-improvement-memory/` | Already deleted. Its experiment plan moved to `examples/self-improvement-memory/experiment.md`; the rest is in git history at `e636c0be`. |
| Pages that link to either | `docs/architecture/README.md`, `sdk.md`, `server.md`, `docs/development.md`, `docs/design/improvement.md`, `docs/design/sdk-and-plugins.md`, `CONTRIBUTING.md`, `examples/self-improvement-memory/README.md` | Update links and the evaluator sections. |
| Learning contract | `contracts/learning.md`, `contracts/openapi.json`, `contracts/fixtures` | Rewrite for tasks, trials and the removed routes. |
| Site docs | `apps/docs/content/docs/reference/evaluator-cli.mdx`, `operate/evaluator-access.mdx` | Delete. |
| Site docs | `guides/learning-loop.mdx`, `reference/typescript-sdk.mdx`, `reference/python-sdk.mdx`, `reference/error-codes.mdx`, `get-started/install.mdx`, `integrations/claude-agent-sdk.mdx` | Rewrite the learning and evaluator sections. |
| READMEs and changelog | `packages/sdk/README.md`, `python/README.md`, `CHANGELOG.md` | Update. The changelog records the breaking change. |

Run `python3 scripts/build_docs.py` after the doc changes so the checked-in site export matches.
