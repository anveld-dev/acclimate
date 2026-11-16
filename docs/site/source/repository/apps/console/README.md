# Acclimate console

TanStack Start UI for the Rust content service. Content, drafts, evaluations, releases and integration records come from PostgreSQL. Applications keep their own agent execution and grading.

## Start

The console always uses verified OIDC identity. Configure PostgreSQL, the Rust API, the console and TLS using the [deployment guide](../../deploy/README.md). No local-operator mode exists. Old `local`/`demo` commands fail without reading or changing their private files.

```sh
npm ci --ignore-scripts
npm run build
# Inject the required runtime environment, then:
npm run start:console
```

`npm run dev` uses Vite with the same production configuration and identity checks. Build is secret-free; either server refuses missing configuration before listening. Only the TLS proxy is public. Open `CONSOLE_ORIGIN`, not the private Node listener.

## Use it

1. **Workspace → Bundles:** choose a bundle and channel, or select New bundle to create, import JSON, or explicitly create an example. Choose the immutable compatibility target: generic, Codex, Claude, Pi or Cursor. Generic leaves native compatibility unchecked; stored origin labels remain separate from content quality.
2. **Content:** browse, filter and download the published files. Edit entry opens that same path in a draft under Changes; published content stays unchanged.
3. **Changes:** reopen a saved draft or suggestion. Save draft generations, import nested files, rename complete skill packages, and review the exact saved snapshot, including kind changes and empty-file additions/removals. Incomplete native metadata can be saved and repaired; publication checks the stored target. Unsaved text prompts before navigation, workspace/channel changes or refresh.
4. **Review release:** from a saved change, choose an evaluation configuration, create a new request, run the matching installed adapter, inspect its bound exact-version evidence, then deliberately publish that snapshot. Choose Release manually to publish without evaluation; it requires its own reason. Complete evidence can include a losing candidate; request state, report completeness and the release decision stay separate.
5. **Releases:** inspect/download historical versions or restore one with a reason. Releases affect future resolutions; existing prepared jobs stay pinned.
6. **App setup:** every authorized reader can open the bundle's real SDK delivery recipe. Applications own their agent loop and credentials; a connection record is optional.
7. **Connections:** workspace administrators manage existing bundle/channel-bound integration records, one-time credentials and optional app-reported receipts. Missing receipts mean unknown delivery. Members shows existing access and current roles in workspace settings, and the last admin cannot remove or demote themselves. Lost credential issuance responses can be reconciled without replaying a secret; replacement follows confirmed revocation. Personal identity and sign-out live in Account.

Audited writes keep their exact submitted snapshot in this tab's session storage before sending. If a response is lost, check the recorded outcome, retry that snapshot, or close the operation before reviewing a new one. Later edits stay separate. Forgetting text or seeing `not_observed` does not prove that the write failed. Logout/account changes purge submitted text; unresolved metadata remains available for reconciliation.

## Run an evaluation

The **Evaluation configuration** selector offers:

- **Payment retry simulator:** model-free payment traces from declarative `payment-policy.json`; this checks orchestration. Missing policy can produce complete zero scores.
- **File presence contract:** model-free instruction/skill presence checks, with no behavioral quality claim.
- **Native Codex review · Luna:** installed retry-review cases and an independent grader, with at most four bounded Luna turns.
- **My app's installed evaluator:** paste public JSON containing dataset/grader revisions, runtime `configId`/`configRevision` and settings, and expected case/repetition pairs. Keep credentials and case contents in your app.

Selecting a profile and creating a request do not execute an agent or call a model. Copy the request ID and frozen public configuration to your application's installed runner. The app owns execution, isolation and grading.

The included checkout runner is optional and needs an explicit owner-only configuration file:

```sh
npm run evaluate:app -- --config /absolute/private/evaluator.json --bundleID UUID --requestID UUID --adapter payment-retry
```

See the [adapter guide](../../examples/evaluation/README.md) for exact adapter names, configuration schema and journal recovery. The console never assumes its server can run your app's evaluator. There is no `.local` or ambient credential fallback. Native Codex evaluation additionally requires `--adapter codex-luna-review --live`; that explicitly permits bounded Luna calls.

The installed adapter must structurally match the frozen request before execution. Other app configurations need that app's installed runner; the console does not download or launch code from a descriptor. See [the adapter guide](../../examples/evaluation/README.md) for policy data, runner callbacks and attempt-journal recovery. An uncertain helper retry keeps the same request/attempt; an explicit new evaluation gets a new request. Legacy unbound evidence remains labeled.

Bundle URLs identify their workspace and bundle; channel-specific views also identify the channel. Saved details, selected files and search can be bookmarked. Another tab's remembered selection cannot retarget an open form. The old Overview/Setup/Improvement URLs redirect to scoped destinations; they aren't sidebar pages.

The SDK writes real local files when preparing a bundle. Console paths are entries inside a stored bundle, not files synchronized from a repository checkout.

