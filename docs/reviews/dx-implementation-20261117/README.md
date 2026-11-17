# Developer experience implementation review — 2026-11-17

Eight independent reviewers inspected the working implementation against the frozen [D2 plan](../../design/developer-experience-council/PLAN.md). The review covers changed and newly added code relative to `52c1ce1`; existing user changes are preserved. Reviewers reproduce concrete findings, repair their assigned files and add regression coverage. The coordinator integrates checks and refreshes installed-package qualification after the product sources settle.

**Status: complete. All 28 confirmed findings repaired; integrated checks and both final cross-checks passed.** The [2026-11-16 evidence](../../design/developer-experience-council/IMPLEMENTATION-RESULTS.md) describes its dated source snapshot. Its release artifacts are retained unchanged. The fresh release and checks below cover the repaired implementation.

| Area | Review and repair record |
| --- | --- |
| TypeScript recovery and callback boundaries | [TypeScript](typescript-recovery.md) |
| Python parity, async lifetime and journals | [Python](python.md) |
| Service authorization, retained operations and capabilities | [Server/security](server-security.md) |
| Headless CLI intents, interruption and quality-check authority | [CLI](cli.md) |
| Policy arithmetic, artifact selection and read-only verification | [Policy/evidence](policy-evidence.md) |
| Console scopes, handoffs and copied integration recipes | [Console](console.md) |
| Native job retention, quarantine and cleanup recovery | [Native](native.md) |
| Release archives, CI, consumers and qualification tooling | [Distribution](distribution.md) |

## Findings repaired

The review resolved 28 distinct findings across the eight areas. The duplicate-JSON finding is cross-referenced in the evidence report and counted once under TypeScript.

| Area | Count | Resulting behavior |
| --- | --- | --- |
| TypeScript | 6 | Preserve durable execution certainty; reject invalid Unicode keys/references and duplicate decoded private JSON fields; stop saved-body recovery after lock loss; classify absent configuration correctly. |
| Python | 3 | Pending asynchronous work hidden in containers remains uncertain; equivalent keyed terminal evidence can recover; conflicting saved lifecycle bodies cannot claim or finish another attempt. |
| Service | 1 | Guided retained mutations reject noncanonical body IDs before a transaction, preserving legacy unmarked syntax. |
| CLI | 4 | Creation/doctor exits reflect the actual failure; interruption validates authority before mutation and confirms its reason; quality success requires bound evidence and authoritative direct parentage. |
| Policy/evidence | 4 | Validate every selected original before any mapper runs, reject supplied symlink ancestry, enforce aggregate byte limits incrementally, and reject impossible manifest inspection states. |
| Console | 3 | Copied JS/Python recipes retain private bound results before cleanup; requested requests make no readiness claim; native setup shows the exact peer/version. |
| Native | 1 | Durable cleanup intent permits explicitly authorized recovery after deletion but before the final cleaned record. |
| Distribution | 6 | Propagate CI export failures; refuse unreviewed archive files; generate reproducible starter/wheel bytes; reject stale/obsolete compiled packages; refuse optimized Python qualification; verify declared release evidence and separate service-binary identity from source claims. |

The Python pending-Future defect was high priority: it could seal ordinary failure evidence while external work remained pending. Each lane records its reproductions, regression checks and severity. No arithmetic policy change was necessary; an additional 500-case deterministic experiment matched complete TypeScript/Python verdict objects.

Two final read-only cross-checks found no concrete regression: the server reviewer checked the repaired CLI authority/lifecycle replay and private JSON scanner; the native reviewer checked copied-recipe retention and CI error precedence. Existing focused suites covering the latter passed 22 tests. These are scoped checks, not a guarantee that no undiscovered bug exists.

## Integrated validation

All logs and generated evidence are private local files under `artifacts/dx-review-20261117/`, ignored by Git.

| Check | Result |
| --- | --- |
| `npm test` | 214 package tests and 245 console tests passed |
| Python 3.11 unittest discovery, `PYTHONPATH=python` | 82 passed |
| `npm run test:evaluator` | 31 compatibility tests passed |
| Full Rust suite against owned PostgreSQL 16 | 70 tests in 23 suites passed; all four database test environment aliases explicitly pointed to the disposable cluster |
| `npm run typecheck` | All workspaces passed |
| Strict Clippy, Rust format, whitespace checks | Passed |
| Production console build and built/Vite entrypoint checks | Passed; 6 entrypoint tests passed |
| Native repository suite after fresh package build | 22 passed, including five real process-death boundaries |
| Operator / improvement suites | 5 / 23 passed |
| Packaging / qualification integrity / async starter checks | 28 Node / 4 Python / 2 async tests passed |
| Fresh package build and installed release verification | Passed, including strict TypeScript starter compilation, optional peers, actual extracted archives and wheel |
| Installed JS/Python qualification against real service/PostgreSQL 16.15 | Passed: five lost committed responses beyond transient retention, unchanged operation identities, explicit policy categories, token rotation, actual CI archives and independent cross-language downloaded review verification |
| Full behavior inventory | 155/155 behaviors, 198/198 scenarios, 941 steps passed across 17 features; zero failures/skips. Report: `artifacts/dx-review-20261117/bdd/coverage.md` |

The behavior run uses fresh production console/package/service builds. No service binary build ran during installed qualification; its digest was recorded and rechecked. `--skip-build` packaging now requires a matching source/output receipt, and removed package modules are cleared before compilation.

## Fresh release identity

Unpublished release: `/private/tmp/acclimate-dx-release-20261117-review-1`. Qualification report: `/private/tmp/acclimate-dx-qualification-20261117-review-1.json`. Copies of its manifest, source inventory and report are in the evidence directory above. `distribution-evidence.json` indexes the generated files and log hashes.

| Identity | SHA-256 |
| --- | --- |
| 152-input release fingerprint | `15feab4b46cd8c4d52592fc318cd171a267daa1ec562d4447ae261a16db03f6b` |
| Release manifest | `559c1dfe4e47158af21178742d0715500e6616b182ee89be1caf5ca844675153` |
| Installed qualification report | `1310b9bb7f5939fc1afe9b4cff2b34d8ed2994df38f460ad1ef02a0a57f55bc2` |
| Tested service executable | `ed09e68c2c93497df582c57b5366b312f915dd2625bd5e053d0a7ebad2a8de8a` |
| Wheel, matching an independent repeated build | `1597fab5a5b18b9fed33a56777165843a0c1c7b1a499c1a52ee8e231f0a7fae1` |

The manifest covers eleven artifact files. Source metadata is a verified inventory, not signed provenance or source attestation for the separately built service executable. The explicit source scope excludes console runtime; its build/unit/behavior checks are recorded separately. Installed checks used Node 26.13.1, Python 3.11.7 and POSIX; minimum Node versions, Windows and network filesystems were not separately qualified.

## Limits

Deterministic callbacks and fake native tasks qualify wiring, protocol, filesystem and process behavior in these fixtures. They do not qualify live model quality, native provider consumption/termination, real external identity providers, public deployment, container remount recovery or arbitrary secret detection. Fixed-root recovery used fresh local processes. Offline review establishes self-consistency; online verification establishes scalar/request binding, not execution authenticity. Starter source inventories are intentionally explicit and need maintenance when files change. Copied connection recipes preserve output through ordinary process completion; the native starter supplies the separate durable job/quarantine protocol.

No paid/live model calls, deployment, publication or commits are part of this review.
