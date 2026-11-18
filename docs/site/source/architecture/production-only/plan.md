# Production-only application

**Reviewed implementation plan, 2026-11-14.** PostgreSQL already stores the real application data. There is no SQLite engine to migrate. This work removes the optional local-operator product path and makes the authenticated application the only path.

The product remains a Rust content service, a TanStack console and app-owned SDK execution. One Rust process and one console process are the supported deployment. No new execution platform, identity provider, enterprise IAM, HA, automatic publication or incidental public deployment.

## 1. One browser identity path

The console verifies standard OIDC authorization-code login with PKCE, state, nonce and exact issuer. Rust owns hashed expiring sessions, verified identity records, workspace membership, current authorization and audit attribution. The console's dedicated login authority is trusted to assert verified identities; document that trust rather than adding a second OIDC verifier in Rust.

Remove runtime local/hosted branches and both mode variables. Reject obsolete mode configuration with a migration error; do not silently reinterpret it. Missing configuration fails before either application process listens. Build steps need no runtime secrets.

- Rust requires distinct login-authority and console-transport credentials, a pinned HTTPS issuer and explicit operator identity pairs. Neither authority credential may appear among machine grants. Parse and validate configuration once where practical.
- Console requires its HTTPS public origin, OIDC issuer/client settings, separate login/transport credentials and an explicit Rust address. Cookies are always Secure/HttpOnly with appropriate SameSite and path settings. Preserve CSRF, exact callback origin, replay and expiry protections.
- Browser data calls always require a valid session plus the dedicated console transport. Machine grants alone never create a browser operator session. Reject mixed machine/session identity and caller-supplied trusted identity headers.
- Ordinary signed-in users see only their memberships. Operators may create a workspace, becoming its initial admin; operator capability does not grant access to every workspace. Viewer/editor/admin and last-admin protections remain.
- Signing in rotates the replaced session, including switching accounts. Logout clears the cookie after committed revocation or an explicit invalid-session result from the valid console transport. A generic upstream 401/404 does not prove revocation and must keep the cookie. Keep the explicit eight-hour lifetime; no refresh-token store or enterprise logout system.

Keep machine SDK authentication and bound content-read/receipt-write credentials. These are real background-app contracts, not local-operator mode. Avoid unnecessary SDK source breaks: the existing optional session transport field can remain compatible, but normal console calls must use a server-only helper that requires a session and the dedicated transport. Public/browser configuration never contains server secrets or an internal-only API address.

## 2. Preserve data and establish ownership deliberately

Initialize new installations with the [current PostgreSQL baseline](../../../migrations/0001_init.sql). It includes the adoption audit table. Databases created by earlier migration chains require the matching service build. See the [deployment guide](../../../deploy/README.md) for fresh installation and restore procedures.

Add one explicit operator action, proposed as `POST /v1/auth/workspace-adoptions` with `{projectId, reason}`. It requires the current signed-in allowlisted operator and dedicated console transport, verifies an existing project, serializes with membership writers and only adopts a project with no memberships. It gives the acting verified operator admin access and records who/when/why. Use one immutable audit row per project. A repeated adoption by its recorded operator returns that history without regranting a later-demoted/removed membership or changing the reason. Recheck the live session and exact operator pair in the transaction. Another operator or an already-owned project without that adoption record is refused. Place it outside membership-gated project routing so an orphan can actually be adopted. No arbitrary target identity or global admin shortcut.

Provide an operator UI for exact workspace ID and reason, with a clear review. This is a cutover/bootstrap action, not an invitation system. Old pending writes remain tied to their original principal and scope; never replay them under a new identity or rewrite receipt ownership. Document their inspection limits and preserve old metadata.

Keep the existing idempotent startup registration of project rows for explicitly configured machine-grant project IDs; it creates no memberships. This preserves first-bundle SDK flows and the existing foreign key contract. Remove request-time GET project backfill. New human workspace ownership is never inferred from grants.

## 3. Explicit production startup and operation

Normal startup consumes explicit environment/private configuration. Retire `npm run local`/`demo` provisioning, private console-demo state, OS-user database inference, automatic examples and the local Compose bridge as app entrypoints. A retained alias may only explain the replacement; it cannot launch a bypass. Existing private state files are not deleted or printed.

Provide a normal production service start and built console start, and a development command using the same required identity path. Separate syntax/config validation from build. The canonical single-host Compose recipe includes both application processes and their runtime images, persistent PostgreSQL, a TLS reverse proxy, secret references/placeholders, health checks and restart/grace policy. Existing API-only systemd artifacts are clearly labeled as partial alternatives; no second complete deployment platform is required. Never ship the example database password as production configuration. Docker is currently unavailable; code and manifest validation are separate from an executed container qualification.

