# Server correctness and security review — 2026-11-17

Reviewed the working implementation against approved D2 and `contracts/dx-evaluation.md`, relative to HEAD `52c1ce1`. Scope: `src/commands.rs`, `src/evaluations.rs`, `src/integrations.rs`, `src/main.rs`, related authorization and comparison submission paths, and their targeted tests. The frozen design was not edited.

## Fixed finding

**P2: Marked evaluator writes accepted noncanonical body identities.** Route UUIDs were checked, but body version/attempt/comparison/binding IDs were not. On an owned PostgreSQL 16 instance, a marked request containing a valid parent UUID in 32-character form returned **201** and persisted that noncanonical value; D2 requires canonical lowercase hyphenated guided identities. A marked start also permitted arbitrary nonempty attempt strings. This allowed retained-ready requests incompatible with the guided runner's identity validation.

`commands::begin_mutation_inner` now validates marked evaluator body identities before starting a transaction: parent/candidate versions, optional proposal, start/finish attempts, finish comparison, and optional comparison request/attempt binding. Rejections use `guided_target_unsupported`. Unmarked historical clients retain their existing body ID syntax. Regression `marked_evaluator_mutations_require_canonical_body_identities` was observed failing with 201 before the fix and passing afterwards; it also confirms invalid starts leave the request unclaimed and legacy unmarked attempt strings still work.

## Verification

All database checks used disposable clusters owned by `scripts.productization.qualify.Harness('/opt/homebrew/opt/postgresql@16/bin')`, calling `start_database()` and `close()` in `finally`. Each test subprocess explicitly set **all four** variables below to that harness's `h.env['DATABASE_URL']`; no ambient database or user credentials were used:

- `ACCLIMATE_DX_TEST_DATABASE_URL`
- `ACCLIMATE_TEST_DATABASE_URL`
- `EVALUATION_TEST_DATABASE_URL`
- `TEST_DATABASE_URL`

Commands and outcomes:

```text
cargo test --test dx_evaluator --test grant_preflight --test evaluations --test integrations -- --nocapture
# PASS: 7 DX + 3 grant preflight + 1 lifecycle + 1 integration tests
cargo test --lib commands::tests -- --nocapture
# PASS: 2 tests
cargo test --test dx_evaluator observations_expose_one_latest_retained_receipt_without_admin_metadata -- --nocapture
# PASS: 1 test, used to initialize a separate owned query-plan fixture
```

The DX tests exercise expired transient deduplication with retained submit/finish recovery, same-principal rotation, exact result identity, changed-body conflicts, closed-operation fences including unmarked writes, revoked write authority for replay/lookup, historical-start replay versus interrupted authoritative state, 2 MiB report create/get/operation envelopes within 4 MiB, request overflow, finish/interrupt races, machine/read-only/missing-project/unsupported-target capabilities, viewer observation access without credential administration, latest receipt ties and out-of-order timestamps, field coherence, retention, and bounded pagination.

The grant tests run the actual executable with `env_clear()` and secret canaries, malformed/duplicate/unknown/oversized stdin, invalid arguments, and invalid runtime/service environment configuration. They confirm fixed bounded diagnostics, no input reflection, and validation before runtime/service initialization.

A separate `EXPLAIN (ANALYZE, FORMAT JSON)` of the observation query after inserting 10,000 additional receipts and analyzing both tables selected `integration_receipts_recent` for the lateral latest-row lookup (two integration loops; 10,003 receipts total; 0.042 ms execution in this small fixture). No migration or forced planner setting was used.

## Clear scope and limits

No additional confirmed defect was found in retained namespace/lock consistency, transaction-level browser authorization, static-grant capability truthfulness, lifecycle row locking, latest-observation projection, response budgets for the admitted maximum fixture, or private stdin validation. Retained results are historical mutation results; lifecycle reads remain necessary. Raw route aliases retain their historical path-scoped namespace and are not guided retained-ready targets. These checks do not attest provider termination, external exactly-once work, deployment behavior, production database scale, or release-wide acceptance. No model call, deployment, commit, or build of distribution artifacts was performed.
