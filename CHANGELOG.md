# Changelog

All notable changes to Acclimate will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

These changes ship in 0.2.0. It renames public fields, routes, options, environment variables and files, removes the names deprecated in 0.1.0, and changes CLI exit codes, a Python SDK option and an attribute, and the OpenAPI file name, so read **Breaking** before you upgrade. An 0.1 SDK or evaluator cannot talk to an 0.2 service. The example CI workflows pin the GitHub Action at `v0.2.0`, the first release that contains it.

### Breaking

- **Workspace, connection and version naming.** Public JSON, both SDKs, the CLI, environment variables, config files and the docs now use one name per concept. Rust and PostgreSQL keep their internal `project_id` and `integration_id` names. See [Upgrading from 0.1](apps/docs/content/docs/reference/versioning.mdx#upgrading-from-01).

  | 0.1 | 0.2 |
  | --- | --- |
  | `projectId` in request and response bodies, `Bundle`, `Connection`, delivery receipts, learning enrollments, capability snapshots, policy receipts, exported review artifacts and `VerifiedVersion.connection` | `workspaceId` |
  | `integrationId` in the same places | `connectionId` |
  | TypeScript `projectId` parameters and `prepare({ projectId })` | `workspaceId` |
  | Python `project_id` arguments | `workspace_id` |
  | TypeScript client option `integrationId`, `client.integrationId` | `connectionId` |
  | Python `AcclimateClient(integration_id=...)`, `client.integration_id`, `integration_id` arguments | `connection_id` |
  | `X-Acclimate-Integration-Id` delivery header | `X-Acclimate-Connection-Id` |
  | `acclimate-operator --project`, `acclimate-learning --integration` | `--workspace`, `--connection` |
  | `ACCLIMATE_PROJECT` | `ACCLIMATE_WORKSPACE` |
  | `ACCLIMATE_INTEGRATION` | `ACCLIMATE_CONNECTION` |
  | `ACCLIMATE_AUTH` grant `{token, principalId, projectId, rights}` | `{token, principalId, workspaceId, rights}` |
  | Evaluator and reader config `projectId` | `workspaceId` |
  | `/v1/projects/{projectId}/...` routes, with `integrations`, `integration-observations` and `promotions` subpaths | Removed. Use `/v1/workspaces/{workspaceId}/...` with `connections`, `connection-observations` and `releases`. `operationPath` must use the `/v1/workspaces` spelling, and `Operation.path` always does. |
  | Handoff file `evaluation-request.json` | `handoff.json` |
  | Handoff `projectId` and `configuration` | `workspaceId` and `descriptor` |
  | `execute({ bundle })` (Python `run.bundle`) | `execute({ version })` (Python `run.version`) |
  | `PreparedDelivery.bundle`, and `PreparedDelivery.version` as version metadata | `PreparedDelivery.version` is the verified version; its metadata is `prepared.version.version` (Python `prepared.version["version"]`) |
  | `DeliveryObservation.bundle`, `DeliveredVersion.bundle` | `.version` |
  | Plugin and `prepareNativeFiles` `bundle` parameter; `prepareNativeFiles(bundle, mapping, prefix, target)` | `prepare(version, options)`; `prepareNativeFiles(version, { mapping, prefix, target })` |
  | `PreparedCodexBundle`, `PreparedClaudeBundle`, `PreparedPiBundle`, `PreparedCursorBundle` | `PreparedCodexVersion`, `PreparedClaudeVersion`, `PreparedPiVersion`, `PreparedCursorVersion` |
  | `listProjects`, `listPromotions`, `promote`, `createIntegration`, `listIntegrations`, `createIntegrationCredential`, `revokeIntegration`, `revokeIntegrationCredential`, `listIntegrationObservations` and the Python aliases | `listWorkspaces`, `listReleases`, `createRelease` and the matching `Connection` methods |
  | `Project`, `Promotion`, `PromotionPage`, `PromoteRequest`, `VerifiedBundle`, `Integration*` types and the Python aliases | `Workspace`, `Release`, `ReleasePage`, `CreateReleaseRequest`, `VerifiedVersion`, `Connection*` |

  Old names fail loudly instead of being ignored. An evaluator config, reader config, handoff or `ACCLIMATE_AUTH` grant with `projectId`, a handoff with `configuration`, a TypeScript `integrationId` client option or `projectId` selection, the old CLI flags, and `ACCLIMATE_PROJECT` or `ACCLIMATE_INTEGRATION` set without the new variable are rejected with an error that names the rename, such as `projectId was renamed to workspaceId in 0.2.0`. Handoffs, configs and journals keep `schemaVersion: 1`. Journals written by 0.1 are still read, so an evaluation in flight during the upgrade can be recovered with the 0.2 evaluator of the same language.

- **Evaluator exit codes.** `acclimate-eval` and the Python `acclimate` command exit 0 ok, 1 fix the command, config or application, 2 quality gate failed, 3 indeterminate, 4 run or service failed, and 5 recovery required. A failed run used to exit 2, and journal problems, a base conflict or an interrupted request used to exit 3. Running with no arguments now exits 1. The CI wrapper uses the same table: `execution_failed` exits 4, `execution_unresolved` and `prior_execution_unresolved` exit 5, and 3 means indeterminate or partial evidence (`quality_indeterminate`, new `execution_partial`).
- **Statistical quality gate by default.** Policies of every schema version, including existing v1 files, run a one-sided 95% paired Student t test on the equal-case mean difference. Fewer than 10 cases, too few repetitions or zero variance without a floor make the verdict indeterminate (exit 3) instead of passing. Declare `"inference": {"method": "none"}` to keep point-estimate comparisons. The ids `connected-development` and `connected-audit` are reserved for connected learning.
- **Python offline option.** `prepare` and `resolve_and_cache` take `offline={"max_age_ms": ...}` or `offline={"pinned_version_id": ...}`, matching the TypeScript `offline` option. The `offline_max_age` and `offline_pinned_version` keywords are gone.
- **Python `ApiError.requestId` is removed.** Use `ApiError.request_id`. Python errors share the `acclimate.AcclimateError` base with a stable `code`; invalid arguments raise `acclimate.UsageError`, a `ValueError` subclass.
- **OpenAPI file renamed.** `contracts/openapi.yaml` is now `contracts/openapi.json`; the content was always JSON. The internal coordination records moved from `contracts/` to `docs/internal/contracts/`.
- **Usage is validated.** Unknown `usage` keys, and negative or non-finite values, make an arm `output_invalid` instead of being dropped silently. Python also accepts `input_tokens`, `output_tokens` and `cost_usd`.
- **CI wrapper flags.** `--concurrency` is rejected: declare `concurrency` in the evaluator definition, where it is part of the descriptor. `--max-cost-usd` must be positive. `--rerun-after` replaces the wrapper's `--retry-after`, which remains a deprecated alias.

### Added

- **Try a change with no server.** `try` runs execute and grade once and checks every returned shape, and `compare --local --parent PAYLOAD --candidate PAYLOAD` compares two payload files or folders with the same pairing and grading as a service run. The report is advisory and never release evidence. A local `--policy` exits 0 pass, 2 fail or 3 indeterminate. Library functions: `runLocalComparison`, `tryEvaluation` and `loadLocalPayload` (Python `acclimate.evaluation_local`).
- **Run controls.** `compare` and `run` accept `--deadline`, `--case-timeout`, `--max-cost-usd`, `--cases`, `--shard`, `--progress` and `--quiet`; a run they stop early is partial and exits 3. Definitions declare `concurrency` (1–64) and `gradeRetries` (0–5), which are fingerprinted. Skipped arms report `not_selected`, `timeout`, `deadline_exceeded` or `cost_limit_reached`. Results include a `runSummary`, and a warning flags parent and candidate outputs that are identical on every pair.
- **Evaluator tokens.** Workspace administrators issue, rotate and revoke expiring machine tokens (`acm_`, principal `machine:{name}`) in the console or at `/v1/workspaces/{workspace}/machine-tokens`. The narrow `evaluate` right covers everything an evaluator does; `write` implies it. Evaluator configs accept `evaluatorTokenFile` or the `ACCLIMATE_EVALUATOR_TOKEN` environment variable instead of an inline token.
- **Abandoned attempts.** `abandoned` is a terminal evaluation state, set explicitly through `POST .../evaluation-requests/{id}/abandon` (`abandonEvaluation`, Python `abandon_evaluation`) or after `ACCLIMATE_EVALUATION_ABANDON_SECONDS` without activity. `compare --retry-after` and the CI wrapper follow an abandoned or interrupted predecessor, and the wrapper's `--abandon-uncertain` calls the abandon route.
- **One error taxonomy.** Each SDK has one `AcclimateError` base with typed codes, plus `TransportError`, `OutputValidationError` (`output.invalid`), `DefinitionError` (`definition.invalid` with `field` and `reason`) and usage errors. The CLI checks arguments before loading the application, names unknown commands and flags, prints readable errors on a terminal and one JSON line otherwise, and accepts `--version`, `--json` and `--verbose` (or `ACCLIMATE_DEBUG=1`). Every code is listed on the generated [error codes](apps/docs/content/docs/reference/error-codes.mdx) page.
- **Callback diagnostics.** A failed callback's redacted message and stack are kept privately in `callback-error.json` by default, and `compare` names the first failed callback and its file. Set `captureCallbackErrors: false` to opt out.
- **Simpler adapters.** `defineApplication()` and default-export adapters, `execution: 'model-free'`, synchronous or async callbacks in both languages, and `run.instructions`, `skillFiles` and `memoryFiles` helpers on the execute input.
- **Per-arm uncertainty.** An `ExecutionUncertainError` from execute fails only that arm (`execution_uncertain`, with an `uncertain.json` marker) and the run continues, in live and local runs of both SDKs.
- **Native harnesses.** `defineHarness`, the public `@acclimate/sdk/native-files` entry, Claude, Cursor and Pi run adapters, `examples/claude-agent.ts`, a relaxed skill validator that names each compatibility rule, and a single `defaultCacheDir()`. An adapter can declare `compatibilityTarget`; `doctor --payload`, `compare --payload`, `compare --local` and `try --payload` then reject incompatible skills with `payload.incompatible` before any run.
- **Solo onboarding.** `npm run local:up` picks free ports, pulls the released images, signs you in to a ready `local-demo` workspace with an example bundle, and writes `env.sh` and `ca-bundle.pem`. `npm run local:trust` trusts the local certificate. `pull` saves a published version as a payload to edit.
- **Run labels.** `compare --retry-after PRIOR --name NAME` names the retry. Requests record optional `runName` and `retryOf` when the service advertises `runLabels`, and the console's Changes tab groups a failed attempt under its retry.
- **Policy statistics and planning.** Policies declare an `inference` block, `metric.scale` (rewards outside it are `evidence.reward_out_of_range`) and `perCaseChecks`. Verdicts, receipts and CLI text report the statistics. `plan` reports the minimum detectable effect and simulated pass rates, and `doctor --policy` reports `policyReadiness`. Analysis intervals are labeled with their estimand, and the fixed-case bootstrap no longer undercovers. `repeatGrade`, `gradeAgreement` and `passAtK` (Python `repeat_grade`, `grade_agreement`, `pass_at_k`) support repeated grading.
- **Policy pins.** Evaluation requests accept `policyDigest`. `compare --policy` and `request --policy` send it when the service advertises `policyPins`, the intent journal records it, and `check` reports `policyPin` as `matched`, `mismatched` or `unpinned`.
- **Named grade components.** `grade` may return `components`, up to 32 named numbers that travel with the outcome. A policy's `metric.component` gates on one instead of the scalar reward.
- **CI quality gate.** A GitHub composite action (`examples/ci/action.yml`), example pull request and post-merge release workflows, and a `pr-gate` job in this repository's CI. The wrapper forwards cancellation and reports `result: cancelled`, writes `--format github|markdown|json` and `--summary-md`, reuses an unchanged candidate's result across commits, and reads the token from `--token-env` or `--token-file` without writing it to a config file. A channel without a release reports `request.channel_empty`.
- **Python SDK parity.** The Python client has every TypeScript client method, the `acclimate` console script, `__all__`, a readable error on Python 3.10 or earlier, a flit-based build, `run_evaluation_async`, `examples/python-support-agent` and `examples/python-evaluation-starter`.
- `acclimate-operator`, the review and release CLI, ships in `@acclimate/sdk`. The plugin packages declare their repository and publish with provenance.
- Documentation: a pitch-first README with a laptop path, join a team, methodology, versioning and error-code pages, Python commands beside the Node ones, and a reference that documents every TypeScript export.

### Changed

- Every artifact is versioned `0.2.0`. The plugin packages peer-depend on `@acclimate/sdk` `^0.2.0`, because `^0.1.0` excludes `0.2.0`.
- The glossary uses one term per concept: the **handoff** is the `handoff.json` file the console downloads and `request` writes, and the **evaluation request** is the service record it names.
- Examples import only published package entries. The checkout evaluator harness moved to `scripts/evaluator-tests/` as `runCheckoutEvaluation`.
- The console scorecard shows the reward change in a neutral tone, counts cases rather than repetitions, shows per-case wins and losses, per-arm missing evidence, and the policy's lower bound or states that there is none.
- A task that fails with a timeout or crash keeps its partial diff.

## [0.1.0]

### Added

- Initial open-source release under Apache-2.0. The service, TypeScript packages and Python SDK are versioned `0.1.0`.
