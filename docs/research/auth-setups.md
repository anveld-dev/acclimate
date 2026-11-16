# Authentication setups for Acclimate

Decision after research: **Keycloak**, chosen by the user. See the [implementation setup](../../deploy/keycloak/README.md). The comparisons below retain the reasoning and alternatives.

Researched 2026-11-14 against official documentation and our current code. This is a decision note, not a provider installation or a production qualification. No credentials, running user data or upstream deployments were used. Auth0 is excluded.

## What we actually need

The product needs people to sign in, keep a revocable session, and access only their workspaces. Applications need separate scoped credentials for fetching bundles and submitting evidence. The API, storage and membership authority already run in Rust/PostgreSQL; choosing an identity product does not require replacing them.

Our current flow is:

```text
Browser → identity provider → console OIDC callback
                                  ↓ verified issuer + subject
                           Rust login authority
                                  ↓
                     PostgreSQL session + membership
```

The [console](../../apps/console/src/server/identity.ts) verifies OIDC using the installed Node client. [Rust](../../src/workspaces.rs) creates the application session; [authorization](../../src/auth.rs) rechecks sessions and current memberships. So the backend is Rust, while the existing external-login callback is TypeScript. Moving that callback into Rust would be a separate change.

## The practical shortlist

“Popular” here means a relevant ecosystem shortlist, not a measured market-share ranking. Repository visibility and feature lists do not establish security or deployment quality.

| Setup | Where authentication runs | Account storage | Main tradeoff for us |
| --- | --- | --- | --- |
| Direct Google/GitHub login + our sessions | Existing app talks to a social provider | Provider identity; our users/sessions in PostgreSQL | Smallest first release if users accept those accounts; depends on that provider |
| Rust authentication inside the app | Axum handlers and Rust libraries | PostgreSQL | No extra identity service; we build and maintain account flows |
| Better Auth in the existing console | TypeScript in TanStack Start | PostgreSQL supported | More ready-made app features; introduces an auth-authority migration |
| Rauthy | Separate Rust OIDC server | Explicit PostgreSQL mode | Fits our current protocol; another service to configure, patch and restore |
| Keycloak | Separate Java identity server | PostgreSQL supported | Broad SSO/admin features; more configuration than this small service needs initially |

The protocol and storage facts below are sourced. The relative fit and workload judgments are engineering conclusions for this repository.

## 1. Direct social login with application sessions

