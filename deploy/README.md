# Single-host production deployment

`compose.yaml` is the application stack for an existing Keycloak deployment: PostgreSQL 16 with a persistent volume, one Rust service, one built Node console and Caddy terminating public HTTPS. Only Caddy publishes host ports (80 and 443). The API, console and PostgreSQL are private Docker-network listeners. Keep the Docker bridge inaccessible to untrusted processes and firewall backend ports. The application containers require outbound access to the configured OIDC issuer and any explicitly configured model endpoint. Do not run multiple Rust processes against one database.

Supply real identity, domain and secret settings before startup. No command infers a PostgreSQL role from the OS account, creates machine/human credentials, adopts existing private state, seeds example content or provisions a database from a developer account. `local`, `demo`, `console-bridge.ts` and `compose-config.ts` are retired explanatory failures. Existing `.local` and environment files are preserved and must be reviewed privately during cutover.

## Configuration

Use **Keycloak** with the existing OIDC integration. The [Keycloak setup](keycloak/README.md) configures the chosen provider. Add `compose.keycloak.yaml` to co-host its pinned production server and separate PostgreSQL database, or connect an existing Keycloak realm using the base application stack. The public URL convention is `https://console.<your-domain>` for the console and `https://api.<your-domain>` for SDK access. Example hostnames and tenant names in templates are placeholders, not provisioned resources.

Choose two DNS hostnames pointing at the intended deployment and make ports 80/443 available to Caddy. Set `CONSOLE_HOST` and `API_HOST` to those hostnames (without schemes or paths), and `ACME_EMAIL` to the certificate contact address. Set the console's `CONSOLE_ORIGIN=https://<CONSOLE_HOST>` and `CONSOLE_PUBLIC_API_URL=https://<API_HOST>`. The public API URL belongs in external app/SDK configuration; `http://service:3000` is the private console-to-Rust hop only.

Create these private files outside the checkout, restricted to their deployment owner:

- `service.env`: completed `deploy/service.env.example`. Supply the PostgreSQL URL, exact HTTPS issuer, distinct login-authority and console-transport credentials, explicit operator issuer/subject pairs, and scoped machine grants if needed. `ACCLIMATE_AUTH=[]` is valid for browser-only operation. The authority credentials must never occur in the machine grants.
- `console.env`: completed `apps/console/.env.example`. The two authority credentials and issuer must match Rust. Supply the real OIDC client ID and secret. Set `CONSOLE_ALLOW_EDITS=true` to enable authoring and Connections mutations; each operation still requires its current workspace role. Register exactly `https://<CONSOLE_HOST>/auth/callback` with the provider for authorization code flow.
- `postgres-password`: the database password alone, supplied by the operator/secret manager. The initial PostgreSQL role password is read from this Compose secret. URL-encode the same password in `DATABASE_URL`; changing the file does not rotate a role in an existing PostgreSQL volume.

Set mode 0600 on runtime files and use a private parent directory. Compose reads `ACCLIMATE_SERVICE_ENV`, `ACCLIMATE_CONSOLE_ENV` and `ACCLIMATE_POSTGRES_PASSWORD_FILE` as absolute file paths. These variables have no insecure defaults. Runtime secrets are never build arguments. Avoid `docker compose config` output, environment dumps or inspect/log capture that could reveal credentials; use `config --quiet` for syntax validation. Defined `ACCLIMATE_MODE`/`CONSOLE_MODE` values are errors and must be removed.

After installing the lockfile dependencies, `npm run check:console-config` checks explicit console configuration without starting a process. Neither it nor a build contacts the identity provider. Required application configuration is checked again by the actual Vite and built server entrypoints before listening. Builds require no runtime secrets.

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

PostgreSQL, Rust, console and proxy use restart policies and 90-second stop grace. Rust drains within 35 seconds plus bounded lock release; its singleton guard is held until work stops. `/health` is process liveness. `/ready` checks database usability, singleton ownership, initialized/live worker and non-draining state within a bounded probe. It does not prove queue progress, model/provider availability or evaluation quality. Console `/ready` validates configuration and upstream readiness without a provider discovery call on each probe.

A service startup applies embedded migrations while holding the singleton ownership lock, then registers only explicitly configured machine-grant project rows. Registration creates no human memberships. Migration failure prevents listening. Human operators create workspaces through verified sign-in; existing memberless workspaces require explicit audited adoption by exact ID and reason. Operator capability alone does not grant existing workspace access.

