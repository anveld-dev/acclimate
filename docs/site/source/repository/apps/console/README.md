# Acclimate console

The TanStack Start console provides sign-in, workspace membership and invitations, machine tokens, bundles, releases, connections, delivery observations and learning.

- **Bundles** imports a payload and publishes the first release. **Content** reads, searches, copies and downloads verified files.
- **Releases** shows channel history and lets an authorized editor release an earlier version again with a reason. If a response is lost, use the retained operation to confirm, retry or close that request.
- **Connections** manages scoped connection and receipt credentials. The setup recipe prepares a version in the application environment.
- **Delivery** shows reported versions and receipt times. Under **Settings**, **Members** manages workspace access, **Model provider** holds the workspace's model endpoint for learning, and **Machine tokens** issues credentials for scripts and CI.
- **Learning** on a bundle sets up the loop, imports and reviews tasks, runs trials, and shows rounds, usage, alerts and rollback.

Bundle URLs name the workspace, bundle and channel. Mutations use explicit scope and the current verified session.

## Production identity and access

Keycloak is the chosen provider. The [sign-in setup](../../deploy/sign-in.md) records the exact realm issuer, confidential client, callback and operator mapping. The transport stays standard OIDC.

Rust requires `DATABASE_URL`, `ACCLIMATE_OIDC_ISSUER`, distinct `ACCLIMATE_LOGIN_TOKEN` and `ACCLIMATE_CONSOLE_TOKEN`, exact `{issuer,subject}` identities in `ACCLIMATE_OPERATORS`, and explicit machine grants in `ACCLIMATE_AUTH`. Machine SDKs work without browser sessions. Console transport plus a verified browser session is a separate authority; mixed machine/session requests are refused.

The console requires:

- `CONSOLE_ORIGIN`: public HTTPS origin, with the canonical Host forwarded by the TLS proxy.
- `CONSOLE_PUBLIC_API_URL`: public HTTPS API URL used in app setup recipes.
- `CONSOLE_SERVICE_URL`: private API endpoint.
- `CONSOLE_SERVICE_TOKEN` and `CONSOLE_LOGIN_TOKEN`: match the separate Rust credentials.
- `CONSOLE_OIDC_ISSUER`, `CONSOLE_OIDC_CLIENT_ID`, `CONSOLE_OIDC_CLIENT_SECRET`: real identity provider configuration.
- `CONSOLE_ALLOW_EDITS=true` to enable bundle creation, channel release, learning and administrative writes.

Remove `ACCLIMATE_MODE` and `CONSOLE_MODE`; they are rejected. Internal URLs and authority credentials never belong in SDK recipes. Forwarding headers do not establish identity or override the canonical public origin.

Operators may create a workspace or explicitly adopt an existing workspace with no memberships. Adoption requires review of the exact workspace, verified identity and reason; history never regrants a removed role. Workspace admins manage verified members. There is no first-visitor admin. Account holds your verified user ID and sign-out. Sign-out must confirm revocation before clearing its cookie; transport errors do not count as success.

OIDC uses the installed `openid-client` authorization-code flow with PKCE, state and nonce. Login transactions are bounded, process-local and expire after five minutes: run one console instance. Sessions retain the eight-hour policy; no refresh-token store is added. Migration 0013 requires fresh login while preserving stored users, memberships, content and machine credentials.

The [production plan](https://github.com/anveld-dev/acclimate/blob/ab0d8d3b5ba7fd33a468d6526edcd5d87cb722ef/docs/architecture/production-only/plan.md) records scope and the [shipping evidence](https://github.com/anveld-dev/acclimate/blob/ab0d8d3b5ba7fd33a468d6526edcd5d87cb722ef/docs/architecture/production-only/evidence.md) separates isolated acceptance from real-provider/public HTTPS and container qualification.

## Check it

```sh
npm run typecheck --workspace @acclimate/console
npm run test:console
npm run build:console
npm run test:bdd
python3 scripts/productization/rust_tests.py --pg-bin /path/to/postgresql/bin
python3 scripts/productization/qualify.py --pg-bin /path/to/postgresql/bin
python3 scripts/productization/hosted_authority.py --pg-bin /path/to/postgresql/bin
```

The runners own disposable databases and credentials. Browser QA uses the real Rust service and Chrome. Hosted-authority QA checks Rust sessions, bootstrap and revocation; it does not exercise a live OIDC provider. No model call is required. Any optional live model check must use Luna.

UI uses shadcn’s compact **Mira** style (`radix-mira` in `components.json`), Tailwind and Lucide. Registry components use the Mira style, with readable task-control overrides in the console. Desktop controls are compact; body content stays at 14px, and touch devices keep 44px button/navigation targets and 16px form text. Layout spacing lives in `src/styles.css`. Avoid global control minimums that override component sizes.

Components live in `src/components/ui`; routes and server functions live under `src/routes` and `src/server`. Only the `radix-mira` registry components the console uses are installed. Add another with the shadcn CLI when a page needs it, and keep existing customizations.

Use the shared Button, Input, Textarea, Label, Checkbox, RadioGroup and NativeSelect for controls. NativeSelect is a [shadcn component](https://ui.shadcn.com/docs/components/native-select), so native selection and form behavior stay intact. Navigation between routes stays links with `aria-current`; it isn't an in-page Tabs widget.

Expandable sections use `ui/disclosure`, a compact composition of shadcn's [Collapsible](https://ui.shadcn.com/docs/components/collapsible) and button styles. Its content stays mounted but hidden when closed, preserving edits while removing hidden controls from keyboard navigation. Use `defaultOpen` for an initial preference, or `open`/`onOpenChange` for stateful deep links. Don't add native `details` or duplicate disclosure styling in feature pages.

Add a missing primitive with `npx shadcn add <component> --cwd apps/console`, then review the generated changes. Don't overwrite the full library: our compact sizing, touch targets and application compositions are intentional. After library changes, typecheck, build and run the browser behaviors.

Bundle pages share one scope header; collection pages use PageTitle. Data updates through the existing polling hooks. Keep refresh buttons out of routine page chrome, and preserve unsaved browser edits during background updates.

Browser components import payload and native validators from `@acclimate/sdk/validation`. The main SDK entry includes Node filesystem helpers and belongs in server/app code. Check this boundary with the console behavior suite.
