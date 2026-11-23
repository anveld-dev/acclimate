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
| `ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` | 3 consecutive failed rounds before an automatic pause. |
| `ACCLIMATE_INTERNAL_BIND` | `127.0.0.1:3001`. The executor listener. Compose sets `executor-listener:3001` on the private executor network. |
| `ACCLIMATE_PROVIDER_ENCRYPTION_KEY` | Unset. 64 hex characters. Required to save a workspace model provider and to lease learning work. |
| `ACCLIMATE_PROVIDER_HTTP_HOSTS` | Empty. Comma-separated exact hostnames a model provider may reach over plain HTTP or at a loopback, private, carrier-grade NAT or unique-local address. Set the same value on the executor. See [provider addresses](#provider-addresses). |
| `ACCLIMATE_SMTP_HOST` | Unset. This disables email delivery and requires leaving the other SMTP settings unset. |
| `ACCLIMATE_CONSOLE_ORIGIN` | Required with SMTP. Use the public HTTPS console origin. |
| `ACCLIMATE_SMTP_FROM` | Required with SMTP. Use a valid sender mailbox. |
| `ACCLIMATE_SMTP_TLS` | `starttls`. Also accepts `tls`. Use `none` only with loopback or `mailpit`. |
| `ACCLIMATE_SMTP_PORT` | 465 for `tls`, 587 otherwise. |
| `ACCLIMATE_SMTP_USERNAME` | Unset. Supply with a password over TLS to authenticate. |
| `ACCLIMATE_SMTP_PASSWORD` | Unset. Supply with a username over TLS to authenticate. |

`ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` uses its default for a missing, zero or invalid value. The service no longer reads `ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS` or `ACCLIMATE_LEARNING_EVALUATION_SECONDS`; rollout leases govern retries. Remove any obsolete settings listed in the [changelog](https://github.com/anveld-dev/acclimate/blob/main/CHANGELOG.md#removed) before startup.

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

The optimizer requests JSON mode and includes `max_completion_tokens` (default 32,768). The inspected CLIProxyAPI Codex translator maps `max_completion_tokens` to `max_output_tokens` and `reasoning_effort` to `reasoning.effort`. Its format switch has no `json_object` case, so JSON mode is unenforced on that route. The optimizer prompts for JSON and validates the returned content. The service retries HTTP 429, HTTP 5xx, connection errors and timeouts with 5- and 30-second backoffs, or after the provider's `Retry-After` when that is longer, up to ten minutes. [Codex Chat Completions translator](https://github.com/router-for-me/CLIProxyAPI/blob/f5c5681a8361c9da53e93c60b6507816eee7468b/internal/translator/codex/openai/chat-completions/codex_openai_request.go)

With a single Codex sign-in, set `routing.cooldown.disable-cooling: true` in the proxy configuration. By default the proxy blocks a model for the time the upstream names after one overloaded or rate-limited reply, which was about five minutes in testing, and answers every request for that model with HTTP 503 in the meantime. With cooling off, only the affected request waits. The executor gateway asks again every 30 seconds for up to seven minutes while the provider keeps sending `Retry-After`, and the optimizer waits for the `Retry-After` time before it retries.

## First start

Export the path/hostname variables above into the deployment shell, without putting secret values in command arguments. Also export `ACCLIMATE_EXECUTOR_TOKEN_FILE` as an absolute path to a private file outside the checkout, and `ACCLIMATE_PROVIDER_HTTP_HOSTS` if you need it (see [provider addresses](#provider-addresses)). `compose.yaml` requires `ACCLIMATE_EXECUTOR_TOKEN_FILE`: every `docker compose` command fails without it. The release workflow publishes `acclimate-executor` and `acclimate-runner` images with the same tags and platforms as the service and console, and `compose.yaml` names them through `ACCLIMATE_EXECUTOR_IMAGE` and `ACCLIMATE_RUNNER_IMAGE`. No release has included them yet, so until one does, build them from the checkout as below. Follow these steps in order. This repository does not run them for you.

1. Generate the provider encryption key and add it to `service.env`. The key is 64 hex characters. Store a copy outside the host, separately from database backups. See [Upgrades and recovery](#upgrades-and-recovery) for why.

   ```sh
   umask 077
   printf 'ACCLIMATE_PROVIDER_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" >> "$ACCLIMATE_SERVICE_ENV"
   ```

2. Validate the configuration, build or pull the service and console, then start PostgreSQL, the service, the console and Caddy. The service applies the database migrations on startup.

   ```sh
   touch "$ACCLIMATE_EXECUTOR_TOKEN_FILE" && chmod 600 "$ACCLIMATE_EXECUTOR_TOKEN_FILE"
   docker compose config --quiet
   docker compose build service console
   docker compose up -d --wait postgres service console proxy
   ```

   With published images, run `docker compose pull postgres service console proxy` instead of the build, and add `--no-build` to `up`.

3. Create the executor credential inside the service container. It prints `{id, token}`. Save only the token in the file that `ACCLIMATE_EXECUTOR_TOKEN_FILE` names. Keep the `id` in your deployment records: `--revoke-executor-token` takes it.

   ```sh
   docker compose exec -T service /usr/local/bin/acclimate-service --create-executor-token \
     | python3 -c 'import json, sys; c = json.load(sys.stdin); print(c["token"], file=open(sys.argv[1], "w")); print("executor credential id:", c["id"])' "$ACCLIMATE_EXECUTOR_TOKEN_FILE"
   ```

4. Build the runner and executor images. From a release that publishes them, run `docker compose pull acclimate-runner acclimate-executor` instead.

   ```sh
   docker compose build acclimate-runner acclimate-executor
   ```

5. Configure [gVisor](#gvisor) on the Docker daemon. Then start the executor. It inspects the runner image when it starts, so the image must exist first.

   ```sh
   docker compose up -d acclimate-executor
   docker compose ps acclimate-executor
   ```

   Within about two minutes `docker compose ps` shows the executor as `healthy`: the service has answered its lease requests with its credential. The executor checks its configuration at startup and exits with status 78 and a plain message when it cannot work: the service refuses its credential (HTTP 401), the token file is missing or empty, `ACCLIMATE_SANDBOX_RUNTIME` is not `runsc` or `docker`, the runner image is missing, or the sandbox preflight fails. If it is restarting or unhealthy, read `docker compose logs acclimate-executor`.

Later starts can use `docker compose up -d --wait postgres service console proxy` followed by `docker compose up -d acclimate-executor`. Until a release publishes the runner and executor images, do not run `docker compose up --no-build` without service names: those images cannot be pulled.

Caddy obtains and stores certificates in its persistent volume. It pins the upstream console `Host` to the configured public hostname, strips incoming forwarding headers and replaces them from the trusted connection. The console reconstructs public URLs from its pinned HTTPS origin, rejects a different Host, and ignores caller-supplied `Forwarded`/`X-Forwarded-*` headers. HTTP from Caddy to the two application listeners is allowed only on the private network. Direct access bypassing this proxy is unsupported. Caddy's administration listener stays container-local; its health check is process/configuration liveness, while its dependency checks require both applications ready.

See the [reverse proxy guide](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/operate/reverse-proxy.mdx) for the headers and limits an alternative proxy must preserve.

PostgreSQL, Rust, console and proxy use restart policies and 90-second stop grace. Rust drains within 35 seconds plus bounded lock release; its singleton guard is held until work stops. `/health` is process liveness. `/ready` checks database usability, singleton ownership, initialized/live worker and non-draining state within a bounded probe. It does not prove queue progress, model/provider availability or evaluation quality. Console `/ready` validates configuration and upstream readiness without a provider discovery call on each probe.

On startup, the service verifies previously applied migrations and applies pending migrations under the singleton ownership lock. A fresh database runs the full embedded migration chain. The service then registers the workspaces named in explicit machine grants. Registration creates no human memberships. Migration failure prevents listening. Human operators create workspaces through verified sign-in; existing memberless workspaces require explicit audited adoption by exact ID and reason. Operator capability alone does not grant existing workspace access.

## Upgrade to the learning-loop schema

Migrations `0017_remove_manual_changes.sql` and `0018_remove_connected_learning.sql` drop the manual change workflow and connected learning. They are destructive and irreversible. For a database through `0015`, startup first applies `0016_automatic_delivery.sql`. The new loop uses `0019_learning_loop.sql`, `0020_learning_optimizer.sql` and `0021_optimizer_effort.sql`.

1. Stop incoming traffic and connected-learning evaluators. Record the version IDs delivered by affected connections, then stop the old service and console. [Upgrade and recover](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/operate/upgrades-and-recovery.mdx) has the query for affected connections.
2. Back up the stopped installation's database with `python3 scripts/operations/backup.py dump /private/backups/acclimate-pre-loop.dump --pg-bin /path/to/postgresql-16/bin`. To read old rounds, proposals or comparisons later, restore the backup into a separate database and run the `pre-learning-loop` build against it.
3. Start the new build to apply the migrations. Queued connected-learning rounds, proposals and evaluation requests are dropped. Set up learning again in the bundle's Learning tab.
4. Connections resolve the version on their configured channel. Release a retained version on that channel with a reason if its connections should use that version. Existing `learn-<connectionId>` channels remain available as ordinary channels with their release history.

Migrations `0022_central_learning.sql` through `0024_learning_reliability.sql` move learning into the service. Back up first. There is no downgrade: to roll back, restore that backup and run the matching earlier build. The cutover stops active rounds and pauses running loops with `tasks-required`. It copies live and retired evolve cases into the task tables as `exact` tasks and keeps round history and improvement memory. It turns each stored `evaluate` machine right into `read`. Give tokens that report outcomes `write`. Startup refuses a static grant in `ACCLIMATE_AUTH` that still lists `evaluate`, so update those first. Then set `ACCLIMATE_PROVIDER_ENCRYPTION_KEY`, start the [rollout executor](#rollout-executor), configure the workspace model provider and start each loop again once its tasks pass admission.

Migrations `0025_import_history.sql` to `0027_provider_key_check.sql` add the import creation time, the round failure cause and the `provider-unavailable` round reason and wait, and the provider key check table. They change no existing rows and need no steps. On its first start after `0027`, a service with `ACCLIMATE_PROVIDER_ENCRYPTION_KEY` set stores a check value for that key, and refuses to start if the key opens none of the stored provider keys. See [the provider encryption key](#provider-encryption-key).

## Upgrades and recovery

See [Upgrade and recover](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/operate/upgrades-and-recovery.mdx) for release pinning and the upgrade sequence.

Stop traffic and both application containers before changing service versions. Rehearse the upgrade on a restored copy if it crosses the destructive migrations above. Take a backup and rehearse restoration on a separate database with the matching service build. Verify readiness and an authenticated read before routing traffic. Normal `docker compose down` preserves volumes. The `--volumes` option deletes them.

There is no downgrade path for the schema. Rolling back means restoring the backup taken before the upgrade and running the build that matches it.

Upgrade the service first, then the executor. A newer service accepts the 1-or-0 judged scores of an executor built before partial credit, so rollouts in flight survive the service upgrade. An older service rejects a newer executor's fractional scores.

Upgrade or restart the executor between rounds. A round pins the executor build and runner image it started with. If no live executor matches them for five minutes, the round fails with `no-matching-executor`. That failure does not count toward the failed-rounds pause, and the next round pins the new executor. Rebuild with `docker compose build acclimate-runner acclimate-executor`, or with a release that publishes them, `docker compose pull acclimate-runner acclimate-executor`, then run `docker compose up -d acclimate-executor`.

To rotate the executor credential, create a new one with `--create-executor-token` as in [First start](#first-start), replace the token file with the new token, restart the executor with `docker compose up -d --force-recreate acclimate-executor`, then revoke the old one with `docker compose exec -T service /usr/local/bin/acclimate-service --revoke-executor-token <old id>`. `--list-executor-tokens` shows which credentials exist and when each was last seen. The executor reads the file only at startup. Stopping it waits up to an hour for its leased rollouts to finish.

Supervisors restart failed processes with policy; investigate repeated failures. Exit code 75 identifies lost database ownership. The executor exits with 78 when its configuration cannot work; restarting does not help until that is fixed. The standalone service wrapper does not invent credentials or silently recover against another database. On SIGTERM readiness is withdrawn before HTTP/work draining and lock release. Backups include sensitive content and must be protected and restored on a schedule.

### Provider encryption key

Keep the provider encryption key with your database backups, but store it separately from them. The service stores a check value sealed with the key the first time it starts with one. A later start with a different key, for example after a backup is restored without its key, stops with an error that names both ways out:

- Restore the original key in `service.env` and start again.
- Or discard every stored workspace provider and start over with the new key: `docker compose exec -T service /usr/local/bin/acclimate-service --reset-provider-keys --confirm`. It prints `{"removedProviders": n}`. Each workspace administrator must then enter their provider again.

When the key is unset, the service starts and logs a warning: saving a provider fails with 503 and stored providers show "Provider key unavailable". A stored provider key that cannot be decrypted is logged with its workspace ID, and that provider shows "Provider key unavailable" until a workspace administrator enters its API key again.

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

## Rollout executor

The executor runs each rollout in a sandbox container started from the chat runner image. [First start](#first-start) creates its credential and starts it. The executor resolves the runner's immutable image ID at startup.

`ACCLIMATE_EXECUTOR_TOKEN_FILE` names the file that holds the executor credential. `acclimate-service --list-executor-tokens` prints each credential's ID, creation time, last-seen time, declared runtime and revoked state as JSON, never a token. Revoke a credential with `acclimate-service --revoke-executor-token <id>`, run with the service's `DATABASE_URL`, for example through `docker compose exec -T service`. See [Upgrades and recovery](#upgrades-and-recovery) to rotate it. Revoking requeues the rollouts it held, or fails those already on their second attempt.

`ACCLIMATE_EXECUTOR_CONCURRENCY` sets how many rollouts the executor runs at once. The default is 1. A higher value finishes rounds sooner, but sends more concurrent requests to the provider and runs more sandboxes on the host.

The service listens at `ACCLIMATE_INTERNAL_BIND`. Compose binds port 3001 to the service address on the private executor network. The executor reaches the workspace model endpoint over `executor-egress`. Attach a containerized model proxy to that network when using its Compose hostname.

The executor mounts a volume subpath into each sandbox, so it needs Docker Engine 26 or later. Each runner receives its own read-only lease directory from that volume.

### gVisor

Production sandboxes use the gVisor runtime `runsc`, the Compose default. Install `runsc` on the host and register it with the Docker daemon in `/etc/docker/daemon.json`, with `--host-uds=open` so the runner can connect to the mounted gateway socket:

```json
{
  "runtimes": {
    "runsc": {
      "path": "runsc",
      "runtimeArgs": ["--host-uds=open"]
    }
  }
}
```

Restart Docker, then check that the daemon lists the runtime:

```sh
docker info --format '{{json .Runtimes}}'
```

Run `ACCLIMATE_SANDBOX_RUNTIME=runsc python3 executor/tests/sandbox.py -v` on the Linux host to verify isolation. Local Compose uses plain Docker.

Before it requests work, the executor runs one throwaway sandbox with the rollout's flags and checks that it can read its lease directory and reach the gateway socket. Without the runtime, or with gVisor registered without `--host-uds=open`, that preflight fails and the executor exits with status 78 and a message that says what to check. Provider verification runs outside a sandbox, so it can pass while the executor cannot run.

### Executor health

The executor touches a health file after each successful lease request and heartbeat (`ACCLIMATE_EXECUTOR_HEALTH_FILE`, default `/tmp/acclimate-executor-health`). `acclimate-executor --health` fails when the file is older than 120 seconds. Both Compose files run it as the container health check, so `docker compose ps acclimate-executor` shows `healthy` while the executor reaches the service.

### Provider addresses

The service checks a workspace provider's base URL when it is saved. The executor checks it again, resolves the host, checks every resolved address and connects only to a checked address, with redirects off. `ACCLIMATE_PROVIDER_HTTP_HOSTS` is a comma-separated list of exact hostnames or IP addresses, compared without case. It is empty by default. Set it to the same value in `service.env` and in the Compose environment for the executor. If they differ, the service can accept a URL that the executor then refuses.

- The URL must use HTTPS. Plain HTTP is allowed only for a listed host.
- The URL must not contain a user name, password, query or fragment.
- These are always refused, listed or not: link-local addresses (including `169.254.169.254`), the unspecified address, multicast, broadcast, `100.100.100.200`, `168.63.129.16`, `fd00:ec2::254`, and the hostnames `metadata.google.internal` and `metadata.goog`.
- These need the host on the list, even over HTTPS: loopback, `localhost` and `*.localhost`, private IPv4 addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), carrier-grade NAT (`100.64.0.0/10`) and IPv6 unique-local addresses (`fc00::/7`). For a hostname, the executor applies the same checks to every address it resolves to.

### Executor privileges

The executor mounts the host Docker socket, which grants host administrator authority to the executor image. Only the executor receives this mount. The executor runs as root, has outbound network access over `executor-egress`, and holds each leased workspace's provider key in memory while it runs that work. Run it only on a host you trust with every workspace's provider key.
