# Parallel qualification input

The reviewed `plan.md` and `review.md` govern. This is planning evidence from source inspection; no checks, services, credentials or providers were exercised.

**Overall objective:** complete A01–A22’s local remediation with isolated, reproducible regressions; demonstrate native-target editing/recovery through app evaluation and deliberate installed-package delivery/rollback; retain installable artifacts and honest external qualification records. Local completion does not establish public distribution, provider quality or hosted readiness.

## Eight lanes and sole ownership

Each lane implements and proves its behavior. The shared-file owner integrates requested changes; other lanes send patches/specifications rather than editing that file. New tests belong to their domain lane. This keeps acceptance parallel, with a short final integration gate.

| Lane | Implementation and exclusive test/integration ownership |
| --- | --- |
| C: contracts | Migration numbering, shared Rust/TS DTOs, command marker/namespace/action-rights/error contracts, cursor encoding, manifest schema and shared compatibility fixture schema. Own existing `tests/productization_regressions.rs`; domain lanes use separate regression files. Freeze additive defaults and contract vectors first. |
| N: content/proposals | Validators/plugins, target-aware publication, bounded provider edits, editor compatibility/diff/skill allocation; corresponding Rust/plugin/console draft tests. Sole owner of compatibility fixture data, `scripts/bdd/provider.py`, `scripts/full-roadmap/run.ts` and fixture tests, proposal/draft/setup/release feature/step files. |
| R: recovery | Pending envelopes, receipts/close, exact replay, credential reconciliation; recovery tests and console connection tests; integration feature/steps. Own all pending-storage fixtures. Coordinate release/draft UI edits with N through component boundaries fixed by C. |
| E: evaluation | Installed adapter, helper/journal, descriptor/binding, chronological lists/polling, improvement UI and SDK comparison tests; evaluation feature/steps. Sole owner of `examples/evaluate-request.test.ts`, `scripts/bdd/world.py`, `scripts/productization/qualify.py`; replace their successful unbound fixtures and preserve named legacy cases. |
| A: access | Last-admin invariant, member discovery/current role, access/identity tests and access/identity/console-access feature/steps. |
| D: delivery | Timeout classifier, Python worker, observed-start recipes; SDK delivery/reporting and Python receipt tests; SDK/Python feature/steps and language consumers. Replace executor-private synchronization with barriers and subprocess exit assertions. |
| O: operations | Launcher/private configuration reader and test-owned state-root seam, diagnostics, manual console bridge; process/setup-diagnostic/local-recovery tests and runtime feature/steps. E consumes its reader, with one dedicated evaluator principal and one `evaluate:local` command. |
| S: shipping/integration | Retained artifact builder/verifiers, release workflow, external harnesses/ledger, generated docs. Sole owner of package manifests/scripts/lockfile, CI, shared BDD runner/browser/environment/coverage/inventory, existing console/navigation feature/step files, `scripts/productization/rust_tests.py` and browser wrapper. Own integrated copied-helper scenario; domain lanes supply focused new step modules/scenarios. |

C records exact file boundaries before work, including monolithic Rust/console files; shared ownership is never implicit. S owns inventory edits only, not every scenario or every test run. Lane owners run their own isolated gates concurrently.

## Start and merge gates

Immediately start independent timeout, access, Python shutdown, diagnostics, packaging and regression scaffolding. C freezes contracts while E/O agree private state/configuration. N/R/E then implement against those contracts; service/API changes land before new clients. Rebase dependent lanes after contract changes, rerun affected regressions, and merge shared fixtures before claiming integration success.

Existing `npm test` covers packages/console only. Required final checks include typecheck/build, targeted lane suites, isolated Rust runner (all three DB variables), Python tests, evaluator/improvement/operator tests, exact retained-artifact consumers, and complete BDD inventory. Use fresh builds, not `--skip-build`. Keep each harness’s private cluster/files/processes; never supply ambient/user database state. Wrap the existing full-roadmap runner in disposable qualification ownership because it currently accepts caller `DATABASE_URL`.

## Acceptance allocation

- **N/C — A01, A10, A11, A13:** shared TS/Rust vectors; generic permissiveness; incomplete native save/reload; every fresh publication/rollback gate; >40 KB untouched content, UTF-8 limits, disjoint anchors, finish reasons; rendered kind/empty-file diff; repeated skill operations.
- **R/C — A04, A12, A14:** lost-response reload, frozen bytes/key, newer edits retained; replay before stale checks; marked/unmarked close races, route-key separation, rights rechecks; storage failure sends nothing; forgotten-text fences; issuance/revocation uncertainty and fresh replacement.
- **E/O — A05–A09:** copied helper on a nonseeded bundle; actual private state; observable behavior and complete losing evidence; strict cross-request/attempt/principal/config rejection plus legacy compatibility; exclusive journal recovery never reexecutes uncertain callbacks; 25+ records, timestamp ties, scoped legacy cursors, later-page polling.
- **D — A02, A16, A17:** stalled-header/body native timeouts and denial/integrity controls; fresh-arrival draining, stuck-client interpreter exit; both installed-language recipes and optional-report failures; actual start events.
- **A — A03, A15:** concurrent final-admin mutations preserve an admin; bounded member pages, nullable role and current authorization.
- **O — A18, A19:** owned ports/private paths/config sentinel failures; restart persistence through native and manual bridge; actual Compose separately recorded.
- **S/N — A20–A22:** retained checksummed artifacts consumed outside checkout; opt-in provider/TLS/OIDC/HTTPS/container harnesses and dated evidence.

## Completion and remaining review

Checklist: every audit row has revision/command/result/sanitized evidence; full inventory passes; integrated browser → helper → bound report → deliberate release → installed preparation → receipt → compatible rollback passes, preserving old pinned bytes; artifacts remain reviewable; external ledger records `passed | blocked | not run` and exact blockers. No incidental publication/deployment; model work requires bounded Luna opt-in.

Remove superseded policy-change races, canonical descriptor-hash tests and old helper names. Retain current transaction ordering, cursor microseconds, legacy unbound promotion semantics and interruption-versus-release distinctions. Full-payload HTTP fixtures, unbound strict successes, source-runner browser handoff and executor-private receipt tests must fail the updated contracts until corrected; passing preparation/synthetic identity checks cannot close external gates.
