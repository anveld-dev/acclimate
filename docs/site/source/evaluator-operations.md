# Provision and operate an evaluator

Service-specific vocabulary is defined in [Internal terms](../CONTEXT.md#internal-terms).

This guide is for the service operator. Application developers start with [Connect an existing agent](getting-started.md). The service records immutable requests and comparisons; the application owns agent execution, model credentials, tools and quality policy.

## Provision the exact identity

1. Confirm the intended workspace, a stable evaluator name and the worker's private persistent storage. Guided workspace IDs are 1–128 ASCII letters/digits/`-_.`, excluding dot/dotdot. New guided resource IDs use canonical lowercase UUIDs. Legacy raw-client access does not imply guided retained-operation support.
2. As a workspace administrator, issue a machine token with only the `evaluate` right from **Settings → Members → Evaluator tokens**, or with `POST /v1/workspaces/{workspaceId}/machine-tokens`. Its principal is `machine:{name}`. The service stores a SHA-256 digest, returns the secret once, and records the issue in the append-only token audit trail. No restart is needed. `evaluate` reads the workspace and runs evaluations; it never publishes, promotes, authors versions or changes channels. Do not add `write`, `propose` or `promote` merely to run evaluations.
3. Deliver the owner-only evaluator configuration to the worker through your secret channel, never through browser configuration or command arguments. The console can download a ready `evaluator.json`. The token can instead live in a private `evaluatorTokenFile` or in `ACCLIMATE_EVALUATOR_TOKEN`. The schema is documented in [evaluator access](../apps/docs/content/docs/operate/evaluator-access.mdx#configure-the-worker-or-ci-job).
4. Run the installed app's `doctor` with that explicit config. The machine-only capability endpoint checks the exact principal's current `evaluate` authority and retained-operation support, and reports its rights, credential kind and expiry, and the abandonment policy. A human editor's console authority or published delivery token is insufficient. `/ready` checks the service, not the provider, evaluator host or progress.

Static `ACCLIMATE_AUTH` grants remain supported for bootstrap and fixed deployment principals. Their format is `{token,principalId,workspaceId,rights}`, and they may use `evaluate`. Validate a private candidate grant file without printing its contents or starting the service:

```sh
target/release/acclimate-service --check-grants < /absolute/private/machine-grants.json
```

The validator reads only explicit stdin, checks the closed grant schema and emits fixed success/error JSON. It does not contact PostgreSQL/OIDC/a model, inspect ambient runtime credentials, open a listener, or validate the rest of your deployment configuration. Deploy a static grant through your private service environment with a [coordinated drain/restart](../deploy/README.md). Registering a machine project does not create human workspace membership. Connected-learning enrollment still names static grant principals.

No evaluator secret enters the browser except the one-time display to the administrator who issued it. Console authors create requests through their own current memberships; the installed application claims/executes them with its separate evaluator identity.

## Policy receipts

Running `compare --policy` or `check` with the original evaluator's private configuration reports the policy verdict for the settled comparison. A check using read-only configuration evaluates the same evidence locally. The receipt contains the public policy ID, revision and SHA-256 digest, verdict, named checks and reporting principal. Inputs, outputs, grading explanations, policy thresholds and credentials stay on the evaluator machine.

The evaluator submits `POST /v1/workspaces/{workspaceId}/bundles/{bundle}/comparisons/{comparison}/policy-receipts` with `requestId`, `attemptId`, `policy` (`id`, `revision`, `sha256`), `verdict`, and `checks` (`code`, `result`). The service checks the machine principal against the submitted comparison and settled attempt. Repeating the same receipt returns the original timestamp. A different report for the same policy digest and comparison returns a conflict. Authorized readers can `GET` that collection. The candidate-wide `GET /v1/workspaces/{workspaceId}/bundles/{bundle}/versions/{candidate}/policy-receipts` lists visible failed and indeterminate receipts across its comparisons.

Release reviewers see the receipts, reported checks and any override in the console. A complete comparison can have no checked policy yet. A candidate with a failed or indeterminate policy needs a release reviewer to acknowledge every current blocking receipt and record a reason. A partial comparison still needs complete evidence for evidence-based publication.

## Stable worker storage and lifecycle

Use a dedicated nonroot UID and a qualified POSIX local filesystem. Configuration parent and journal/cache/workspace roots are owner-only 0700; secret/state files are 0600. Reject symlink ancestors and use canonical absolute paths. TypeScript durable execution requires Node >=22.22 and `python3` with `fcntl`; Python requires >=3.11 and no Node runtime dependency.

Mount the private journal volume at the same canonical absolute location across replacements. Retain the exact service URL string, workspace and principal. Use the originating language/release to recover unfinished attempts. Each request has kernel `flock` ownership; a file/PID/age is never proof that work did or did not execute. Network filesystems and distributed cross-host execution are not qualified by this operating model.

For native repository jobs, configure the dedicated worker's OS `TMPDIR` to its private persistent workspace parent before launch. The starter validates that parent, records a private job/workspace binding and launch intent before native execution, and retains unresolved workspaces. Only confirmed-stop recovery can remove them. Do not run automatic age-based cleanup against unresolved jobs. See [native repository operations](../examples/native-repository/README.md).

Back up worker journals/private artifacts separately from PostgreSQL, under your existing protected backup policy. Restoring a copy at the same pathname on another physical filesystem does not share a kernel lock. Establish original worker termination and preserve one authoritative physical volume before using restored state.

## Rotate a token without changing attempt ownership

1. Rotate the token from the console or with `POST /v1/workspaces/{workspaceId}/machine-tokens/{id}/rotate`. The successor keeps the same `machine:` principal and rights. Set `overlapSeconds` (0–604,800) to keep the old token valid while workers switch; the console uses one hour. No restart is needed.
2. Replace only the token in the worker's private config, token file or CI secret, preserving service URL, workspace, principal, canonical root, request IDs, attempts and operation keys. Run `doctor`. Existing in-process clients using the old token drain during the overlap.
3. If an old client is denied after the overlap, preserve its saved report and recover with the same-principal successor.

Revoke a token from the console or with `POST /v1/workspaces/{workspaceId}/machine-tokens/{id}/revoke` and a reason. Each transaction rechecks the token under a row lock, so revocation applies to the next request. Revoking a credential neither terminates a provider operation nor authorizes another principal to take over its attempt; abandon the attempt instead. Expired tokens stop working the same way.

A static grant still rotates with overlapping grants and two coordinated restarts.

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
| Abandoned | Terminal. Its evidence never counts; a new request for the same candidate may start (`--retry-after` accepts it) |
| Running; worker gone (cancelled CI job) | Abandon explicitly with a reason, or let the inactivity TTL abandon it; then start a new request |
| Completed/failed | Inspect terminal evidence; quality and release remain separate |
| Foreign language journal or changed principal/root | Refuse takeover; resolve with the original supported runtime and identity |

New retained evaluator operations outlive the transient 24-hour idempotency cache and recheck current authorization on execution, replay, lookup and close. Retained responses are historical mutation results, not current running-state proof. The runner re-reads current lifecycle before callbacks. A check racing with a later interruption cannot cancel already started external work.

Use the installed `status` and explicit `interrupt --reason ...` commands for headless inspection/intent. Interruption uses a separate short-held command lock so an active execution lock does not prevent recording intent. A fresh CI worker without the original journal cannot resume the running request. Before creating replacement work, establish whether its original external effects can safely be repeated.

### Abandon an attempt whose worker is gone

An `abandoned` request is a server-side terminal state for an attempt whose outcome is unknown. It is reached in two ways:

- **Inactivity.** The service abandons a running attempt with no start, progress report or bound comparison for `ACCLIMATE_EVALUATION_ABANDON_SECONDS` (default 7,200). The sweep runs every 30 seconds and records `abandonedBy: service:evaluation-expiry`.
- **Explicit call.** `POST /v1/workspaces/{workspaceId}/bundles/{bundle}/evaluation-requests/{id}/abandon` with a required `reason`, by any principal with `evaluate` or a workspace editor. The SDK clients expose `abandonEvaluation` and `abandon_evaluation`; the console offers **Abandon attempt**. It records the reason, `abandonedBy` and `abandonedAt`, and replays like other retained evaluator operations.

After abandonment the service refuses the old attempt's start, progress, comparison and finish calls. Promotion rejects any comparison bound to the attempt with `evidence_abandoned`, including one submitted before abandonment, and policy receipts already require a settled attempt. A new request for the same candidate content may then start, and `--retry-after` accepts an abandoned predecessor. Connected-learning evaluations keep their own deadlines and refuse explicit abandonment.

This keeps the service's honesty about execution. Abandonment never infers that the original worker stopped or that its model and tool calls ran exactly once; a stale heartbeat is not termination. It only fences the attempt so its evidence cannot count. The replacement attempt may repeat paid or side-effecting work, so record why you abandoned it and settle any external effects first.

## Diagnostics and retention

Default command diagnostics contain fixed safe codes, phase, execution certainty, next action and validated correlation IDs. Configuration contents, arbitrary server/provider messages, raw runtime keys, private paths, expected answers and outputs stay out of logs. Read-only delivery observations remain separate from admin credential management and do not prove consumption. CLI `status` also reads the latest optional evaluator progress report. Its `progress` object shows the reported phase, completed/total arms, optional case and repetition, receipt time, and time checked. The service marks running reports fresh for 60 seconds and retains the latest observation for up to 24 hours. Missing reports and unavailable progress reads produce `activity: unknown`. Freshness describes when the service received the report. Only the application can confirm whether external work stopped.

New comparison output references default to `acclimate:artifact:sha256:…`. The digest identifies the private journal artifact envelope. Use the case, repetition, side and role with the installed `export` command on the originating worker to retrieve a mapped copy. Older comparisons and caller-supplied references remain readable.

TypeScript adapters can call `assertEvaluationOutput(value)` on an unknown provider result to check its JSON representation. For adapter output rejected by the runner, inspect `output-validation.json` in the corresponding private job directory for the field and suggested correction. For example, convert a Date with `toISOString()` before returning it. Python's `define_evaluation` accepts coroutine callbacks and awaits each one to completion on a private event loop. A failed callback's redacted message and traceback are kept in `callback-error.json` in its private job directory unless the config sets `captureCallbackErrors: false`.

Export deliberately selected/redacted review artifacts through the app's mapper. Do not recursively upload a journal or its private parent. Retain completed exports under authorized artifact storage with an explicit expiry/ACL; protect original recovery journals independently. Local hashes establish consistency and online scalar checks establish binding, not execution attestation or quality confidence.

## Serve connected learning

The service schedules proposals, development evaluations, and held-out audits. The installed evaluator runs the assigned private fixtures and replays.

Use the service connection UUID as `connectionId` when constructing the application's delivery
`AcclimateClient`. Keep that UUID stable across process restarts and credential rotation.
`resolveAndCache` then resolves the configured channel for this connection and keeps its offline
cache separate from other connections. Resolve once for each fresh job and keep that verified
version for the lifetime of the job.

Install the terminal-outcome hook once in the application. Use a dedicated outcome client
with the write principal named in the enrollment. Supply the persisted UUID of the logical task
outcome so retries retain the same identity. Provide only application-approved teaching summaries
that the proposer may receive. The application retains task inputs, private grader evidence,
and traces.

```ts
import { createLearningOutcomeReporter } from '@acclimate/sdk/learning';

const reportOutcome = createLearningOutcomeReporter({ client: outcomeClient, workspaceId, connectionId });

// In the application's terminal outcome hook, after its own grade is durable.
await reportOutcome(job.version, {
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

If the application receives a reviewed correction later, keep the terminal outcome immutable and append a correction with its own durable UUID. Use the same outcome principal.

```ts
await outcomeClient.reportLearningCorrection(workspaceId, connectionId, {
  correctionId: review.id,
  outcomeId: job.outcomeId,
  feedback: { expected: review.expectedSummary, observed: review.observedSummary },
});
```

Define development and held-out audit apps with `defineEvaluation`. Install them in the evaluator process and export the registration descriptors from the same private build. The export contains commitments to the inputs, answers and repetition counts. Send only this public registration to the administrator.

```ts
import { connectedEvaluationDescriptor, type ConnectedLearningDriverOptions } from '@acclimate/sdk/learning';

export const registration = {
  development: connectedEvaluationDescriptor(developmentApp),
  audits: auditApps.map(app => connectedEvaluationDescriptor(app)),
};

export default {
  development: developmentApp,
  audit: auditApps,
  // Both callbacks in this installation use the app's model-free private grader.
  recheckExecution: 'model-free',
  requalifyFieldCaseExecution: 'model-free',
  async recheck({ assignment, baseline, signal }) {
    // The private store resolves the original job by its immutable outcome UUID.
    return replayReviewedCorrection({ assignment, baseline, signal });
  },
  async requalifyFieldCase({ assignment, candidate, signal }) {
    return gradePriorFieldRegression({ assignment, candidate, signal });
  },
} satisfies ConnectedLearningDriverOptions['apps'];
```

Keep development and audit case IDs, dataset revisions and private inputs disjoint. Keep expected answers in the private app definition. The worker checks the registered commitment before executing a bound evaluation.

The application supplies `replayReviewedCorrection`. Read the original private evidence using `assignment.outcomeId` and rerun its check on the provided, verified `baseline` with read-only effects. Return `'reproduced'` when the same discrepancy persists, `'resolved'` when the new revision already fixes it, or `'unavailable'` when the app lacks sufficient evidence.

The driver retains a private intent and result under the evaluator journal. A retry after a lost response resubmits the saved verdict. If a callback started but has no recorded result, reconcile its original effects and send the verified result through `reportLearningRecheck`. Preserve the journal while reconciling. An unavailable check lets other corrections proceed. Start the evaluator with the compiled application module.

```sh
acclimate-learning --config /private/evaluator.json --connection "$CONNECTION_ID" \
  --installation "$INSTALLATION_ID" --apps ./dist/learning-evaluators.mjs
```

Keep this process running with the same private evaluator config and durable `journalRoot` used
by the evaluation runner. It polls for assignments, passes cancellation into active evaluation
callbacks, and reconciles saved reports after a restart. If execution began without a saved report,
the journal preserves uncertainty and the driver reports a diagnostic for operator reconciliation.
Use `--live` or `allowLive: true` to authorize live execution. Declare `apps.recheckExecution` and `apps.requalifyFieldCaseExecution` independently. An omitted replay mode defaults to `'live'`. Specify `'model-free'` only for a callback that runs without a model. Applications that manage
their own process lifecycle can call `serveConnectedLearning` with an `AbortSignal`.

### Audit fresh jobs after rollout

To measure a managed release in production, attach a fresh SDK delivery receipt to the same job's
terminal outcome. At the application’s actual start event, call `prepared.reportStarted()` (Python
`prepared.report_started()`) and persist its returned receipt with the job UUID. Repeated calls
for the prepared job return the same event. A missing reporter or full queue yields `null` in
TypeScript or `None` in Python. If the reporter queue was full, retry on the same prepared job after it drains. The SDK keeps the original start timestamp and event ID. Apps using the lower-level `resolveAndCache` API can instead call
`receiptReporter.reportStartedReceipt(version)` once at that event. Ensure delivery of the
receipt before submitting the terminal outcome. A durable outbox can send the exact receipt again
using its original UUID and the receipt credential.

Pass that receipt as `startedReceipt` to the terminal outcome hook. When the service recognizes an
eligible job on a managed release, its accepted outcome includes `fieldAudit` with the
assigned control's pinned version and digest. A fresh resolution and exact channel revision are
required. Receipt-only observations provide no field verdict.

Install the independent evaluator with the separate evaluator principal. The SDK selects eligible
jobs by a stable hash of workspace, connection, and outcome UUID. The default is 10 percent.
Configure `samplePercent: 100` for deterministic qualification or an explicitly chosen
low-volume rollout. The evaluator independently grades the recorded served result and performs
a read-only replay of the assigned control on the same private input and objective. The SDK
passes this control as `predecessor`. It can precede several successive releases. Its output should be
`correct`, `incorrect`, or `indeterminate` for each arm. A correct predecessor and incorrect
served result count as a regression. A correct served result with a known predecessor grade
counts as a pass. Two incorrect results or an indeterminate comparison contribute neither.

```ts
import { createLearningFieldAuditor } from '@acclimate/sdk/learning';

const prepareFieldAudit = createLearningFieldAuditor({
  client: evaluatorClient,
  workspaceId,
  connectionId,
  cacheDir: evaluatorCache,
  evaluate: async ({ job, served, predecessor, signal }) => {
    return gradeRecordedJobAndReplayReadOnly(job, { served, predecessor, signal });
  },
});

// The app's durable evaluator task owns this work item and retains its private job data.
const fieldAudit = await prepareFieldAudit(job.version, {
  job: job.privateFieldEvaluationData,
  startedReceipt: job.startedReceipt,
  outcome: job.acceptedOutcome,
  signal,
});
if (fieldAudit) await fieldAuditOutbox.save(fieldAudit.outcomeId, fieldAudit);
```

The outbox sends the saved verdict through `evaluatorClient.reportLearningFieldAudit(workspaceId,
connectionId, fieldAudit)`. Retry the saved request with the same outcome UUID without replaying
the app job. If native predecessor execution became uncertain, settle the original attempt through
the app's own journal before issuing any replacement work. Keep customer input, served output, and
the replay's evidence private.

Keep sending a completed grade if another release has shipped. The service records the verdict against the served revision and returns its field window. Only the current revision can trigger automatic rollback. Three regressions among its latest ten accepted verdicts can restore the assigned control. Ten passing accepted verdicts while the release is still current can establish it as a field control for later releases.

The optional `requalifyFieldCase` callback above handles a previous field failure when a candidate reproduces withdrawn content. Implement `gradePriorFieldRegression` using the original private input from `assignment.outcomeId` and the supplied candidate. Return `'pass'` if the candidate now satisfies the original objective, otherwise `'regression'`. The worker saves intent before calling the grader, stores its verdict before posting it, and reuses the saved verdict after an interrupted delivery. Preserve the private grader's own evidence. An `execution.uncertain` diagnostic means the prior callback started without a saved verdict. Reconcile that private execution and submit its verified result with `reportLearningFieldReplay`. A failed required replay blocks release.

An app that owns replay scheduling directly can call `evaluatorClient.getLearningFieldRequalification(workspaceId, connectionId, versionId)` to obtain the pinned version, digest, baseline revision and pending outcome IDs. Use `evaluatorClient.reportLearningFieldReplay(workspaceId, connectionId, body)` to submit the saved verdict. If the baseline changes, read the outstanding obligations for the new revision. [Wire fields and restore semantics](../contracts/learning.md#service-managed-connected-learning).

### Replay the incident that prompted a change

When a reported outcome includes teaching, set `requireIncidentReplay: true` on the outcome or on a later `reportLearningCorrection` request. Each candidate for that correction must pass a replay of its original private incident before it can advance to the independent audit. The original outcome ID identifies the application record. For example, an invoice agent can load the disputed invoice from its private job store and check whether the candidate now takes the reviewed action.

Implement `apps.replayIncident({ assignment, candidate, signal })` in the connected evaluator. Resolve private inputs by `assignment.outcomeId`, execute the check with read-only effects on the verified candidate, and return `pass`, `regression`, or `unavailable`. A regression or unavailable verdict blocks this round. Set `replayIncidentExecution: 'model-free'` for deterministic callbacks, or explicitly authorize live execution as for other private replays. Only the verdict and binding identifiers go to the service. The evaluator journals the callback intent and verdict so it can retry delivery after an interruption. If a callback's completion is uncertain, reconcile the private execution before submitting its verified verdict with `reportLearningIncidentReplay`.

Open **Delivery → Find a reported outcome** for the connection, or call `client.getLearningOutcome(workspaceId, connectionId, outcomeId)` with workspace read access. A lookup shows the terminal job version, each correction's admission or recheck state, its most recent round and any candidate replay verdict. A reported outcome with no corrections can receive reviewed teaching later. A worker diagnostic ending in `_callback_missing` includes the outcome UUID as its correlation ID. Install the named callback, or run the assignment with your separate evaluator. The same assignment can be recovered using the original journal.

The outcome lookup also shows the version and revision currently delivered by the connection. For an audited job it shows the field verdict, its control version and whether that verdict triggered a rollback. A correction that reached rollout retains its original promotion, along with any subsequent withdrawal and the version and revision the rollback restored. The development and independent audit links open the candidate's recorded evidence.

At worker startup, `learning.apps_module_missing` means the `--apps` path does not identify an installed file. For `learning.apps_module_load_failed`, check the module's imports in the worker's Node installation. For `learning.apps_invalid_export`, default-export `{ development, audit: [...] }` using evaluations built with `defineEvaluation` from the installed SDK. Optional replay callbacks must be functions. The worker checks the module before reading evaluator configuration or polling for work.

When embedding the worker, the second argument to `onDiagnostic` carries the local error, including any underlying callback error as its cause. The CLI prints the safe diagnostic.
