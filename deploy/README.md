# Single-host production deployment

This directory holds the files for the single-host Docker Compose deployment. The operator procedures live in the documentation pages listed below. This README keeps what is specific to the repository: how the stack is built, notes for upgrading old databases, the native alternatives and the verification checks.

Service-specific vocabulary is defined in [Internal terms](../CONTEXT.md#internal-terms).

## Operator documentation

| To do this | Read |
| --- | --- |
| Bring up a deployment, with the co-hosted Keycloak or an existing one | [Self-host Acclimate](https://acclimate.anveld.dev/docs/operate/self-host) |
| Set the optimizer, register gVisor, start, check, upgrade and rotate the executor | [Enable learning](https://acclimate.anveld.dev/docs/operate/enable-learning) |
| Replace the bundled Caddy | [Use your own reverse proxy](https://acclimate.anveld.dev/docs/operate/reverse-proxy) |
| Probe the stack, read exit codes and check the public routes and sign-in | [Check health and readiness](https://acclimate.anveld.dev/docs/operate/health-and-readiness) |
| Back up, restore and keep the provider encryption key | [Back up and restore](https://acclimate.anveld.dev/docs/operate/backup-and-restore) |
| Upgrade to a new Acclimate release or roll back | [Upgrade and recover](https://acclimate.anveld.dev/docs/operate/upgrades-and-recovery) |
| Find the cause of a symptom | [Troubleshooting](https://acclimate.anveld.dev/docs/operate/troubleshooting) |
| Look up an environment variable, the provider address rules or a service command | [Environment variables](https://acclimate.anveld.dev/docs/reference/configuration) |
| Change the Keycloak realm, theme or email | [Keycloak setup](keycloak/README.md) |

## Files in this directory

| File | Purpose |
| --- | --- |
| `init.sh` | Writes the private directory with every secret and the checkout's `.env`. See [Self-host Acclimate](https://acclimate.anveld.dev/docs/operate/self-host). |
| `Dockerfile`, `console.Dockerfile` | Build the service image and the console image. |
| `Caddyfile` | Caddy configuration for the console and API hostnames. |
| `console-probe.mjs` | The console container's health check. It requests `/ready` with the public `Host`. |
| `service.env.example` | Template for the private `service.env`. |
| `acclimate.service` | systemd unit for the API alone. See [Native and partial alternatives](#native-and-partial-alternatives). |
| `keycloak/` | The co-hosted Keycloak image, realm and first-person templates, Caddy configuration and its own guide. |
| `local/` | Caddy configuration for the local stack. |
| `mailpit.md`, `sign-in.md` | Notes on local email and on the choice of Keycloak. |

The model proxy used for the measured runs in the docs is described in [Development](../docs/development.md).

## Stack design

`compose.yaml` is the application stack: PostgreSQL 16 with a persistent volume, one service, one built console and Caddy, which terminates public HTTPS. `compose.keycloak.yaml` adds Keycloak with its own PostgreSQL instance. Without it, the stack signs in through an existing Keycloak.

The stack never guesses identity or secrets. `init.sh` generates every secret and the first person's Keycloak account once, and refuses to run when the private directory or `.env` already exists. No command infers a PostgreSQL role from the OS account, creates machine credentials, adopts existing private state, seeds example content or provisions a database from a developer account. Compose reads the private file paths from `ACCLIMATE_CONFIG_DIR` in `.env` and has no default for it. Runtime secrets are never build arguments, and builds need no runtime secrets.

The executor and the runner image sit behind the `learning` Compose profile. Every container logs to Docker's `json-file` driver with at most five 10 MB files. Keycloak's admin console is published on `127.0.0.1:${KEYCLOAK_ADMIN_PORT:-8180}` only, and `KC_HOSTNAME_ADMIN` points the console there.

**Networks.** Only Caddy publishes public host ports, 80 and 443.

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

## Native and partial alternatives

For native execution, build with `cargo build --locked --release` and `npm ci --ignore-scripts && npm run build`. Explicitly inject each process's runtime environment, then use `npm start` for the service and `npm run start:console` for the built console. `ACCLIMATE_SERVICE_BINARY` may name an absolute installed service binary. `npm run dev` uses Vite with the same required production identity configuration. The console defaults to `HOST=127.0.0.1 PORT=3100`. Bind a different address only behind the trusted proxy. These commands load no environment files implicitly.

`deploy/acclimate.service` is an **API-only partial alternative**, not a complete deployment. Install the release binary at `/usr/local/bin/acclimate-service`, create its dedicated user and group, and install a completed root-owned mode-0600 `/etc/acclimate/service.env`. Use loopback `ACCLIMATE_BIND=127.0.0.1:3000` and the address of your separately provisioned PostgreSQL instead of the Compose hostname. The authenticated console, PostgreSQL, TLS proxy, public DNS, backup and firewall remain separately required. Never enable the unit incidentally while editing or testing this repository.

## What has been tested

`scripts/productization/external.py` runs opt-in checks for development and releases. Run `python3 scripts/productization/external.py --help` from the repository root to list them and their options. Each run with `--execute --gate` runs one check. The optional `--output` flag writes the result to a new file. Choose a path in a private directory.

| `--gate` | What it checks | Needs |
| --- | --- | --- |
| `container` | Builds the deployment images and checks them in a disposable Compose project with a private volume, a test issuer and test certificates. It also runs the shell blocks of [Back up and restore](https://acclimate.anveld.dev/docs/operate/backup-and-restore) and [Upgrade and recover](https://acclimate.anveld.dev/docs/operate/upgrades-and-recovery) verbatim and checks which data each keeps. | Docker and Playwright for Python with Chromium |
| `remote-model` | One bounded `gpt-6-luna` completion against your configured endpoint | `--live`. Can incur model charges. |
| `native-*` | Prepared files and version pinning with an installed agent SDK | `--live`. Can incur model charges. |

The `container` check runs every documented block except the `git` commands. Its Keycloak is a stand-in container, so the Keycloak database commands run against the real `keycloak-db` service but no Keycloak upgrade is tested. `test_deployment.py` fails when a page's block no longer matches the one the check runs. To check your own deployment's public routes and sign-in, follow [Verify API access and sign-in](https://acclimate.anveld.dev/docs/operate/health-and-readiness#verify-api-access-and-sign-in).

## Executor internals

[Enable learning](https://acclimate.anveld.dev/docs/operate/enable-learning) has the operator procedure, including gVisor registration, the executor's privileges and its credential. The provider address rules are in [Environment variables](https://acclimate.anveld.dev/docs/reference/configuration#provider-addresses).

- **Sandboxes.** The executor runs each rollout in a sandbox container started from the chat runner image. It resolves the runner's immutable image ID at startup. It mounts a volume subpath into each sandbox, so it needs Docker Engine 26 or later. Each runner receives its own read-only lease directory from that volume.
- **Preflight.** Before it requests work, the executor runs one throwaway sandbox with the rollout's flags. It checks that the sandbox can read its lease directory and reach the gateway socket. If that fails, the executor exits with status 78 and a message that says what to check.
- **Health.** The executor touches a health file after each successful lease request and heartbeat. The file is `ACCLIMATE_EXECUTOR_HEALTH_FILE`, by default `/tmp/acclimate-executor-health`. `acclimate-executor --health` fails when the file is older than 120 seconds. Both Compose files run it as the container health check.
- **Credentials.** Revoking a credential requeues the rollouts it held, or fails those already on their second attempt. Run the service commands with the service's `DATABASE_URL`, for example through `docker compose exec -T service`.
- **Isolation test.** Run `ACCLIMATE_SANDBOX_RUNTIME=runsc python3 executor/tests/sandbox.py -v` on the Linux host to verify isolation. Local Compose uses plain Docker.
