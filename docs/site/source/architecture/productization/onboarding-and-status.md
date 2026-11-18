# Onboarding and truthful status

**Implemented.** Start with an empty workspace and show what Acclimate knows about content and connections. 

The console starts from authorized workspace data. Channel reads resolve a version, verify the payload digest and read its history. Stored bundle provenance supplies its origin label. The [deploy guide](../../../deploy/README.md) describes service liveness and database readiness.

## First useful session

A verified operator can create a workspace or adopt an existing unowned project. A new workspace starts empty. Choose **Create your first bundle** to write instructions, upload files or import bundle JSON. File and JSON imports show a preview and require confirmation. The atomic bundle-setup transaction records the supplied content, origin, initial version and channel together. Historical bundles retain their original labels, including **Example content**. Bundle and channel selection uses scoped IDs and checks current access. [Drafts and content](drafts-and-content.md)

After publication, App setup provides the scoped credential and SDK instructions for checking a delivery. A console read establishes that the console accessed the bundle. The connection view uses the application's verified/prepared receipts to report what the app received.

## Contracts and status

Add server-owned provenance to each bundle: `origin` = `example | imported | created | unknown`, `created_at`, and optional `source_label` supplied as `sourceLabel` by the atomic setup flow under the bounds in the content plan. Return it in scoped bundle list/detail responses. Origin is set atomically at creation by the authorized operation, persists through edits/releases, and is not a security or quality claim. Existing bundles migrate to `unknown`; never classify them from names or `CONSOLE_DATA_SOURCE`. Offer an explicit operator adoption action to mark a known legacy example, with confirmation and audit; do not overwrite content or promote it. Existing demo state may identify a candidate, never silently relabel it.

Use a project-scoped, authorized list of `{id, name, origin}` and available channel names for selection. Reuse channel resolution and exact-byte verification; distinguish an empty list from access denied or a failed list. Keep credentials server-side. The import and SDK owners define their own operation and verification contracts; this page consumes their confirmed results rather than inventing protocols.

For the selected channel, show **Last successful read** with timestamp, version and revision only after resolution, digest verification and required content read succeed. A timestamp is an observation, not a promise of current availability: after a failed refresh show “Last read at …; current state unknown” and the safe error. With no successful read, say “Not read yet.” If retained in memory, stale content is visibly marked and editing/publishing disabled until refreshed; if not retained, show no content. A failed request alone does not prove the service is offline. Separate optional service liveness (`/health` responded at time) from readiness: readiness is unknown unless an authenticated representative read succeeds, and is only a point-in-time observation. Never infer app connectivity from service health.

Show pending during requests, confirmed success, and sanitized errors for authorization, selection, verification and network failure. For an ambiguous write timeout, preserve the draft and say “We couldn’t confirm the result. Check Releases before retrying.” Reconcile using the [content operation lookup](drafts-and-content.md#recover-uncertain-writes) and a fresh read, including after browser restart and the old cache expiry; never issue a new key blindly or claim failure. Keep the draft workspace’s ambiguous-write warning and operation recovery in bundle creation and asynchronous import.

## Delivery order and checks

1. Service owner: migrations and `src/bundles.rs` list/detail/create provenance and adoption authorization; SDK owner exposes typed reads. Coordinate origin values with import owner. Migrate legacy records as unknown and test project isolation and adoption.
2. Console owner: `apps/console/src/server/channel.ts`, server functions and routes implement selection, empty/setup/error states and the verified-read observation; remove the environment-derived label. Test duplicate names, safe rendering, denied access, digest failure, failed refresh and ambiguous writes.
3. Local operator owner: keep ordinary startup empty and preserve previously stored bundles. Update `apps/console/README.md` and deployment instructions. No startup should silently seed or alter an existing workspace.
4. Hosted-mode owner: add authenticated browser sessions, tenant-scoped authorization and CSRF protection before exposing selection or writes. Local mode remains loopback-only with a server-held project token. Do not imply that the current console is hosted-ready.

Acceptance: a clean real workspace stays empty across restarts; a historical example stays labelled after restart and edits; legacy content remains unknown until deliberate adoption; an imported bundle and an example with the same name remain distinguishable and selectable by ID. A verified read followed by an outage reports the prior observation and unknown current state, while `/health` alone never turns readiness green. A timed-out publish is reconciled without a duplicate release. A configured app shows only its reported facts; missing optional reports remain unknown, and inaccessible projects never appear in selection.

Defer dashboards, generic monitoring, automatic trace capture, billing and claims about evaluation or quality. 
