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

1. **Workspace → Bundles:** choose a bundle and channel, or select New bundle to write instructions, upload files, or import bundle JSON. Choose the fixed compatibility target from generic, Codex, Claude, Pi or Cursor. Generic leaves native compatibility unchecked.
2. **Content:** browse, filter and download the published files. Edit entry opens that same path in a draft under Changes; published content stays unchanged.
3. **Changes:** reopen a saved draft or suggestion. Save draft generations, import nested files, rename complete skill packages, and review the exact saved snapshot, including kind changes and empty-file additions/removals. Incomplete native metadata can be saved and repaired; publication checks the stored target. Unsaved text prompts before navigation, workspace/channel changes or refresh.
4. **Review release:** from a saved change, paste the installed evaluator’s public configuration, create a request, run the matching application, inspect its bound exact-version evidence, then deliberately publish that snapshot. Choose Release manually to publish without evaluation; it requires its own reason. Complete evidence can include a losing candidate; request state, report completeness and the release decision stay separate.
5. **Releases:** inspect/download historical versions or restore one with a reason. Releases affect future resolutions; existing prepared jobs stay pinned.
6. **App setup:** every authorized reader can open the bundle's real SDK delivery recipe. Applications own their agent loop and credentials; a connection record is optional.
7. **Connections:** workspace administrators manage existing bundle/channel-bound integration records, one-time credentials and optional app-reported receipts. Missing receipts mean unknown delivery. Members shows existing access and current roles in workspace settings, and the last admin cannot remove or demote themselves. Lost credential issuance responses can be reconciled without replaying a secret; replacement follows confirmed revocation. Personal identity and sign-out live in Account.

Audited writes keep their exact submitted snapshot in this tab's session storage before sending. If a response is lost, check the recorded outcome, retry that snapshot, or close the operation before reviewing a new one. Later edits stay separate. Forgetting text or seeing `not_observed` does not prove that the write failed. Logout/account changes purge submitted text; unresolved metadata remains available for reconciliation.

## Run an evaluation

On a saved candidate, paste the JSON from your installed evaluator’s `describe` command.
The console previews the dataset, grader, configuration revision and case inventory.
The SDK’s evaluation CLI loads your installed cases, agent and grader from the adjacent
application module. Set `ACCLIMATE_EVALUATOR_CASES` if you keep the cases in a private JSON file. For the native Codex reviewer, run
`npm run --silent evaluate:app -- describe` in its checkout.

Create the request, download `evaluation-request.json`, and give it to the evaluator owner.
Select Node.js or Python for the matching `compare` command. It reports scores and accepts an optional policy file. A recognized native Codex request
shows its checkout command. The evaluator runs the frozen parent and candidate. The request
shows its reported activity, coverage, and paired grades. Use the policy-check command
beside a bound comparison with the application’s own quality-policy file before deciding
whether to publish the saved snapshot. Checking with the evaluator principal stores its policy identity, digest, verdict and named checks on the comparison. An evidence-based release of a candidate with failed or indeterminate verdicts requires a reviewer to acknowledge the exact receipts and record an override reason. [Application evaluator setup](../../examples/evaluation-starter/README.md)

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

UI uses shadcn’s compact **Mira** style (`radix-mira` in `components.json`), Tailwind and Lucide. Registry components use the Mira style, with readable task-control overrides in the console. Desktop controls are compact; body content stays at 14px, and touch devices keep 44px button/navigation targets and 16px form text. Layout spacing lives in `src/styles.css`. Avoid global control minimums that override component sizes.

Components live in `src/components/ui`; routes and server functions live under `src/routes` and `src/server`. All 63 file-providing entries in the official `radix-mira` UI registry are installed. The upstream `form` entry currently provides no files; use Field for form composition. The registry inventory was verified against shadcn 4.23.0; existing application customizations are preserved.

Charts use the existing `ui/chart` components with Recharts 3.8: ChartContainer, themed config, tooltip and legend. Compose area, bar, line, pie, radar and radial charts with Recharts primitives inside that wrapper. Reuse these before introducing another chart library. See the [official chart guide](https://ui.shadcn.com/docs/components/chart).

Use the shared Button, Input, Textarea, Label, Checkbox, RadioGroup and NativeSelect for controls. NativeSelect is a [shadcn component](https://ui.shadcn.com/docs/components/native-select), so native selection and form behavior stay intact. Navigation between routes stays links with `aria-current`; it isn't an in-page Tabs widget.

Expandable sections use `ui/disclosure`, a compact composition of shadcn's [Collapsible](https://ui.shadcn.com/docs/components/collapsible) and button styles. Its content stays mounted but hidden when closed, preserving edits while removing hidden controls from keyboard navigation. Use `defaultOpen` for an initial preference, or `open`/`onOpenChange` for stateful deep links. Don't add native `details` or duplicate disclosure styling in feature pages.

Add a missing primitive with `npx shadcn add <component> --cwd apps/console`, then review the generated changes. Don't overwrite the full library: our compact sizing, touch targets and application compositions are intentional. After library changes, typecheck, build and run the browser behaviors.

Bundle pages share one scope header; collection pages use PageTitle. Data updates through the existing polling hooks. Keep refresh buttons out of routine page chrome, and preserve unsaved browser edits during background updates.

Draft toolbar actions wrap within the workbench, keeping Save, Review and Continue available without a duplicate mobile menu. Evaluation always names its saved snapshot. Keep the published-parent comparison label, dirty-navigation guards and focus return when changing this layout.

Browser components import payload and native validators from `@acclimate/sdk/validation`. The main SDK entry includes Node filesystem helpers and belongs in server/app code. Check this boundary with `npm run test:bdd -- --dev-console --tags @UI-DRAFT-02`; production bundling alone can hide an unsafe import.

## Check the UI

Content, Changes, Releases and App setup share one bundle header. Drafts use a channel-specific list; suggestions remain bundle-wide. New bundle has one source mode and explicitly creates and publishes. Saved drafts lead to Review release, where app evaluation and manual release are separate choices. App setup offers one language recipe at a time.

Task controls use 14px text and roughly 32px desktop height; touch targets remain 44px with 16px mobile inputs. Existing saved-write, authorization, evidence and pinned-job rules still apply.

The behavior suite covers responsive layouts, touch controls, keyboard focus and recovery. For actual Chrome 200% zoom against a disposable service, build first, then run:

```sh
.venv-bdd/bin/python scripts/test_console_native_zoom.py --output artifacts/ui-native-zoom
```

The output path must be new. This check needs installed Chrome, PostgreSQL server binaries and the BDD Python dependencies; it does not read the running workspace's private configuration or call models.

Evaluation cases use shared Table and Disclosure components: compact paired summaries, adjacent Parent/Candidate details, and labeled stacking in narrow containers. Keep signed rewards, missing evidence, unknown cost and output references honest. Case maps keep one roving tab stop inside a bounded scroll area. For the focused PostgreSQL/OIDC browser qualification after building:

```sh
.venv-bdd/bin/python scripts/testing/evaluation_layouts.py --verify --cases 600 --output artifacts/evaluation-check
.venv-bdd/bin/python scripts/testing/evaluation_focus.py --output artifacts/evaluation-focus-check
```

Use fresh output directories. The second runner mounts actual components in Vite to check comparison replacement focus and the shared chart; it does not change stored comparisons.
