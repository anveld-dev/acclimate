# Headers, members and sign-in

Workspace and bundle pages now share `PageHeader`: matching title typography, left alignment and action placement. Bundle Back stays above the title. Descriptions get their own full-width row.

Members uses names from the sign-in profile and a role menu in each row. Invite is a compact email-and-role form. The recipient must sign in with that verified email and explicitly join. Pending invitations support resend and revoke; SMTP delivery is queued in PostgreSQL (migration 0015). [Local Mailpit setup](../../../deploy/mailpit.md) captures invites and Keycloak verification emails. The row action menu copies the user ID or opens removal confirmation. Keyboard focus returns to the row after an action. Optional display names are stored by migration 0014; issuer and subject still determine identity and access.

The [Keycloakify theme](../../../apps/keycloak-theme/README.md) shares the console's color tokens and font. The production Keycloak image builds the JAR and installs it before optimization. The running local realm also selects it. Existing accounts pick up names on their next sign-in.

## Direct sign-in

Signed-out visits go straight to Keycloak and return to the requested page afterward. The welcome/sign-in gate is removed. Signing out opens Keycloak's credential form. Service outages and access denial stay separate from expired-session handling, and background revalidation does not initiate sign-in navigation.

Latest verification: [member and entry-flow checks](../../../artifacts/inline-members-focus-final/summary.json), [long identities](../../../artifacts/inline-members-long-final/summary.json), [11 BDD scenarios](../../../artifacts/inline-members-finished-bdd/coverage.md), [real Keycloak flow](../../../artifacts/inline-members-keycloak/report.json), and [saved workspace views](../../../artifacts/inline-members-live-final/summary.json). The console's 179 tests and typecheck pass. [Interaction results](../../../artifacts/inline-members-interaction-results.json) cover 56 desktop/mobile states and 20 actual 200% zoom states. The initial zoom run used an outdated import locator; the linked rerun preserves that diagnostic and verifies the updated control path.

## Earlier layout checks

| Evidence | Result |
| --- | --- |
| [Header/member behaviors](../../../artifacts/headers-members-focused-compact/summary.json) | Seven checks: alignment, duplicate names, 320px layout, role changes, explicit Add/Remove and last-admin protection. |
| [Long identities](../../../artifacts/headers-auth-long-members/summary.json) | Five views; full identity details stay available and rejected demotion leaves membership intact. |
| [Desktop layouts](../../../artifacts/headers-auth-desktop-final/summary.json) | 46 captured states across 1024, 1440 and 1920px. |
| [Core workflows](../../../artifacts/headers-auth-core-final/summary.json) | 58 states, including actual 200% browser zoom. |
| [Interaction states](../../../artifacts/headers-auth-interactions/summary.json) | 54 menu, tooltip, dialog, validation and narrow-layout states. |
| [Saved example workspace](../../../artifacts/headers-auth-examples/summary.json) | 16 views through real Keycloak sign-in. |
| [Live sign-in layouts](../../../artifacts/keycloakify-live-layout/summary.json) | Desktop, 390px and 320px; keyboard order, password visibility and touch targets. No credentials or submission. |
| [Real Keycloak protocol](../../../artifacts/keycloakify-protocol-retry/report.json) | Packaged theme, verified profile name, bad credentials, SSO, restart, revocation and logout. Native Keycloak 26.8.2 with PostgreSQL. |
| [Member/navigation BDD](../../../artifacts/headers-members-bdd-compact/coverage.md) | Six selected scenarios pass. |
| [Identity/access BDD](../../../artifacts/headers-auth-authority/coverage.md) | 29 selected scenarios pass. |

The earlier layout pass also ran 19 identity/deployment checks.

These are selected checks, not a claim that all 198 BDD scenarios ran. No models were called. Docker image execution and broad assistive-technology qualification remain outside this pass; the provider test runs the actual Keycloak distribution natively.
