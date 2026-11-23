# Run Acclimate locally

If you already have a workspace, start with [Connect an existing agent](getting-started.md). This document covers developing and operating the service.

The Rust service uses PostgreSQL. The TypeScript and Python SDKs deliver versioned content and run app-side learning evaluations. Start with the local stack and the delivery example. Configure an optimizer endpoint to run learning rounds.

## Configure the app

There is one production identity path, including during development. PostgreSQL 16 stores all service data. The console uses Keycloak through OIDC and HTTPS; browser users need verified sessions and workspace membership. Machine SDK credentials stay separate.

For laptop development, run `npm run local:up` from the checkout. The [local stack guide](../apps/docs/content/docs/get-started/run-locally.mdx) covers prerequisites, Caddy's local CA and the bootstrap login.

Use the [deployment guide](../deploy/README.md) for production hosting and required private configuration. The [console guide](../apps/console/README.md) lists identity settings. Builds need no runtime credentials:

```sh
npm ci --ignore-scripts
npm run build
cargo build --release
```

Inject runtime environment from your secret manager. `npm start` starts the built Rust service, `npm run start:console` starts the built console, and `npm run dev` runs Vite with the same required production configuration. Supply an explicitly provisioned PostgreSQL database and credentials for both processes.

Rust validates PostgreSQL/access/issuer configuration before listening, holds exclusive queue ownership, initializes the schema and registers the workspaces named in explicit machine grants. That registration never grants human membership. The console validates its own required settings before built or development listening. Use the public console URL through the configured TLS proxy, not its private listener.

## Access and startup

The exact operator identities configured for the pinned issuer may create workspaces. To recover an existing machine-created workspace with no human memberships, an operator reviews its exact ID, their verified identity and a reason, then explicitly adopts it. The immutable audit never silently restores access on retry. Other access changes use current workspace admins and verified user IDs.

