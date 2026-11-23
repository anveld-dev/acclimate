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

## Service environment

Set `DATABASE_URL` explicitly. It has no default. The Rust service reads the settings below. Compose path variables and console settings are described above.

| Setting | Default or requirement |
| --- | --- |
| `ACCLIMATE_BIND` | `127.0.0.1:3000`. The Compose example sets `0.0.0.0:3000`. |
| `ACCLIMATE_AUTH` | Required JSON array of scoped machine grants. Use `[]` for no static grants. |
| `ACCLIMATE_OIDC_ISSUER` | Required HTTPS issuer. |
| `ACCLIMATE_LOGIN_TOKEN` | Required login-authority credential. |
| `ACCLIMATE_CONSOLE_TOKEN` | Required console transport credential, distinct from the login token. |
| `ACCLIMATE_OPERATORS` | Required JSON array of issuer/subject pairs. Use `[]` for no global operators. |
| `ACCLIMATE_MODEL_ENDPOINT` | Unset. Set a full OpenAI-compatible Chat Completions URL to enable the optimizer. Versioned delivery works without it. Enrolled loops need an optimizer to propose changes. |
| `ACCLIMATE_MODEL_TOKEN` | Required when the optimizer endpoint is set. |
| `ACCLIMATE_MODEL` | Required when the optimizer endpoint is set. Use a model ID the endpoint serves. |
| `ACCLIMATE_MODEL_REASONING_EFFORT` | Unset. Accepts `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. |
| `ACCLIMATE_MODEL_TIMEOUT_SECONDS` | 600 seconds per HTTP attempt. Accepts 30–3,600. |
| `ACCLIMATE_MODEL_MAX_COMPLETION_TOKENS` | 32,768. Accepts 1,024–262,144. |
| `ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS` | 604,800 seconds (7 days) to start a queued evaluation. |
| `ACCLIMATE_LEARNING_EVALUATION_SECONDS` | 86,400 seconds (24 hours) to finish a started evaluation. |
| `ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` | 3 consecutive failed rounds before an automatic pause. |
| `ACCLIMATE_SMTP_HOST` | Unset. This disables email delivery and requires leaving the other SMTP settings unset. |
| `ACCLIMATE_CONSOLE_ORIGIN` | Required with SMTP. Use the public HTTPS console origin. |
| `ACCLIMATE_SMTP_FROM` | Required with SMTP. Use a valid sender mailbox. |
| `ACCLIMATE_SMTP_TLS` | `starttls`. Also accepts `tls`. Use `none` only with loopback or `mailpit`. |
| `ACCLIMATE_SMTP_PORT` | 465 for `tls`, 587 otherwise. |
| `ACCLIMATE_SMTP_USERNAME` | Unset. Supply with a password over TLS to authenticate. |
| `ACCLIMATE_SMTP_PASSWORD` | Unset. Supply with a username over TLS to authenticate. |

Learning timeout and failure-count settings use their defaults for missing, zero or invalid values. Remove any obsolete settings listed in the [changelog](https://github.com/anveld-dev/acclimate/blob/main/CHANGELOG.md#removed) before startup.

## CLIProxyAPI with Codex sign-in

Acclimate supports OpenAI-compatible Chat Completions endpoints for the optimizer. Follow the CLIProxyAPI setup guide and pin the proxy build. At the linked v8 revision, set `server.port` to `8317` (the default) and put a private client API key in `access.api-keys`. Set `server.host` to an interface reachable by the service on a private network. Use loopback when both processes run directly on the same host. Inside Compose, use the proxy's reachable hostname since loopback refers to the service container. [CLIProxyAPI setup guide](https://help.router-for.me/) · [Example configuration](https://github.com/router-for-me/CLIProxyAPI/blob/f5c5681a8361c9da53e93c60b6507816eee7468b/config.example.yaml)

Run `cli-proxy-api -config /private/config.yaml -codex-login` to sign in with Codex, then start the proxy with `cli-proxy-api -config /private/config.yaml`. Check the served model IDs at `GET /v1/models` using the proxy client key. [CLI flags](https://github.com/router-for-me/CLIProxyAPI/blob/f5c5681a8361c9da53e93c60b6507816eee7468b/cmd/server/main.go)

Set these values in the service environment.

| Setting | Value |
| --- | --- |
| `ACCLIMATE_MODEL_ENDPOINT` | Full URL, for example `http://127.0.0.1:8317/v1/chat/completions`. The service posts to the URL as written. |
| `ACCLIMATE_MODEL_TOKEN` | Required nonempty proxy client key from `access.api-keys`. The service sends it as a bearer token. |
| `ACCLIMATE_MODEL` | `gpt-6.2-astra` for the experiment, or the model ID served by your proxy. |
| `ACCLIMATE_MODEL_REASONING_EFFORT` | `high` for the experiment. |

