# Production plan review

Four fresh reviewers checked authentication, scope, compatibility and acceptance, exchanged objections and converged on these decisions. No application code changed during planning/review.

| Objection | Resolved decision |
| --- | --- |
| Deleting all project backfill breaks configured machine clients' first bundle and project foreign keys | Retain explicit machine-grant project-row registration at startup. It creates no human memberships. Remove GET/read-time writes. |
| A new migrate/serve/schema-checker system adds machinery without fixing the browser bypass | Keep the existing singleton-lock-protected startup migration. Test failure-before-listen and upgrade preservation. |
| Removing SDK `sessionToken` is an unnecessary source break | Preserve compatibility; put unconditional session requirements in the console's server-only transport helper and Rust credential classification. |
| Adoption retries can restore a membership removed after the initial adoption | Immutable one-row-per-project audit; same recorded operator gets history, never a regrant. Recheck session/operator and serialize with membership writers. |
| A memberless workspace cannot use a membership-gated endpoint to become owned | Use the exact `/v1/auth/workspace-adoptions` action with dedicated console transport and operator session; no broad project-routing exemption. |
| Generic logout 401/404 can mean wrong transport or routing, not revoked session | Clear only after committed revocation or an explicit invalid-session result from the correctly authenticated transport. Preserve cookie on other failures. |
| An HTTPS configuration string does not establish trusted proxy routing | Define the canonical origin, Host reconstruction, stripped forwarding headers and private listeners; verify actual built console through the test TLS proxy. |
| Both Compose and systemd need not become two deployment platforms | One complete single-host Compose application recipe; both runtime artifacts required. Label API-only alternatives honestly. |
| TLS fixtures can accidentally become a runtime fake-identity mode | Keep the issuer/proxy/CA in tests only. Exercise the real installed OIDC client and callback; no production HTTP/identity bypass. |
| Every machine test need not launch browsers | Shared production config setup; only browser/protocol lanes start the issuer/console TLS fixture. Machine/API fixtures remain explicit and isolated. |
| Old browser sessions and local operation principals cannot be silently trusted or reassigned | Migration revokes old sessions once. Preserve receipt owners and pending metadata; document original-principal recovery before cutover. |
| A remote console is not a checkout evaluator | Default to app-owned request/config handoff; optional included runner requires an explicit private config path and preserves journal service/principal/root identity. |

## Review evidence

[Authentication](../../research/archive/production-planning/review-auth.md) · [Scope](../../research/archive/production-planning/review-scope.md) · [Compatibility](../../research/archive/production-planning/review-compat.md) · [Acceptance](../../research/archive/production-planning/review-acceptance.md).

The implementation must preserve all 141 behaviors / 183 variants and add focused production-only coverage. Local fixture success is not live-provider, public HTTPS or container qualification. Docker's daemon is unavailable; real deployment settings are still user inputs.
