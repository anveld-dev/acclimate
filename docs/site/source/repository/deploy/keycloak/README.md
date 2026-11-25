# Keycloak setup

Keycloak is the chosen sign-in provider. The Rust API, PostgreSQL memberships and machine SDK credentials keep their existing roles. We use the standard OIDC client already in the console, without a vendor SDK.

The image follows Keycloak’s [container build](https://www.keycloak.org/server/containers), [hostname](https://www.keycloak.org/server/hostname) and [health](https://www.keycloak.org/observability/health) configuration.

The co-hosted option pins **Keycloak 26.8.2**, runs its production command with PostgreSQL, and adds an identity hostname behind Caddy. Keycloak gets a separate PostgreSQL instance/volume and credential; its lifecycle cannot overwrite Acclimate's database. The base application stack also supports an existing external Keycloak deployment.

This recipe runs one Keycloak instance with local cache mode; it does not promise identity-server high availability. Internal clients resolve the public identity hostname directly to the private TLS proxy, preserving the public issuer and certificate without depending on public-IP loopback routing.

## Sign-in theme

The image builds our [Keycloakify app](../../apps/keycloak-theme/package.json) and installs `acclimate-keycloak-theme.jar` before Keycloak's optimized build. The realm selects `acclimate` for both login and email. Its colors and fonts match the console; upstream Keycloakify pages still handle passwords, MFA, passkeys and recovery.

For an existing external Keycloak server, run `npm ci --ignore-scripts` and `npm run build:theme` with Java 17+ and Apache Maven available. Copy `apps/keycloak-theme/dist_keycloak/acclimate-keycloak-theme.jar` into Keycloak's `providers/`, rebuild and restart Keycloak, then choose **acclimate** under Realm settings → Themes → Login theme and Email theme. Updating an already-imported realm JSON does not change its stored settings.

Sign-in requests the standard `profile` and `email` scopes so member lists can show names and invitations can check verified email. Display names are optional and never grant access; authorization continues to use the exact issuer and subject. Existing accounts get their current name on their next sign-in. Workspace administrators invite people by email and role. The recipient signs in with that verified email and explicitly accepts; issuer and subject remain the account identity. Configure application SMTP and Keycloak email separately. For development, see [Mailpit](../mailpit.md).

## Addresses and client

Replace `example.com` with your owned domain:

| Setting | Value |
| --- | --- |
| Console | `https://console.example.com` |
| API | `https://api.example.com` |
| Identity | `https://auth.example.com` |
| Realm | `acclimate` |
| Exact issuer | `https://auth.example.com/realms/acclimate` |
| Confidential OIDC client | `acclimate-console` |
| Exact redirect | `https://console.example.com/auth/callback` |

The public [realm template](acclimate-realm.json) uses environment placeholders for the redirect origin and client secret. It enables authorization code flow, requires S256 PKCE and uses RS256 ID tokens. Password grants, implicit grants, service accounts and public signup are disabled. It includes no users or real credentials.

[`acclimate-users-0.json`](acclimate-users-0.json) adds the first person from placeholders: the UUID that `ACCLIMATE_OPERATORS` names, their email as user name, a verified email, a temporary password with `UPDATE_PASSWORD`, and the `realm-management` role `realm-admin`, so they administer this realm without a master-realm account. Only `compose.keycloak.yaml` mounts it. The local stack creates its own user.

Keycloak expands those placeholders on first import. Startup skips a realm that already exists; changing the file or an environment variable does **not** rotate an existing client secret or overwrite a realm. Use the admin API/CLI for deliberate updates. See the official [import behavior](https://www.keycloak.org/server/importExport).

## Private configuration

`deploy/init.sh` writes `keycloak.env`, `keycloak-postgres-password` and `KEYCLOAK_HOST` with the rest of the deployment, as in [Self-host Acclimate](../../apps/docs/content/docs/operate/self-host.mdx). `keycloak.env.example` lists its variables. `ACCLIMATE_OIDC_CLIENT_SECRET` must equal `CONSOLE_OIDC_CLIENT_SECRET` in the console file, and `KC_DB_PASSWORD` the database password file. There is no `KC_BOOTSTRAP_ADMIN_*`, so Keycloak creates no master-realm administrator.

Set both application issuer fields to the exact realm issuer above. There is no trailing slash in this template. Client ID is `acclimate-console`. The three public hostnames must be distinct. Do not use a container's HTTP address as the issuer.

Management port 9000 and both PostgreSQL listeners have no host ports. Caddy publishes 80/443, and Compose publishes Keycloak's HTTP port on `127.0.0.1:${KEYCLOAK_ADMIN_PORT:-8180}` for the admin console, with `KC_HOSTNAME_ADMIN` set to that address. The console signs in through the public `/realms/acclimate` routes and calls the admin API on the loopback port, so public `/admin`, the master realm and the management endpoints stay blocked by the supplied Caddy configuration. The master realm's admin console cannot sign in through Caddy for the same reason.

## The first person

The first browser sign-in asks for a new password and the name that Keycloak's user profile requires. The person then manages people at `http://127.0.0.1:8180/admin/acclimate/console/` through an SSH tunnel, as in [Manage people](../../apps/docs/content/docs/operate/self-host.mdx#manage-people). Break-glass recovery uses Keycloak's own `bootstrap-admin` command for a temporary master-realm administrator and `kcadm.sh set-password` inside the container, because that administrator cannot use the admin console.

Initial accounts are admin-provisioned. Email verification and forgotten-password flows are off until real SMTP is configured; enable them deliberately in Keycloak before offering those flows. Passkey/MFA policies can be configured there without moving workspace roles out of Rust.

## Existing identity service

For externally hosted Keycloak, use only `compose.yaml`; register an equivalent confidential client in its realm and copy the exact issuer and secret into the application settings. The co-hosted overlay is optional, not a second login implementation.

Changing issuers does not merge existing users. Preserve business data and plan any account linking/migration explicitly. Application sign-out revokes the Rust session and opens the credential form with `prompt=login`. Keycloak SSO remains available to other applications. Provider account disablement does not automatically revoke an already issued application session.

## Qualification and operations

Manifest/realm/probe checks:

```sh
npm run test:identity:contracts
```

The real-server check uses Python 3.12+, a copied official distribution, Java 21, the production realm template and disposable PostgreSQL. It runs both the built and Vite consoles by default, each with fresh data. It calls no models and never uses a user database:

```sh
python3 scripts/testing/fetch_keycloak.py --output /private/test-tools
npm run build
cargo build --locked
npm run test:identity:keycloak -- --keycloak-home /private/test-tools/keycloak-26.8.2 --java-home /absolute/java21/home --pg-bin /path/to/postgresql/bin --report /private/keycloak-evidence.json
```

Fetch verifies the official release asset's SHA256 and refuses an existing output directory. It imports the unmodified first-person template without a bootstrap administrator. The first person signs in by email, changes the temporary password and lists users in the realm admin console on the private listener. The check also covers wrong-password rejection, browser code/PKCE login, callback replay, disabled grants, session rotation, membership removal, PostgreSQL persistence across restart and application logout followed by Keycloak SSO sign-in. Its disposable CA is trusted by Node; only the disposable browser context has a TLS exception. It does not qualify a Docker image or public TLS deployment. `--runtime built` or `--runtime vite` selects a focused run; omit it for full coverage. Reports must use a new path.

The [testing guide](../../features/README.md#keycloak-and-sign-in-coverage) separates provider interoperability from generic failure tests and the full product behavior suite. CI runs the Keycloak provider matrix in its own job so a failure in the main behavior suite cannot prevent it from starting.

Back up and restore Keycloak's PostgreSQL volume separately from Acclimate. Its realm import file is provisioning, not a full backup. Never delete either volume to apply configuration or reset a login. Verify public HTTPS and the real realm through the [external gates](../README.md#what-has-been-tested) before routing users.

## Verification record — 2026-11-14

The real Keycloak 26.8.2 distribution passed against disposable PostgreSQL 18 and the built console using Java 21. Its binary version and official release SHA256 were verified. Actual identity rows were checked in PostgreSQL. The tests passed first-time environment substitution, PKCE/callback rejection, operator/viewer membership, restart without overwriting an existing realm/client, and app-session logout. Both built and Vite generic OIDC regression gates also passed.

Six Keycloak deployment/probe contracts, six existing deployment contracts and four shared fixture tests passed. CI includes the native provider check. Retained evidence is `artifacts/keycloak/acceptance.json`, `acceptance-protocol.json` and `contracts.log`; the official archive digest is in `artifacts/keycloak-tools/verified-release.json`.

Docker image execution and public DNS/TLS deployment remain unrun. No models were called or existing application database/private settings used. These local checks do not substitute for your deployment’s live qualification.

### Expanded regression coverage

The follow-up adds 12 real-provider check groups on **each** console runtime, built and Vite. Both pass with fresh PostgreSQL-backed Keycloak instances. The deployment/fixture gate now has 19 passing tests, including missing identity configuration, spoofed forwarding headers and an old-Python fetch guard. Reports are in `artifacts/keycloak/testing-refresh/provider.json`, `oidc.json` and `contracts-final.log`. Earlier reports above keep their original scope. See the [testing guide](../../features/README.md#keycloak-and-sign-in-coverage) for the full product regression gates.
