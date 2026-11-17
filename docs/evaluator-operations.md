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

## Serve connected learning

Use the service connection UUID as `integrationId` when constructing the application's delivery
`AcclimateClient`. Keep that UUID stable across process restarts and credential rotation.
`resolveAndCache` then resolves the configured channel for this connection and keeps its offline
cache separate from other connections. Resolve once for each fresh job and keep that verified
bundle for the lifetime of the job.

Install the terminal-outcome hook once in the application. Use a dedicated outcome client
with the write principal named in the enrollment. Supply the persisted UUID of the logical task
outcome so retries retain the same identity. Provide only application-approved teaching summaries
that the proposer may receive. The application retains task inputs, private grader evidence,
and traces.

```ts
import { createLearningOutcomeReporter } from '@acclimate/sdk/learning';

const reportOutcome = createLearningOutcomeReporter({ client: outcomeClient, projectId, integrationId });

// In the application's terminal outcome hook, after its own grade is durable.
await reportOutcome(job.bundle, {
  outcomeId: job.outcomeId,
  status: 'failed',
  feedback: {
    expected: 'Require signed evidence before publishing an assertion.',
    observed: 'Published an assertion based on a draft receipt.',
  },
});
```

Submit outcomes asynchronously through the application's own durable outbox if retries must survive
process loss. Persist the terminal report or its exact request fields with the task result.
The lower-level `reportLearningOutcome` method accepts those fields and defaults its retry key to
the outcome UUID.

Build an application module whose default export is
`{ development: developmentApp, audit: [auditApp] }`. Each app is produced by
`defineEvaluation`. Register the corresponding descriptors during enrollment. Keep development
and held-out cases and revisions disjoint. The service assigns each evaluation to the configured
evaluator principal and installation, and the driver runs the installed app whose descriptor
matches the exact request.

```sh
acclimate-learning --config /private/evaluator.json --integration "$INTEGRATION_ID" \
  --installation "$INSTALLATION_ID" --apps ./dist/learning-evaluators.mjs
```

Keep this process running with the same private evaluator config and durable `journalRoot` used
by the evaluation runner. It polls for assignments, passes cancellation into active evaluation
callbacks, and reconciles saved reports after a restart. If execution began without a saved report,
the journal preserves uncertainty and the driver reports a diagnostic for operator reconciliation.
Use `--live` only to permit execution by an installed live evaluator. Applications that manage
their own process lifecycle can call `serveConnectedLearning` with an `AbortSignal`.

### Audit fresh jobs after rollout

To measure a managed release in production, attach a fresh SDK delivery receipt to the same job's
terminal outcome. Use `receiptReporter.reportStartedReceipt(bundle)` when the job starts. This
replaces `reportStarted` for that job and returns the exact queued receipt or `null` if the local queue
is full. Retain the returned receipt body alongside the durable job UUID. Ensure delivery of the
receipt before submitting the terminal outcome. A durable outbox can send the exact receipt again
using its original UUID and the receipt credential.

Pass that receipt as `startedReceipt` to the terminal outcome hook. When the service recognizes an
eligible job on the current managed release, its accepted outcome includes `fieldAudit` with the
predecessor's pinned version and digest. A fresh resolution and exact channel revision are
required. Receipt-only observations provide no field verdict.

Install the independent evaluator with the separate evaluator principal. The SDK selects eligible
jobs by a stable hash of workspace, connection, and outcome UUID. The default is 10 percent.
Configure `samplePercent: 100` for deterministic qualification or an explicitly chosen
low-volume rollout. The evaluator independently grades the recorded served result and performs
a read-only predecessor replay on the same private input and objective. Its output should be
`correct`, `incorrect`, or `indeterminate` for each arm. A correct predecessor and incorrect
served result count as a regression. A correct served result with a known predecessor grade
counts as a pass. Two incorrect results or an indeterminate comparison contribute neither.

```ts
import { createLearningFieldAuditor } from '@acclimate/sdk/learning';

const prepareFieldAudit = createLearningFieldAuditor({
  client: evaluatorClient,
  projectId,
  integrationId,
  cacheDir: evaluatorCache,
  evaluate: async ({ job, served, predecessor, signal }) => {
    return gradeRecordedJobAndReplayReadOnly(job, { served, predecessor, signal });
  },
});

// The app's durable evaluator task owns this work item and retains its private job data.
const fieldAudit = await prepareFieldAudit(job.bundle, {
  job: job.privateFieldEvaluationData,
  startedReceipt: job.startedReceipt,
  outcome: job.acceptedOutcome,
  signal,
});
if (fieldAudit) await fieldAuditOutbox.save(fieldAudit.outcomeId, fieldAudit);
```

The outbox sends the saved verdict through `evaluatorClient.reportLearningFieldAudit(projectId,
integrationId, fieldAudit)`. Retry the saved request with the same outcome UUID without replaying
the app job. If native predecessor execution became uncertain, settle the original attempt through
the app's own journal before issuing any replacement work. Keep customer input, served output, and
the replay's evidence private.

The service counts up to ten recent eligible verdicts for the exact current promotion. When
automatic rollback is enabled, three regressions in that window restore the verified predecessor
for later jobs. A stale verdict cannot roll back a newer delivery revision. Automatic rollback
defaults on for new enrollments and for existing enrollments when the migration runs. Workspace
administrators can opt out in the connection settings.
