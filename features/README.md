# Behavior tests

These are executable Given / When / Then stories for the shipped product. Start with [setup](setup.feature), [releases](releases.feature) and [SDK delivery](sdk_delivery.feature).

Each scenario gets a fresh workspace. The suite starts its own PostgreSQL cluster and real Rust service, then deletes them on exit. It never uses your running app's database or reads dotenv files.

```sh
# Once: Node 22.22+, Rust, Python 3.11+ and PostgreSQL server binaries are required.
npm ci --ignore-scripts
python3 -m venv .venv-bdd
.venv-bdd/bin/pip install -r scripts/bdd/requirements.txt
.venv-bdd/bin/python -m playwright install chromium

# Builds the service, packages and console, then runs every behavior.
npm run test:bdd
```

If PostgreSQL isn't found, pass `-- --pg-bin /path/to/postgresql/bin`. On Apple Silicon Homebrew, this is often `/opt/homebrew/opt/postgresql@17/bin`. Run as a regular user: PostgreSQL refuses to initialize a cluster as root.

For a smaller development loop:

```sh
npm run test:bdd -- --lane browser
npm run test:bdd -- --lane runtime
npm run test:bdd -- --tags '@setup or @releases'
npm run test:bdd -- --name 'Reopen the exact saved generation'
npm run test:bdd -- --dev-console --tags @UI-CONTENT-01
```

`--skip-build` uses existing builds. Leave it off when checking a code change. Partial runs report the behaviors they didn't exercise; they don't count as complete coverage.

All pushes to `main` run the full workflow. On pull requests, changes limited to the static documentation and its exports run the docs rebuild, link checks and PR quality gate. Public docs content also runs the unit and SDK reference checks. Changes to feature specifications or the reviewed inventory run all behavior shards. These selections combine when a PR touches multiple areas. Runtime, dependency, workflow and unrecognized paths run the full suite.

When behaviors are selected, CI builds the service, packages and console once, then runs three shards on separate runners. The shards divide the sorted behavior IDs and keep each scenario's examples together. The `behaviors` job combines their results and requires every reviewed variant to pass. The `behavior-results` artifact contains the combined report and the shard artifacts contain JUnit files and browser failure captures.

For local parallel runs, `npm run test:bdd -- --parallel` runs `console.feature` alongside the remaining features. Each process starts its own service and PostgreSQL cluster. The runner combines their results in `artifacts/bdd/` and checks the same inventory as the serial run.

`--dev-console` runs the real Vite server and checks UI module imports before the story. This catches Node-only imports that production bundling can hide. CI runs a focused browser flow in development mode too. Its reports use `artifacts/bdd-dev/` so a focused dev run preserves the full suite's report.

| Stories | What actually runs |
|---|---|
| [Setup](setup.feature) | Initial publication, workspace scope, invalid input and restart persistence |
| [Releases](releases.feature) | Release reasons, authorization, history and rollback |
| [Access](access.feature) | Real Rust sessions, workspace roles, membership changes and sign-out; fixture login authority |
| [Integrations](integrations.feature) | Scoped credentials, revocation, truthful receipts and retry identity |
| [TypeScript SDK](sdk_delivery.feature), [Python SDK](python_sdk.feature) | Public clients, real delivery/cache/files, explicit offline policy and reporting; native plugin preparation |
| [Console](console.feature), [personal access UI](console_access.feature) | Chromium against the built TanStack console, real service and database; desktop/mobile navigation, import, published content, release and access actions |
| [Combined native walkthrough](native_walk.feature) | Browser import, native version compatibility, installed SDK and plugin delivery, scoped receipts and rollback |
| [Navigation](navigation.feature) | Canonical scope, cross-tab form targets, published content history, role changes, legacy recovery and unsaved-work guards |
| [Local recovery](local_recovery.feature) | Real backend/console processes and private PostgreSQL: stalled/dropped ownership connection, exact release after restart, same console process and clean shutdown; real OIDC browser authentication through the private TLS proxy |
| [Identity boundary](identity.feature) | Public callback handler against real Rust sessions; fixture external identity provider, transaction binding, expiry, logout and cookie flags |
| [UX refinements](ux_refinement.feature) | Missing published entries and initial folder import |

The reviewed [inventory](../scripts/bdd/inventory.json) records 98 behaviors and 123 scenario variants. Every expected variant must run and pass. A missing, skipped, undefined or failing variant leaves that behavior uncovered. The coverage checker has its own regression tests.

After a run, open `artifacts/bdd/coverage.md`. Machine results are in `coverage.json`, `results.json` and `junit/`. Browser failures save screenshots and Playwright traces in `failures/`; these contain disposable fixture data and should still be treated as private. To inspect a trace: `.venv-bdd/bin/playwright show-trace artifacts/bdd/failures/<name>.zip`.

