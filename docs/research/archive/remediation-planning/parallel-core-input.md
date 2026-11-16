# Parallel core implementation input

Authoritative scope: `plan.md` and `review.md`. Eight lanes, eight workers maximum; the ninth slot stays available for integration review. No lane needs a completed foundation subsystem before starting fixtures and isolated modules.

## Sole ownership

| Lane | Files and responsibility | Audit coverage |
| --- | --- | --- |
| C: contract integrator | `src/{lib,types}.rs`, all new migrations, `contracts/**`, SDK `{types,client,index}.ts`, npm manifests, `scripts/build_contracts.py`, `tests/http_contract.rs`. Own shared DTOs, exports, numbering and final wiring; apply small call-site requests only in these owned files. | Cross-cutting |
| N: native content/provider | `src/{bundles,drafts,channels}.rs`; new Rust compatibility/provider-patch modules; SDK `internal/native-files.ts` and new pure validator; plugin source/tests; `tests/drafts.rs`, new native/patch tests. Generic saves, immutable target, publication validation, patch reconstruction. | A01,A10 |
| R: recovery/access | `src/{commands,auth,workspaces,integrations}.rs`; `tests/{workspace_access,integrations}.rs`, new receipt/fence tests. Action authorization, durable receipts/close, admin invariant, membership inspection, credential issuance/revocation. | A03,A04,A12,A14,A15 |
| E: evidence service | `src/{evaluations,improvement}.rs`, SDK `compare.ts`, `tests/{evaluations,proposals}.rs`. Sole `improvement.rs` owner integrates bound submission, worker target validation and chronological pagination. | A07,A08,A09; N/R hooks |
| U: console | Entire `apps/console/**` and console unit tests. Recovery envelopes, target/diagnostics/import/diff/naming, request/polling UI, member/credential inspection. | A01,A04,A06,A07,A09,A11–A15 |
| H: app evaluator | `scripts/evaluate-local.ts`, new adapter/journal modules, `examples/evaluate-request*`, `examples/{improvement,service-proposer}/**`, new behavioral/native adapter fixtures. Own copied helper, installed descriptor, callbacks and private attempt recovery. | A05,A06,A07,A08,A20 |
| D: delivery | SDK `{cache,reporting,prepare}.ts` and corresponding SDK tests; `python/**`; delivery recipes including `examples/{codex-agent,cursor-agent}.ts`. Timeout classifier, daemon receipts, observed-start reporting. | A02,A16,A17 |
| S: setup/shipping/acceptance | `scripts/{dev-console,local-processes}*`, `tools/operator/**`, packaging/productization/operations scripts, qualification/browser/BDD harnesses, CI, Docker/Compose files, shipping docs; remaining integration tests. | A18–A22; whole-path acceptance |

Existing files outside these allocations require an explicit owner assignment before edits. C owns generated contract/docs output; S requests generation after source settles. N supplies changes for `OpenAiModel`; C installs delegation into N's new module once, preserving public `ProposalModel`. E alone adds N's candidate-validation call. R retains `begin_mutation`'s call signature and derives action centrally, avoiding edits across N/E handlers. D supplies plugin reporting requirements to N; H supplies npm script changes to C. R adds target fields to workspace listings from N’s DTO contract; S writes the private launcher configuration consumed by H.

## Freeze checklist and minimum unblockers

C publishes a short contract change before substantive callers merge, with N/R/E/H signoff:

- Immutable target creation/default/read DTOs; path diagnostics; native grammar matrix and shared positive/negative fixtures. Generic bytes/digests remain identical.
- Exact marker/header value, allowed actions, canonical routes, both existing namespace/lock strings, authorization sets, lookup/close DTOs/statuses, expiry/adoption rules and typed credential outcome. Freeze normalized body serialization once and retain its exact bytes.
- Optional paired `{requestId,attemptId}`, `requireBoundEvidence=false` defaults, structural runtime descriptor keys/bounds, scoped timestamp/UUID cursor format and legacy UUID resolution.
- Rust validator/patch and command helper signatures; installed adapter `describe`/callbacks, journal scope/ownership/recovery states, stable submission/finish keys; copied command syntax; private configuration path/schema and dedicated read/write-only evaluator provisioning.
- UTF-8 byte limits, literal anchor uniqueness/overlap semantics, finish-reason allowlist, service-first rollout and migration ordering.

Minimum stubs: compile-safe optional/default DTOs; pure validator signatures plus shared fixtures; marker ignored by old service fixtures only; command outcome discriminants; strict/legacy request-report fixtures; fake installed adapter and crash-state journal fixtures. Stubs must never claim compatibility, execution or completion. No public raw transport is added to the SDK.

## Waves, DAG and integration

Wave 0: all eight launch. C freezes shared seams; N develops pure validators/patches, R namespace tests, E binding/cursor fixtures, U mocked flows, H fake adapter/journal, D delivery regressions, S disposable harness/artifact retention.

Wave 1: `C → N,R,E,U,H`; `N → E` only for candidate validator; `E → H,U`; `R → U`; `H → U,S`; `S(configuration) → H(execution)`; `D → S`. U/H build against frozen fixtures while services land. N/R/E otherwise proceed independently. No ownership transfer occurs.

Merge C defaults/seams; N/R/E service changes; C SDK surfaces; H/D clients; U flows; S acceptance/artifacts. Database rollout precedes strict clients.

## Correctness gates

Resolve before freeze: bound submission must lock the same evaluation row as interrupt/finish, so interruption cannot race evidence acceptance; both binding fields must appear together. Journal recovery must preserve report bytes and write keys across lost submission/finish responses. Closing must adopt a matching live legacy receipt before tombstoning; test unrelated-route reuse and delayed unmarked writes. Native compatibility must inspect stored immutable payload inside publication transactions, including rollback.

Run isolated Rust database tests, actual provider HTTP patch fixtures (Unicode/disjoint/duplicate/finish truncation), strict/legacy attribution and cursor ties; session-storage failure/reload/close browser tests invoking the actual copied helper; journal concurrent/crash recovery; timeout-denial/integrity tests; Python stuck-client subprocess exit. Final disposable-service path includes incomplete native save/reload/repair, losing complete evaluation, deliberate release, installed-package preparation, optional receipt and rollback. External qualification records remain passed/blocked/not-run; no model/service/configuration changes are implied.
