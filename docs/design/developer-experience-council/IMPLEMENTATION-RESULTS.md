# Developer experience implementation evidence

This is the 2026-11-16 qualification snapshot. The [2026-11-17 implementation review](../../reviews/dx-implementation-20261117/README.md) records subsequent findings, repairs and refreshed evidence. The artifact identities below continue to identify the original snapshot.

Implemented on 2026-11-16 by nine implementation agents with shared interface coordination. Two independent implementation auditors reviewed recovery/parity and evidence/native behavior. All eleven material findings, including the coordinator's callback-mutation finding, were repaired and rechecked. Their [recovery audit](audit-recovery.md) and [evidence/native audit](audit-evidence-native.md) retain the reproductions and repair evidence.

The normative [D2 plan](PLAN.md) is unchanged, SHA-256 `9bd400d28d8e07f1906273dd7ead095c9add3f273e5e33adc5045fe9e23462e1`. The earlier council signatures approve that design; the implementation evidence below is a separate record.

**Disposition: implementation complete; both independent audits clear; all recorded local checks passed.** External and live qualification limits remain explicit below.

## Delivered behavior

- Installed TypeScript and Python evaluator definitions, nonexecuting preflight, durable paired execution and app-owned CLI. Both preserve exact mutation bytes and original operation identities, reject uncertain replay and share an OS lock across languages.
- Read-only capability discovery, retained draft/request/start/submit/finish operations with current authorization, bounded HTTP responses, and read-authorized delivery observations.
- Explicit quality policy, independently bound read-only review verification, and role-selected redacted output/explanation export. Private artifacts bind identity inside their hashed envelopes before any mapper runs.
- Console evaluator selection, public handoff copy/download, connected delivery/agent recipes, and a separate Delivery view for readers.
- Complete JS/TS/Python starters, headless CI archive, four native repository harness examples, private crash-recovery locators, and versioned SDK/plugin/wheel/starter artifacts.

Start with [getting started](../../getting-started.md), [evaluator operations](../../evaluator-operations.md), or the [native repository guide](../../../examples/native-repository/README.md).

## Release and runtime identity

The locally generated, unpublished release is `/private/tmp/acclimate-dx-release-20261116-final`. Its manifest covers eleven files, including the source inventory, SDK/plugin tarballs, Python wheel, three starter archives and public metadata. All artifact sizes/hashes and all 144 source input hashes were rechecked after qualification.

| Record | SHA-256 |
| --- | --- |
| Release input fingerprint | `28080f179f25dee385c804b7553c38b03a80b21dc70fde96d7b6dbd4e00858aa` |
| Release manifest | `434f88c49afa56979a03df375799c11b7aa5f7507fc652f9237177376b8fe628` |
| Installed qualification report | `8882375e95d45e9198c318b50de33dd3343b4f5f5ae65946adcef5033067cdeb` |

The source fingerprint covers the explicit SDK/plugin/Python/service, starter and distribution inputs listed in `SOURCE.json`; it excludes console runtime, tests and unrelated documentation. Console qualification is recorded separately below. Installed checks used Node 26.13.1, Python 3.11.7, macOS/POSIX, PostgreSQL 16 and the real Rust service. The minimum supported runtime versions were not separately exercised in this run.

Generated evidence is local and ignored by Git: `artifacts/dx-implementation/installed-qualification.json`, `release-manifest.json`, `release-source.json`, and test logs. The original qualification report is `/private/tmp/acclimate-dx-qualification-20261116-final.json`. These are local evidence paths, not published download endpoints. [Packaging instructions](../../../scripts/packaging/README.md) reproduce the checks using fresh output paths.

## Validation results

