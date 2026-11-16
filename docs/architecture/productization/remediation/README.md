# Productization implementation

> Earlier implementation record. Production startup, identity and evaluator setup now follow the [production-only plan](../../production-only/plan.md). Old local-launcher commands below are retired.

The [2026-11-14 audit](../current-audit.md) led to the reviewed [fix plan](plan.md), [review decisions](review.md) and [parallel implementation](parallel-work.md). The A01–A22 local changes are complete. **The final run passed all 132 behaviors, 171 scenarios and 814 steps, with no skips.** Focused Rust, SDK, console, Python and evaluator checks also passed. The later [UI pass](../ui-improvements.md#implementation-evidence) expanded coverage to 141 behaviors and 183 scenarios, all passing. External qualification remains separate in the [shipping ledger](shipping-evidence.md).

The service still owns content, frozen evaluation intent, evidence and deliberate releases. Apps own execution and grading. Native drafts can be saved incomplete and repaired; publishing validates the immutable compatibility target. Uncertain writes retain an exact submitted snapshot and support reconciliation, exact retry and authenticated close. Legacy unbound evaluations remain compatible and labeled.

## Local acceptance matrix

These rows map the audit IDs from the [plan](plan.md#coverage-of-the-audit) to landed behavior and retained focused evidence. The final combined browser/service gate applies to every row. [Shipping evidence](shipping-evidence.md) records exact commands, dated live results and external blockers. Private logs stay under `artifacts/remediation/`: `rust-isolated-final.log`, `dev-fix-packages.log` (90 tests), `console-final.log` (96 tests), `evaluator.log`, `python.log` and `pack-verify-final.log`. The final browser/service coverage report is `dev-fix-bdd-full/coverage.md` (132/132 behaviors); the proposal bridge result is `full-roadmap-live/result.json`. These files are local evidence, not documentation exports.

| Audit | Landed behavior | Focused evidence |
| --- | --- | --- |
| A01 | Immutable native target; shared checks at publication, proposal candidates and delivery; incomplete drafts remain saveable | Rust/native checks, SDK checks |
| A02 | Real timeout cache fallback preserves permission and integrity checks | SDK checks |
| A03 | Serialized final-admin protection | isolated access checks |
| A04 | Draft reload recovery keeps submitted bytes, later edits and close/retry paths separate | console checks, recovery browser run |
| A05 | Installed app adapter, public configuration and behavioral simulator | evaluator checks, console checks |
| A06 | Copied private helper uses explicit bundle/request IDs and a dedicated evaluator | evaluator checks, browser handoff |
| A07 | Explicit new evaluations get fresh identities; uncertain retries keep the original | console checks, isolated lifecycle checks |
| A08 | Bound submission/finish validate request, attempt, principal and settings under the interrupt lock; legacy stays explicit | isolated evidence checks |
| A09 | Chronological microsecond cursors, scoped old-UUID compatibility and direct active-ID polling | isolated pagination checks, console checks |
| A10 | Bounded exact-anchor proposal edits reconstruct against original bytes | Rust patch/HTTP checks, proposal bridge |
| A11 | Shared final diff includes kinds and empty files, with full downloads beyond its preview | console checks |
| A12 | Suggestion/release recovery consults durable outcomes before fresh-state checks | Rust receipt checks, recovery browser run |
| A13 | New skills receive unique package names | console checks |
| A14 | Typed issuance reconciliation and confirmed revoke before fresh-key replacement; no stored secret replay | Rust access checks, console checks |
| A15 | Admin membership pages and nullable current-role lookup | isolated access checks, console checks |
| A16 | Bounded daemon reporting drains fresh arrivals; stuck clients do not hold Python exit | Python checks; TS late-arrival regression and final combined walkthrough passed |
| A17 | Complete TS/Python recipes use separate optional reporting credentials and actual observed starts | SDK/recipe checks, Python checks |
| A18 | Safe setup diagnostics and private-state preservation | launcher checks, [evidence ledger](shipping-evidence.md) |
| A19 | Documented manual Compose service/console bridge with separate state | initializer checks; actual container lifecycle blocked |
| A20 | Opt-in native-provider harnesses and installed Codex/Luna review path | [Dated provider evidence](shipping-evidence.md); Claude/Pi/Cursor sessions unrun |
| A21 | Versioned tarballs/wheel, checksums, manifest and isolated installed consumers | retained-package checks; public availability unrun |
| A22 | Opt-in OIDC/HTTPS/container qualification with explicit result records | harness checks; external gates remain separate |

## Choose and run an evaluator

The console offers payment retry simulation, file presence, native Codex/Luna review, or a bounded public configuration from your app. Custom JSON declares dataset/grader revisions, runtime `configId`/`configRevision` and settings, and expected case/repetition identities. It carries no credentials, case contents or executable loader.

Selecting a profile or creating its strict request runs nothing. The app's installed adapter must match the frozen configuration. For the three included adapters, the console copies the matching command:

```sh
npm run evaluate:local -- --bundleID UUID --requestID UUID
npm run evaluate:local -- --bundleID UUID --requestID UUID --adapter presence-contract
npm run evaluate:local -- --bundleID UUID --requestID UUID --adapter codex-luna-review --live
```

The first uses payment-policy traces and no model. Presence checks file contracts. Native review requires the explicit `--live` invocation and configured Codex/Luna access. An unrelated custom configuration is handed to its own installed app runner; it does not receive a misleading local command. See [the adapter guide](../../../../examples/evaluation/README.md) and [console guide](../../../../apps/console/README.md).

Complete losing evidence remains complete. Neither the simulator nor a narrow native run establishes statistical improvement. No package publication or deployment is part of local completion; [shipping evidence](shipping-evidence.md) is the source for exact qualified scope and remaining gates.

