# Acceptance and feasibility review

Reviewed plan, five inputs, audit and existing harnesses on 2026-11-14. A01–A22 are mapped; none is absent. The plan is implementable, but its finish line needs the following concrete evidence contract. No runtime checks were executed for this review.

## Resolve before implementation

- Distinguish **local remediation complete** from **qualified for external release**. A20 and A22 require external evidence; A21 can locally produce installable artifacts but cannot establish public availability. A blocked external gate must remain visible rather than failing every default check or silently counting as passed.
- Resolve the helper contract once: evaluation input specifies `evaluate:local`, dedicated evaluator principal and `scripts/evaluate-local.ts`; shipping specifies `local:evaluate`, author principal and `scripts/local-evaluate.ts`. The combined plan selects dedicated read/write credentials without promote/propose; update the other input before assigning work. Test a nonseeded selected bundle.
- Freeze durable-command lock ordering, marked/unmarked key semantics, close tombstones, descriptor canonicalization and cursor/error contracts before parallel edits. Compatibility and recovery both alter replay ordering; evaluation and recovery both alter request creation. Independent patches can each pass their narrow tests while defeating the combined transaction invariant.

## Existing checks that cannot establish the claims

`npm test` omits Rust, Python, evaluator and browser gates. Bare `cargo test` silently skips database tests or consumes ambient `DATABASE_URL`; use `scripts/productization/rust_tests.py` with its private cluster and all three database variables. Never point process-ownership or fault tests at user databases.

`features/steps/console.py` injects evaluator environment values and invokes the source runner: it does not execute the copied helper or validate private configuration. Add a test-owned launcher state root; running the fixed-path convenience launcher against the checkout's existing state is unsuitable for default acceptance.

`examples/evaluate-request.test.ts` calls its test “bound attempt” but only checks finish arguments; its report has no request/attempt association and both payloads get presence rewards. `scripts/bdd/world.py` and `qualify.py` also create unbound finishing reports. Update successful lifecycle fixtures and retain explicit historical-unbound rejection/read/release cases.

`scripts/bdd/provider.py` and `scripts/full-roadmap/run.ts` emit full-payload provider responses. Update these HTTP fixtures for bounded edits; keep public `ProposalModel` full-payload test doubles where that unchanged trait is intended. Python receipt tests synchronize through `_worker.submit`; replace that private executor assumption. Preparation tests, synthetic identity fixtures and copied peer dependencies remain useful but do not establish live provider/OIDC/download qualification.

## Minimal acceptance matrix

Every row needs a command, source revision, actual result and retained sanitized evidence.

| Audit IDs | Required model-free evidence |
| --- | --- |
| A01 | Shared TS/Rust fixtures plus real routes/plugins; generic stays permissive; incompatible direct/draft/unevaluated release and rollback fail; policy/proposal/release races and replay after policy change. |
| A02 | Real stalled headers/body causing native TimeoutError for channel and exact pin; permitted verified fallback succeeds; denials, corruption, expired/wrong pins fail. |
| A03, A15 | Serialized final-admin concurrent demotion/removal leaves an admin; member pages/nullable role, current authorization, stale UI and one-connection reads. |
| A04, A12, A14 | Browser reload after dropped responses, exact bytes/key, newer edits preserved; committed replay before stale checks; close/write race; unavailable storage sends nothing; legacy/forgotten payload fence; lost issuance/revoke and fresh replacement. |
| A05–A08 | Copied helper against disposable real service; frozen installed descriptor, observable payment traces, complete losing report; cross-request/attempt/principal/config rejection; journal restart after start/submit/finish loss never reexecutes uncertain work. |
| A09 | 25+ chronological records, equal timestamps, legacy/scoped cursors, insert during paging, later-page direct polling and stale-scope rejection. |
| A10, A11, A13 | Actual adapter HTTP reconstruction with untouched >40 KB bytes, escaping/UTF-8/bounds/invalid anchors; rendered kind/empty-file changes; repeated skill add/rename/remove remains saveable. |
| A16, A17 | Both installed-language recipes; optional receipt failures preserve delivery; observed start only; Python fresh-arrival barriers and actual stuck-client subprocess exit. |
| A18, A19 | Disposable ports/private paths/config sentinel tests; restart persistence for native and manual bridge; actual Compose explicitly blocked when unavailable. |
| A20–A22 | Retained artifact checksums and isolated consumers; opt-in provider, TLS/OIDC/HTTPS/container harnesses with separate dated external results. |

## Release gates

Require typecheck/build, targeted regressions, isolated Rust/Python/package checks and complete BDD coverage with deliberately reviewed inventory updates. Run one native-target browser → helper → bound report → deliberate release → installed preparation → optional receipt → compatible rollback path. No paid default calls, live-user faults, publication or deployment. External runs require explicit opt-in, Luna only, bounded work and no model substitution; record `passed`, `blocked` or `not run` per claim.