| Check | Result |
| --- | --- |
| `npm test` | 191 package tests and 240 console tests passed |
| Final evaluator package suite | 82 passed after all added acceptance regressions |
| `npm run typecheck` | All workspaces passed |
| Python unittest discovery, Python 3.11, `PYTHONPATH=python` | Final rerun: 70 passed |
| `cargo test --all-targets -- --test-threads=1` | All suites passed against an owned disposable PostgreSQL database; all test database aliases were explicitly set so database tests ran |
| `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` | Passed |
| `npm run test:evaluator` | 31 passed; copied-command HTTP fixture exercises the shared installed runner |
| `npm run test:operator`, `npm run test:improvement` | 5 and 23 passed |
| Production console build; built/Vite entrypoint integration | Passed; 6 entrypoint tests passed |
| Full behavior inventory | 155 behaviors / 198 scenarios passed, 0 failed/skipped; 941 steps passed across all 17 features. Report: `artifacts/dx-bdd-final/coverage.md` |
| Focused UI-EVAL-01 and UI-ACCESS-01 browser checks | 3 scenarios passed: actual public JSON download plus clipboard, canary exclusion, viewer/editor Delivery access and absent credential controls |
| Final CLI acceptance recheck | 11 TypeScript CLI tests and focused Python counterparts passed, including uncertain committed-submit exit/retry and running/interrupted indeterminate policy checks |
| Oversized committed-submit recovery | Focused TS/Python full-runner HTTP tests passed; saved body/key and original comparison survive retry with no repeated callbacks |
| Missing-runtime preflight | 1 focused subprocess test passed; TypeScript typecheck also passed after the final test additions |
| Native repository tests | 20 passed, including real killed-process recovery fixtures and installed harness preparation |
| Packaging privacy and installed async lifetime | 9 and 2 passed |
| `npm run build:packages`, `npm run pack:verify` | Final immutable release passed clean external consumers, strict TS starter compilation and extracted starter archives |
| Installed DX qualification | Both languages passed the real service workflow, five committed-response-loss phases beyond transient retention, same-principal token rotation, CI archive and cross-language downloaded review verification |

## D2 gate coverage

This matrix identifies the tests and qualification layers used for each gate. A focused check establishes its exercised fixtures; it is not a claim that every possible deployment or provider has been qualified.

