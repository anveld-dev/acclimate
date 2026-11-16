# Independent compatibility review

2026-11-14. Review only of `docs/architecture/production-only/plan.md` against checked-in SDK, CLI, authorization, workspace, evaluator and deployment code. No runtime/private-state access, tests, browser, model calls or application edits.

The production boundary is sound: remove the console's implicit machine identity while preserving intentional background application clients. Three decisions need to become concrete before implementation: grant-backed project registration, adoption retry semantics, and evaluator journal continuity.

## Grant-backed projects: retain startup registration

**Blocking ambiguity:** section 2 leaves the backfill decision open. `src/main.rs:66` calls `backfill_projects`; `src/workspaces.rs:30` inserts every configured machine grant's project, without memberships. `GET /v1/projects` repeats it at `:139`. Migration 0006 only discovers projects from bundles already stored when that migration runs, then adds the bundle→project foreign key. Removing both runtime calls means a newly configured machine grant can authenticate but cannot create its first bundle for its absent project. Adoption also cannot repair this because the proposed endpoint requires an existing project.

Choose the compatible small contract: retain idempotent startup registration of configured grant project rows under the existing startup ownership lock; remove request-time backfill so GET is read-only. Registration must never create a user, membership or adoption record. Existing names remain unchanged (`ON CONFLICT DO NOTHING`). Operators explicitly adopt an unowned project if browser access is needed. Requiring a separate project provisioning command would be a new machine setup contract and must be implemented/documented before deleting registration; a historical one-time migration alone is insufficient.

`projects()` currently labels machine discovery results `operator` (`src/workspaces.rs:158`). Retain that legacy machine DTO label if needed for SDK compatibility, but remove its meaning from browser roles. A machine discovery result cannot confer deployment-operator entitlement.

## Keep the SDK and service CLI contracts

`ClientOptions.sessionToken` is already an optional trusted-server transport field (`packages/sdk/src/client.ts:61`); the client conditionally sends it at `:170`. Keeping it costs no security boundary: Rust decides whether the bearer/session combination is valid. Removing the field forces a source break without fixing any runtime flaw. Make every console server client use one helper requiring both the dedicated transport and session; make Rust reject machine bearer plus session. Token-only clients must continue using explicit project rights without a human login.

`tools/operator/cli.ts` is a machine API client for proposal/review/history/promote/rollback, not browser bootstrap. Preserve it or rename it with a compatible alias. `src/integrations.rs:54` deliberately allows machine integration administration with write plus promote, alongside human admin membership. Scoped `aci_` content/receipt credentials are separate. Removing local console mode is not authorization to delete either background contract.

## Adoption must be immutable and cannot resurrect access

The route outside `/v1/projects/{id}` is necessary: `session_context` rejects membershipless project paths before their handlers (`src/auth.rs:313`). Use the existing exact `membership:{project}` advisory lock acquired before membership/session locks (`src/workspaces.rs:394`), and recheck current session plus exact allowlisted issuer/subject in the adoption transaction. No generic permission framework is needed.

The proposed same-operator no-op needs a precise order. After authenticating the current operator and locking the existing project/membership namespace, inspect an immutable unique-per-project adoption record. Its recorded operator can receive the original adoption result; another operator conflicts. An existing record never changes reason/time/audit and never inserts or upgrades membership again. Only an absent record plus **zero memberships** may atomically insert the first admin and audit. Otherwise a retry after that operator was removed/demoted could regain access, or a changed reason could rewrite attribution. Viewer-only projects are already owned for this purpose; this flow is not recovery of an adminless project. The response must distinguish historical adoption from current membership.

## Preserve principal and evaluator recovery identities

The plan correctly forbids principal rewriting, but cutover must state the operational consequence. `src/commands.rs:157`, `:342` scopes replay/lookup/close by principal, project, namespace and key. A legacy console machine write cannot be found or closed by its new `user:<uuid>` principal. Before retiring old console access, stop submissions and reconcile/close using the original legitimate machine principal and exact operation metadata. Keep unresolved records attributable; absence observed under a new principal says nothing about the old write. Browser actor storage also hashes service URL plus session secret (`selection.ts:105`), so cutover/login invalidates convenience scopes. Do not auto-replay old envelopes. No cross-principal recovery endpoint is required.

Evaluator continuity has a second identity boundary: the journal hashes service URL, project, bundle, request and evaluator principal (`examples/evaluation/journal.ts:47`), while service start/finish bind evaluator principal and attempt (`src/evaluations.rs:298`, `:325`). Replacing `.local/console-demo` access with a private config file must preserve endpoint spelling, principal and original journal root for unfinished attempts, or require explicit finish/interruption before changing them. A new default journal root can strand an active attempt even when PostgreSQL data is preserved. Interruption does not cancel already running app callbacks.

Keep included adapters runnable through explicit app configuration: service URL, project, evaluator principal/token and journal root, with no fallback to launcher state. `localEvaluatorCommand()` currently emits a command solely from descriptor equality (`apps/console/src/lib/evaluation-config.ts:48`); this proves no runner is configured. Default to public request/config handoff or clearly incomplete setup examples. The helper remains a checkout example unless its adapters, journal/private I/O and Python ownership dependency are deliberately packaged. Preserve the journal's no-reexecution marker and installed adapter allowlist.

## Deployment and preservation evidence

Section 4's separate SDK public API URL is necessary: console server calls use `CONSOLE_SERVICE_URL`, which may become an internal container address. External recipes need an explicit public URL and scoped app credentials; neither console transport nor evaluator secrets belong in rendered configuration. Existing `deploy/Dockerfile`, service unit and Compose overlay package only Rust, so production packaging must add the built console and both private configuration sets as promised.

Keep append-only migrations and original PostgreSQL database/volume or verified restore. Startup project registration plus immutable adoption can coexist with existing content IDs, machine grants, integration hashes, operation ownership and evaluator attempt ownership. Compatibility acceptance should explicitly exercise a newly configured machine project, first bundle creation, read-only GET, absence of inferred membership, explicit adoption, and same-adopter retry after membership change. These are requested future evidence, not checks run by this review.