## Production identity and access

Keycloak is the chosen provider. The [sign-in setup](../../deploy/sign-in.md) records the exact realm issuer, confidential client, callback and operator mapping. The transport stays standard OIDC.

Rust requires `DATABASE_URL`, `ACCLIMATE_OIDC_ISSUER`, distinct `ACCLIMATE_LOGIN_TOKEN` and `ACCLIMATE_CONSOLE_TOKEN`, exact `{issuer,subject}` identities in `ACCLIMATE_OPERATORS`, and explicit machine grants in `ACCLIMATE_AUTH`. Machine SDKs work without browser sessions. Console transport plus a verified browser session is a separate authority; mixed machine/session requests are refused.

The console requires:

- `CONSOLE_ORIGIN`: public HTTPS origin, with the canonical Host forwarded by the TLS proxy.
- `CONSOLE_PUBLIC_API_URL`: public HTTPS API URL used in app setup recipes.
- `CONSOLE_SERVICE_URL`: private API endpoint.
- `CONSOLE_SERVICE_TOKEN` and `CONSOLE_LOGIN_TOKEN`: match the separate Rust credentials.
- `CONSOLE_OIDC_ISSUER`, `CONSOLE_OIDC_CLIENT_ID`, `CONSOLE_OIDC_CLIENT_SECRET`: real identity provider configuration.
- `CONSOLE_ALLOW_EDITS=true` to enable authoring.

Remove `ACCLIMATE_MODE` and `CONSOLE_MODE`; they are rejected. Internal URLs and authority credentials never belong in SDK recipes. Forwarding headers do not establish identity or override the canonical public origin.

Operators may create a workspace or explicitly adopt an existing project with no memberships. Adoption requires review of the exact project, verified identity and reason; history never regrants a removed role. Workspace admins manage verified members. There is no first-visitor admin. Account holds your verified user ID and sign-out. Sign-out must confirm revocation before clearing its cookie; transport errors do not count as success.

OIDC uses the installed `openid-client` authorization-code flow with PKCE, state and nonce. Login transactions are bounded, process-local and expire after five minutes: run one console instance. Sessions retain the eight-hour policy; no refresh-token store is added. Migration 0013 requires fresh login while preserving stored users, memberships, content and machine credentials.

The [production plan](../../docs/architecture/production-only/plan.md) records scope and the [shipping evidence](../../docs/architecture/production-only/evidence.md) separates isolated acceptance from real-provider/public HTTPS and container qualification.

## Check it

```sh
npm run typecheck
npm test
npm run test:bdd
npm run test:evaluator
npm run build
python3 scripts/productization/rust_tests.py --pg-bin /path/to/postgresql/bin
python3 scripts/productization/qualify.py --pg-bin /path/to/postgresql/bin
python3 scripts/productization/hosted_authority.py --pg-bin /path/to/postgresql/bin
```

The runners own disposable databases and credentials. Browser QA uses the real Rust service and Chrome. Hosted-authority QA checks Rust sessions, bootstrap and revocation; it does not exercise a live OIDC provider. No model call is required. Any optional live model check must use Luna.

UI uses shadcn’s compact **Mira** style (`radix-mira` in `components.json`), Tailwind and Lucide. The 63 shared components use the Mira registry style, with readable task-control overrides in the console. Desktop controls are compact; body content stays at 14px, and touch devices keep 44px button/navigation targets and 16px form text. Layout spacing lives in `src/styles.css`. Avoid global control minimums that override component sizes.

Components live in `src/components/ui`; routes and server functions live under `src/routes` and `src/server`. To refresh the full component library, run `npx shadcn add --all --overwrite --yes --cwd apps/console` from the repo root, then typecheck and run the browser behaviors.

Browser components import payload and native validators from `@acclimate/sdk/validation`. The main SDK entry includes Node filesystem helpers and belongs in server/app code. Check this boundary with `npm run test:bdd -- --dev-console --tags @UI-DRAFT-02`; production bundling alone can hide an unsafe import.

## Check the UI

Content, Changes, Releases and App setup share one bundle header. Drafts use a channel-specific list; suggestions remain bundle-wide. New bundle has one source mode and explicitly creates and publishes. Saved drafts lead to Review release, where app evaluation and manual release are separate choices. App setup offers one language recipe at a time.

Task controls use 14px text and roughly 32px desktop height; touch targets remain 44px with 16px mobile inputs. Existing saved-write, authorization, evidence and pinned-job rules still apply.

The behavior suite covers responsive layouts, touch controls, keyboard focus and recovery. For actual Chrome 200% zoom against a disposable service, build first, then run:

```sh
.venv-bdd/bin/python scripts/test_console_native_zoom.py --output artifacts/ui-native-zoom
```

The output path must be new. This check needs installed Chrome, PostgreSQL server binaries and the BDD Python dependencies; it does not read the running workspace's private configuration or call models.