[Google implements OIDC](https://developers.google.com/identity/openid-connect/openid-connect), so it is a natural candidate for the existing callback. We register a real client, verify its returned identity, then keep our own session and workspace membership. There is no separate identity server to operate. This is a candidate fit, not an executed Google qualification.

GitHub needs a different adapter: its [user OAuth flow does not issue OIDC ID tokens](https://docs.github.com/en/apps/github-authentication-discovery-endpoints). Its metadata and GitHub Actions OIDC do not make ordinary GitHub sign-in a drop-in for our current OIDC client. A GitHub adapter would exchange the code and fetch the authenticated user's stable identity through the provider API.

**Good fit:** an initial developer/team audience happy to use an existing account. We avoid building password signup, mail delivery and recovery.

**Limit:** people need an account at an enabled provider. Adding multiple providers needs explicit account linking and a stable internal user ID. Google specifically says to use `sub`, not a changeable email address, as the identity key. Never silently merge users by email.

## 2. Authentication built into Rust

These are building blocks, not one complete account product:

- [axum-login](https://docs.rs/axum-login/latest/axum_login/) provides authentication/authorization middleware and backend traits.
- [tower-sessions](https://docs.rs/tower-sessions/latest/tower_sessions/) provides session middleware; its documented SQLx store supports PostgreSQL. Use compatible crate versions, not an assumed combination of every latest release.
- [openidconnect](https://docs.rs/openidconnect/latest/openidconnect/) supports Rust OIDC clients, including authorization code with PKCE.
- [RustCrypto Argon2](https://docs.rs/argon2/latest/argon2/) provides password hashing.
- [webauthn-rs](https://docs.rs/webauthn-rs/latest/webauthn_rs/) provides passkey registration/authentication primitives.

**Good fit:** all authentication logic must live in our Rust application, and the required login methods are deliberately narrow.

**Work we own:** enrollment, verification and recovery, abuse limits, password/reset or passkey lifecycle, credential changes, device/session management and the corresponding UI. A session crate does not supply those product flows.

We already have custom Rust sessions with transaction-backed revocation and memberships. Installing another session middleware would not automatically improve that boundary. Keep it unless a specific gap justifies a migration; preserve user IDs, memberships and audit attribution if replacing it. Moving only the OIDC callback into Rust is a smaller change than building a password system.

## 3. Better Auth inside TanStack Start

[Better Auth](https://better-auth.com/docs/introduction) is TypeScript, supports email/password, social sign-in and account/session management, and has plugins for features such as 2FA and passkeys. It has an [official TanStack Start integration](https://better-auth.com/docs/integrations/tanstack) and [PostgreSQL support](https://better-auth.com/docs/adapters/postgresql).

**Good fit:** Rust owns the domain API, but TypeScript authentication in our existing Node process is acceptable. This deserves consideration when ready-made application account flows matter more than a fully Rust implementation.

**Our integration cost:** it is not a configuration-only replacement for the current OIDC provider. We must choose who owns the authoritative session and how account disablement, credential changes and logout reach Rust. Avoid two unrelated sessions that can disagree about whether someone is still signed in. Better Auth's organization model should not become a second copy of our workspace memberships.

## 4. Rauthy as a separate Rust identity service

[Rauthy](https://sebadob.github.io/rauthy/) supplies OIDC, passkeys/MFA and account/admin interfaces. Its [database configuration](https://sebadob.github.io/rauthy/config/config.html) supports PostgreSQL with `database.hiqlite = false`. The default Hiqlite storage uses SQLite, so the default deployment does not satisfy our database choice. Use a dedicated database/role rather than letting its migrations manage Acclimate's tables.

**Good fit:** we want self-hosted identity with ready-made account features, and Rust implementation is an explicit preference. Its OIDC interface fits our current split without replacing application memberships or SDK credentials.

**Work we own:** one more service, a stable issuer/hostname, encryption and signing material, recovery/email configuration, upgrades, backups and real login qualification. Pin a release and verify its configuration and supported signing algorithm against the client. “Written in Rust” does not remove this operational work.

The earlier recommendation was too broad: Rauthy is a strong Rust candidate, not an automatic winner over simpler social login or existing app-level auth libraries.

## 5. Keycloak for a broader identity setup

[Keycloak](https://www.keycloak.org/docs/latest/server_admin/index.html) has account administration, identity brokering, recovery, MFA and enterprise federation features. It [supports PostgreSQL](https://www.keycloak.org/server/db); its development database is not a production choice. Its server is [Java](https://github.com/keycloak/keycloak), but a Rust API can integrate through OIDC.

**Good fit:** enterprise identity providers, existing company SSO or several products sharing a login system are real near-term requirements.

**Our cost:** another server plus realm/client, proxy, recovery and upgrade configuration. Reuse its identity protocol while keeping workspace authorization in Rust. We do not need to move all product roles into an identity server just to offer login.

## Other established options and important traps

- **Ory:** [Kratos](https://github.com/ory/kratos) handles identity/account flows; [Hydra](https://www.ory.com/hydra) handles OAuth2/OIDC token issuance. First-party login can use Kratos alone. Preserving our existing OIDC-provider interface is a different architecture and can require Hydra plus login/consent integration. Do not add the whole suite for ordinary app login. Check self-hosted OSS features separately from Network/Enterprise documentation.
- **Supabase Auth:** its [Go auth service and PostgreSQL storage](https://supabase.com/docs/guides/getting-started/architecture) are compatible with a Rust API. Its [sessions/JWT and provider integration](https://supabase.com/docs/guides/auth/architecture) would need an explicit adapter/authority design here. Adding the entire Supabase platform solely for sign-in would expand our current deployment.
- **Zitadel:** [the vendor's version comparison](https://preview.zitadel.com/choose-version) distinguishes v4 from its next-generation product. At review time, the next version still lists OIDC-provider capability, recovery and several enterprise features as upcoming. Evaluate a pinned version; do not carry v4 feature claims into preview configuration.
- **Kanidm:** it is Rust, but its [server storage](https://github.com/kanidm/kanidm/blob/master/server/lib/Cargo.toml) is not a PostgreSQL backend. It is outside this project's storage requirement.

## Decisions to preserve whichever setup wins

1. **One application session authority.** Keep Rust's current expiry, revocation and transaction-backed membership checks, or replace them through a reviewed migration. A valid identity token alone does not grant a workspace role.
2. **Human login and machine grants stay separate.** SDK clients do not need a browser login or a new OAuth server to fetch content. Existing scoped grants and credential revocation still apply.
3. **Account linking is explicit.** Preserve stable internal IDs and exact issuer/subject mappings. A new issuer or matching email must not silently inherit an old user's privileges.
4. **Define provider revocation honestly.** Our current login creates an application session. Disabling or signing out of the identity provider does not automatically revoke it. Decide whether application-session controls are enough or whether provider events/revalidation are needed.
5. **Recovery is part of auth.** Passkeys still need a deliberate lost-device/additional-device story; passwords need safe reset flows. Reuse maintained implementations and test actual recovery, not only successful login.

## Recommendation for our scope

Keep Axum, SQLx, PostgreSQL, current workspace authorization and machine SDK credentials. Do not switch frameworks or install a new session stack for this choice.

- **Smallest setup:** one real OIDC provider for social login, reusing our existing session boundary. Google is the closest current fit; GitHub needs a new adapter.
- **Self-hosted, Rust identity required:** qualify Rauthy with PostgreSQL as a separate service.
- **Built-in account flows, TypeScript acceptable:** evaluate Better Auth in the existing console, with a concrete session-authority migration first.
- **Enterprise SSO needed soon:** qualify Keycloak before building those capabilities ourselves.

These are conditional recommendations, not installed dependencies. No market-share ranking, memory benchmark, price comparison or security guarantee was inferred from project marketing. Live integrations remain untested.
