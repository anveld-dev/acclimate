# Local email

Mailpit catches development email. Open **http://localhost:8025** to read invites,
email verification links and password resets. It never forwards mail to a real inbox.
Application data still lives in PostgreSQL.

## Native development

```sh
npm run mail:start
npm run mail:status
npm run mail:stop
```

The helper downloads Mailpit **1.33.1**, checks the pinned release SHA256, and
starts it in the background. SMTP listens on `127.0.0.1:1025`; the inbox listens on
`127.0.0.1:8025`. Captured messages persist in ignored `.local/mailpit/` with private
filesystem permissions. Stopping it keeps the inbox. Occupied ports are reported;
the helper never kills another process. Inherited `MP_*` settings are discarded so
an existing relay configuration cannot accidentally send development mail.

Add these settings to the Rust service's private development environment, then restart it:

```dotenv
ACCLIMATE_CONSOLE_ORIGIN=https://localhost:3443
ACCLIMATE_SMTP_HOST=127.0.0.1
ACCLIMATE_SMTP_PORT=1025
ACCLIMATE_SMTP_FROM=Acclimate <noreply@acclimate.local>
ACCLIMATE_SMTP_TLS=none
```

Use your actual HTTPS console origin. Invitation links use this configured origin,
never an incoming Host header. No SMTP username or password is needed for Mailpit.

## Keycloak

For an existing local realm, configure **Realm settings → Email**:

| Setting | Native Keycloak | Keycloak in the Compose network |
| --- | --- | --- |
| Host | `127.0.0.1` | `mailpit` |
| Port | `1025` | `1025` |
| From | `noreply@acclimate.local` | `noreply@acclimate.local` |
| From display name | `Acclimate` | `Acclimate` |
| SSL / StartTLS / Authentication | Off | Off |

Enable **User registration**, **Email as username**, **Verify email** and **Forgot
password** under Login. The native helper applies those exact settings without
reimporting the realm or changing users, clients, roles or data:

```sh
# Inject KC_ADMIN_PASSWORD from your private environment or secret manager.
python3 scripts/configure_dev_mail.py --server http://127.0.0.1:8180
```

It only accepts a loopback admin endpoint. Existing realm imports are not overwritten.
Public production signup and SMTP settings remain deliberate deployment choices.

## Docker alternative

```sh
docker compose -f compose.mailpit.yaml up -d --wait
```

Use either Docker or the native helper, since they use the same host ports.
To share the application’s private network, include `compose.mailpit.yaml` with
the existing Compose files instead. Inside containers, set SMTP host to `mailpit`.
Both published ports bind only to host loopback. The Mailpit network has no external
route. Keep this overlay out of production.

## Try an invitation

1. Open a workspace’s **Members → Invite member**. Enter a test email and role.
2. Open the message in Mailpit and follow **Join workspace**.
3. Sign in with that email, or register. Open the verification email in Mailpit, then set a password when Keycloak asks.
4. Click **Join workspace** to accept. Reading a link alone never adds a member.

Invitations last seven days. Admins can resend or revoke them. Email sends are queued
in PostgreSQL and retried up to five times. “Sent” means SMTP accepted the message;
it does not prove someone opened it. A restart can send a duplicate of the same link.
Forwarding a link cannot grant access to a different verified email. An invitation
cannot overwrite an existing membership’s role.

For a real sender, configure SMTP with `ACCLIMATE_SMTP_TLS=starttls` (default) or
`tls`, plus an optional complete `ACCLIMATE_SMTP_USERNAME` / `ACCLIMATE_SMTP_PASSWORD`
pair. Plain SMTP is restricted to local Mailpit addresses. Keycloak needs its own
SMTP settings; the application does not send Keycloak verification or reset mail.

Mailpit options: [official runtime reference](https://mailpit.axllent.org/docs/configuration/runtime-options/).

## Checks

These use disposable PostgreSQL, Rust and a separate Mailpit inbox. They do not read
or delete development mail and make no model calls:

```sh
cargo build --locked
npm run test:email -- --pg-bin /path/to/postgresql/bin --report artifacts/email-protocol.json
```

Add `--email` to the [real Keycloak gate](keycloak/README.md#qualification-and-operations)
for the browser flow: invite, register, verify email, set password, accept and open
the workspace. CI runs SMTP checks and that flow on the built and Vite consoles.
The shared member/navigation behavior tests also use isolated Mailpit instances.

Invitation, verification and password-reset emails share Acclimate’s light email
layout and clear action buttons. Each keeps a plain-text version. Existing captured
emails keep their original appearance; new sends use the updated templates.

Members reads current membership and delivery status every five seconds while the
page is visible, and when you return to it. It preserves loaded pages and keyboard
focus, pauses while a form or menu is open, and retries quietly after an outage.
Accepting an invitation removes it from the pending list and adds the member
without a page reload.
