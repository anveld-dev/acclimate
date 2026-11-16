# Workspaces and access

The app has one production identity path. PostgreSQL stores users, browser sessions, memberships and audit records. A workspace is an existing project; there is no organization layer. The [reviewed production plan](../production-only/plan.md) governs this cutover.

## Who can do what

| Actor | Authority |
| --- | --- |
| Browser user | Verified OIDC identity, active session, current workspace membership |
| Deployment operator | Exact pinned issuer/subject allowlist; may create a workspace or explicitly adopt an unowned existing project |
| Workspace admin | Administers that workspace's verified members; cannot create other workspaces |
| Application SDK | Explicit scoped machine grant or integration credential; no browser session |

Viewers read. Editors write, request improvements and release. Admins also manage members. Operator status never bypasses membership on an owned workspace. The service rejects requests that mix machine credentials with browser sessions.

## Sign-in and revocation

The console uses the pinned `openid-client` authorization-code flow with PKCE, state and nonce. It forwards only verified issuer/subject to Rust using a dedicated login authority. Rust pins the exact issuer, maps the identity to an existing or new user and creates an eight-hour opaque session. A supplied previous session is revoked during account rotation, even when accounts differ.

The browser's HttpOnly, Secure, SameSite=Lax cookie travels through the console's dedicated service transport. Rust loads the active session and current role for every operation, then rechecks them transactionally. Selection cookies carry navigation, never authority. Public IDs and SDK setup snippets never include authority credentials or private API endpoints.

Membership changes and session revocation lock the same rows as authorized writes. A write ordered first can commit; revocation blocks later operations. Sign-out clears the cookie only after committed revocation or a typed invalid-session result from valid console transport. An upstream outage or generic 401 is not proof of sign-out.

## First access and existing data

Operators can create a project and atomically become its admin. Explicit machine grants register project rows at startup without granting human membership. To take responsibility for an existing project with zero memberships, an operator reviews the exact project ID, their verified identity and a reason, then calls the audited adoption operation.

Adoption uses the same project membership lock as other writers and records one immutable audit per project. A historical retry shows the original decision and current role; it never restores a role removed later. Other operators and already owned projects cannot use adoption to bypass their admins.

Migration 0013 revokes old browser sessions once. It preserves users, memberships, versions, channels, histories, machine credentials and receipt ownership. Coordinate the cutover and require fresh login. Nothing adopts or deletes the running user's data automatically.

## Native app boundary

Applications retain their own SDK, loop, tools, credentials, execution and grading. Machine grants authorize only the configured project and rights. Browser pending writes remain bound to the verified actor and exact project/bundle/channel. Removing a user blocks new browser actions; revoking an evaluator token blocks its next service call. Neither claims to stop an app's remote execution.

See [deployment](../../../deploy/README.md), [console setup](../../../apps/console/README.md) and [production evidence](../production-only/evidence.md). Invitations, organizations, automatic provisioning, refresh-token storage and distributed console sessions remain outside this release.
