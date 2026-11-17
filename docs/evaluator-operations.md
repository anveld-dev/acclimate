# Provision and operate an evaluator

This guide is for the service operator. Application developers start with [Connect an existing agent](getting-started.md). The service records immutable requests and comparisons; the application owns agent execution, model credentials, tools and quality policy.

## Provision the exact identity

1. Confirm the intended project, a stable evaluator principal, and the worker's private persistent storage. Guided project IDs are 1–128 ASCII letters/digits/`-_.`, excluding dot/dotdot. New guided resource IDs use canonical lowercase UUIDs. Legacy raw-client access does not imply guided retained-operation support.
2. In your secret manager, provision a strong token for that same principal/project with exactly `read` and `write`. The current static `ACCLIMATE_AUTH` grant format is `{token,principalId,projectId,rights}`. Evaluator `write` grants other project writes too; no narrower eval-only right exists in this release. Do not add propose/promote merely to run evaluations.
3. Validate a private candidate grant file without printing its contents or starting the service:

```sh
target/release/acclimate-service --check-grants < /absolute/private/machine-grants.json
```

The validator reads only explicit stdin, checks the closed grant schema and emits fixed success/error JSON. It does not contact PostgreSQL/OIDC/a model, inspect ambient runtime credentials, open a listener, or validate the rest of your deployment configuration.

4. Deploy the grant through your existing private service environment. Follow [coordinated deployment](../deploy/README.md): one Rust process owns the database, so changes require a coordinated drain/restart. Registering a machine project does not create human workspace membership.
5. Deliver an owner-only evaluator configuration file to the worker through your secret channel, never through browser configuration or command arguments. Its schema is documented in [getting started](getting-started.md#3-obtain-evaluator-access-before-creating-a-request).
6. Run the installed app's `doctor` with that explicit config. The machine-only capability endpoint checks the exact principal's current project read/write authority and retained-operation support. A human editor's console authority or published delivery token is insufficient. `/ready` checks the service, not the provider, evaluator host or progress.

No evaluator secret enters the browser. Console authors create requests through their own current memberships; the installed application claims/executes them with its separate evaluator identity.

## Stable worker storage and lifecycle

Use a dedicated nonroot UID and a qualified POSIX local filesystem. Configuration parent and journal/cache/workspace roots are owner-only 0700; secret/state files are 0600. Reject symlink ancestors and use canonical absolute paths. TypeScript durable execution requires Node >=22.22 and `python3` with `fcntl`; Python requires >=3.11 and no Node runtime dependency.

Mount the private journal volume at the same canonical absolute location across replacements. Retain the exact service URL string, project and principal. Use the originating language/release to recover unfinished attempts. Each request has kernel `flock` ownership; a file/PID/age is never proof that work did or did not execute. Network filesystems and distributed cross-host execution are not qualified by this operating model.

For native repository jobs, configure the dedicated worker's OS `TMPDIR` to its private persistent workspace parent before launch. The starter validates that parent, records a private job/workspace binding and launch intent before native execution, and retains unresolved workspaces. Only confirmed-stop recovery can remove them. Do not run automatic age-based cleanup against unresolved jobs. See [native repository operations](../examples/native-repository/README.md).

Back up worker journals/private artifacts separately from PostgreSQL, under your existing protected backup policy. Restoring a copy at the same pathname on another physical filesystem does not share a kernel lock. Establish original worker termination and preserve one authoritative physical volume before using restored state.

## Rotate a token without changing attempt ownership

1. Add a replacement token for the **same exact** principal/project and required rights while retaining the old token. Validate and restart with overlapping grants.
2. Replace only the token in the worker's explicit private config, preserving service URL, project, principal, canonical root, request IDs, attempts and operation keys. Run `doctor`. Let existing in-process clients using the old credential drain during overlap.
3. After old workers are quiescent, remove the old token, validate and restart again. If an old client is denied, preserve its saved report and recover with the same-principal replacement credential.

Emergency revocation may skip overlap, but can leave external work and submissions uncertain. Revoking a credential neither terminates a provider operation nor authorizes another principal to take over its attempt. Dynamic credential issuance, restart-free rotation and narrower evaluation rights remain explicit follow-ups.

## Recovery decisions

| Observed facts | Supported action |
| --- | --- |
| Requested; no execution marker | Same owned journal/key may claim after current identity/version checks |
| Start response lost; same journal/attempt | Recover original retained start result, then re-read current request before scheduling |
| Execution marker; no complete sealed report | Refuse callbacks; inspect/stop the original external app, then explicitly interrupt and decide whether new work is safe |
| Exact report saved; submission response lost | Recover/replay original retained body/key; never run callbacks again |
| Comparison confirmed; finish response lost | Recover original finish and authoritative current binding |
| Running; original journal absent/relocated | Restore original supported root/identity or inspect/interrupt; no speculative replay |
| Interrupted | Keep private evidence; the record is interrupted but the external job may still be active |
| Completed/failed | Inspect terminal evidence; quality and release remain separate |
| Foreign language journal or changed principal/root | Refuse takeover; resolve with the original supported runtime and identity |

New retained evaluator operations outlive the transient 24-hour idempotency cache and recheck current authorization on execution, replay, lookup and close. Retained responses are historical mutation results, not current running-state proof. The runner re-reads current lifecycle before callbacks. A check racing with a later interruption cannot cancel already started external work.

Historical unmarked attempts may lack retained receipts. `not_observed` after transient retention does not prove that a submission never committed. If no trustworthy receipt or bound current state identifies the outcome, preserve it as `legacy.submission_unconfirmed` for inspection; do not invent a new key or automatically resubmit an ambiguous old comparison.

Use the installed `status` and explicit `interrupt --reason ...` commands for headless inspection/intent. Interruption uses a separate short-held command lock so an active execution lock does not prevent recording intent. A fresh CI worker without the original journal cannot resume the running request. Before creating replacement work, establish whether its original external effects can safely be repeated.

## Diagnostics and retention

Default command diagnostics contain fixed safe codes, phase, execution certainty, next action and validated correlation IDs. Configuration contents, arbitrary server/provider messages, raw runtime keys, private paths, expected answers and outputs stay out of logs. Read-only delivery observations remain separate from admin credential management and do not prove consumption. Remote evaluator heartbeat/progress is not stored in this release; running with no observed local progress means unknown, not stopped.

Export deliberately selected/redacted review artifacts through the app's mapper. Do not recursively upload a journal or its private parent. Retain completed exports under authorized artifact storage with an explicit expiry/ACL; protect original recovery journals independently. Local hashes establish consistency and online scalar checks establish binding, not execution attestation or quality confidence.
