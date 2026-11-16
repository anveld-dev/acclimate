# Shipping evidence

> Pre-cutover remediation evidence. Local launcher, Compose bridge and evaluator state-root instructions here are retired. The [production evidence](../../production-only/evidence.md) is the current startup and identity record.

Updated 2026-11-14. The later [UI implementation pass](../ui-improvements.md#implementation-evidence) passed 141 behaviors / 183 scenarios / 873 steps; the remediation-only counts below retain their original evidence scope. This records executed checks separately from runnable tooling and external availability. The reviewed [plan](plan.md) and [contract freeze](../../../../contracts/remediation.md) govern scope.

| Area | Status | Actual evidence / remaining requirement |
|---|---|---|
| A18 private state and diagnostics | passed | `node --import tsx --test scripts/private-state.test.ts scripts/local-processes.test.ts scripts/compose-config.test.ts`: 16 tests, including redaction, private-file/symlink refusal, backend-only code-75 recovery and bounded retry exhaustion, occupied non-HTTP port detection and unreadable-config preservation. Atomic file and parent-directory sync precede return. No live launcher state was opened. |
| A19 manual Compose bridge | implemented; not run | New `compose.service.yaml`, explicit new-state initializer and console-only bridge. The initializer subprocess security test passed (dedicated read/write evaluator, mode-0600 state/environment, no printed token, existing state refused unchanged). Native PostgreSQL routing remains separate. Actual container execution requires the opt-in lifecycle gate below. |
| Python wheel consumer | passed | Python 3.12 built a wheel, installed it with `--no-index --no-deps` into an external temporary venv and checked real preparation plus cleanup under `-I`. No checkout import path was used. |
| A21 retained release directory | passed locally | `npm run pack:verify -- --skip-build` consumed the fresh package build and retained five version-0.1.0 npm tarballs plus the Python wheel under `artifacts/releases/0.1.0/`. External offline npm runtime/type/native-peer consumers and Python wheel preparation passed. All six SHA256SUMS entries independently verified. These artifacts include the browser-safe validation export. Earlier artifacts are preserved under `0.1.0-before-receipt-fix/` and `0.1.0-before-browser-fix/`. The export runtime/type consumer passed in `dev-fix-pack.log`. The package-check manifest records publication and external qualification as not run within that package-only check. CI uploads the retained directory; it does not publish packages. |
| Fresh package + console + Rust build | passed | Fresh package build and Rust `cargo build --locked` passed; the console/SDK rebuild after the browser-boundary fix also passed (`dev-fix-build.log`). Earlier logs: `artifacts/remediation/build-final.log`, `cargo-build.log`, `console-build-final.log`. |
| Focused browser acceptance | passed | Latest nine variants passed all 44 steps: native/custom evaluator profiles, actual copied model-free helper, create/save response loss with later edits, held-response file-selector disabling, real authorization-loss retention, close returning a known draft commit, safe saved-route handoff, and the combined native walkthrough. Evidence: `artifacts/remediation/bdd-targeted-complete/` and `bdd-targeted-complete.log`. |
| Remediation BDD before UI pass | passed | Final fresh run passed all 132 reviewed behaviors, 171 scenarios and 814 steps, with zero failed, undefined or skipped cases. It used the real built service/console/packages and a private PG17 cluster. Logs and retained machine evidence: `artifacts/remediation/dev-fix-bdd-full.log`, `artifacts/remediation/dev-fix-bdd-full/`; current report: `artifacts/bdd/coverage.md`. Default tests made no model calls. Earlier discovery runs are retained separately and do not substitute for this complete acceptance. |
| External harness safety | passed | Six `scripts/productization/test_external.py` tests: default no execution, paid opt-in guard, output redaction, credential URL refusal, redirect refusal and actual Playwright string-URL predicates. Native driver without `--live` exits before reading stdin/authentication or loading a provider SDK. |

The combined [native walkthrough](../../../../features/native_walk.feature) imports a Codex-target bundle through the browser, saves and reloads an incomplete skill, repairs it, reconciles a lost save response, creates a strict request, executes the actual displayed helper command with a private test-owned state root, checks every bound case and deliberately releases. An outside-checkout app installs freshly packed SDK/Codex-plugin tarballs, checks exact native instruction/skill/memory bytes, observes a real model-free child start and reports through a separate receipt credential. Browser rollback changes the next job's mapping while both earlier prepared workspaces retain exact pinned bytes; an invalid optional reporting credential does not break delivery or app start.

The browser never executes the native paid profile in default BDD: it checks its strict frozen runtime/cases and copied `--adapter codex-luna-review --live` command while the request remains `requested`. Custom public descriptors reject malformed intent, remain frozen after later form edits, and hand off to the app's installed evaluator without inventing a local executable. Payment-policy results establish orchestration and complete losing evidence; they do not establish native review quality.

| Other final verification | Result | Evidence log under `artifacts/remediation/` |
|---|---|---|
| Package tests | 90 passed | `dev-fix-packages.log` |
| Console tests | 96 passed | `dev-fix-tests.log` |
| Isolated Rust tests | 42 passed; all three DB-test variables point to an owned cluster | `rust-isolated-final.log` |
| Python SDK/recipe tests | 12 passed | `python.log` |
| Evaluator tests | 20 passed | `evaluator.log` |
| Improvement, operator, full-roadmap fixtures, operations | 5 / 4 / 5 / 2 passed | `improvement.log`, `operator.log`, `full-roadmap-tests.log`, `operations.log` |
| Formatting, typecheck, Clippy, build | passed | `fmt.log`, `typecheck-final.log`, `clippy.log`, `console-build-final.log` |
| npm high-severity audit threshold | exit 0 | `npm-audit.log` |
| Documentation links/search/figures | 2,570 links, 9,143 search entries, 9 figures clean | `dev-fix-docs-check.log`, `dev-fix-docs-build.log` |
| Documentation browser | 41 pages, 410 responsive/theme checks, zero network/browser errors | `docs-browser.log` |

The combined walkthrough exposed a real TypeScript receipt queue race: a fresh event arriving after the iterator ended but before its completion callback cleared ownership could remain pending despite successful transport. A deterministic probe reproduced it; the reporter fix and focused regression passed before the final artifact rebuild. The browser runs also exposed saved-route timing and hidden revoke-error issues, which were fixed before the latest focused acceptance. Superseded failures remain under `bdd-native-receipt-race/`, `bdd-navigation-transition/` and `initial-bdd/`; none are presented as passing evidence.

## Development-browser follow-up

The production suite missed a real development import failure: the library and editors imported validators through the Node SDK entry. Vite loaded its filesystem/crypto exports in the browser and the route hit its error boundary. An HTTP/SSR check was insufficient.

The UI now imports `@acclimate/sdk/validation`, which shares pure payload/native checks and error identity with the Node entry, uses browser UTF-8 encoding and has no filesystem dependency. The installed-package check covers this new export. A regression checks UTF-8 limits and shared error identity.

`npm run test:bdd -- --skip-build --dev-console --tags @UI-DRAFT-02` passed the real Vite module loads, draft save and browser/service restart story: one scenario, five steps. CI now runs it separately and retains `artifacts/bdd-dev/` alongside the full production report. Fresh reads of the running local console loaded all four affected UI modules with zero page or console errors and no Buffer global (`dev-live-browser.log`). The production rerun also passed all 171 scenarios and 814 steps; both reports are retained under `dev-fix-bdd-full/` and `dev-fix-bdd-dev/`. Evidence: `dev-browser-green.log`, `dev-fix-typecheck.log`, `dev-fix-tests.log`, `dev-fix-packages.log`, `dev-fix-build.log` and `dev-fix-pack.log` under `artifacts/remediation/`.

## External qualification

| External gate | Status | Exact scope and blocker |
|---|---|---|
| Native Codex/Luna | passed | Actual three-turn Codex SDK/Luna run passed on 2026-11-14: fresh v1, fresh v2 and resumed v1 all returned the expected random instruction/skill/memory markers without other-version markers. Result: `artifacts/remediation/native-codex.json`. This does not establish in-place hot reload, native improvement quality or statistical improvement. |
| Luna proposal/evaluation bridge | passed | Actual bounded private-PG full-roadmap run passed with one service proposal and four app review turns, SDK 0.169.0, complete evidence, explicit reviewed release, stale-revision denial, retained old pin and rollback. Evidence: `artifacts/remediation/full-roadmap-live/result.json` and its `evidence/summary.json`. The proposer used the bounded patch response through a local SDK-backed HTTP bridge. This is not direct vendor API/TLS qualification or statistical proof of improvement. |
| Native Claude/Luna | not run | Actual `query` driver is implemented with native skill/project options and random markers. Requires a real configured compatible Luna provider/gateway; its availability/authentication was not inspected or assumed. |
| Native Pi/Luna | not run | Actual `createAgentSession`/resource-loader driver is implemented. Requires explicitly selected `ACCLIMATE_QUALIFY_PI_PROVIDER` exposing Luna and app authentication. No provider model was substituted. |
| Native Cursor/Luna | not run | Actual `Agent.create` native-local driver is implemented. Requires Cursor authentication and confirmed provider Luna support. No provider session/scanner behavior has been observed. |
| Direct remote model TLS | not run | Opt-in single bounded Luna HTTP completion exists. Requires an explicitly supplied HTTPS endpoint/token. Local compatibility adapters do not qualify this gate. |
| Real OIDC sign-in | not run | Interactive fresh-browser issuer → callback → secure-cookie → logout harness exists. Requires a configured HTTPS console, real issuer/client and disposable operator test account. Fixture identity tests are separate. |
| HTTPS authenticated deployment | not run | Verified-certificate health plus authenticated scoped bundle-read harness exists and rejects redirects. Requires an explicitly configured external qualification deployment. |
| Container lifecycle | blocked | Harness builds the deployment image, uses a randomly named private Compose project/database volume, tests authenticated persistence, restart and SIGTERM exit, then removes only its own stack. Docker preflight could not connect to the daemon socket. The actual lifecycle was not run; no Docker build/start/deployment was performed as an incidental test. |
| Public npm/PyPI or release download availability | not run | No package, image or release was published. Retained local artifacts and CI uploads do not imply public availability. Publication requires a separate explicit action. |

Reproduction commands and driver limits are in [the deployment guide](../../../../deploy/README.md#qualification-boundaries). Each invocation creates a new mode-0600 JSON result only at an explicit `--output` path. Failed configured gates remain `blocked`, and unselected gates remain `not run`. Do not label this implementation hosted-ready or claim statistical improvement from deterministic fixtures.