When adding a user action, add its scenario and a stable ID, then deliberately update the inventory's name, source, lane and expected case count. Don't regenerate the inventory as part of a test run: that could silently accept deleted coverage.

Browser stories use the actual installed OIDC client through discovery, authorization, code exchange, JWKS verification and Secure session cookies. The Node process trusts only the private fixture CA for this test; disposable Chromium contexts explicitly accept that test certificate. Production processes have no fake identity or HTTP issuer mode. The identity boundary lane additionally keeps direct provider injection to isolate callback transaction failures.

Passing this suite establishes the listed behavior for private fixtures. It doesn't establish model quality, live OIDC/JWT interoperability, HTTPS deployment behavior, hostile-tenant isolation, or live native agent sessions. Native plugin scenarios check preparation without launching an agent. No paid model calls occur.

## Keycloak and sign-in coverage

Keep the fixture suite and real Keycloak checks. Fixtures let us test invalid signatures, issuer/nonce/state mismatches and expired transactions without changing a real identity server. The Keycloak gate checks the actual selected provider through the installed OIDC client.

| Gate | Coverage | Command |
|---|---|---|
| Deployment and fixture contracts | Private ports, required configuration, PostgreSQL separation, confidential client, readiness failures and proxy-header handling | `npm run test:identity:contracts` |
| Full product behaviors | Every inventory scenario, including version delivery, roles and identity boundaries | `npm run test:bdd` |
| OIDC failure cases | Built and Vite consoles, signed tokens, state/nonce/issuer/signature failures, callback replay, rotation, logout and canonical Host | `npm run test:identity:protocol -- --pg-bin /path/to/postgresql/bin --report artifacts/identity/protocol.json` |
| Real Keycloak | Built and Vite consoles, rejected password, PKCE, callback and grant policies, rotation, memberships/removal, PostgreSQL restart, logout and SSO sign-in afterward | `npm run test:identity:keycloak -- …` (setup below) |

For the Keycloak gate, use Python 3.12+ and Java 21, then fetch the pinned official distribution into a **new** directory. Build first so the production-console half uses current code:

```sh
npm run build
cargo build --locked
python3 scripts/testing/fetch_keycloak.py --output artifacts/test-tools/keycloak
npm run test:identity:keycloak -- --keycloak-home artifacts/test-tools/keycloak/keycloak-26.8.2 --java-home /absolute/java21/home --pg-bin /path/to/postgresql/bin --report artifacts/keycloak/provider-check.json
```

The default checks **both** runtimes, with a fresh PostgreSQL cluster and copied Keycloak installation for each. Use `--runtime built` or `--runtime vite` for a focused run; the report records which ran. Use a new report path each time. The provider gate is separate from the behavior inventory, so fixture coverage cannot stand in for real Keycloak coverage.

CI runs all four gates and gives Keycloak its own job. The provider check verifies the public realm template and actual PostgreSQL identity rows; it doesn't run the Docker image, Caddy or your public DNS/TLS setup. Those remain deployment checks in the [Keycloak guide](../deploy/keycloak/README.md#qualification-and-operations).

The stories use [Behave](https://behave.readthedocs.io/en/stable/tutorial/). Steps call public HTTP, package and browser interfaces; direct SQL arranges bounded receipt/session/ownership faults and inspects fixture membership counts. No statement touches an ambient database.

The supplemental `scripts/test_console_browser.py` command preserves the former
read-only browser probe through the production identity path: literal script text
without execution, no-store responses, filtering, 22-release cursor pagination,
refresh, revoked-session denial, secret redaction, 404 and unchanged stored business
state. Its former unconfigured-render expectation is replaced by the entrypoint
fail-before-listen tests; there is no unconfigured application entrypoint.

### Email invitations

Members now invites by email and role. `UI-ACCESS-02` checks that sending an invite
alone grants no access; the verified recipient must accept. `NAV-12` checks that
losing admin access closes an in-progress invitation form. These fixtures start a
private Mailpit inbox and preserve the reviewed story IDs.

`scripts/testing/email_invitations.py` checks real SMTP delivery, matching verified
email, expiry, revocation, existing-role preservation and interrupted delivery.
The real Keycloak gate's `--email` option covers registration → inbox verification
→ password setup → invitation acceptance on each selected console runtime.
See [local email setup](../deploy/mailpit.md).

The email provider gate also checks HTML and text parts for invitation, verification
and password reset, plus 600px/320px email layouts. Its Members checks leave the
Invite button focused, preserve an in-progress invite form, and watch delivery and
acceptance update without navigation. `scripts/testing/member_live_updates.py`
covers multiple loaded pages, scrolled focus, outage recovery and role revocation.
CI runs both checks.
