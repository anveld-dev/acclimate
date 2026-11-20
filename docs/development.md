# Run Acclimate locally

If you already have a workspace, start with [Connect an existing agent](getting-started.md). This document covers developing and operating the service.

The first implementation is a Rust HTTP service, a TypeScript delivery SDK, and native preparation plugins. The app runs the agent. Start with PostgreSQL and the delivery example; model calls are optional.

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

For a fresh install, point the service at an empty database. Subsequent starts reuse the database initialized by this build. Keep any database created by the former migration chain with its matching service build. See the [deployment and recovery instructions](../deploy/README.md#upgrades-and-recovery).

Run one Rust process per database and one console process. `/health` is liveness; `/ready` requires database access, ownership, initialization and a live worker. Readiness is not a promise of provider availability or queue progress. SIGTERM withdraws readiness, stops new claims and drains within 35 seconds before releasing ownership. A lost ownership connection exits75. Your deployment supervisor restarts it with the same explicit configuration; there is no local launcher recovery mode.

HTTP requests have a 2MiB limit, 30-second deadline and 64-handler concurrency cap. Mutations and replay outcomes commit together. Existing prepared jobs stay pinned across releases and restarts. Keep database backups and test restoring with matching PostgreSQL tools.

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

The release workflow attaches the verified SDK, plugin and starter artifacts to a GitHub Release and publishes the service and console images to GitHub Container Registry. The SDKs and plugins are installed from release assets, with no npm or PyPI registry publication. See the [maintainer release instructions](releasing.md).

The independent package imports are `@acclimate/sdk` and `@acclimate/{codex,claude,pi,cursor}-plugin`. SDK-dependent helpers use `@acclimate/claude-plugin/native`, `@acclimate/pi-plugin/native`, and `@acclimate/cursor-plugin/native`. Install the corresponding optional native peer in the application: Claude Agent SDK `0.3.325` or `@earendil-works/pi-coding-agent` `1.5.2`. Cursor uses optional peer `@cursor/sdk` 1.3.1 (Node 22.13+). Pi's native loader requires Node 22.19+; preparation-only paths do not load that SDK.

Claude options and Pi's actual resource loader now have offline checks. Neither provider session is live-qualified. The separate `npm run test:codex-session` uses three explicit Luna turns for fresh v1, fresh v2 and resumed v1; it does not test in-place reload. Cursor now has verified local options and preparation; its live provider and scanner behavior remain unqualified.

## Use Python

Python 3.11+ is required. Run `python -m pip wheel --no-deps --wheel-dir artifacts ./python`, then install the generated wheel in your application. Runtime dependencies are standard library only. Its `AcclimateClient`, `resolve_and_cache`, and `prepare_files` helpers use the same R0 contract. The private filesystem helpers require POSIX.

Existing cache/preparation roots must already be private and owned by the current user. Both SDKs reject unsafe existing directories instead of changing their permissions.

## Checks

Use a disposable database. The tests create records and apply migrations; do not point them at a production database.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:verify
PYTHONPATH=python python -m unittest discover -s python/tests -v
python scripts/check-python-package.py
cargo fmt --check
cargo clippy --all-targets -- -D warnings
python3 scripts/productization/rust_tests.py --pg-bin /path/to/postgresql/bin
cargo build
npm run test:e2e -- --pg-bin /path/to/postgresql/bin
```

Plain `cargo test` reports tests that need PostgreSQL as ignored. The Rust test runner above provisions an isolated database and executes the full suite, including those tests.

The process-level test checks publication, cache and preparation, release, authorization, rollback and restart persistence. `npm run test:codex` is the separate live Luna-only check: it asks for random values stored only in prepared resources. It does not claim a direct SDK discovery event or cover resumed sessions.

Back up the database before production use, use dump/restore tools matching the server major version, test restoring it, choose retention for private evidence, and keep provider access with its operator. Production configuration is mandatory. Isolated acceptance evidence still does not prove that a particular public deployment or identity provider is ready.


## Earlier verification record

On 2026-11-13: 10 Rust tests, 24 TypeScript tests, strict Clippy/format/type checks, the built JavaScript entry points, and the PostgreSQL process-level flow passed. The proposal checks include interrupted attempts, allowed paths, oversized candidates, disabled providers, and durable authorship. PostgreSQL 16 backup/restore preserved the records and all six saved payload digests in the disposable process-test database.

The separate live check passed with Codex SDK `0.169.0` and `gpt-6-luna`, retrieving three fresh values held only in prepared resources. At that milestone, live Claude/Pi sessions, in-place session refresh, Windows ACLs, and a live service-side proposer call were unqualified. The full-roadmap record below adds the service proposer through a Luna SDK-backed test adapter. CI is configured; these results are from local runs, not a hosted CI run.


The SDK release pass added isolated TypeScript tarball consumers, an isolated Python wheel consumer and Python delivery against the running service. It checked real Claude/Pi loader interfaces offline, three Codex session turns, and a five-turn Luna author/compare run that recorded complete paired evidence without promotion. See the [milestone record](implementation/next-milestone.md) for boundaries and remaining limits. Audit findings were resolved by migrating the Pi dependency to its maintained package scope.


The completed release pass ran 12 Rust tests, 28 default TypeScript tests, 5 improvement-workflow tests and 5 Python tests. Strict builds/lint/type checks, external package consumers, process restart/ownership checks, and `npm audit` passed. Eight live `gpt-6-luna` turns covered the three-session qualification and five-turn improvement workflow. The latter recorded complete evidence and left its channel unchanged. A private retained copy is under `artifacts/qualification-2026-11-13/`; those IDs belong to the disposable test service, not a production channel.


The full-roadmap pass adds service-generated Luna evidence, the actual operator review/release/rollback path, Cursor preparation, scoped history in both SDKs, and matching-version backup/restore tests. The [acceptance ledger](implementation/full-roadmap.md) records that historical milestone.

## Behavior tests

Run `npm run test:bdd` to check the current user flows against disposable PostgreSQL, the real Rust service, public SDKs and the built console. Setup, focused runs and coverage limits are in the [behavior test guide](../features/README.md). The command makes no paid model calls and leaves your running app's data alone.

Sign-in has two separate regression gates: `npm run test:identity:protocol` checks generic OIDC failure cases on built/Vite consoles; `npm run test:identity:keycloak` checks the actual Keycloak distribution on both runtimes. Run `npm run test:identity:contracts` for deployment and fixture checks. See [Keycloak test setup](../features/README.md#keycloak-and-sign-in-coverage) for prerequisites and report paths. A fixture pass alone does not qualify Keycloak or a public deployment.