## Operate connected learning

1. Configure the service proposer in the private service environment using `ACCLIMATE_MODEL_ENDPOINT`, `ACCLIMATE_MODEL_TOKEN`, and `ACCLIMATE_MODEL`. The checkout accepts `gpt-6.2-sol`, `gpt-6-luna`, and `gpt-5.6-luna`. The proposer may make paid calls once eligible outcomes reach an enrolled connection.
2. Add two distinct machine principals to the workspace in `ACCLIMATE_AUTH`. Grant the outcome principal `write` and the evaluator principal `read` plus `write`. A grant has `token`, `principal_id`, `project_id`, and `rights`. Keep their tokens in the application and use a separate delivery credential. Restart the service with the updated configuration.
3. Build the app's development evaluator and independent audit evaluators with `defineEvaluation`. Prepare JSON with their public descriptors as `{ development: developmentApp.descriptor, audits: [auditApp.descriptor] }`. Set stable, disjoint dataset revisions and case IDs. Keep audit data and answers in the app. [Evaluator installation and reporting](../docs/evaluator-operations.md#serve-connected-learning) describes the worker and terminal hook.
4. As a workspace administrator, open **Connections**, select an enabled connection whose source channel already has a release, and choose **Set up continuous learning**. Enter a stable evaluator installation ID, the two machine principal IDs, one permitted existing bundle path per line, the proposal admission limit, and the descriptor JSON. Choose **Enroll connection**. Leave automatic rollout unchecked to review each qualifying release. Enabling automatic rollout also requires promotion authority. Automatic rollback defaults on for new enrollments and for existing enrollments when the migration runs. Clear the setting at enrollment or use **Disable automatic rollback** on an existing enrollment to opt out.
5. Start the app-side `acclimate-learning` process with its private evaluator config, persistent journal, connection UUID, installation ID, and compiled evaluator module. In the ordinary job path, resolve content with the same connection UUID and report the stable terminal outcome from the application's completion hook. Report only teaching summaries approved for proposer use.

Inspect **Continuous learning** on the connection for remaining proposal admissions, available audit cohorts, round results, and the current delivery target. A qualifying round in manual mode waits for an authorized release decision. Automatic rollout uses the exact candidate and passing audit evidence; it advances the enrolled connection's delivery target. The source channel and sibling connections retain their own targets. A stopped connection continues delivering its last released version.

Use **Add proposal admissions or audit cohorts** when the allowance or audit inventory runs low. Install new audit evaluators before making their descriptors available to the scheduler. Each audit is consumed when assigned, including interrupted audits. Use **Stop learning** to close further admission and rollout. An already-dispatched native evaluation may still be settling; keep its journal and reconcile the same attempt before taking action.

### Monitor and roll back a release

Post-rollout audits use real terminal jobs served by the active learned rollout on that connection. They run separately from the private audit cohorts used to qualify a release. A sample must bind the job's terminal outcome to a matching started receipt and the exact delivered version, digest, and delivery revision. The receipt must come from a fresh channel resolve with verified network or cache content and be at most 30 days old when the outcome is submitted. Explicit version pins, stale offline delivery, and jobs on the starting version before the first learned rollout are ineligible.

