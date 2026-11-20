# Self-improvement memory: removal

This file lists everything D7 and D8 remove: each server module, migration, table, route, setting, SDK and Python module, CLI command, console surface, example, workflow, doc and test. It also gives the order that keeps the repository building after every step. It owns phases 1 and 2 of the [phased plan](README.md#phased-plan), migrations `0016_remove_manual_changes.sql` and `0017_remove_connected_learning.sql`, the data-archive question (README question 5) and the `CONTEXT.md` glossary.

Names follow the [README](README.md#names). Line numbers are for commit 4096ff1b. Line counts are `wc -l`.

## Decisions

1. **Removal comes first.** Phase 1 removes the hand-made change workflow (D8). Phase 2 removes connected learning and the comparison machinery (D7, D8). The new loop starts in phase 3, so no release has two learning paths (D2).
2. **Drop, don't keep read-only.** A read-only view of the old tables would need code to read them, which is a legacy path (D2). Operators archive with the existing backup script before upgrading, and the migrations drop the tables.
3. **The channel release route stays** as a delivery primitive (D8 default). Its request becomes `{versionId, expectedRevision, unevaluatedReason}`. `comparisonId` and `policyOverride` go, because no comparison or policy can justify a release any more. The `unevaluated_reason` column and the `unevaluatedReason` field keep their names: no decision needs a rename, and it would touch about 58 files.
4. **The `propose` right goes** with the public proposals route. Tokens that held only `propose` are revoked by the migration, with a `machine_token_events` row.
5. **`learn-<connectionId>` delivery channels become ordinary channels.** Their rows and release history stay. Nothing deletes a version.
6. **Historical docs stay.** Dated research, acceptance, review and layout records under `docs/` are evidence and are not edited. Pages that describe the removed product as current are deleted or rewritten.
7. **Every removed setting is rejected at startup** with a message that names it, so an operator cannot believe a critic model or review deadline is still in force.

## Rules for every step

- Clippy runs with `-D warnings` (`package.json` `lint:rust`). A `pub(crate)` item or private function that loses its last caller fails the build. Delete it in the same step that removes the caller, or make it `pub` in a `pub mod` when a later phase needs it. The one exception is `DurableCommand`, which phase 3 reuses (see phase 2).
- Every step ends with `npm run lint`, `npm run typecheck`, `npm test`, `cargo test` and `python -m unittest discover -s python/tests`. Steps that touch package exports also run `npm run pack:verify` (the installed-consumer checks in `scripts/packaging/verify.mjs` and `scripts/packaging/verify-wheel.py`).
- Each phase regenerates `contracts/openapi.json`-derived docs, `apps/docs/content/docs/reference/error-codes.mdx` (`scripts/error-codes.ts`) and the `docs/site` export (`python3 scripts/build_docs.py`).
- Before phase 1, tag the last pre-change commit `pre-learning-loop`. The optional flat-history control (D10) runs from that tag, so its examples can be deleted from `main`.

## Phase 1: remove the manual product

Connected learning still runs in phase 1. It creates proposals, evaluation requests and comparisons internally, and its evaluators still claim requests and submit comparisons. Phase 1 removes only what a person used to make a change by hand.

### Server

| Change | Where | Action |
| --- | --- | --- |
| Bundle setup moves out of drafts | `src/drafts.rs:428-498` (`source_label`, `setup`) | Move to `src/bundles.rs` as `create_setup`, and register `POST /v1/workspaces/{project}/bundle-setups` in `src/lib.rs` `router`. Its seed release passes `unevaluated_reason` as today (`src/drafts.rs:486-491`). |
| Drafts | `src/drafts.rs` (528) | Delete the rest of the file, `mod drafts` (`src/lib.rs:22`) and `.merge(drafts::routes())` (`src/lib.rs:200`) |
| Policy receipts | `src/policy_receipts.rs` (275), `src/channels/policy.rs` (105) | Delete both files, `mod policy_receipts` (`src/lib.rs:31`), `.merge(policy_receipts::routes())` (`src/lib.rs:203`) and `mod policy` (`src/channels.rs:1`) |
| Policy override types | `src/types.rs:66-87` (`PolicyReceiptReference`, `PolicyOverride`), `PromoteRequest.policy_override` (`:95`), `Promotion.policy_override` and `policy_approval_promotion_id` (`:108-111`) | Delete |
| Release quality gating | `src/channels.rs:114-119` and `:129-148` (override columns), `:165-178` (`visible_policy_override`), `:338-356` (override check and `policy::approve`) | Delete. The public `promote` handler (`src/channels.rs:179`) rejects `comparisonId` with `400 invalid_content` and requires `unevaluatedReason`. `promote_in_tx` keeps the comparison branch (`:262-337`) for `Publication::Learning` until phase 2. |
| Override in connected learning | `src/connected_learning_worker.rs:1188`, `:1221`, `:1848`, `Review.policy_override` (`:2145`), `:2179-2181`, `:2221-2240`, `:2312`; `src/connected_learning/field_audits.rs:188`, `:197`; the `policy_override: None` fields of `PromoteRequest` at `src/connected_learning.rs:625` and `src/connected_learning/restore.rs:204` | Remove the field and the `policy_override_required` branches. The review route stays until phase 2 and takes `{approve}` only. |
| Public proposals | `src/improvement.rs:251-286` (`create_proposal`), `:287-304` (`enqueue_proposal`), `post(...)` at `src/lib.rs:243` | Delete. `enqueue_managed_proposal` (`:305`) stays for connected learning. |
| Manual comparisons | `src/improvement.rs:119` (`create_comparison`) | Require `evaluation` and accept only a request with `requested_by = 'service:connected-learning'`. An unbound comparison returns `400 invalid_content`. |
| Manual evaluation requests | `src/evaluations.rs:282-301` (`create`), `.post(create)` at `:109` | Delete. `enqueue_evaluation` (`:302`) and its `bounded` check (`:253`, called at `:319`) stay for connected learning. |
| Bound comparisons | `POST …/comparisons` with an `evaluation` binding | Kept until phase 2, because connected learning's evaluators still submit them |
| `propose` right | `src/auth.rs:6` (`RIGHTS`), `src/commands.rs:96`, `src/commands.rs:444`, `src/evaluations.rs:240`, `src/machine_tokens.rs:278` (the rights message; `:544` is a test); the machine-token right schemas in `contracts/openapi.json:6155` and `:6486-6499`; `packages/sdk/src/types.ts:163`; `python/acclimate/types.py:305` | Remove. `validate_grants` (`src/auth.rs:18`) then rejects an `ACCLIMATE_AUTH` grant that still lists `propose`, through its rights check at `:41`. |
| Draft operation keys | `src/commands.rs:112-126` (draft rights), `:130-132` (`global`) | Delete the draft rows. `global` becomes `path.ends_with("/bundle-setups")`. Drop the draft cases in the tests at `:728-841`. |

### Migration `0016_remove_manual_changes.sql`

Tested against a database migrated through `0015` on PostgreSQL 18.

```sql
-- Phase 1: remove the hand-made change workflow (D8).
DROP TABLE draft_snapshots;
DROP TABLE drafts;
DROP TABLE evaluation_policy_receipts;

ALTER TABLE promotions
    DROP COLUMN policy_approval_promotion_id,
    DROP COLUMN policy_override;

-- Recovery records for removed draft routes can never be looked up again.
DELETE FROM operation_records WHERE path ~ '^/v1/workspaces/[^/]+/bundles/[^/]+/channels/[^/]+/drafts(/|$)';
DELETE FROM idempotency WHERE path ~ '^/v1/workspaces/[^/]+/bundles/[^/]+/channels/[^/]+/drafts(/|$)';

-- The propose right goes with the public proposals route.
INSERT INTO machine_token_events(project_id, token_id, action, actor_principal, reason)
SELECT project_id, id, 'revoked', 'service:migration', 'The propose right was removed'
FROM machine_tokens
WHERE rights = ARRAY['propose'] AND revoked_at IS NULL;
UPDATE machine_tokens
SET revoked_at = now(), revoked_by = 'service:migration', revoke_reason = 'The propose right was removed'
WHERE rights = ARRAY['propose'] AND revoked_at IS NULL;
ALTER TABLE machine_tokens DROP CONSTRAINT machine_tokens_rights_check;
UPDATE machine_tokens
SET rights = CASE WHEN rights = ARRAY['propose'] THEN ARRAY['read'] ELSE array_remove(rights, 'propose') END
WHERE 'propose' = ANY(rights);
ALTER TABLE machine_tokens ADD CONSTRAINT machine_tokens_rights_check
    CHECK (cardinality(rights) BETWEEN 1 AND 4
           AND rights <@ ARRAY['read', 'evaluate', 'write', 'promote']);
```

A revoked propose-only token gets `{read}` only to satisfy the cardinality check. It is revoked, so it grants nothing. `mutation_audit` rows for removed routes stay: the table is an audit log.

### Routes removed in phase 1

| Route | Handler |
| --- | --- |
| `GET`, `POST /v1/workspaces/{p}/bundles/{b}/channels/{c}/drafts` and `/drafts/{d}`, `/history`, `/save`, `/discard`, `/publish` | `src/drafts.rs:103-129` |
| `GET`, `POST /v1/workspaces/{p}/bundles/{b}/comparisons/{id}/policy-receipts`; `GET …/versions/{id}/policy-receipts` | `src/policy_receipts.rs:107-118` |
| `POST /v1/workspaces/{p}/bundles/{b}/proposals` | `src/lib.rs:241-244` |
| `POST /v1/workspaces/{p}/bundles/{b}/evaluation-requests` | `src/evaluations.rs:107-110` |
| Unbound `POST …/comparisons` | `src/improvement.rs:119` (bound comparisons stay until phase 2) |

OpenAPI: delete the paths at `contracts/openapi.json:3295-3584` (drafts), `:2313-2671` (policy receipts), the `post` operations under `:1047` (proposals) and `:1610` (evaluation requests), and their schemas. Drop `comparisonId` and `policyOverride` from the release request under `:765`.

### SDK and CLI (TypeScript)

| Item | Where | Action |
| --- | --- | --- |
| `compare`, `submitComparison` | `packages/sdk/src/compare.ts` (311), exported at `packages/sdk/src/index.ts:20` | Delete the two functions and their exports. Keep `TaskExecutionError`, `InfrastructureError` and the result types, which the runner still imports, until phase 3 moves them into `evaluation/types.ts`. |
| Policy, statistics, planning, analysis | `packages/sdk/src/evaluation/policy.ts` (1427), `policy-receipt.ts` (64), `plan.ts` (291), `plan-command.ts` (79), `student-t.ts` (91), `analysis.ts` (490), `evidence-gaps.ts` (49) | Delete. Remove `PolicyError` (`evaluation/index.ts:56`), `export * from './analysis.js'` (`:78`) and `planEvaluation`, `PlanError` (`:84`). |
| Review evidence export | `packages/sdk/src/evaluation/artifacts.ts` (1176) | Delete with `export` and `verify-export` |
| Local comparison | `packages/sdk/src/evaluation/local.ts:249-500` (`runLocalComparison`, `scoreLocalComparison`, `localReport`, `writeLocalReport`), `local-cli.ts:33-40`, `:107-259`, `:299-311` | Delete. `tryEvaluation` and `tryCommand` stay. |
| Manual handoff intents | `packages/sdk/src/evaluation/cli-intents.ts` (733) | Delete with the `request`, `run`, `status` and `interrupt` commands |
| `acclimate-eval` commands | `packages/sdk/src/evaluation/cli.ts:73-119` | Delete `compare`, `request`, `run`, `check`, `status`, `interrupt`, `export`, `verify-export` and `plan`, and the `policy`, `handoff`, `aa`, `effects`, `simulations` and `seed` flags. Keep `try`, `coverage`, `describe`, `doctor` (without `--handoff` and `--policy`) and `pull`. |
| `acclimate-operator` | `packages/sdk/src/operator/cli.ts` (317), `operator/bin.ts` (4), `tools/operator/` (cli.ts 10, operator.test.ts 188, README.md 23) | Delete, with the `bin` entry in `packages/sdk/package.json` and the `operator` and `test:operator` scripts in `package.json` |
| Package exports | `packages/sdk/package.json` `exports` | Remove `./evaluation/policy`, `./evaluation/artifacts`, `./evaluation/analysis` |
| Client methods | `packages/sdk/src/client.ts:662` `createProposal`, `:681` `createComparison`, `:706-750` policy receipts, `:779-867` drafts, `:888` `createEvaluation` | Delete. `createRelease` (`:645`) takes the new request in phase 2. |
| Types | `packages/sdk/src/types.ts:38` `PolicyOverride`, `:63` `ProposalRequest`, `:107-152` policy receipts, `:279-310` drafts, `:311` `EvaluationRequest`, the `propose` member of the token rights at `:163` | Delete. Drop `policyOverride` from `CreateReleaseRequest` (`:42`) and `Release` (`:46`). |
| Learning policy type | `packages/sdk/src/types.ts:1` imports `EvaluationPolicy` from `policy.ts` for `LearningSelectionPolicy` (`:399`) | Remove the import and define `LearningSelectionPolicy` as `Record<string, unknown>` until phase 2 deletes the learning types, so `policy.ts`, `student-t.ts` and `evidence-gaps.ts` can go in phase 1 |
| Review mapper | `packages/sdk/src/evaluation/application.ts:3`, `:27` (`toReviewArtifact`, typed by `ReviewMapper` from `artifacts.ts`); `app-cli.ts:36`, `:330-346` | Remove the option and its validation with `artifacts.ts` |
| Command JSON parser | `parseCommandJson` (`packages/sdk/src/evaluation/cli-intents.ts:119`), used by the kept `try` through `loadLocalPayload` (`local.ts:8`, `:136`) | Move it into `local.ts` before `cli-intents.ts` is deleted |
| Error codes | `packages/sdk/src/evaluation/errors.ts:21-59`, `:153-191` | Delete the `handoff.*`, `request.*` and `policy.*` codes and any other code no kept command can raise. Regenerate `reference/error-codes.mdx`. |

### Python

| Item | Where | Action |
| --- | --- | --- |
| Policy, statistics, planning, analysis | `python/acclimate/_evaluation_policy_receipt.py` (31), `_student_t.py` (93), `evaluation_policy.py` (871), `evaluation_plan.py` (219), `evaluation_analysis.py` (378) | Delete |
| Review evidence export | `python/acclimate/evaluation_artifacts.py` (716) | Delete |
| CLI | `python/acclimate/evaluation_cli.py:42` and `_FLAGS`, `_evaluation_cli_intents.py` (382), `_evaluation_local_cli.py` (245), `evaluation_local.py` (523) | The same command cut as `acclimate-eval`. Delete the intents module and the local comparison half of the other two. |
| Client methods | `python/acclimate/client.py:369` `create_proposal`, `:384` `create_comparison`, `:401-413` policy receipts, `:457-488` drafts, `:489` `create_evaluation` | Delete |
| Types | `python/acclimate/types.py:58-67` policy override, `:95` `ProposalRequest`, `:272-300` policy receipts, `:377-427` drafts, `:229` `EvaluationRequest`, the `propose` key of the token rights at `:305`, and their `__all__` entries (`:811`) | Delete |
| Guided targets | `python/acclimate/_evaluation_shared.py:684-691` | Drop the `createRequest` and `createDraft` targets. `submit` (comparisons) and the request transitions go in phase 2. |

### Console

Delete the **Changes** bundle view and everything only it uses. The **Content** view becomes read-only. Bundles are still created by import on the library page (`bundle-setups`).

| Action | Files |
| --- | --- |
| Delete components | `bundle-changes.tsx` (350), `changes-overview.tsx` (361) and `.css` (602), `changes-pipeline.tsx` (441), `changes-queues.css` (202), `changes-triage.tsx` (96) and `.css` (148), `changes-triage-rail.tsx` (62) and `.css` (111), `changes-case-triage.tsx` (224) and `.css` (266), `comparison-evidence.tsx` (359), `diff-content.tsx` (242), `file-merge.tsx` (148), `file-merge-engine.ts` (57), `file-merge.css` (46), `code-editor.tsx` (185), `code-editor-engine.ts` (165), `draft-workspace.tsx` (1573), `draft-discard-dialog.tsx` (85), `draft-studio.css` (86), `editable-paths.tsx` (84), `evaluation-activity.tsx` (70), `evaluation-case-map.tsx` (174) and `.css` (25), `evaluation-case-results.css` (208), `evaluation-case-workbench.tsx` (353) and `.css` (351), `evaluation-configuration.css` (198), `evaluation-handoff-download.tsx` (20), `evaluation-history-view.tsx` (701) and `.css` (594), `evaluation-pair-row.tsx` (156), `evaluation-policy-receipts.tsx` (134), `evaluation-request-inspector.tsx` (291), `evaluation-scorecard.tsx` (264), `evaluation-setup.tsx` (329), `evaluation-workspace.css` (1279), `history-files.tsx` (212), `improvement-workspace.tsx` (2159), `learning-history.tsx` (293, already imported nowhere), `release-comparison.tsx` (237) and `.css` (210), `suggestion-composer.tsx` (139), `suggestion-workspace.css` (228), `use-evaluation-history.ts` (292) |
| Delete lib and server | `lib/artifact-changes.ts`, `changes-workspace.ts`, `comparison-summary.ts`, `editor-source.ts`, `evaluation-config.ts`, `evaluation-history.ts`, `evaluation-pairs.ts`, `evaluation-request-labels.ts`, `evaluation-run-name.ts`, `evaluation-score-summary.ts`, `evaluation-version-options.ts`, `improvement-history.ts`, `rename-skill-package.ts`, `review-next-step.ts`, `run-attempts.ts`, `unique-skill-name.ts`; `server/drafts.ts` (138), `content-actions.ts` (12), `improvement.ts` (348), `improvement-actions.ts` (13), `version-workflows.ts` (74) |
| Delete assets | `public/evaluator-setup.html`, `public/changes-ridge.webp` |
| Rewrite | `lib/operation-target.ts:22-24` (drop `proposals`, `evaluation-requests` and `drafts` from the recoverable targets); `navigation.ts:4` (drop `'changes'` from `BundleView`), `:32-35`, `:49-50`, `:66-93`, `:95-121`; `routes/w.$.tsx:21`, `:272-273`, `:305-308`; `routes/__root.tsx:19-22`, `:33-36` (stylesheet links of deleted pages); `bundle-releases.tsx` (714: remove `ReleaseComparison`, comparison and policy rows at `:484-544`, release with a reason only); `related-pending.tsx` (drop `runDraftCommand`); `server/read-console.ts:79-83` and `server/edit-channel.ts:57`, `:138` (release body `{versionId, expectedRevision, unevaluatedReason}`, without `comparisonId` in phase 2); `lib/pending-operation.ts` and `lib/content-operation.ts` (drop draft operations); `lib/evaluator-config.ts:2` (drop `propose`); `bundle-library.tsx:873` (draft wording) |
| Keep | `changes-releases.css` (its `.bundle-releases`, `.release-*` rules style the releases page), `pending-changes.tsx` (bundle creation still guards unsaved browser text), `syntax*`, `file-tree*`, `file-navigator.tsx`, `version-inspector.*`, `import-content.tsx` |
| Delete tests | `apps/console/tests/comparison-evidence`, `comparison-summary`, `content-diff-contract`, `draft-discard-dialog`, `drafts`, `evaluation-activity`, `evaluation-config`, `evaluation-handoff-download`, `evaluation-history-view`, `evaluation-history`, `evaluation-request-labels`, `evaluation-run-name`, `evaluation-score-summary`, `evaluation-scorecard`, `evaluation-version-options`, `history-files`, `improvement-recovery`, `improvement`, `learning-visualizations`, `rename-skill-package`, `review-next-step`, `run-attempts`, `suggestion-composer`, `version-workflows` (`.test.ts`), and `tests/fixtures/app-evaluator.ts`, `evaluation-focus.tsx`, `unequal-repetitions.ts` |
| Rewrite tests | `pending-operation.test.ts` (drafts), `edit-channel.test.ts` (release body), `request-navigation.test.ts`, `channel-navigation.test.ts` (no Changes view), `machine-tokens.test.ts` (no `propose`) |

### Examples, CI and the GitHub Action

| Item | Lines | Action |
| --- | --- | --- |
| `examples/ci/` (action.yml 251, ci.py 1457, ci.sh, README, workflows, test fixtures) | 2,038 | Delete |
| `examples/improvement/`, `examples/service-proposer/`, `examples/improve-review.ts` | 240, 355, 168 | Delete, with the `example:improve` and `test:improvement` scripts and `scripts/improvement-tests/` (5 files) |
| `examples/release-feed/` (compare-range.ts, live-model.ts) | 659 | Delete |
| `examples/evaluation-starter/`, `examples/python-evaluation-starter/` | 849, 358 | Delete `analyze.*`, `ANALYSIS.md`, `quality-policy.example.json` and the `compare` and `check` instructions. Phase 3 rewrites the README for `serveLearningLoop`. Update `scripts/packaging/starter-files.json`. |
| `examples/evaluation/` | 99 | Delete `analysis.*`, `ANALYSIS.md` and the request, handoff and policy instructions |
| `examples/native-repository/README.md:114-119`, `application.mjs:89-90`, `smoke.mjs`, `harness-template.mjs:6`; `examples/claude-agent.ts:10`; `examples/python-support-agent/README.md:38`, `:68` | | Remove `compare` and `--policy` usage. Keep `describe`, `doctor` and `try`. |
| `.github/workflows/ci.yaml:79-80` (`test:improvement`, `test:operator`), `:86-119` (`pr-gate` job) | | Delete |
| `package.json` `lint:workflows` and `lint:format` | | Drop `examples/ci/workflows/*.yml` and `examples/ci/action.yml` |
| `scripts/packaging/ci-starter.test.mjs` (842), the `ci` entry in `starter-files.json`, `test:ci-starter` | | Delete. Remove the action-pin check from `scripts/packaging/verify.mjs`. |
| `scripts/evaluation/policy-calibration.ts` (66), `scripts/qualify-improvement.py` (187), `scripts/full-roadmap/` (4 files, with `test:full-roadmap`, `qualify:full-roadmap*` and `scripts/productization/full_roadmap.py`), `scripts/acceptance/dx_personas/ci_release_engineer.py` (272) | | Delete. Remove the `qualify:full-roadmap` step at `.github/workflows/ci.yaml:167`. |
| `scripts/productization/qualify.py:151` (draft flow) and `:175-178` (evaluation request and comparison) | | Rewrite the draft flow as a version upload and release, and delete the evaluation-request flow. Keep `Harness` (`:31`), which the experiment driver uses ([experiment.md](experiment.md)). |
| `scripts/productization/hosted_authority.py:48` | | Replace the denied draft create with a denied version upload |
| `scripts/evaluate-app.ts` (116), `scripts/evaluator-tests/` (9 files), `scripts/packaging/qualify_dx.py` (559), `scripts/acceptance/dx_personas/*` | | Drop `compare`, `check`, `request`, `run`, policy and handoff paths. Phase 3 points the evaluator tests at `serveLearningLoop`. |
| `scripts/packaging/verify.mjs:128-130`, `:160-162`, `:293-294`; `scripts/packaging/verify-wheel.py:35` | | Assert that `@acclimate/sdk/evaluation/policy`, `/artifacts` and `/analysis` fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`, that `acclimate-operator` is not installed, and that `acclimate.evaluation_policy` is absent |

### Rust and behavior tests

| File | Action |
| --- | --- |
| `tests/drafts.rs` (352) | Delete |
| `tests/proposals.rs` (368) | Delete the public-create cases. The rest goes in phase 2. |
| `tests/operation_recovery.rs` (486) | Rewrite `legacy_key_only_close_uses_the_committed_draft_action…` (`:412`) and the draft paths in `:135` and `:293` against bundle setups and versions |
| `tests/native_publication.rs` (190) | Replace the draft path (`:96-105`) with `POST …/versions` and a release |
| `tests/machine_tokens.rs` (763) | Remove the draft calls (`:369-376`) and `propose` |
| `tests/http_contract.rs` (708) | Extend `only_canonical_route_spellings_exist…` (`:673`) so every phase 1 route returns `404 not_found`. Replace the comparison evidence in `channel_etag_cas_comparisons_and_promotion_history` (`:306`) with reasons. |
| `tests/grant_preflight.rs` (120) | Add: a grant listing `propose` is rejected |
| `features/drafts.feature` (99) with `steps/drafts.py` (204); `features/proposals.feature` (56) with `steps/proposals.py` (111); `features/evaluation.feature` (120) with `steps/evaluation.py` (226) and `steps/evaluation_profiles.py` (95) | Delete |
| `features/console.feature` | Delete the scenarios at `:30`, `:38`, `:48`, `:57`, `:69`, `:81`, `:89`, `:96`, `:105`, `:114`, `:121`, `:128`, `:135`, `:277`, `:286`, `:309`, `:321`, `:332`, `:352`. Drop the `draft` example row of `:147`. The rollout and audit scenarios (`:186`, `:201`, `:214`, `:229`, `:242`) go in phase 2. |
| `features/releases.feature` | Delete `:10`, `:18`, `:26`, `:33`. Rewrite `:39` as "A release requires a reason". |
| `features/navigation.feature:17`, `:23`; `features/ux_refinement.feature:6`, `:15`, `:33`; `features/integrations.feature:21`; `features/python_sdk.feature:23` | Delete or rewrite without drafts and evaluation |
| `features/steps/console.py`, `navigation.py`, `ui_improvements.py`, `ux_refinement.py`, `recovery_regressions.py`, `remediation_recovery.py`; `scripts/bdd/inventory.json`, `world.py`, `interactions.py`, `sdk_consumer.mjs`, `python_consumer.py` | Remove the steps and inventory rows of deleted scenarios |
| `features/steps/access.py`, `integrations.py`, `releases.py`, `setup.py`, `sdk.py`, `native_walk.py`, `recovery_reload.py` | Rewrite the draft, evaluation-request and manual comparison calls as version uploads and releases with a reason |
| `scripts/testing/release_setup_layouts.py`, `version_inspector_layouts.py`, `connection_layouts.py`, `source_workspaces.py`, `navigation_lifecycle.py` | Rewrite the draft and evaluation steps the same way |
| `packages/sdk/tests/productization/client.test.ts:31-83` | Delete the draft client cases |
| `scripts/testing/changes_workspace.py`, `editor_review_layouts.py`, `evaluation_focus.py`, `evaluation_layout_checks.py`, `evaluation_layouts.py`, `evaluation_setup_layouts.py`, `evaluation_weighting.py`, `suggestion_layout_checks.py`, `suggestion_layouts.py`, `file_tree_workflows.py` | Delete. Drop the removed routes from `compact_console.py`, `compact_edges.py`, `desktop*_workflows.py`, `desktop_layouts.py`, `golden_path_workflows.py` and `interaction_console.py`. |

### Docs

| Item | Action |
| --- | --- |
| `apps/docs/content/docs/guides/ci-pr-check.mdx` (172), `guides/evaluate-a-change.mdx` (178), `guides/service-generated-proposals.mdx` (26), `reference/operator-cli.mdx` (36), `concepts/methodology.mdx` (210) | Delete, and update the `meta.json` files |
| `guides/review-and-release.mdx` (37) | Rewrite as releases and rollback with a reason |
| `reference/evaluator-cli.mdx` (252), `reference/typescript-sdk.mdx`, `reference/python-sdk.mdx`, `reference/http-api.mdx`, `get-started/quickstart.mdx` (195), `get-started/install.mdx`, `get-started/run-locally.mdx` | Remove `compare`, `--policy`, `check`, `plan`, export, drafts and the operator CLI |
| `tools/operator/README.md` and `scripts/full-roadmap/README.md` | Delete, with their `PAGES` rows (`scripts/build_docs.py:58`, `:63`) |
| `docs/evaluator-operations.md:24-31` (Policy receipts), `docs/development.md:69-102` (improvement loop, service edit, real review, full roadmap) | Delete |
| `docs/architecture/productization/drafts-and-content.md`, `improvement-and-evaluation.md` | Keep as history |

### Order inside phase 1

1. Move bundle setup to `src/bundles.rs`. `cargo test` passes with drafts still present.
2. Delete drafts, policy receipts and quality gating in the server, add `0016`, update OpenAPI, Rust tests and features. The SDK still compiles, because its draft and policy-receipt methods are plain HTTP calls.
3. Delete the public proposal and evaluation-request create routes and the `propose` right.
4. Delete the SDK and Python manual code, the operator CLI and the exports, then run `npm run pack:verify`.
5. Delete the console Changes view.
6. Delete the examples, the action, the CI jobs and scripts, then the docs, and regenerate `docs/site`.

## Phase 2: remove connected learning

After phase 2 the service delivers versions and runs no learning. `contracts/learning.md` says learning is not available until the loop ships (evaluator-and-contracts.md rewrites it in phase 3).

### Server modules deleted

| File | Lines |
| --- | --- |
| `src/connected_learning.rs` | 1,212 |
| `src/connected_learning_worker.rs` | 2,383 |
| `src/connected_learning/corrections.rs`, `epochs.rs`, `field_audits.rs`, `field_requalification.rs`, `incident.rs`, `parent_cache.rs`, `repetitions.rs`, `restore.rs`, `selection.rs`, `statistics.rs` | 3,908 |
| `src/connected_learning/calibration_view.sql`, `incumbent_view.sql`, `outcome_status.sql`, `parent_cache.sql`, `replay_work.sql`, `round_view.sql`, `worker_enrollments.sql` | 291 |
| `src/improvement.rs` (proposals, comparisons, `proposal_worker`, critic objections) | 880 |
| `src/evaluations.rs` (evaluation requests, capabilities, abandonment) | 657 |
| `src/evaluation_progress.rs` | 194 |
| `src/proposal_edits/skills.rs` | 339 |
| Total with phase 1 (`drafts.rs`, `policy_receipts.rs`, `channels/policy.rs`) | 10,772 |

### Server code rewritten

| Where | Change |
| --- | --- |
| `src/lib.rs:17-20`, `:23-25`, `:37` | Delete the modules and the `connected_learning_worker`, `abandon_*` and `proposal_worker` re-exports |
| `src/lib.rs:198-199`, `:201-202`, `:233-248` | Delete the merges and the comparison and proposal routes |
| `src/lib.rs:54` (`AppState.provider`), `:56-114` (`ProposalModel`, `CriticFuture`, `CriticVerdict`, `ProposalFailure`, `ClassifiedProposalFuture`), `:267-274` (`LearningEvidence`), `:276-470` (`OpenAiModel` with its critic, settings, proposals, `critique` and `complete`) | Delete, with the provider build in `src/main.rs:142-144`, `:172`. `propose` needs `ProposalRequest`, `reconstruct_scoped`, `INSTRUCTION` and `NOTE_INSTRUCTION`, which this phase deletes, and nothing in phases 2 and 3 calls a model. Phase 4 adds `OptimizerModel` and a new `OpenAiModel` built from this client ([optimizer.md](optimizer.md)). The `ACCLIMATE_MODEL*` settings have no reader in phases 2 and 3, and startup accepts them. |
| `src/proposal_edits.rs` | Delete `mod skills` (`:5-7`), `INSTRUCTION` and `SKILL_INSTRUCTION` (`:10`), `NOTE_INSTRUCTION` and `CreateNote` (`:30-40`), `memory_path` (`:42-53`), `validate_growth` (`:55-75`), `changed_files` and `edit_excerpts` (`:77-127`), `reconstruct_scoped` (`:137`) and the `allowed_paths` check (`:163-165`). The public `reconstruct(parent, content)` (`:129`) loses its `ProposalRequest` argument and applies anchored edits under the payload limit (D5). It is `pub` in a `pub mod`, so it stays compiled with no caller, and `tests/proposal_patch.rs` keeps testing it. Phase 4 restores `changed_files` and rewrites `reconstruct` ([optimizer.md](optimizer.md)). |
| `src/proposal_scanner.rs`, `mod proposal_scanner` (`src/lib.rs:33`) | `scan` (`:42`) is `pub(crate)` in a private module, and its only caller is `src/improvement.rs:656`. Make the module `pub mod` and `scan` a `pub fn`, so it and its tests survive phases 2 and 3 under `-D warnings`. Phase 4 adds `findings`. |
| `src/types.rs:90-96` (`PromoteRequest`), `:100-116` (`Promotion`) | `PromoteRequest {version_id, expected_revision, unevaluated_reason}`. `Promotion` drops `comparison_id`. Delete `ProposalRequest`, `Proposal`, `ComparisonRequest`, `EvaluationBinding`, `CaseKey`, `Usage`, `Outcome`, `CasePair` and `Comparison` (`:123-225`). |
| `src/channels.rs:214-218` (`Publication`), `:229-235`, `:262-337`, `:361-373` (field release insert) | Delete. `promote_in_tx(tx, project, bundle, channel, reviewer, request)` takes no publication argument. It checks the reason, the revision and compatibility, and inserts the promotion. Remove the `internal_channel` checks at `:31` and `:186`, and in `bundles::create_setup` (moved from `src/drafts.rs:466` in phase 1), and the `audit_reader` call at `:113`. |
| `src/integrations.rs:92`, `:320`, `:367-368`, `:403-409`; `src/workspaces.rs:200-204` | Move `CONNECTION_HEADER` (`src/connected_learning.rs:24`) to `src/integrations.rs`. A connection resolves its own channel only, and `delivery_history` reads that channel's promotions. Stop hiding `learn-*` channels. |
| `src/commands.rs:28-66`, `:97-107`, `:240-245` | Delete the guided evaluator grammar for comparisons and evaluation requests. `guided_project` stays (`rights`, `:87`). `guided_uuid` loses its last caller and goes. |
| `src/commands.rs:511-682` (`DurableCommand`, `DurableReceipt`) | Keep. Today only connected learning uses them, and phase 3's enrollment, evolve-case and outcome routes reuse them ([evaluator-and-contracts.md](evaluator-and-contracts.md)). Between phases 2 and 3 they have no caller. They are `pub(crate)`, so add `#[allow(dead_code)]` on the two items for phase 2 only, or land phases 2 and 3 together. |
| `src/main.rs:3`, `:183-184`, `:188`, `:224-234`, `:245-273` | Stop spawning `connected_learning_worker` and `proposal_worker`. Move `runtime.worker_started()` (`src/improvement.rs:432`) into `invitation_worker`, so `wait_for_worker` (`src/main.rs:187`) still returns. Phase 3 adds the loop worker beside it. |
| Startup | Fail when any setting in the Removed row of the README is set, naming it (`tests/runtime_preflight.rs`) |

### Migration `0017_remove_connected_learning.sql`

Tested against a database migrated through `0016`. The final schema holds 19 tables, no views and one function (`machine_token_events_append_only`).

```sql
-- Phase 2: remove connected learning and the comparison machinery (D7, D8).
DROP VIEW connected_learning_round_replays;
DROP VIEW connected_learning_correction_work;
DROP VIEW connected_learning_replay_results;
DROP VIEW connected_learning_available_audits;

DROP TABLE
    connected_learning_round_corrections,
    connected_learning_incumbent_events,
    connected_learning_field_decisions,
    connected_learning_field_verdicts,
    connected_learning_field_releases,
    connected_learning_automatic_promotions,
    connected_learning_authorizations,
    connected_learning_replay_obligations,
    connected_learning_corrections,
    connected_learning_rounds,
    connected_learning_outcomes,
    connected_learning_renewals,
    connected_learning_policy_epochs,
    connected_learning_cohorts,
    connected_learning_enrollments;

DROP FUNCTION connected_field_checkpoint(text, uuid, bigint, uuid);
DROP FUNCTION connected_field_eligible(text, uuid, uuid, bigint);
DROP FUNCTION connected_field_requirements(text, uuid, uuid, bigint);
DROP FUNCTION connected_learning_identities(jsonb);
DROP FUNCTION connected_learning_register(text, uuid, uuid, integer, jsonb);
DROP FUNCTION connected_learning_preserve_audits();
DROP FUNCTION connected_learning_record_primary_correction();

ALTER TABLE versions DROP COLUMN proposal_id;
DROP TABLE evaluation_progress;
DROP TABLE evaluation_requests;
DROP TABLE comparisons;
DROP TABLE proposals;

ALTER TABLE promotions DROP COLUMN comparison_id;

-- Connected-learning receipts can never be replayed. The table stays for the loop routes.
DELETE FROM durable_commands WHERE scope LIKE 'learning/%';

DELETE FROM operation_records WHERE path ~ '^/v1/workspaces/[^/]+/(bundles/[^/]+/(proposals|comparisons|evaluation-requests)|connections/[^/]+/learning)(/|$)';
DELETE FROM idempotency WHERE path ~ '^/v1/workspaces/[^/]+/(bundles/[^/]+/(proposals|comparisons|evaluation-requests)|connections/[^/]+/learning)(/|$)';
```

Dropping the triggers is implicit: `connected_learning_preserve_audits` and `connected_learning_primary_correction` live on dropped tables. Every `durable_commands` row today has a `learning/{connection}/{operation}` scope (`src/commands.rs:542`), so the `DELETE` empties the table. The loop's outcome receipts reuse it with `learning/{bundle_id}/outcome` scopes from phase 3.

### Routes removed in phase 2

| Route | Handler |
| --- | --- |
| `GET`, `PUT …/connections/{c}/learning`; `POST /stop`, `/restore`, `/renew`, `/corrections`, `/rechecks`, `/outcomes`, `/incident-replays`; `GET /outcomes/{o}`, `/work` | `src/connected_learning.rs:32-74` |
| `GET`, `POST …/learning/field-requalifications[/{v}]`; `POST /field-audits`; `POST /rounds/{r}/review` | `src/connected_learning_worker.rs:31-45` |
| `GET …/bundles/{b}/proposals`, `/proposals/{id}`; `POST`, `GET /comparisons`, `GET /comparisons/{id}` | `src/lib.rs:233-248` |
| `GET …/bundles/{b}/evaluation-requests[/{id}]`; `POST /start`, `/finish`, `/interrupt`, `/abandon`; `GET`, `POST /progress` | `src/evaluations.rs:101-131`, `src/evaluation_progress.rs:41-48` |
| `GET /v1/workspaces/{p}/evaluation-capabilities` | `src/evaluations.rs:103-106` |

OpenAPI: delete `contracts/openapi.json:14-96`, `:1047-1598`, `:1610-2092`, `:2672-2970`, `:3651-3812` and their schemas. `/health` (`:1599-1609`) and `/connection-observations` (`:2971-2990`) stay. Drop `comparisonId` from the release request and response at `:765`.

### Settings removed

| Setting | Read at | Phase |
| --- | --- | --- |
| `ACCLIMATE_CRITIC_MODEL`, `ACCLIMATE_CRITIC_ENDPOINT`, `ACCLIMATE_CRITIC_TOKEN` | `src/lib.rs:305-317` | 2 |
| `ACCLIMATE_LEARNING_REVIEW_SECONDS` | `src/connected_learning_worker.rs:1453` | 2 |
| `ACCLIMATE_LEARNING_PARENT_MAX_REUSES`, `ACCLIMATE_LEARNING_PARENT_MAX_AGE_SECONDS` | `src/connected_learning/parent_cache.rs:23-24` | 2 |
| `ACCLIMATE_LEARNING_PAIR_BUDGET`, `ACCLIMATE_LEARNING_MAX_REPETITIONS`, `ACCLIMATE_LEARNING_CALIBRATION_REPETITIONS` | `src/connected_learning/repetitions.rs:187`, `:183`, `:75` | 2 |
| `ACCLIMATE_LEARNING_MAX_STEPS_BETWEEN_AUDITS`, `ACCLIMATE_LEARNING_MAX_CHAIN_AGE_SECONDS`, `ACCLIMATE_LEARNING_CALIBRATION_ATTEMPTS`, `ACCLIMATE_LEARNING_FAILURE_WINDOW_SECONDS` | `src/connected_learning_worker.rs:1298`, `:2002`, `:860`, `:1960` | 2 |
| `ACCLIMATE_PROPOSAL_GROWTH_FLOOR_BYTES` | `src/proposal_edits.rs:62` | 2 |
| `ACCLIMATE_EVALUATION_ABANDON_SECONDS` | `src/evaluations.rs:138` | 2 |

`ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS` and `ACCLIMATE_LEARNING_EVALUATION_SECONDS` (`src/connected_learning_worker.rs:1431`, `:758`) are kept by the README but have no reader between phases 2 and 3. `ACCLIMATE_MODEL`, `ACCLIMATE_MODEL_ENDPOINT` and `ACCLIMATE_MODEL_TOKEN` have no reader between phases 2 and 4. Startup accepts all of them. Also update `apps/docs/content/docs/reference/configuration.mdx` (17 mentions), `deploy/README.md` (9), `apps/docs/content/docs/operate/evaluator-access.mdx`, `docs/evaluator-operations.md` and `contracts/learning.md`.

### SDK (TypeScript)

| Item | Where | Action |
| --- | --- | --- |
| Connected learning driver | `packages/sdk/src/learning/connected.ts` (723), `connected-fixtures.ts` (50), `connected-replay.ts` (83), `serve-cli.ts` (87), `index.ts` (2) | Delete, with the `./learning` export and the `acclimate-learning` bin. Phase 3 adds both back for `serveLearningLoop`. |
| Evaluation request runner | `packages/sdk/src/evaluation/runner.ts:138-331` (`assertDescriptor`, `assertFrozen`, `assertReport`, `reportsEqual`, `verifyEvaluatorAuthority`), `:442` (`runEvaluationRequest`), `packages/sdk/src/internal/evaluation-transport.ts:37-46` | Delete. `pull` keeps its channel read. |
| Progress | `packages/sdk/src/evaluation/progress.ts` (75), `./evaluation/progress` export, `createEvaluationProgressReporter` (`evaluation/index.ts:80`) | Delete |
| Paired arms | `packages/sdk/src/evaluation/collection.ts` (75), the parent/candidate scheduling in `trials.ts` (697), `runner.ts` and `journal.ts` | Rewritten in phase 3 to score one version with `ROLLOUTS_PER_CASE` rollouts (evaluator-and-contracts.md). `definition.ts`, `application.ts`, `grading.ts`, `manifest.ts` and `local.ts` `tryEvaluation` stay. `collection.ts` imports `CaseKey` from `types.ts`, so move that interface into `collection.ts` in this phase. |
| Collection tests | `packages/sdk/tests/evaluation/collection.test.ts` | Delete the cases that call `startEvaluation` and the other request methods deleted below. Phase 3 rewrites the rest with `collection.ts`. |
| Client methods | `packages/sdk/src/client.ts:455-626` (all learning methods), `:675`, `:694`, `:868-887`, `:901-1024` | Delete. `createRelease` (`:645`) sends `{versionId, expectedRevision, unevaluatedReason}`. |
| Types | `packages/sdk/src/types.ts:69-106`, `:153-235`, `:329-361`, `:393-732` | Delete. `CreateReleaseRequest` and `Release` drop `comparisonId` and keep `unevaluatedReason`. |
| Delivery receipts | `packages/sdk/src/reporting.ts`, `DeliveryReceiptRequest` (`types.ts:733`) | Keep. The started-receipt binding for field audits (`learning/connected.ts:64-87`) goes with the driver. |

### Python

| Item | Where | Action |
| --- | --- | --- |
| Progress | `python/acclimate/evaluation_progress.py` (47), `EvaluationProgressReporter` (`__init__.py:34-36`, `:57`) | Delete |
| Client methods | `python/acclimate/client.py:282-296`, `:376-399`, `:492-523`, `:535-643` | Delete |
| Types | `python/acclimate/types.py:102-134`, `:135-187`, `:203-271`, `:301-353`, `:536-789`, and `__all__` | Delete |
| Release | `CreateReleaseRequest` (`types.py:68`), `Release` (`:76`) | Drop `comparisonId`. Keep `unevaluatedReason`. |
| Guided targets | `python/acclimate/_evaluation_shared.py:684-691` | Drop the `submit` (comparisons) target and the request transitions after it |

Python has no learning driver. `serveLearningLoop` is TypeScript only (README, Code).

### Console

| Action | Files |
| --- | --- |
| Delete | `components/connection-learning.tsx` (967), `connection-learning-controls.tsx` (177), `outcome-lookup.tsx` (226), `server/connection-learning-policy.ts` (290) |
| Rewrite | `components/workspace-connections.tsx` (1,432: drop the learning section), `server/integration-core.ts` (983: drop every learning action, including `review` (`:329`, `:652`) and `renew` (`:697`), and the policy blockers), `components/workspace-delivery.tsx` (drop outcome lookup), `components/sdk-setup-recipes.ts` (drop `@acclimate/sdk/learning` recipes until phase 3) |
| Delete tests | `apps/console/tests/connection-learning.test.ts` (733) |
| Rewrite tests | `integrations.test.ts`, `credential-recovery.test.ts`, `listing.test.ts`, `delivery-observations.test.ts`, `sdk-setup.test.ts` |

### Examples, scripts and CI

| Item | Lines | Action |
| --- | --- | --- |
| `examples/self-improvement/` (19 files) | 3,265 | Delete. Run it from `pre-learning-loop` if the flat-history control is wanted. Remove the `qualify:self-improvement:*` and `freeze:self-improvement:large` scripts and `scripts/testing/self_improvement.py` (91). |
| `examples/real-app-learning/` (9 files) | 1,147 | First move the W1 fixtures and grader the experiment needs (`baseline.json`, `tasks.py`, `40-case-additions.json`, `grade.py`, `check-replication.py`, `replication-audit.json`) to `examples/self-improvement-memory/fixtures/w1/`, with their SHA-256 digests in `fixtures/w1/SOURCES.json`. Then delete the rest. Phase 5 ports the Codex turn and model adapter from `run.ts` at tag `pre-learning-loop` ([experiment.md](experiment.md)). |
| `scripts/operations/qualify.py:79-80` | | Drop the `comparisons` fixture insert. The `promotions` insert at `:77` keeps `unevaluated_reason`. |
| `scripts/connected-learning-e2e.ts` | 2,378 | Delete |
| `scripts/productization/connected_learning.py` (36), `.github/workflows/ci.yaml:177-204` (`connected-learning` job) | | Delete |
| `scripts/bdd/learning.py` (121), `scripts/testing/learning_visualizations.py` (19), `scripts/testing/connection_video.py` | | Delete, or drop the learning steps |
| `scripts/service-e2e.ts:290-385`, `:506` | | Replace proposal and comparison steps with version upload and release |
| `scripts/local/stack.py:480` and the local demo seed | | Seed a bundle and release only |
| `scripts/packaging/verify.mjs:132-133`, `:164-165` | | Assert `@acclimate/sdk/learning` and `/evaluation/progress` are absent until phase 3 restores `./learning` |

### Tests and features

| File | Action |
| --- | --- |
| `tests/proposals.rs` (368), `tests/proposal_provider_http.rs` (143), `tests/evaluations.rs` (380), `tests/evaluation_progress.rs` (443), `tests/evidence_regressions.rs` (434), `tests/round_lifecycle_migration.rs` (50) | Delete. Phase 4 adds `tests/optimizer_provider_http.rs` with the new client. |
| `tests/dx_evaluator.rs` (1,045) | Move `observations_expose_one_latest_retained_receipt_without_admin_metadata` (`:814`) to `tests/integrations.rs`, then delete the file |
| `tests/integrations.rs` (1,609) | Delete `learning_admission_and_delivery_are_connection_scoped` (`:290` to the end). Keep `:63`. |
| `tests/machine_tokens.rs` | Delete `abandoned_attempts_are_fenced…` (`:546`). Rewrite `:197` so the `evaluate` right is shown on version and payload reads. Phase 3 points it at `GET /work`. |
| `tests/postgres.rs:142-195`, `tests/productization_regressions.rs:86`, `tests/process_ownership.rs:325` (`LOCK TABLE proposals`) | Replace proposals and comparisons. The ownership test locks `workspace_invitations`. |
| `tests/proposal_patch.rs` (276) | Drop `ProposalRequest` (`:1`, `:6`) and call `reconstruct(parent, content)`. Delete `scoped_skill_mutations…` (`:146`), `new_memory_note…` (`:216`), `proposal_growth…` (`:234`), `generated_skill_edits…` (`:245`) and the outside-path case in `:45`. |
| `tests/production_schema.rs` (89) | Rewrite as the upgrade test below |
| `src/proposal_scanner.rs` tests | Keep unchanged. The module becomes `pub mod` (see "Server code rewritten"). |
| `features/connected_learning.feature` (112) with `steps/connected_learning.py` (339), `learning_measurements.py` (117), `learning_review.py` (430), `field_requalification.py` (86) | Delete |
| `features/console.feature:186`, `:201`, `:214`, `:229`, `:242` | Delete |
| `features/sdk_delivery.feature:122`, `:128` | Delete (paired grading) |
| `packages/sdk/tests/learning/` (4 files, 721), `tests/compare/compare.test.ts` (383), `tests/evaluation/analysis`, `plan`, `policy`, `policy-vectors`, `progress`, `artifacts` | Delete (the evaluation ones in phase 1) |
| `packages/sdk/tests/evaluation/cli.test.ts` (1,637), `core.test.ts` (1,595), `local.test.ts` (654), `manifest.test.ts`, `pull.test.ts`, `contracts/evaluation-contracts.test.ts` | Rewrite for the kept commands |
| `python/tests/test_evaluation_analysis.py`, `test_evaluation_plan.py`, `test_evaluation_policy.py`, `test_evaluation_artifacts.py`, `test_starter_analyze.py` (phase 1); `test_evaluation_progress.py` (phase 2) | Delete |
| `python/tests/test_evaluation_cli.py`, `test_evaluation_core.py`, `test_evaluation_local.py`, `test_client_parity.py`, `typing/positive.py`, `typing/negative.py` | Rewrite |
| `contracts/fixtures/comparison-incomplete.json`, `comparison-invalid.json`, `comparison-v1.json`, `connected-confidence-decisions.json`, `connected-selection-policy.json`, `evaluation-analysis/`, `evaluation-policy/` (phase 1); `tests/conformance/evaluation-manifest-v1.json` only if `manifest.ts` goes | Delete |

### Docs

| Item | Action |
| --- | --- |
| `apps/docs/content/docs/guides/connected-learning.mdx` (57) | Delete. Phase 3 adds `guides/learning-loop.mdx`. |
| `deploy/README.md:50-82` (Operate connected learning, Monitor and roll back) | Delete. Add the upgrade note under `## Upgrades and recovery` (`:83`). |
| `docs/evaluator-operations.md:93-257` (Serve connected learning, field audits, incident replays) | Delete. Rewrite `:7-92` for the app principal in phase 3. |
| `docs/architecture/continuous-learning/` (10 files, 546 lines) | Delete. It describes the removed loop as a plan. |
| `docs/design/improvement.md`, `docs/architecture/server.md`, `docs/architecture/sdk.md`, `docs/architecture/contracts.md`, `docs/getting-started.md`, `apps/console/README.md` | Rewrite for delivery plus the loop. Update the `PAGES` descriptions at `scripts/build_docs.py:26` and `:36`. |
| `contracts/learning.md` (141) | Replace with one paragraph: learning is not available in this release. Phase 3 rewrites it. |
| Old design files in this folder: `round-lifecycle.md`, `proposer-and-selector.md`, `data-model.md`, `contracts-and-surfaces.md` | Deleted in phase 0, with this rewrite. Their research is summarized in [decisions.md](decisions.md#superseded). |

### Order inside phase 2

1. Move the W1 fixtures to `examples/self-improvement-memory/fixtures/w1/`. Delete the SDK learning driver and the connected examples, scripts and CI job. The server is unchanged, so every suite passes.
2. In one commit: delete the server modules and the model client, add `0017`, rewrite `channels.rs`, `integrations.rs`, `commands.rs`, `lib.rs`, `main.rs`, `proposal_edits.rs` and `proposal_scanner.rs`'s visibility, update OpenAPI, the Rust tests and `scripts/operations/qualify.py`. This must be one step, because every deleted module calls the others.
3. Delete the client methods and types in TypeScript and Python, and the progress reporters. Run `npm run pack:verify`.
4. Delete the console learning page.
5. Delete and rewrite the docs, then regenerate `docs/site`.

## Data handling

The two migrations are destructive and irreversible. The data in the dropped tables is the record of past rounds, proposals, comparisons, corrections, field audits and receipts. None of it feeds the new loop: memory starts empty (D6), and the evolve split starts from setup cases and new outcomes (D4).

| Option | Verdict |
| --- | --- |
| Keep the tables read-only behind an archive route | Rejected. It is a legacy path (D2) and keeps the statistical schema alive. |
| Export into new tables, such as an archive of past rounds | Rejected. Nothing reads them. |
| **Back up, then drop** | **Recommended.** The operator takes a full backup with the existing script before starting the new build. The backup is the archive. |

The upgrade note in `deploy/README.md` and `apps/docs/content/docs/operate/upgrades-and-recovery.mdx` says:

1. Take a full backup: `python3 scripts/operations/backup.py dump /private/backups/acclimate-pre-loop.dump`. Restore it into a database with the `pre-learning-loop` build to read old rounds.
2. Before phase 2, find connections that receive a learned version. After `0017` they receive their own channel's version instead:

   ```sql
   SELECT e.project_id, e.integration_id, e.source_channel, e.delivery_channel,
          d.version_id AS delivered, s.version_id AS source_head
   FROM connected_learning_enrollments e
   JOIN channels d ON (d.project_id, d.bundle_id, d.name) = (e.project_id, e.bundle_id, e.delivery_channel)
   JOIN channels s ON (s.project_id, s.bundle_id, s.name) = (e.project_id, e.bundle_id, e.source_channel)
   WHERE d.version_id <> s.version_id;
   ```

   To keep a learned version, release it on the connection's channel with a reason before upgrading.
3. No drain is needed. Queued rounds, proposals and evaluation requests are dropped. Evaluators still polling `…/learning/work` get `404 not_found` and must be stopped.
4. `learn-<connectionId>` channels stay as ordinary channels with their release history.

Retention of the new loop's rounds, evaluations and traces is README question 4 and belongs to evaluator-and-contracts.md.

## Product pitch

### `README.md`

Replace the headline and the first two paragraphs (`README.md:3-5`):

> **Acclimate improves your agent's harness on its own and delivers each version to your jobs.** It runs the self-improvement loop from [arXiv 2611.18856](https://arxiv.org/abs/2611.18856). Each round it scores the released version on your evolve cases, writes five candidate changes from the scores, traces and errors, screens them, evaluates the survivors and releases the one the selector adopts. An improvement memory records what each change was meant to fix and what it fixed, so later rounds, and later models, build on it.
>
> Your application still runs the agent and grades its work. Acclimate versions the instructions, skills and memory files it uses, delivers the released version to the next job, and lets you point a channel back at an earlier version.

Delete `README.md:11-21` (local `compare`), `:34-45` (live comparison) and `:49-50`, `:52` (gating, operator CLI, connected learning). Keep `:51` (delivery). Phase 3 adds "Enroll a bundle", with `serveLearningLoop` and `PUT …/learning`. Update the descriptions in `packages/sdk/package.json:4` and `python/pyproject.toml:9`, `apps/docs/content/docs/index.mdx:3-12` and `apps/docs/app/(home)/page.tsx:9-10`, `:30`, `:35`, `:59`, `:94` the same way. Add a `### Removed` section to `CHANGELOG.md` listing the routes, commands, exports and settings in this file.

### `CONTEXT.md`

Replace both tables. The terms are the README's names.

| Term | Meaning |
| --- | --- |
| Workspace | The scope for bundles, connections and the people who can access them. |
| Bundle | A named collection of agent instructions, skills and memory files: the harness. |
| Version | An immutable snapshot of a bundle. Its digest identifies the exact bytes. |
| Channel | A named reference, such as `stable`, to the version jobs should use. |
| Release | A move of a channel to a version, with a reason. Restoring an earlier version creates a new release. |
| Connection | The link between an application and the workspace, bundle and channel it uses. |
| Learning loop | The always-on loop for one enrolled bundle. It runs rounds back to back and releases adopted versions on its learning channel. |
| Round | One pass of the loop: score the incumbent, propose five candidates, screen, evaluate the survivors, adopt or keep, and score the held-out split. |
| Candidate | One of the five proposed changes in a round, with its diagnosis and predicted fixes. |
| Evolve split | The cases the loop learns from. Their scores, traces and errors reach the optimizer. |
| Held-out split | Fixed cases kept in the evaluator's own store. Their scores are shown for monitoring and never reach the optimizer. |
| Outcome | An application's result for a task with an expected answer. It becomes an evolve case. |
| Improvement memory | The optimizer-only record of problems and the attempts that tried to fix them. It is never delivered to jobs. |
| App principal | The machine identity that submits outcomes and evolve cases and runs the evaluator for a loop. |

Internal terms: keep **Operation result** and **Delivery receipt**. Delete Proposal, Comparison, Draft, Evaluation request, Handoff, Learning enrollment, Policy epoch, Admission decision, Teaching view, Harness treatment, Audit cohort, Development incumbent, Renewal, Recheck, Field audit, Field window, Requalification, Incident replay, Restore target, Delivery revision and Policy override receipt. Mirror the table in `apps/docs/content/docs/concepts/glossary.mdx` and rewrite `concepts/how-it-works.mdx`.

## Tests that prove the removal

| Test | Checks |
| --- | --- |
| `tests/production_schema.rs` | Apply migrations through `0015`, seed one row in every dropped table, a connected-learning `durable_commands` row, a `learn-*` channel, a propose-only token and a `read`+`propose` token, then run to the latest. Assert the exact kept table set of 19, no views, the `promotions` columns `(…, unevaluated_reason, reviewer, created_at)` with no `comparison_id`, `policy_override` or `policy_approval_promotion_id`, an empty `durable_commands`, the revoked token with its `revoked` event, the trimmed rights, and that the `learn-*` channel resolves. |
| `tests/http_contract.rs` `only_canonical_route_spellings_exist…` | Every route in both removal tables returns `404 not_found` |
| `tests/runtime_preflight.rs` | Each removed setting fails startup with its name |
| `tests/grant_preflight.rs` | A grant with `propose` is rejected |
| `tests/http_contract.rs` release cases | A release without `unevaluatedReason` is `400`. `comparisonId` and `policyOverride` are unknown fields and rejected. |
| `scripts/packaging/verify.mjs`, `verify-wheel.py` | Removed subpaths, bins and modules are absent from the installed packages |
| `apps/console/tests/navigation.test.ts` | `/w/{w}/bundles/{b}/changes` does not parse |
| `npm run lint:docs` | No page links to a deleted file |

## Open questions

1. **The `learn-*` channels.** They become ordinary channels. Should `0017` instead delete channels whose only releases came from connected learning?
2. **`try`, `describe`, `coverage`, `doctor` and `pull`.** They help an app author write the evaluation the loop runs, so they stay. Should they move to the `acclimate-learning` bin in phase 3 and `acclimate-eval` go?