For a fresh install, point the service at an empty database. Startup applies pending migrations. Before upgrading an existing database, back it up and review the [destructive learning-loop migrations](../deploy/README.md#upgrade-to-the-learning-loop-schema).

Run one Rust process per database and one console process. `/health` is liveness. `/ready` requires database access, ownership, initialization and a live learning worker. Readiness is not a promise of provider availability or queue progress. SIGTERM withdraws readiness, stops new claims and drains within 35 seconds before releasing ownership. A lost ownership connection exits with code 75. Your deployment supervisor restarts it with the same explicit configuration; there is no local launcher recovery mode.

HTTP requests have a 2 MiB limit, 30-second deadline and 64-handler concurrency cap. Mutations and replay outcomes commit together. Existing prepared jobs stay pinned across releases and restarts. Keep database backups and test restoring with matching PostgreSQL tools.

## Publish and consume content

Configure `ACCLIMATE_URL`, `ACCLIMATE_WORKSPACE`, `ACCLIMATE_SCOPE` and `ACCLIMATE_TOKEN` for the workspace. To publish the first version of a new bundle, supply your bundle JSON, its name and the reason for the initial release.

```sh
npm run example:publish -- "$BUNDLE_FILE" "$BUNDLE_NAME" "$INITIAL_RELEASE_REASON"
```

The service creates the bundle, version and channel in one operation. The channel defaults to `stable`. Set `ACCLIMATE_CHANNEL` to choose another, or `ACCLIMATE_OPERATION_ID` to reuse the same operation on retry.

Set `ACCLIMATE_BUNDLE` to the printed bundle ID. Pass a task from your application to start a paid Codex session.

```sh
npm run example:codex -- --live "$TASK"
```

The explicit --live flag authorizes a paid Luna turn using the official Codex SDK and existing app authentication. The app fetches a fresh channel mapping, verifies/caches immutable bytes, prepares native files, then starts a fresh read-only session. Only `gpt-6-luna` and `gpt-5.6-luna` are accepted; the default is `gpt-6-luna`. The service never receives Codex credentials. The example requests cancellation after 110 seconds; an SDK error does not prove external termination. Successful completion cleans the prepared inputs, while unconfirmed execution retains them and reports uncertainty. Use the [native repository starter](../examples/native-repository/README.md) for persistent private job locators and explicit quarantine recovery. No new live-provider termination guarantee is claimed.

The cache uses `ACCLIMATE_CACHE` or `~/.cache/acclimate`. Its root must be private and have no symlink ancestors; choose a canonical path if your machine uses symlinked home or temp directories. `ACCLIMATE_SCOPE` must identify the authenticated app principal consistently; never reuse it across unrelated principals. Refresh does not modify active sessions.

`npm run build:packages` emits JavaScript and type declarations under `dist/`. `npm run build` builds both the packages and web console. Local package entry points are `acclimate/sdk`, `acclimate/codex-plugin`, `acclimate/claude-plugin`, `acclimate/pi-plugin`, and `acclimate/cursor-plugin`. Build locally installable packages with `npm run build:packages`, then use `npm pack --workspace @acclimate/sdk --pack-destination artifacts` (create `artifacts/` first). Repeat for each plugin you use, including `@acclimate/cursor-plugin` if needed. Install the SDK tarball and selected plugin tarballs together in the external app, for example `npm install /path/artifacts/acclimate-sdk-0.1.0.tgz /path/artifacts/acclimate-codex-plugin-0.1.0.tgz`. `npm run pack:verify` builds and retains versioned tarballs, the Python wheel, SHA256SUMS and a manifest under `artifacts/releases/<version>/`, after checking isolated external consumers. It refuses an existing release output; use `npm run pack:verify -- --output /new/private/release` for another run. Preparation-only imports work without native peers.

The release workflow attaches the verified SDK, plugin and starter artifacts to a GitHub Release and publishes the service and console images to GitHub Container Registry. Installers can use the release assets. Registry publication is a separate workflow dispatch. See the [maintainer release instructions](releasing.md).

The independent package imports are `@acclimate/sdk` and `@acclimate/{codex,claude,pi,cursor}-plugin`. SDK-dependent helpers use `@acclimate/claude-plugin/native`, `@acclimate/pi-plugin/native`, and `@acclimate/cursor-plugin/native`. Install the corresponding optional native peer in the application: Claude Agent SDK `0.3.325` or `@earendil-works/pi-coding-agent` `1.5.2`. Cursor uses optional peer `@cursor/sdk` 1.3.1 (Node 22.13+). Pi's native loader requires Node 22.19+; preparation-only paths do not load that SDK.

Claude options and Pi's actual resource loader now have offline checks. Neither provider session is live-qualified. The separate `npm run test:codex-session` uses three explicit Luna turns for fresh v1, fresh v2 and resumed v1; it does not test in-place reload. Cursor now has verified local options and preparation; its live provider and scanner behavior remain unqualified.

## Use Python

Python 3.11+ is required. Run `python -m pip wheel --no-deps --wheel-dir artifacts ./python`, then install the generated wheel in your application. Runtime dependencies are standard library only. Its `AcclimateClient`, `resolve_and_cache`, and `prepare_files` helpers use the same HTTP and payload contracts. The private filesystem helpers require POSIX.

Existing cache/preparation roots must already be private and owned by the current user. Both SDKs reject unsafe existing directories instead of changing their permissions.

## Checks

Install the lint prerequisites in the repository’s development instructions. Use Python 3.11 or later on your PATH as `python3`. The database integration runners below provision disposable clusters and need PostgreSQL server binaries.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:verify
PYTHONPATH=python python3 -m unittest discover -s python/tests -v
python3 scripts/check-python-package.py
cargo fmt --check
cargo clippy --all-targets -- -D warnings
python3 scripts/productization/rust_tests.py --pg-bin /path/to/postgresql/bin
PG_BIN=/path/to/postgresql/bin python3 executor/tests/central_learning.py -v
cargo build
npm run test:e2e -- --pg-bin /path/to/postgresql/bin
npm run test:learning-e2e -- --pg-bin /path/to/postgresql/bin
npm run test:learn-cli -- --pg-bin /path/to/postgresql/bin
```

Plain `cargo test` reports tests that need PostgreSQL as ignored. The Rust test runner above provisions an isolated database and executes the full suite, including those tests.

The central learning gate starts a private PostgreSQL cluster, the service, an executor container, and a scripted model endpoint. It kills and restarts the executor during a live sandbox run and waits for lease expiry. Set `ACCLIMATE_SANDBOX_RUNTIME=runsc` to exercise gVisor on a configured Linux host. Docker Desktop uses plain Docker by default.

For the model-free experiment checks, install the grader dependencies and run the simulation as shown in the [experiment README](../examples/self-improvement-memory/README.md#prepare-and-check-the-fixtures). The learning integration runners use scripted optimizers and require no provider credentials.

The process-level test checks publication, cache and preparation, release, authorization, rollback and restart persistence. `npm run test:codex` is the separate live Luna-only check: it asks for random values stored only in prepared resources. It does not claim a direct SDK discovery event or cover resumed sessions.

Back up the database before production use, use dump/restore tools matching the server major version, test restoring it, choose retention for private evidence, and keep provider access with its operator. Production configuration is mandatory. Isolated acceptance evidence still does not prove that a particular public deployment or identity provider is ready.

## Behavior tests

Run `npm run test:bdd` to check the current user flows against disposable PostgreSQL, the real Rust service, public SDKs and the built console. Setup, focused runs and coverage limits are in the [behavior test guide](../features/README.md). The command makes no paid model calls and leaves your running app's data alone.

Sign-in has two separate regression gates: `npm run test:identity:protocol` checks generic OIDC failure cases on built/Vite consoles; `npm run test:identity:keycloak` checks the actual Keycloak distribution on both runtimes. Run `npm run test:identity:contracts` for deployment and fixture checks. See [Keycloak test setup](../features/README.md#keycloak-and-sign-in-coverage) for prerequisites and report paths. A fixture pass alone does not qualify Keycloak or a public deployment.
