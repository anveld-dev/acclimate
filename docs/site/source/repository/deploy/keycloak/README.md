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

The public [realm template](acclimate-realm.json) uses environment placeholders for the redirect origin and client secret. It enables authorization code flow, requires S256 PKCE and uses RS256 ID tokens. Password grants, implicit grants, service accounts and public signup are disabled. No users or real credentials are included.

Keycloak expands those placeholders on first import. Startup skips a realm that already exists; changing the file or an environment variable does **not** rotate an existing client secret or overwrite a realm. Use the admin API/CLI for deliberate updates. See the official [import behavior](https://www.keycloak.org/server/importExport).

## Private configuration

Complete the base application settings in the [deployment guide](../README.md). Add:

- `KEYCLOAK_HOST=auth.example.com`, and DNS for that host pointing at Caddy.
- `ACCLIMATE_KEYCLOAK_ENV`: absolute path to a private file completed from `deploy/keycloak/keycloak.env.example`.
- `ACCLIMATE_KEYCLOAK_POSTGRES_PASSWORD_FILE`: absolute path to a private file containing the Keycloak database password. It must match `KC_DB_PASSWORD` in the runtime file.

Use owner-only files and a private parent. Supply a strong bootstrap admin password and a separate client secret. `ACCLIMATE_OIDC_CLIENT_SECRET` in Keycloak's file must equal `CONSOLE_OIDC_CLIENT_SECRET` in the console file. The Rust login-authority and console-transport secrets remain separate.

Set both application issuer fields to the exact realm issuer above. There is no trailing slash in this template. Client ID is `acclimate-console`. The three public hostnames must be distinct. Do not use a container's HTTP address as the issuer.

## Start the identity service first

After explicitly injecting the paths and hostnames:

```sh
export COMPOSE_FILE=compose.yaml:compose.keycloak.yaml
docker compose config --quiet
docker compose up -d --build --wait keycloak-db keycloak
```

This starts only the new identity database and Keycloak. It neither starts nor migrates the existing application database. The optimized image enables readiness and database health checks. Management port 9000, HTTP port 8080 and both PostgreSQL listeners have no published host ports. Only Caddy later publishes 80/443. A private-network HTTP hop is used behind edge TLS; restrict access to the Docker bridge and deployment host.

## Create the first person

The bootstrap identity administrator and the Acclimate deployment operator are separate accounts/capabilities. Use Keycloak's admin CLI inside the private container. Authenticate interactively; the password is not a command argument:

```sh
docker compose exec keycloak /bin/bash -c 'umask 077; exec /opt/keycloak/bin/kcadm.sh config credentials --config /tmp/acclimate-admin.config --server http://127.0.0.1:8080 --realm master --user bootstrap-admin'
```

Create an owner-only `/private/initial-user.json` using a secret manager or private editor. Its shape is:

```json
{
  "username": "your-login",
  "enabled": true,
  "firstName": "Your",
  "lastName": "Name",
  "email": "you@example.com",
  "credentials": [{"type": "password", "value": "REPLACE_PRIVATELY", "temporary": true}]
}
```

Pass that file on stdin, then remove the temporary CLI session configuration:

```sh
docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh create users --config /tmp/acclimate-admin.config -r acclimate -f - < /private/initial-user.json
docker compose exec keycloak rm -f /tmp/acclimate-admin.config
```

The returned Keycloak user UUID is the OIDC `sub`. Put that exact UUID into `ACCLIMATE_OPERATORS` with the realm issuer. It is not Acclimate's separate Account user ID. Complete private files before starting the application:

```sh
docker compose up -d --build --wait
```

The first browser login requires changing the temporary password. Configure a permanent identity administrator and retire the temporary bootstrap account using Keycloak's documented administration tools. Public `/admin`, the master realm and management endpoints are blocked by the supplied Caddy configuration; administration stays private.

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

Fetch verifies the official release asset's SHA256 and refuses an existing output directory. The check covers wrong-password rejection, browser code/PKCE login, callback replay, disabled grants, session rotation, membership removal, PostgreSQL persistence across restart and application logout followed by Keycloak SSO sign-in. Its disposable CA is trusted by Node; only the disposable browser context has a TLS exception. It does not qualify a Docker image or public TLS deployment. `--runtime built` or `--runtime vite` selects a focused run; omit it for full coverage. Reports must use a new path.

The [testing guide](../../features/README.md#keycloak-and-sign-in-coverage) separates provider interoperability from generic failure tests and the full product behavior suite. CI runs the Keycloak provider matrix in its own job so a failure in the main behavior suite cannot prevent it from starting.

Back up and restore Keycloak's PostgreSQL volume separately from Acclimate. Its realm import file is provisioning, not a full backup. Never delete either volume to apply configuration or reset a login. Verify public HTTPS and the real realm through the [external gates](../README.md#what-has-been-tested) before routing users.

## Verification record — 2026-11-14

The real Keycloak 26.8.2 distribution passed against disposable PostgreSQL 18 and the built console using Java 21. Its binary version and official release SHA256 were verified. Actual identity rows were checked in PostgreSQL. The tests passed first-time environment substitution, PKCE/callback rejection, operator/viewer membership, restart without overwriting an existing realm/client, and app-session logout. Both built and Vite generic OIDC regression gates also passed.

Six Keycloak deployment/probe contracts, six existing deployment contracts and four shared fixture tests passed. CI includes the native provider check. Retained evidence is `artifacts/keycloak/acceptance.json`, `acceptance-protocol.json` and `contracts.log`; the official archive digest is in `artifacts/keycloak-tools/verified-release.json`.

Docker image execution and public DNS/TLS deployment remain unrun. No models were called or existing application database/private settings used. These local checks do not substitute for your deployment’s live qualification.

### Expanded regression coverage

The follow-up adds 12 real-provider check groups on **each** console runtime, built and Vite. Both pass with fresh PostgreSQL-backed Keycloak instances. The deployment/fixture gate now has 19 passing tests, including missing identity configuration, spoofed forwarding headers and an old-Python fetch guard. Reports are in `artifacts/keycloak/testing-refresh/provider.json`, `oidc.json` and `contracts-final.log`. Earlier reports above keep their original scope. See the [testing guide](../../features/README.md#keycloak-and-sign-in-coverage) for the full product regression gates.