| Gate | Executed evidence and scope |
| --- | --- |
| G01 | Final tarball/wheel consumers ran paired two-task comparisons, public descriptors/handoffs and bound submissions without repository imports. Console download was checked separately in Chromium. |
| G02 | Pure public contracts, production browser build, built/Vite entrypoint checks and isolated imports passed. An isolated Node child with an empty PATH verifies missing `python3` blocks public preflight and run with zero claims/callbacks and no attempt journal. Durable runtime requires POSIX plus `python3`/`fcntl` for TypeScript, as documented. |
| G03 | SDK contract/core and Python core fixtures reject invalid guided targets, altered frozen bindings and foreign journals before callbacks. Doctor tests distinguish denied/missing authority from readiness. |
| G04 | `tests/dx_evaluator.rs` tests machine read/write/denied/human/revoked/project authorization and private capability responses against PostgreSQL. |
| G05 | Actual subprocess ownership tests cover same-language contention, cross-language kernel flock, foreign journal formats and original-root refusal. Private filesystem tests cover unsafe paths and durable new-directory creation. |
| G06 | Real installed JS/Python fault proxy drops committed start/submit/finish responses after expiring the transient cache beyond 24 hours; original IDs and output counts are retained. Rust tests cover authorization, historical replay/interruption, race and maximum report/wrapper sizes; SDK tests cover streamed oversize rejection. Final full-runner HTTP regressions in both languages commit the comparison, return decoded JSON above 4 MiB, then recover the original comparison using the saved exact report/key with no repeated callbacks; TS also tests a small gzip wire body expanding above the decoded budget. |
| G07 | Compatibility/core fixtures cover known legacy commitment and no-receipt uncertainty, refusing guessed retransmission and callback replay. |
| G08 | Real process-death marker and lock-helper-death tests, held callback cancellation tests and native crash fixtures preserve uncertainty and resource lifetime. |
| G09 | Both core suites assert the full serial paired trace, mutable input/content isolation, captured callback results, uncertainty, truthful missing grades and usage. Audit regressions cover cancellation during authoritative reads. |
| G10 | CLI suites distinguish complete candidate loss, failed/incomplete evidence, interruption, invalid configuration, durable creation recovery and independent policy categories. Final TS/Python CLI fixtures directly check committed-submit uncertainty produces exit 3, then recovers the original exact body/key/attempt/comparison without repeating callbacks. Installed qualification runs pass/fail/invalid policies. |
| G11 | 26 shared policy vectors plus TypeScript/Python parser and numeric-boundary tests cover exact identity, inventory, equal-case aggregation, required evidence, unknown cost and threshold behavior. TS/Python CLI fixtures directly assert requested/running/interrupted requests remain indeterminate with exit 3. |
| G12 | Contract/core/CLI/policy/artifact tests and installed export canaries check private config, tokens, errors and unselected content. Real console download checks synthetic token/path canaries. |
| G13 | Both artifact suites and actual CLI exports exercise selected output/explanation roles, required/optional dispositions, no-journal scalar export, corrupt bindings and role swaps before mapper invocation, portable JSON and unsafe paths. |
| G14 | All four fake native tasks run from installed/extracted consumers. Repository tests inspect retained patches, unchanged original source, resource conflicts, memory exclusion and uncertain termination. Live model consumption is unrun. |
| G15 | Console unit/browser stories exercise explicit choice with no default, frozen saved requests, pending recovery/channel drift, and public handoff copy/download. |
| G16 | Real service tests cover selected receipt-row coherence, ordering, expired/missing observations and reader authorization. Console tests plus viewer/editor browser checks cover Delivery access and credential-control separation. |
| G17 | Installed Python async recipe drains two caller cancellations while an unrelated task remains responsive and resources stay alive. Core tests reject async callables/coroutines/futures and nested awaitables as ordinary evidence. |
| G18 | Disposable service provisioning validates private stdin grants; actual restarts exercise overlapping old/new tokens for one principal, then old-token 401 and original comparison recovery with the new token. Same physical journal roots and fresh worker processes were used; containers were not tested. |
| G19 | Final manifest, artifact checksums, source fingerprint, clean installed imports, actual starter archives and schema-1 compatibility fixtures were exercised. Publication is unrun. |
| G20 | External installed JS/Python apps create candidate/request headlessly and recover committed creation loss beyond 24 hours, then run/check/export. CLI fixtures reject changed intent/payload/descriptor and channel drift without rebasing. Strict TS starter compilation also passes. |
| G21 | Native subprocess crash fixtures stop at launch-intent/acceptance/retention/stopped boundaries and retain private locators; root/TMPDIR/marker and context/memory checks fail closed. Provider termination is simulated, not live-qualified. |
| G22 | Installed opposite-language readers verify downloaded exports against independently selected online requests after terminal worker journals are removed, with no journal recreation or execution. Tampered target/scalars fail; exports retain `executionAttested:false`. |

## Final acceptance recheck

The final evidence review identified three missing direct regression cases. New fixtures now pass for full-runner recovery after a committed submit returns more than 4 MiB, uncertain comparison-submit CLI exit/retry, and indeterminate policy checks on running/interrupted requests. The recovery auditor independently inspected and reran these cases. Both languages cover oversized response recovery, uncertain-submit CLI retry and lifecycle policy checks. No originally identified acceptance gap or material audit finding remains unresolved.

## Qualification limits

No paid model calls, live native providers, public deployment, registry publication or real external identity-provider qualification ran as part of this change. Deterministic callbacks establish protocol and wiring behavior; they do not establish model quality, behavioral improvement or live provider termination. Fixed-root worker recovery used local processes rather than container remounts. Durability requires the documented private local filesystem semantics; network filesystems and Windows are not qualified. Browser fixtures establish behavior, not a separate visual usability study. Existing production hosting and identity qualification requirements remain in force.
