# Production sign-in

Use **Keycloak**. The service stays **Axum + SQLx + PostgreSQL**; the console uses its existing OIDC client. Keycloak manages login and credentials. Rust keeps application sessions, current workspace memberships, audit attribution and machine SDK access.

Follow the [Keycloak setup](keycloak/README.md) for the pinned production image, PostgreSQL deployment, realm/client import and first-operator steps. Use the base stack for an existing Keycloak deployment, or add `compose.keycloak.yaml` to co-host it. No other provider is selected.

| Purpose | Address convention |
| --- | --- |
| Console | `https://console.<your-domain>` |
| API | `https://api.<your-domain>` |
| Keycloak | `https://auth.<your-domain>` |
| Realm issuer | `https://auth.<your-domain>/realms/acclimate` |
| OIDC client ID | `acclimate-console` |
| Exact callback | `https://console.<your-domain>/auth/callback` |

Use owned DNS and real runtime credentials. Template names are not deployed resources. Copy the issuer verbatim into `CONSOLE_OIDC_ISSUER`, `ACCLIMATE_OIDC_ISSUER` and each operator identity. The operator subject is the exact Keycloak user UUID, not an email or the application's separate user ID.

The client is confidential, uses authorization code with S256 PKCE, and receives signature-verified RS256 ID tokens. Its client secret is distinct from Rust's two authority credentials. No browser session or Keycloak credential replaces a background application's scoped SDK token.

Keycloak identity administration does not grant Acclimate workspace access. Membership and session revocation still happen in Rust. Changing issuer requires an explicit identity migration; existing rows are never silently reassigned by email. Application sign-out revokes its session and does not promise provider-wide logout.

The [research comparison](../docs/research/auth-setups.md) explains the alternatives considered. The provider decision is now settled; live public-deployment qualification remains separate from isolated testing.