Retain the existing startup migration under the singleton lock. Migration failure prevents listening. Deployment is coordinated stop, verified backup, start upgraded service, verify readiness, then route traffic; there is no rolling-update claim. Do not add a second migrate/serve/schema-checker subsystem or mutate the running workspace database incidentally during implementation.

Keep `/health` as process liveness; add bounded `/ready` for database usability, held singleton ownership, an initialized live worker task and non-draining state. It does not prove queue progress, provider availability or model quality. Console gets syntax/configuration and upstream readiness without contacting the identity provider on every probe. Its real built and Vite entrypoints validate required configuration before listening; build remains secret-free. Pin its canonical HTTPS origin, define Host/proxy reconstruction explicitly, and ignore spoofable forwarding headers. The proxy strips/replaces forwarding headers and direct untrusted console/backend access is blocked by deployment networking. Internal HTTP is allowed only on that documented private hop; public browser/API origins are HTTPS. On shutdown, withdraw readiness, stop accepting requests/claiming new work, drain within a documented bound and release the queue guard last. Preserve attempt-limited recovery, ownership-loss failure and single-process restrictions. Backup/restore remains PostgreSQL and must be rehearsed on disposable data.

## 4. Production UI and evaluator handoff

Account, workspace creation, Members and Connections use verified identity and current role only. Anonymous visitors see sign-in; a verified user with no workspace sees the appropriate creation/request-access path. Never fabricate an operator to keep a page usable. Preserve scoped URLs, explicit publication/release, unsaved edits and uncertain-write recovery.

App setup needs a separately configured public API URL for external SDK consumers; do not copy an internal container hostname into their recipe or expose transport credentials. Credential creation remains scoped and one-time secrets stay memory-only.

Evaluation requests are app-owned execution. Do not infer that a remote web deployment can run a checkout command just because its public descriptor matches an included adapter. Default to copyable request/configuration handoff. Keep included installed adapters runnable through explicit private app configuration, without reading `.local/console-demo` or machine-user database state. Test-only fixture configuration stays under test-owned directories. Preserve strict request/attempt binding, journal recovery, output/evidence inspection and deliberate release. No central worker/sandbox fleet is added.

## 5. Tests and cutover evidence

Keep all 141 existing behaviors / 183 variants and their outcome assertions; update setup and identity assumptions rather than dropping coverage. Machine SDK stories remain machine-authenticated; browser stories use the production identity path.

Build one test-owned HTTPS OIDC issuer and console TLS proxy, using the installed real OIDC client through discovery, authorization, code exchange, JWKS and ID-token verification. Keep its fake identities and keys strictly in test code. Use private test CA trust for Node verification and explicitly documented browser fixture trust; never add a runtime HTTP/fake-auth mode. A test issuer is protocol regression evidence, not qualification of the user's live provider.

Required checks: an isolated 0012→0013 upgrade preserves exact content/version/history/credential/membership identities while revoking old sessions once; startup project registration creates no human ownership; invalid/missing/legacy configuration fails startup; anonymous/expired/revoked sessions and mixed credentials fail; operator and workspace roles remain distinct; unowned adoption is explicit/audited/race-safe; actual login/callback/logout/session rotation work; SDK and scoped integration delivery still work; exact writes/evaluation/release/rollback retain their semantics; PostgreSQL readiness, single-owner startup and bounded shutdown work; both built processes run with production configuration. Preserve mobile/keyboard/dev/browser checks. No default paid model calls; any opted-in model use remains Luna only.

Use isolated PostgreSQL clusters and private fixture configurations, never the running workspace database or ambient credentials. Retain executed evidence separately from Docker/live-OIDC/HTTPS/publication gates that could not run. The implementation can be complete locally while real deployment still needs the user's issuer/client/origin and runtime secrets; never claim that external sign-in was verified from fixtures.

## Planning inputs

[Authentication](../../research/archive/production-planning/auth-input.md) · [Runtime](../../research/archive/production-planning/runtime-input.md) · [Console](../../research/archive/production-planning/console-input.md) · [Acceptance](../../research/archive/production-planning/acceptance-input.md) · [Compatibility](../../research/archive/production-planning/compatibility-input.md).

## Review decisions

The [review record](review.md) resolves objections from four fresh reviewers. This plan governs implementation over the earlier inputs. External issuer/client/origin configuration remains deployment input; no real provider or domain was supplied or invented during planning.