The TypeScript helper samples 10% of eligible jobs by default, using a stable hash of the project, connection, and outcome ID. The application can set `samplePercent` from 0 to 100, with 0 skipping all jobs. The rate stays fixed until the application changes it. The enrolled evaluator independently grades the recorded served behavior and a read-only replay with the previous version on the same private input. A regression requires incorrect served behavior and correct predecessor behavior. Unresolved grades and cases where both versions are incorrect do not add a verdict. A runtime failure alone supplies no regression verdict. [Wire the started receipt and evaluator into the job path](../docs/evaluator-operations.md#audit-fresh-jobs-after-rollout).

Inspect the round in **Continuous learning** for its post-rollout audit window and rollback promotion. Each managed rollout starts its own window. Upon recording a verdict, the service checks the latest ten accepted verdicts in submission order. With automatic rollback enabled, three regressions in that window restore the previous version, even before the window contains ten verdicts. The restored version gets a fresh delivery revision. Use **Disable automatic rollback** or **Enable automatic rollback** to change the connection policy. Disabling rollback still allows the evaluator to record verdicts. **Stop learning** or revoking the connection closes field audits and rollback as well.

The service retains the verdict, rollout and predecessor identities, delivery receipt reference, evaluator principal, and any rollback promotion. Keep private inputs and grading evidence in the app. Keep each completed verdict in the app's durable outbox until the service acknowledges it. After timeout or restart, resend the same verdict under the same evaluator identity. A retry of an accepted verdict returns its original result, including any rollback promotion, without adding to the window. If a new verdict is rejected because its rollout is no longer current, retain the report for inspection and close that job's audit. Missing receipts, unavailable inputs, and interrupted replays can reduce the sample count. Check the app's queue and evidence when the window stops advancing.

New online resolves on this connection pick up the restored version. Prepared jobs keep their original pins, and a client configured to use cached content while offline checks for a revision change when it can resolve online again. The source channel and sibling connections retain their own delivery targets.

## Upgrades and recovery

Use a coordinated stop, verified backup, upgraded start, readiness verification, then route traffic. There is no rolling or multi-process deployment guarantee. Stop traffic and both application containers before upgrading, preserve the PostgreSQL volume, and rehearse migration and restoration against disposable copies first. Never use `down --volumes` for retained data. Normal `docker compose down` preserves volumes.

The security cutover revokes old browser sessions once and requires fresh OIDC login. It preserves business records, machine credentials, memberships and exact content/version/history identities. Do not rewrite pending operation principals or replay old writes as the new human identity. Retain old metadata and inspect/resume only under the original service, project and principal with matching journal identity. Old launcher credentials do not grant a browser session. The explicit `evaluate:app -- --config /absolute/private/config.json ...` runner replaces launcher-state lookup; see the evaluator documentation for its private schema and app-owned handoff.

Supervisors restart failed processes with policy; investigate repeated failures. Exit code 75 identifies lost database ownership. The standalone service wrapper does not invent credentials or silently recover against another database. On SIGTERM readiness is withdrawn before HTTP/work draining and lock release. Backups include sensitive content and must be protected and restored on a schedule.

## Native and partial alternatives

For native execution, build `cargo build --locked --release` and `npm ci --ignore-scripts && npm run build`. Explicitly inject each process's runtime environment, then use `npm start` for Rust and `npm run start:console` for the built console. `ACCLIMATE_SERVICE_BINARY` may name an absolute installed service binary. `npm run dev` uses Vite with the same required production identity configuration. Console defaults to `HOST=127.0.0.1 PORT=3100`; bind a different address only behind the trusted proxy. No environment files are loaded implicitly by these commands.

`deploy/acclimate.service` is an **API-only partial alternative**, not a complete deployment. Install the release binary at `/usr/local/bin/acclimate-service`, create its dedicated user/group, and install a completed root-owned mode-0600 `/etc/acclimate/service.env`. Use loopback `ACCLIMATE_BIND=127.0.0.1:3000` and the actual separately provisioned PostgreSQL address instead of the Compose hostname. The authenticated console, PostgreSQL, TLS proxy, public DNS, backup and firewall remain separately required. Never enable the unit incidentally while editing or testing this repository.

## Qualification boundaries

`python3 scripts/productization/external.py` only prints the unrun gate ledger. Explicit `--execute --gate https` verifies live TLS, liveness, readiness and a machine-scoped read against a configured endpoint. `--execute --gate oidc --interactive` checks the actual supplied issuer/console through a disposable browser sign-in and logout. Supply `--url`, `--issuer` or `--project --token-env` as relevant, and a new private `--output` file for evidence. It never saves browser cookies.

`--execute --gate container` alone owns a random disposable project, private volume, test-only HTTPS issuer/certificates and the two deployment images. It qualifies only that isolated fixture stack, never a live provider or public certificate. No image is published and no other Compose project is stopped/pruned. Docker daemon execution was unavailable during implementation; manifest and source checks are not executed container qualification. Real deployment still requires the operator's issuer/client/origins/secrets. Paid model/native gates additionally require `--live`, use Luna only and remain distinct from application startup and model-free checks.

## Private backup and restore

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

It creates three randomly named databases, applies migrations and fixture records, compares all restored table data including exact binary payloads and history, tests refusal of a populated target and transactional failure, and drops only the databases it created. It does not alter the database named by `DATABASE_URL`. A process kill or database outage can interrupt cleanup; remove only the randomly named `acclimate_ops_…` databases after identifying them. This synthetic qualification does not prove any particular production backup is restorable; perform and verify a restore of each operational backup on an appropriate schedule.
