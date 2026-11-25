# Single-host production deployment

This directory holds the files for the single-host Docker Compose deployment. The operator procedures live in the documentation pages listed below. This README keeps what is specific to the repository: how the stack is built, notes for upgrading old databases, the native alternatives and the verification scripts.

Service-specific vocabulary is defined in [Internal terms](../CONTEXT.md#internal-terms).

## Operator documentation

| To do this | Read |
| --- | --- |
| Bring up a deployment, with the co-hosted Keycloak or an existing one | [Self-host Acclimate](../apps/docs/content/docs/operate/self-host.mdx) |
| Set the optimizer, register gVisor, start, check, upgrade and rotate the executor | [Enable learning](../apps/docs/content/docs/operate/enable-learning.mdx) |
| Replace the bundled Caddy | [Use your own reverse proxy](../apps/docs/content/docs/operate/reverse-proxy.mdx) |
| Probe the stack, read exit codes and run the live checks | [Check health and readiness](../apps/docs/content/docs/operate/health-and-readiness.mdx) |
| Back up, restore and keep the provider encryption key | [Back up and restore](../apps/docs/content/docs/operate/backup-and-restore.mdx) |
| Upgrade to a new Acclimate release or roll back | [Upgrade and recover](../apps/docs/content/docs/operate/upgrades-and-recovery.mdx) |
| Find the cause of a symptom | [Troubleshooting](../apps/docs/content/docs/operate/troubleshooting.mdx) |
| Look up an environment variable, the provider address rules or a service command | [Environment variables](../apps/docs/content/docs/reference/configuration.mdx) |
| Change the Keycloak realm, theme or email | [Keycloak setup](keycloak/README.md) |

## Files in this directory

| File | Purpose |
| --- | --- |
| `Dockerfile`, `console.Dockerfile` | Build the service image and the console image. |
| `Caddyfile` | Caddy configuration for the console and API hostnames. |
| `console-probe.mjs` | The console container's health check. It requests `/ready` with the public `Host`. |
| `service.env.example` | Template for the private `service.env`. |
| `acclimate.service` | systemd unit for the API alone. See [Native and partial alternatives](#native-and-partial-alternatives). |
| `keycloak/` | The co-hosted Keycloak image, realm template, Caddy configuration and its own guide. |
| `local/` | Caddy configuration for the local stack. |
| `mailpit.md`, `sign-in.md` | Notes on local email and on the choice of Keycloak. |

## Stack design

`compose.yaml` is the application stack: PostgreSQL 16 with a persistent volume, one service, one built console and Caddy, which terminates public HTTPS. `compose.keycloak.yaml` adds Keycloak with its own PostgreSQL instance. Without it, the stack signs in through an existing Keycloak.

The stack never guesses identity or secrets. No command infers a PostgreSQL role from the OS account, creates machine or human credentials, adopts existing private state, seeds example content or provisions a database from a developer account. The Compose path variables have no insecure defaults. Runtime secrets are never build arguments, and builds need no runtime secrets.

**Networks.** Only Caddy publishes host ports, 80 and 443.

| Network | Members | Purpose |
| --- | --- | --- |
| `backend` (internal) | PostgreSQL, service, console, Caddy, Keycloak | Private application traffic. PostgreSQL has no outbound route. |
| `outbound` | service, console, Keycloak | Outbound HTTPS, such as to the OIDC issuer and the optimizer endpoint. |
| `edge` | Caddy | Public traffic. |
| `executor` (internal) | service, executor | The executor listener. The service binds `ACCLIMATE_INTERNAL_BIND` to port 3001 on this network. |
| `executor-egress` | executor | The executor's route to model providers. |

Keep the Docker bridge inaccessible to untrusted processes and firewall the backend ports. Do not run more than one service process against one database.

**Caddy.** Caddy stores certificates in its persistent volume. It pins the upstream `Host` to the configured public hostname, strips incoming forwarding headers and replaces them from the trusted connection. Direct access that bypasses the proxy is unsupported. Caddy's administration listener stays inside its container. Its health check covers the process and its configuration, and its dependency checks require both applications to be ready.

**Startup.** The service verifies the migrations already applied and applies pending ones while it holds its exclusive lock on the database. A fresh database runs the full embedded migration chain. A migration failure prevents listening. The service then registers the workspaces named in static machine grants. Registration creates no human memberships.

**Workspaces.** Operators create workspaces after a verified sign-in. An existing workspace without members needs explicit, audited adoption by exact ID and reason. Being an operator alone gives no access to an existing workspace.

**Shutdown.** PostgreSQL, the service, the console and Caddy use restart policies and a 90-second stop grace period. On SIGTERM the service stops reporting ready, then drains requests and work within 35 seconds and releases its database lock. The lock is held until work stops. Exit code 75 means the service lost its hold on the database. The standalone service wrapper does not invent credentials or silently recover against another database.

**Configuration checks.** After installing the lockfile dependencies, `npm run check:console-config` checks explicit console configuration without starting a process. Neither it nor a build contacts Keycloak. The Vite and built server entrypoints check required configuration again before they listen.

## CLIProxyAPI with Codex sign-in

Acclimate supports OpenAI-compatible Chat Completions endpoints for the optimizer. The reference setup is CLIProxyAPI with a Codex sign-in. The steps are in [Set up a local model proxy](../apps/docs/content/docs/tutorials/first-learning-round.mdx#set-up-a-local-model-proxy), and the optimizer settings are in [Environment variables](../apps/docs/content/docs/reference/configuration.mdx#optimizer). This section keeps the details behind them.

Pin the proxy build. The notes here were checked against the v8 revision that these links point to: the [example configuration](https://github.com/router-for-me/CLIProxyAPI/blob/f5c5681a8361c9da53e93c60b6507816eee7468b/config.example.yaml), the [CLI flags](https://github.com/router-for-me/CLIProxyAPI/blob/f5c5681a8361c9da53e93c60b6507816eee7468b/cmd/server/main.go) and the [Codex Chat Completions translator](https://github.com/router-for-me/CLIProxyAPI/blob/f5c5681a8361c9da53e93c60b6507816eee7468b/internal/translator/codex/openai/chat-completions/codex_openai_request.go). The proxy's own guide is the [CLIProxyAPI setup guide](https://help.router-for.me/).

- **Listener.** Set `server.port` to `8317`, the default. Set `server.host` to an interface the service can reach on a private network. Use loopback when both processes run directly on the same host. Inside Compose, use the proxy's reachable hostname, because loopback there is the service container itself.
- **Settings.** `ACCLIMATE_MODEL_ENDPOINT` is the full URL, for example `http://127.0.0.1:8317/v1/chat/completions`. `ACCLIMATE_MODEL_TOKEN` is the proxy client key from `access.api-keys`, which the service sends as a bearer token. The experiment used `ACCLIMATE_MODEL=gpt-6.2-astra` with `ACCLIMATE_MODEL_REASONING_EFFORT=high`.
- **Request shape.** The optimizer requests JSON mode and sends `max_completion_tokens`, 32,768 by default. The translator maps `max_completion_tokens` to `max_output_tokens` and `reasoning_effort` to `reasoning.effort`. Its format switch has no `json_object` case, so JSON mode is not enforced on that route. The optimizer prompts for JSON and validates the returned content.
- **Retries.** The service retries HTTP 429, HTTP 5xx, connection errors and timeouts with 5-second and 30-second backoffs, or after the provider's `Retry-After` when that is longer, for up to ten minutes.
- **Cooling.** With a single Codex sign-in, set `routing.cooldown.disable-cooling: true` in the proxy configuration. By default the proxy blocks a model for the time the upstream names after one overloaded or rate-limited reply, which was about five minutes in testing. It answers every request for that model with HTTP 503 in the meantime. With cooling off, only the affected request waits. The executor's gateway asks again every 30 seconds for up to seven minutes while the provider keeps sending `Retry-After`. The optimizer waits for the `Retry-After` time before it retries.

## Upgrade to the learning-loop schema

These notes are for a database that was last run by a build from before the current learning loop. For every other upgrade, follow [Upgrade and recover](../apps/docs/content/docs/operate/upgrades-and-recovery.mdx). The notes are keyed by the last migration your database has applied. To find it, run this against the database. It returns the number without leading zeros, so `16` means `0016`.

```sql
SELECT max(version) FROM _sqlx_migrations;
```

There is no downgrade for any of these. To roll back, restore the backup you took first and run the build that matches it. Rehearse the upgrade on a restored copy of the database before you run it on the live one.

### Remove obsolete settings

Remove these from old environment files before you start the new service. Startup names the first obsolete setting it finds.

- `ACCLIMATE_MODE` and `CONSOLE_MODE` were removed. Delete them from both the service and the console environments. Startup rejects any defined value.
- The service no longer reads `ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS` or `ACCLIMATE_LEARNING_EVALUATION_SECONDS`. Rollout leases govern retries.
- The [changelog](https://github.com/anveld-dev/acclimate/blob/main/CHANGELOG.md#removed) lists the other removed settings.

### From migration 0015 or 0016

Migrations `0017_remove_manual_changes.sql` and `0018_remove_connected_learning.sql` permanently drop the manual change workflow and connected learning, with their records. For a database at `0015`, startup first applies `0016_automatic_delivery.sql`. The new loop uses `0019_learning_loop.sql`, `0020_learning_optimizer.sql` and `0021_optimizer_effort.sql`. Keep the backup as your archive of the old records.

1. Stop incoming traffic and the connected-learning evaluators.
2. Find the connections that receive a learned version. After `0018` they receive their own channel's version instead.

   ```sql
   SELECT e.project_id, e.bundle_id, e.integration_id, e.source_channel, e.delivery_channel,
          d.version_id AS delivered, s.version_id AS source_head
   FROM connected_learning_enrollments e
   JOIN channels d ON (d.project_id, d.bundle_id, d.name) = (e.project_id, e.bundle_id, e.delivery_channel)
   JOIN channels s ON (s.project_id, s.bundle_id, s.name) = (e.project_id, e.bundle_id, e.source_channel)
   WHERE d.version_id <> s.version_id;
   ```

   Record the delivered version ID for each affected connection. Then stop the old service and console.

3. Back up the stopped installation's database.

   ```sh
   python3 scripts/operations/backup.py dump /private/backups/acclimate-pre-loop.dump --pg-bin /path/to/postgresql-16/bin
   ```

   To read old rounds, proposals or comparisons later, restore the backup into a separate database and run the `pre-learning-loop` build against it.

4. Start the new build to apply the migrations. Queued connected-learning rounds, proposals and evaluation requests are dropped. Turn on learning again in the bundle's **Learning** tab.
5. Connections now resolve the version on their configured channel. If a connection should keep the version you recorded, release that version on its channel with a reason. This also changes every other connection that uses the channel. Existing `learn-<connectionId>` channels stay as ordinary channels with their release history.

### From migration 0019, 0020 or 0021

Migrations `0022_central_learning.sql` to `0024_learning_reliability.sql` move learning into the service. Back up first. An application no longer runs an evaluator, so stop any evaluator you ran for the earlier learning API.

Before you start the new service, edit `ACCLIMATE_AUTH`. Startup refuses a static grant that still lists the `evaluate` right. Give tokens that report outcomes the `write` right.

On startup, the migrations:

- copy live and retired evolve cases into the task tables as tasks with an `exact` grader, and drop the old case table
- keep round history and improvement memory
- stop open rounds and cancel their queued rollouts and optimizer calls
- pause running loops with the reason `tasks-required`
- turn each stored `evaluate` right on a machine token into `read`

The service starts with no held-out tasks. Import or write them in the console.

Before you resume a loop, set `ACCLIMATE_PROVIDER_ENCRYPTION_KEY` and start the executor as in [Enable learning](../apps/docs/content/docs/operate/enable-learning.mdx). Then configure the workspace's model provider and choose a task model and a judge model on the bundle's **Learning** tab. Resuming requires 20 admitted evolve tasks and 20 admitted held-out tasks.

### From migration 0022, 0023 or 0024

Migrations `0025_import_history.sql`, `0026_round_failure_cause.sql` and `0027_provider_key_check.sql` add the import creation time, the round failure cause, the `provider-unavailable` round reason and wait, and the provider key check table. They change no existing rows and need no steps of their own.

Two things change around them:

- **The provider key check.** On its first start after `0027`, a service with `ACCLIMATE_PROVIDER_ENCRYPTION_KEY` set stores a check value for that key. It refuses to start if the key opens none of the stored provider API keys. See [Keep the provider encryption key](../apps/docs/content/docs/operate/backup-and-restore.mdx#keep-the-provider-encryption-key).
- **The executor credential file.** `compose.yaml` now requires `ACCLIMATE_EXECUTOR_TOKEN_FILE` and gives the executor a health check. Every `docker compose` command fails without the variable, including `pull`, `up`, `down` and `exec`, even for a deployment that runs no executor. Export it in the deployment shell before you upgrade. Without an executor any path works, for example an empty private file.

The runner image default changes from `acclimate-chat:1` to `ghcr.io/anveld-dev/acclimate-runner:${ACCLIMATE_VERSION:-latest}`. If you rebuild from the checkout, `docker compose build acclimate-runner acclimate-executor` tags the new names. An `ACCLIMATE_RUNNER_IMAGE` you set yourself still names the image for both the runner and the executor.

The release workflow publishes `acclimate-executor` and `acclimate-runner` images with the same tags and platforms as the service and console. `compose.yaml` names them through `ACCLIMATE_EXECUTOR_IMAGE` and `ACCLIMATE_RUNNER_IMAGE`. No release has included them yet. Until one does, build them from the checkout, and do not run `docker compose up --no-build` without service names, because those images cannot be pulled.

### Service and executor versions

Upgrade the service first, then the executor. A newer service accepts the 1-or-0 judged scores of an executor built before partial credit, so rollouts in flight survive the service upgrade. An older service rejects a newer executor's fractional scores and its `provider-rejected` error code. A newer service still accepts `gateway-upstream` for every provider failure from an older executor, and treats each one as an outage until the executor is upgraded.

## Native and partial alternatives

For native execution, build with `cargo build --locked --release` and `npm ci --ignore-scripts && npm run build`. Explicitly inject each process's runtime environment, then use `npm start` for the service and `npm run start:console` for the built console. `ACCLIMATE_SERVICE_BINARY` may name an absolute installed service binary. `npm run dev` uses Vite with the same required production identity configuration. The console defaults to `HOST=127.0.0.1 PORT=3100`. Bind a different address only behind the trusted proxy. These commands load no environment files implicitly.

`deploy/acclimate.service` is an **API-only partial alternative**, not a complete deployment. Install the release binary at `/usr/local/bin/acclimate-service`, create its dedicated user and group, and install a completed root-owned mode-0600 `/etc/acclimate/service.env`. Use loopback `ACCLIMATE_BIND=127.0.0.1:3000` and the address of your separately provisioned PostgreSQL instead of the Compose hostname. The authenticated console, PostgreSQL, TLS proxy, public DNS, backup and firewall remain separately required. Never enable the unit incidentally while editing or testing this repository.

## What has been tested

`scripts/productization/external.py` runs checks against real endpoints. Run `python3 scripts/productization/external.py --help` from the repository root to list them and their options. Each run with `--execute --gate` runs one check. The optional `--output` flag writes the result to a new file. Choose a path in a private directory.

| `--gate` | What it checks | Needs |
| --- | --- | --- |
| `https` | The API certificate and hostname, liveness, database and worker readiness, and an authenticated workspace read | A machine token with read access, named by `--token-env` |
| `oidc` | Sign-in with your configured issuer, secure console session cookies and sign-out | Playwright with its Chromium browser, `--interactive` and a disposable test account |
| `container` | Builds the deployment images and checks them in a disposable Compose project with a private volume, a test issuer and test certificates | Docker |
| `remote-model` | One bounded `gpt-6-luna` completion against your configured endpoint | `--live`. Can incur model charges. |
| `native-*` | Prepared files and version pinning with an installed agent SDK | `--live`. Can incur model charges. |

The `container` check and the repository's other tests use test issuers and certificates. Only the `https` and `oidc` checks verify your own deployment's endpoints. The commands for those two are in [Check health and readiness](../apps/docs/content/docs/operate/health-and-readiness.mdx#verify-api-access-and-sign-in).

## Backup scripts

[Back up and restore](../apps/docs/content/docs/operate/backup-and-restore.mdx) has the operator procedure. This section describes the scripts in `scripts/operations/`.

`backup.py` needs Python 3 and `psql`, `pg_dump` and `pg_restore` from the same major version as the connected server. `--pg-bin` selects the tools explicitly. `DATABASE_URL` accepts PostgreSQL URLs with the `sslmode`, `sslrootcert`, `sslcert`, `sslkey` and `connect_timeout` query options. The script passes the URL to the tools through libpq environment variables, not command arguments.

The dump is a consistent custom-format snapshot, created exclusively with mode 0600. It is taken without owners or ACLs, so it holds no database roles or grants. Restore refuses a target with existing relations and uses `pg_restore --exit-on-error --single-transaction`, so an SQL error rolls the whole restore back.

For a repeatable local test of the scripts, set `DATABASE_URL` to a disposable PostgreSQL server and a role that may create and drop databases, then run:

```sh
python3 scripts/operations/qualify.py --pg-bin /path/to/postgresql-16/bin
```

It creates three randomly named databases, installs the schema and inserts fixture records. It compares all restored table data, including exact binary payloads and history, and tests the refusal of a populated target and a transactional failure. It drops only the databases it created and does not alter the database named by `DATABASE_URL`. A process kill or database outage can interrupt cleanup. If that happens, identify the randomly named `acclimate_ops_…` databases before you remove them. This test does not show that any particular production backup can be restored.

## Executor internals

[Enable learning](../apps/docs/content/docs/operate/enable-learning.mdx) has the operator procedure, including gVisor registration, the executor's privileges and its credential. The provider address rules are in [Environment variables](../apps/docs/content/docs/reference/configuration.mdx#provider-addresses).

- **Sandboxes.** The executor runs each rollout in a sandbox container started from the chat runner image. It resolves the runner's immutable image ID at startup. It mounts a volume subpath into each sandbox, so it needs Docker Engine 26 or later. Each runner receives its own read-only lease directory from that volume.
- **Preflight.** Before it requests work, the executor runs one throwaway sandbox with the rollout's flags. It checks that the sandbox can read its lease directory and reach the gateway socket. If that fails, the executor exits with status 78 and a message that says what to check.
- **Health.** The executor touches a health file after each successful lease request and heartbeat. The file is `ACCLIMATE_EXECUTOR_HEALTH_FILE`, by default `/tmp/acclimate-executor-health`. `acclimate-executor --health` fails when the file is older than 120 seconds. Both Compose files run it as the container health check.
- **Credentials.** Revoking a credential requeues the rollouts it held, or fails those already on their second attempt. Run the service commands with the service's `DATABASE_URL`, for example through `docker compose exec -T service`.
- **Isolation test.** Run `ACCLIMATE_SANDBOX_RUNTIME=runsc python3 executor/tests/sandbox.py -v` on the Linux host to verify isolation. Local Compose uses plain Docker.
