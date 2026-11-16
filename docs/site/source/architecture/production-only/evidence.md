# Production implementation evidence

Updated 2026-11-14. Implementation and isolated acceptance are complete. The [plan](plan.md), [review](review.md) and [parallel paths](parallel-work.md) record scope and ownership.

## What changed

The app has one identity path: PostgreSQL plus verified OIDC browser sessions and current memberships. Distinct machine grants still serve background applications. Local/demo provisioning and old private-state evaluator lookup are retired. Nothing resets, adopts or migrates the running user's database during development.

Operators can explicitly adopt a memberless project after reviewing its exact ID, their verified identity and a reason. Adoption is serialized and audited; historical retries never restore a removed role. Migration 0013 preserves business rows and revokes previous browser sessions once. Coordinate that upgrade and require fresh sign-in.

The production recipe includes PostgreSQL 16, Rust, a built Node console and a TLS proxy, with private backend listeners and explicit secret inputs. Readiness checks usable storage, singleton ownership and a live initialized worker. Shutdown withdraws readiness and releases ownership after work stops or its bounded deadline cancels it.

## Executed checks

Evidence lives under `artifacts/production-only/`; browser reports have separate directories.

| Check | Result |
| --- | --- |
| Rust authority, contracts, upgrade and actual process lifecycle | 55 passed against disposable PostgreSQL 18; includes old-row/checksum preservation, one-time session cutover, DB failure, wrong configuration, ownership loss, recovery and bounded shutdown |
| Actual release binary through supported startup wrapper | Ready, health and clean SIGTERM passed on an owned database |
| TypeScript/package tests | 100 passed |
| Console unit tests | 129 passed |
| Evaluator | 31 runner tests plus 3 private-configuration tests passed; includes exact report/recovery identity, process death, concurrent runners and relocated journal rejection |
| Operator / improvement / roadmap fixture tests | 4 / 5 / 5 passed, no model calls |
| Python SDK / operations / fixture tests | 12 / 2 / 4 passed; isolated wheel consumer passed |
| Deployment and external-gate unit contracts | 13 passed; Compose configuration validated without starting Docker |
| Actual built and Vite startup | 6 executable tests passed; missing/obsolete configuration cannot listen, valid processes expose probes, implicit dotenv is ignored and configured public Host works |
| Default OIDC client via disposable HTTPS issuer/proxy | Built and Vite passed discovery, code exchange, JWKS/signature, PKCE, state, nonce, rotation, logout, invalid claims, replay and canonical Host checks |
| Portable artifacts | Five npm tarballs, Python wheel, external runtime/type consumers and copied standalone console passed; checksums/manifest retained |
| Strict checks | Typecheck, format and Clippy passed; npm audit high-severity gate passed (two low and four moderate development-tool advisories remain) |

The final default suite passed **147/147 behaviors, 190/190 scenarios and 895/895 steps**, with zero failures or skips. It retains all original 141 behaviors/183 variants and adds 6 behaviors/7 production access variants. The original inventory is protected by a checked hash guard.

Final evidence:

- `artifacts/production-only/acceptance.json`: consolidated results and external limits.
- `artifacts/production-only-bdd-acceptance/`: complete coverage, scenario results and JUnit files.
- `artifacts/production-only-bdd-dev-acceptance/`: actual Vite draft flow, 1 scenario/5 steps, including the browser-safe import boundary.
- `artifacts/production-only-native-zoom-acceptance/`: actual Chrome 200% zoom, 14 routes and 2 dialogs, zero browser errors.
- `artifacts/production-only/console-readonly-acceptance.log`: 15 layouts plus literal HTML, caching, pagination, refresh, revoked-session denial, redaction, 404 and unchanged business-state checks.
- `artifacts/production-only/console-protocol-final.json`: final built/Vite OIDC verification.
- `artifacts/production-only/{entrypoints-final.log,container-source-build.json,packages-final/manifest.json}`: actual prelisten/no-dotenv/public-host regressions, isolated exact Docker-source builds and relocated artifacts.

Earlier failed or partial browser reports are retained separately; none is substituted for the final comprehensive report. CI includes the production startup, protocol, fixture, import-closure and supplemental browser gates. CI configuration itself was not a hosted CI run.

## Limits and deployment inputs

These are isolated acceptance results, not a completed public rollout. Test certificates and identities are under test ownership; production code has no fixture provider or TLS bypass. The test browser's certificate exception is confined to its disposable context; Node verifies the fixture CA explicitly.

Real OIDC issuer/client settings, public console/API URLs, operator subjects and deployment secrets have not been supplied. Live-provider/public HTTPS qualification remains unrun. Docker was unavailable: manifest checks, standalone runtime execution and copied-source builds do not count as executed container qualification. No daemon was started, image or package published, public deployment performed or paid model called during this work. Prior Luna evidence belongs to earlier milestones.

The old local-operator process was stopped gracefully. Its PostgreSQL data and private files remain unchanged. To launch the authenticated app, complete the runtime settings in the [deployment guide](../../../deploy/README.md); do not restore the removed bypass.

## Keycloak follow-up

Keycloak is now the selected provider. The [setup](../../../deploy/keycloak/README.md) adds a pinned production image, optional co-hosted PostgreSQL deployment, private management boundary and a confidential realm/client template. Real Keycloak 26.8.2 login, PKCE/callback rejection, current memberships, PostgreSQL restart persistence and local logout passed with the existing console. The detailed record is `artifacts/keycloak/acceptance.json`; Docker execution and public deployment remain separate unrun gates. The earlier comprehensive behavior report above retains its original scope.

### Full regression after the Keycloak update

The expanded tests passed on 2026-11-14. The new record is `artifacts/keycloak/testing-refresh/summary.json`; older reports above remain unchanged.

| Gate | Result |
|---|---|
| Complete behavior inventory | 147 behaviors, 190 scenarios, 895 steps; zero failures or skips |
| Real Keycloak 26.8.2 | 12 groups each on built and Vite consoles; separate fresh PostgreSQL clusters |
| Generic OIDC failures | Built and Vite passed, including signature/issuer/nonce/state rejection |
| Deployment and identity fixtures | 19 tests passed |
| Rust / package / console / Python SDK | 55 / 100 / 129 / 12 tests passed |
| Built/Vite process entrypoints | 6 tests passed |
| Evaluator / operator / improvement / roadmap fixtures | 31 / 4 / 5 / 5 tests passed |
| Other checks | Type checks, builds, Rust formatting/Clippy, model-free service and roadmap flows, read-only browser, Vite draft flow, isolated package consumers and docs links passed |

Keycloak runs in its own CI job, separately from the fixture behavior suite. See the [testing guide](../../../features/README.md#keycloak-and-sign-in-coverage) for commands and coverage boundaries. These were local runs; hosted CI, Docker image execution and public deployment are still unverified. No models or existing user database/private configuration were used. The dependency audit has no high or critical findings; it still reports four moderate and two low findings.
