# Acclimate sign-in

This Keycloakify app produces the `acclimate` login and email themes. It uses the console's [shared color tokens](../console/src/theme/tokens.css) and Inter font. Keycloakify's maintained pages handle credentials, MFA, recovery and passkeys; we supply the layout and styling.

Run `npm run build:theme` from the repository root with Java 17+ and Apache Maven installed. The result is `apps/keycloak-theme/dist_keycloak/acclimate-keycloak-theme.jar`, targeting our Keycloak 26 deployment.

The [Keycloak image](../../deploy/keycloak/Dockerfile) builds and installs this JAR automatically. See the [deployment guide](../../deploy/keycloak/README.md) for an existing external server. Theme selection is stored in Keycloak, so an existing realm needs both its Login theme and Email theme set to **acclimate** explicitly.

The [real-provider check](../../scripts/testing/keycloak_protocol.py) installs the JAR into a disposable Keycloak/PostgreSQL stack and checks authentication and session behavior. The [layout check](../../scripts/testing/keycloak_theme_layout.py) checks the running sign-in page at desktop and narrow widths without credentials or form submission.

Verification and password-reset emails use a matching card, readable action button,
and an alternative text part. The email templates live in `src/email`; native
Keycloak still creates and validates the links, expiry and recovery flow. Templates
escape interpolated values and load no external fonts, images or scripts.
