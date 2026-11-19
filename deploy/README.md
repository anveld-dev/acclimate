# Single-host production deployment

Service-specific vocabulary is defined in [Internal terms](../CONTEXT.md#internal-terms).

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

On first startup, the service applies its embedded schema baseline to an empty database under the singleton ownership lock. Subsequent starts verify the recorded migration. The service then registers the projects named in explicit machine grants. Registration creates no human memberships. Migration failure prevents listening. Human operators create workspaces through verified sign-in; existing memberless workspaces require explicit audited adoption by exact ID and reason. Operator capability alone does not grant existing workspace access.

## Operate connected learning

1. Configure the service proposer in the private service environment using `ACCLIMATE_MODEL_ENDPOINT`, `ACCLIMATE_MODEL_TOKEN`, and `ACCLIMATE_MODEL`. The checkout accepts `gpt-6.2-sol`, `gpt-6-luna`, and `gpt-5.6-luna`. The proposer may make paid calls once eligible outcomes reach an enrolled connection.
2. Add two distinct machine principals to the workspace in `ACCLIMATE_AUTH`. Grant the outcome principal `write` and the evaluator principal `read` plus `write`. A grant has `token`, `principal_id`, `project_id`, and `rights`. Keep their tokens in the application and use a separate delivery credential. Restart the service with the updated configuration.
3. Define the development evaluator and each held-out audit evaluator in the application. Export their descriptors with `connectedEvaluationDescriptor(app)`. This binds the private fixtures, answers and repetitions to what the installed worker will grade. Supply distinct audit inputs and case identities across cohorts. Keep the inputs and answers in the app. [Install the evaluator and terminal hook](../docs/evaluator-operations.md#serve-connected-learning).
4. In **Connections**, select an enabled connection whose source channel has a published release and open its continuous learning setup. Enter an installation ID, both machine principals, permitted existing paths and proposal allowance. Register the development and audit descriptors. Select manual review or authorize automatic rollout. Each release affects only this connection. Automatic rollback defaults on.
5. Start the app-side `acclimate-learning` process with the enrollment's installation ID and a persistent evaluator journal. Resolve the connection once per job, retain its delivery revision, and report the job's terminal outcome. The app can attach an approved correction later. A correction observed on an older revision needs a private recheck on the current one.
6. Use [0,1] rewards with the v3 connected selection policies. A development step needs a one-sided 90% paired Student t bound above −0.03 and a gain, a passing targeted replay, or configured cost savings. A fresh cumulative comparison against published delivery needs a 90% bound above 0 before each audit, by default every three accepted steps. A fresh held-out audit needs a 95% bound above −0.03. Set `auditMode: "superiority"` to require held-out gain. Missing candidate trials get the worst observed reward, missing parent trials get the best observed reward, and the 15% cap applies per arm. Incomplete parent arms cannot be reused. Audit-rejected digests are blocked within the epoch. Field monitoring continues after validation. [Policy and enrollment contract](../contracts/learning.md#service-managed-connected-learning).

By default the proposer edits existing permitted files. To authorize structural changes, open **Manage skill package permissions** on an idle connection and specify the skill names the proposer may create or retire. Approve the two lists separately. Each creation must contain a valid `SKILL.md`. Include future file paths in the permitted path list if the learner should be able to edit those files on later rounds. Changes still undergo native compatibility checks, development comparison and an independent audit. Path-specific lessons only authorize edits to their named path.

Inspect recent rounds, remaining proposal admissions and unused audit cohorts on the connection. Install fresh audit evaluators before adding them to the service. An audit cohort is reserved while a round is active. A complete recorded comparison consumes it. A round that closes without one releases the cohort. To adopt a different grader, dataset or acceptance policy, finish the current round or wait for its review deadline, install the replacement evaluators, then renew with the new development descriptor or policies. Preserve the installed app and private journal for unsettled evaluations. Renewal uses the current renewal revision, which is separate from the connection's delivery revision.

Passing development steps accumulate on a private incumbent. Inspect its chain length, cumulative estimate and next audit trigger on the enrollment API. The service normally checks the cumulative head against the published delivery version after three accepted steps and audits it once if the cumulative development gate passes. Set `ACCLIMATE_LEARNING_MAX_STEPS_BETWEEN_AUDITS` (default 3) and `ACCLIMATE_LEARNING_MAX_CHAIN_AGE_SECONDS` (default 86,400) to tune this cadence; a chain is also checked when no admissible corrections remain. A failed cumulative check, failed audit, declined or expired review, policy epoch change, or published channel change resets search to the current delivery checkpoint. The stored search lineage remains available after reset or release. Deploy the updated SDK evaluator with the service so it accepts cumulative assignments.

Deploy the service and connected SDK evaluator together for planned repetitions. Set `ACCLIMATE_LEARNING_CALIBRATION_REPETITIONS` (default 2, range 2–5), `ACCLIMATE_LEARNING_MAX_REPETITIONS` (default 3, range 1–5), and `ACCLIMATE_LEARNING_PAIR_BUDGET` (default and ceiling 1,000 pairs, with the installed inventory as the minimum). Each pair requests two trials before any retries. The budget applies to development, cumulative and audit evaluations. Each evaluation uses the largest uniform count that fits the pair budget, repetition cap, and comparison report size limit. Explicit collection schedules retain their registered trial inventories. Calibration uses that same report limit and the separate 1,000-pair wire ceiling. Inspect `noiseCalibration` for counts, projected MDE and power. A gate stops epoch admission only when the lower end of its 95% projected MDE interval exceeds its `targetEffect`. If only the point estimate exceeds the target, inspection reports a warning and admission continues. The guard pools prior epochs with matching development, evaluator, baseline and repetition identities. Rotate the policy epoch to calibrate an already calibrated enrollment with the new planner. In 5,000 simulations with 30 cases (60% deterministic, 40% flaky), audit power at +5 points was 42.46% at 90 pairs versus 19.24% at 30 pairs. Pass rates at the −3-point boundary were 3.04% and 3.34%, respectively.

The enrollment field `maxCorrectionsPerRound` defaults to 5 and accepts 1–10. Set `ACCLIMATE_LEARNING_PARENT_MAX_AGE_SECONDS` and `ACCLIMATE_LEARNING_PARENT_MAX_REUSES` to control reuse of comparable development parent results. They default to 86,400 seconds and 3 uses. Either value can be set to 0 to disable reuse.

Set `ACCLIMATE_LEARNING_EVALUATION_SECONDS` to adjust the 24-hour evaluation deadline, measured from the start of execution. Queued requests can wait up to seven days. Set `ACCLIMATE_LEARNING_REVIEW_SECONDS` to adjust the 14-day review deadline. A round stops after five consecutive processing errors, and its latest error is visible in the enrollment view.

The enrollment retains its authorizer across ordinary settings edits. Enabling automatic rollout or rollback re-authorizes the enrollment. Automatic promotions and rollbacks record `service:connected-learning` as the reviewer and retain a reference to the authorization.

### Monitor and roll back a release

Attach the exact started receipt and revision to a served job's terminal outcome. The receipt must come from a fresh verified channel resolution and have reached the service within the previous 30 days. The app retains the original job and grades the served answer against a read-only replay on the same private input with the assigned control version. The SDK samples ten percent of eligible jobs by default. [Wire field evidence and replay](../docs/evaluator-operations.md#audit-fresh-jobs-after-rollout).

Submit completed verdicts even if the channel has since advanced. They belong to the revision the job used. Only a verdict for the current revision can automatically change delivery. The evaluator reports a paired win, loss or tie. The service compares 50% and 75% loss rates among discordant pairs with a sequential test at nominal alpha 0.05 and beta 0.20. A first upper-bound crossing can trigger rollback, and a first lower-bound crossing makes the release eligible as a future validated control. The enrolled source release supplies the initial control. When a version is restored, grading uses a distinct validated version if one is available.

A rollback takes effect on the next fresh resolve. Existing jobs retain their pins. Keep the private records behind the field regressions. Before reauthorizing withdrawn content, the evaluator must replay each triggering case three times under the proposed version and report at least two passes on the current baseline. Read the service's outstanding case IDs and retain the returned verdicts in the application's durable outbox. [Field requalification contract](../contracts/learning.md#service-managed-connected-learning).

To restore manually, open **Restore or refresh the delivery target** on the connection. Choose an earlier delivered release or the source channel's currently approved release. Review its exact revision and version, enter a reason, and submit against the connection's displayed delivery revision. The service records a new promotion, preserves connection identity and closes work built against the superseded baseline. A stale revision requires a fresh review. An enabled connection can be restored even after learning was stopped. A restore does not restart a stopped learner.

## Upgrades and recovery

This release starts from a fresh schema baseline. For an installation made with the former migration chain, keep the existing database and its matching service build together. To try this release alongside it, provision a separate empty PostgreSQL database and point the new service at it. The baseline has no in-place upgrade path for the former schema.

For deployments already on this baseline, stop traffic and both application containers before changing service versions. Take a backup and rehearse restoration on a separate database with the matching service build. Verify readiness and an authenticated read before routing traffic. Normal `docker compose down` preserves volumes. The `--volumes` option deletes them.

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

It creates three randomly named databases, installs the schema and inserts fixture records, compares all restored table data including exact binary payloads and history, tests refusal of a populated target and transactional failure, and drops only the databases it created. It does not alter the database named by `DATABASE_URL`. A process kill or database outage can interrupt cleanup; remove only the randomly named `acclimate_ops_…` databases after identifying them. This synthetic qualification does not prove any particular production backup is restorable; perform and verify a restore of each operational backup on an appropriate schedule.
