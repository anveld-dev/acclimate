# Single-host production deployment

Service-specific vocabulary is defined in [Internal terms](../CONTEXT.md#internal-terms).

For a walkthrough from a fresh server to a delivered version, see [Self-host Acclimate](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/operate/self-host.mdx).

`compose.yaml` is the application stack for an existing Keycloak deployment: PostgreSQL 16 with a persistent volume, one Rust service, one built Node console and Caddy terminating public HTTPS. Only Caddy publishes host ports (80 and 443). The API, console and PostgreSQL are private Docker-network listeners. Keep the Docker bridge inaccessible to untrusted processes and firewall backend ports. The application containers require outbound access to the configured OIDC issuer and any explicitly configured model endpoint. Do not run multiple Rust processes against one database.

Supply real identity, domain and secret settings before startup. No command infers a PostgreSQL role from the OS account, creates machine/human credentials, adopts existing private state, seeds example content or provisions a database from a developer account.

## Configuration

Use **Keycloak** with the existing OIDC integration. The [Keycloak setup](keycloak/README.md) configures the chosen provider. Add `compose.keycloak.yaml` to co-host its pinned production server and separate PostgreSQL database, or connect an existing Keycloak realm using the base application stack. The public URL convention is `https://console.<your-domain>` for the console and `https://api.<your-domain>` for SDK access. Example hostnames and tenant names in templates are placeholders, not provisioned resources.

Choose two DNS hostnames pointing at the intended deployment and make ports 80/443 available to Caddy. Set `CONSOLE_HOST` and `API_HOST` to those hostnames (without schemes or paths), and `ACME_EMAIL` to the certificate contact address. Set the console's `CONSOLE_ORIGIN=https://<CONSOLE_HOST>` and `CONSOLE_PUBLIC_API_URL=https://<API_HOST>`. The public API URL belongs in external app/SDK configuration; `http://service:3000` is the private console-to-Rust hop only.

Create these private files outside the checkout, restricted to their deployment owner:

- `service.env`: completed `deploy/service.env.example`. Supply the PostgreSQL URL, exact HTTPS issuer, distinct login-authority and console-transport credentials, explicit operator issuer/subject pairs, and scoped machine grants if needed. `ACCLIMATE_AUTH=[]` is valid for browser-only operation. The authority credentials must never occur in the machine grants.
- `console.env`: completed `apps/console/.env.example`. The two authority credentials and issuer must match Rust. Supply the real OIDC client ID and secret. Set `CONSOLE_ALLOW_EDITS=true` to enable authoring and Connections mutations; each operation still requires its current workspace role. Register exactly `https://<CONSOLE_HOST>/auth/callback` with the provider for authorization code flow.
- `postgres-password`: the database password alone, supplied by the operator/secret manager. The initial PostgreSQL role password is read from this Compose secret. URL-encode the same password in `DATABASE_URL`; changing the file does not rotate a role in an existing PostgreSQL volume.

Set mode 0600 on runtime files and use a private parent directory. Compose reads `ACCLIMATE_SERVICE_ENV`, `ACCLIMATE_CONSOLE_ENV` and `ACCLIMATE_POSTGRES_PASSWORD_FILE` as absolute file paths. These variables have no insecure defaults. Runtime secrets are never build arguments. Avoid `docker compose config` output, environment dumps or inspect/log capture that could reveal credentials; use `config --quiet` for syntax validation. Defined `ACCLIMATE_MODE`/`CONSOLE_MODE` values are errors and must be removed.

After installing the lockfile dependencies, `npm run check:console-config` checks explicit console configuration without starting a process. Neither it nor a build contacts the identity provider. Required application configuration is checked again by the actual Vite and built server entrypoints before listening. Builds require no runtime secrets.

## CLIProxyAPI with Codex sign-in

Acclimate supports OpenAI-compatible Chat Completions endpoints for the optimizer. Follow the CLIProxyAPI setup guide and pin the proxy build. In the current v8 config, set `server.port` to `8317` (the default) and put a private client API key in `access.api-keys`. Bind the listener to an interface reachable by the service on a private network. Use loopback when both processes run directly on the same host. Inside Compose, use the proxy's reachable hostname since loopback refers to the service container. [CLIProxyAPI setup guide](https://help.router-for.me/) · [Example configuration](https://github.com/router-for-me/CLIProxyAPI/blob/f5c5681a8361c9da53e93c60b6507816eee7468b/config.example.yaml)

Run `cli-proxy-api -config /private/config.yaml -codex-login` to sign in with Codex, then start the proxy with `cli-proxy-api -config /private/config.yaml`. Check that the intended model ID is available to the signed-in account. [CLI flags](https://github.com/router-for-me/CLIProxyAPI/blob/f5c5681a8361c9da53e93c60b6507816eee7468b/cmd/server/main.go)

Set these values in the service environment.

| Setting | Value |
| --- | --- |
| `ACCLIMATE_MODEL_ENDPOINT` | Full URL, for example `http://127.0.0.1:8317/v1/chat/completions`. The service posts to the URL as written. |
| `ACCLIMATE_MODEL_TOKEN` | Required nonempty proxy client key from `access.api-keys`. The service sends it as a bearer token. |
| `ACCLIMATE_MODEL` | `gpt-6.2-astra` for the experiment, or the model ID served by your proxy. |
| `ACCLIMATE_MODEL_REASONING_EFFORT` | `high` for the experiment. |

The optimizer requests JSON mode and includes `max_completion_tokens` (default 32,768). The inspected CLIProxyAPI Codex translator maps `max_completion_tokens` to `max_output_tokens` and `reasoning_effort` to `reasoning.effort`. Its format switch has no `json_object` case, so JSON mode is unenforced on that route. The optimizer prompts for JSON and validates the returned content. The service retries HTTP 429 using its fixed 5- and 30-second backoffs. [Codex Chat Completions translator](https://github.com/router-for-me/CLIProxyAPI/blob/f5c5681a8361c9da53e93c60b6507816eee7468b/internal/translator/codex/openai/chat-completions/codex_openai_request.go)

## Build and start

Export the path/hostname variables above into the deployment shell, without putting secret values in command arguments. Validate and build first:

```sh
docker compose config --quiet
docker compose build service console
```

Startup below is an explicit deployment action; this repository does not execute it automatically:

```sh
docker compose up -d --wait
```

Caddy obtains and stores certificates in its persistent volume. It pins the upstream console `Host` to the configured public hostname, strips incoming forwarding headers and replaces them from the trusted connection. The console reconstructs public URLs from its pinned HTTPS origin, rejects a different Host, and ignores caller-supplied `Forwarded`/`X-Forwarded-*` headers. HTTP from Caddy to the two application listeners is allowed only on the private network. Direct access bypassing this proxy is unsupported. Caddy's administration listener stays container-local; its health check is process/configuration liveness, while its dependency checks require both applications ready.

See the [reverse proxy guide](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/operate/reverse-proxy.mdx) for the headers and limits an alternative proxy must preserve.

PostgreSQL, Rust, console and proxy use restart policies and 90-second stop grace. Rust drains within 35 seconds plus bounded lock release; its singleton guard is held until work stops. `/health` is process liveness. `/ready` checks database usability, singleton ownership, initialized/live worker and non-draining state within a bounded probe. It does not prove queue progress, model/provider availability or evaluation quality. Console `/ready` validates configuration and upstream readiness without a provider discovery call on each probe.

On first startup, the service applies its embedded schema baseline to an empty database under the singleton ownership lock. Subsequent starts verify the recorded migration. The service then registers the workspaces named in explicit machine grants. Registration creates no human memberships. Migration failure prevents listening. Human operators create workspaces through verified sign-in; existing memberless workspaces require explicit audited adoption by exact ID and reason. Operator capability alone does not grant existing workspace access.

## Upgrade to the learning-loop schema

Migrations `0017_remove_manual_changes.sql` and `0018_remove_connected_learning.sql` drop the manual change workflow and connected learning. They are destructive and irreversible. Migrations `0019` through `0021` install the self-improvement loop.

1. Take a full backup before starting the new build: `python3 scripts/operations/backup.py dump /private/backups/acclimate-pre-loop.dump --pg-bin /path/to/postgresql-16/bin`. The backup is the archive. To read old rounds, proposals or comparisons, restore it into a separate database and run the `pre-learning-loop` build against it.
2. After `0018`, a connection receives its own channel's version, not a learned version. Record the delivered version IDs before upgrading. After upgrading, you can release a retained version on the source channel with a reason, which updates all connections using that channel. [Upgrade and recover](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/operate/upgrades-and-recovery.mdx) has the query that lists affected connections.
3. No drain is needed. Queued rounds, proposals and evaluation requests are dropped. Stop app-side `acclimate-learning` evaluators: their `…/learning/work` requests return `404 not_found`.
4. `learn-<connectionId>` channels stay as ordinary channels with their release history.

## Upgrades and recovery

See [Upgrade and recover](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/operate/upgrades-and-recovery.mdx) for release pinning and the upgrade sequence.

This release starts from a fresh schema baseline. For an installation made with the former migration chain, keep the existing database and its matching service build together. To try this release alongside it, provision a separate empty PostgreSQL database and point the new service at it. The baseline has no in-place upgrade path for the former schema.

For deployments already on this baseline, stop traffic and both application containers before changing service versions. Take a backup and rehearse restoration on a separate database with the matching service build. Verify readiness and an authenticated read before routing traffic. Normal `docker compose down` preserves volumes. The `--volumes` option deletes them.

Supervisors restart failed processes with policy; investigate repeated failures. Exit code 75 identifies lost database ownership. The standalone service wrapper does not invent credentials or silently recover against another database. On SIGTERM readiness is withdrawn before HTTP/work draining and lock release. Backups include sensitive content and must be protected and restored on a schedule.

## Native and partial alternatives

For native execution, build `cargo build --locked --release` and `npm ci --ignore-scripts && npm run build`. Explicitly inject each process's runtime environment, then use `npm start` for Rust and `npm run start:console` for the built console. `ACCLIMATE_SERVICE_BINARY` may name an absolute installed service binary. `npm run dev` uses Vite with the same required production identity configuration. Console defaults to `HOST=127.0.0.1 PORT=3100`; bind a different address only behind the trusted proxy. No environment files are loaded implicitly by these commands.

`deploy/acclimate.service` is an **API-only partial alternative**, not a complete deployment. Install the release binary at `/usr/local/bin/acclimate-service`, create its dedicated user/group, and install a completed root-owned mode-0600 `/etc/acclimate/service.env`. Use loopback `ACCLIMATE_BIND=127.0.0.1:3000` and the actual separately provisioned PostgreSQL address instead of the Compose hostname. The authenticated console, PostgreSQL, TLS proxy, public DNS, backup and firewall remain separately required. Never enable the unit incidentally while editing or testing this repository.

## Qualification boundaries

Run `python3 scripts/productization/external.py --help` from the repository root to list the gates and their options. Each run with `--execute --gate` checks one gate. The optional `--output` flag writes the result to a new file. Choose a path in a private directory.

After starting your deployment, use the HTTPS gate to verify the API certificate and hostname, liveness, database and worker readiness, and an authenticated workspace read. Set `ACCLIMATE_CHECK_TOKEN` in your environment to a machine token with read access to the test workspace. Pass the variable name to the script.

```sh
python3 scripts/productization/external.py --execute --gate https \
  --url https://api.example.com --workspace test-workspace --token-env ACCLIMATE_CHECK_TOKEN
```

With Playwright and its Chromium browser installed, use the OIDC gate to check sign-in with your configured issuer, secure console session cookies and logout. Sign in with a disposable test account when the browser opens. The script discards the browser session after the check.

```sh
python3 scripts/productization/external.py --execute --gate oidc --interactive \
  --url https://console.example.com --issuer https://id.example.com/realms/acclimate
```

The `container` gate builds and checks the deployment images in a disposable Docker Compose project with a private volume, fixture issuer and test certificates. Use the `https` and `oidc` gates to verify your deployment's own endpoints. The `remote-model` gate checks a bounded Luna completion against your configured endpoint, and the `native-*` gates exercise prepared files and version pinning with an installed native provider SDK. Those gates require `--live` and can incur model charges.

## Private backup and restore

See [Back up and restore](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/operate/backup-and-restore.mdx) for the self-hosted backup workflow.

The scripts use Python 3 and `psql`, `pg_dump`, `pg_restore` from the same major version as the connected server. `--pg-bin` selects the tools explicitly. `DATABASE_URL` accepts PostgreSQL URLs and the `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, and `connect_timeout` query options. The URL is passed through libpq environment variables, not command arguments. Protect the environment from other users. The dump is a consistent PostgreSQL custom-format snapshot, created exclusively with mode 0600; keep its parent directory private. It contains sensitive content and history. Encrypt it at rest and in transit, set a retention policy, and securely manage keys and copies. The database roles and ACLs are not included; provision them separately.

```sh
# Point DATABASE_URL at the source database; choose a new path in a private directory.
python3 scripts/operations/backup.py dump /private/backups/acclimate.dump --pg-bin /path/to/postgresql-16/bin
# Create a new, empty database with the correct owner first. Point DATABASE_URL at it.
python3 scripts/operations/backup.py restore /private/backups/acclimate.dump --pg-bin /path/to/postgresql-16/bin
```

Restore refuses a target with existing relations. It uses `pg_restore --exit-on-error --single-transaction`, so SQL errors roll back the restore; a failed restore is not a usable recovery. Investigate the error and retry against a fresh empty database. Restore into an isolated database and verify payloads, channel revisions, decision history and application access before switching the stopped service to it. Never restore over a live database. Confirm the service's database URL and scoped grants before starting it, then run an authenticated read and monitor the process. The archive excludes cluster roles and cannot replace a separate disaster recovery plan for PostgreSQL itself.

For a repeatable local qualification, set `DATABASE_URL` to a disposable PostgreSQL server connection whose role may create and drop databases, then run:

```sh
python3 scripts/operations/qualify.py --pg-bin /path/to/postgresql-16/bin
```

It creates three randomly named databases, installs the schema and inserts fixture records, compares all restored table data including exact binary payloads and history, tests refusal of a populated target and transactional failure, and drops only the databases it created. It does not alter the database named by `DATABASE_URL`. A process kill or database outage can interrupt cleanup; remove only the randomly named `acclimate_ops_…` databases after identifying them. This synthetic qualification does not prove any particular production backup is restorable; perform and verify a restore of each operational backup on an appropriate schedule.