The optimizer requests JSON mode and includes `max_completion_tokens` (default 32,768). The inspected CLIProxyAPI Codex translator maps `max_completion_tokens` to `max_output_tokens` and `reasoning_effort` to `reasoning.effort`. Its format switch has no `json_object` case, so JSON mode is unenforced on that route. The optimizer prompts for JSON and validates the returned content. The service retries HTTP 429, HTTP 5xx, connection errors and timeouts with 5- and 30-second backoffs. [Codex Chat Completions translator](https://github.com/router-for-me/CLIProxyAPI/blob/f5c5681a8361c9da53e93c60b6507816eee7468b/internal/translator/codex/openai/chat-completions/codex_openai_request.go)

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

On startup, the service verifies previously applied migrations and applies pending migrations under the singleton ownership lock. A fresh database runs the full embedded migration chain. The service then registers the workspaces named in explicit machine grants. Registration creates no human memberships. Migration failure prevents listening. Human operators create workspaces through verified sign-in; existing memberless workspaces require explicit audited adoption by exact ID and reason. Operator capability alone does not grant existing workspace access.

## Upgrade to the learning-loop schema

Migrations `0017_remove_manual_changes.sql` and `0018_remove_connected_learning.sql` drop the manual change workflow and connected learning. They are destructive and irreversible. For a database through `0015`, startup first applies `0016_automatic_delivery.sql`. The new loop uses `0019_learning_loop.sql`, `0020_learning_optimizer.sql` and `0021_optimizer_effort.sql`.

1. Stop incoming traffic and connected-learning evaluators. Record the version IDs delivered by affected connections, then stop the old service and console. [Upgrade and recover](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/operate/upgrades-and-recovery.mdx) has the query for affected connections.
2. Back up the stopped installation's database with `python3 scripts/operations/backup.py dump /private/backups/acclimate-pre-loop.dump --pg-bin /path/to/postgresql-16/bin`. To read old rounds, proposals or comparisons later, restore the backup into a separate database and run the `pre-learning-loop` build against it.
3. Start the new build to apply the migrations. Queued connected-learning rounds, proposals and evaluation requests are dropped. Configure a bundle evaluator for the new learning API.
4. Connections resolve the version on their configured channel. Release a retained version on that channel with a reason if its connections should use that version. Existing `learn-<connectionId>` channels remain available as ordinary channels with their release history.

## Upgrades and recovery

See [Upgrade and recover](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/operate/upgrades-and-recovery.mdx) for release pinning and the upgrade sequence.

Stop traffic and both application containers before changing service versions. Rehearse the upgrade on a restored copy if it crosses the destructive migrations above. Take a backup and rehearse restoration on a separate database with the matching service build. Verify readiness and an authenticated read before routing traffic. Normal `docker compose down` preserves volumes. The `--volumes` option deletes them.

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

### Rollout executor

Compose builds the chat runner and the executor resolves its immutable image ID at startup.
Point `ACCLIMATE_EXECUTOR_TOKEN_FILE` to a file containing a provisioned executor credential and
set the service's `ACCLIMATE_PROVIDER_ENCRYPTION_KEY` to 64 hex characters.
Set `ACCLIMATE_PROVIDER_HTTP_HOSTS` on the service and executor to a comma-separated list of exact hostnames when a local proxy requires HTTP or loopback access. Supply the same value in the service environment file and the Compose environment for the executor. The default is empty.
The service listens at `ACCLIMATE_INTERNAL_BIND`. Compose binds port 3001 to the service address on the private executor network.
The executor reaches the workspace model endpoint over `executor-egress`.
Attach a containerized model proxy to that network when using its Compose hostname.
Configure the production Docker daemon's `runsc` runtime with
`--host-uds=open` in its `runtimeArgs` so the runner can connect to the
mounted gateway socket. Run `ACCLIMATE_SANDBOX_RUNTIME=runsc python3
executor/tests/sandbox.py -v` on the Linux host to verify isolation.
Local Compose uses plain Docker. Use a Docker engine supporting volume subpath mounts (26+).

The executor mounts the host Docker socket. This grants host administrator
authority to the executor image. Only the executor receives this mount.
Each runner receives its own read-only lease directory from the Linux volume.
