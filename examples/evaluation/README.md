# Installed application evaluation

The console creates a frozen request and hands its ID and public configuration to your application. Creating a request does not run an adapter. **Copy configuration** includes the configured public HTTPS API URL, project, bundle, request and descriptor; it contains no evaluator credential or private filesystem path.

To use an adapter included in this checkout, install and configure the checkout separately. Create an owner-only directory (0700) and a JSON file (0600) outside version control with this shape. Replace every placeholder privately; do not paste the resulting credentials into chat, the console, logs or a command line:

```json
{
  "schemaVersion": 1,
  "serviceUrl": "https://api.example.com",
  "workspaceId": "YOUR_WORKSPACE_ID",
  "evaluatorPrincipalId": "YOUR_DEDICATED_EVALUATOR_PRINCIPAL",
  "evaluatorToken": "YOUR_SCOPED_EVALUATOR_TOKEN",
  "journalRoot": "/absolute/private/evaluation-journals"
}
```

The evaluator credential needs read/write access to the selected workspace; it needs neither propose nor promote. The service URL, project and principal must identify the same application as the request. Remote API URLs require HTTPS. HTTP is accepted only for an explicitly configured same-host private hop at 127.0.0.1, localhost or [::1]; it is never a public deployment recipe. `journalRoot` must be absolute and owner-only; the helper creates it when absent. Symlinks, shared permissions, unknown fields, oversized files and missing configuration are rejected. The helper reads only the file supplied through `--config`; environment credentials, launcher files and default state directories are never consulted.

For your own agent, install the [application evaluator starter](../evaluation-starter/README.md) and provide your agent, cases and grader. To evaluate Codex on the saved code-review tasks included in this checkout, print the installed descriptor, use it to create a request in the console, and run that request against the deployed service:

```sh
npm run --silent evaluate:app -- describe
npm run evaluate:app -- --config /absolute/private/evaluator.json --bundleID UUID --requestID UUID --adapter codex-luna-review --live
```

For the policy decision on the saved request, download its public JSON from the console and run:

```sh
npm run --silent evaluate:app -- check --config /absolute/private/evaluator.json --handoff handoff.json --policy /path/to/your/quality-policy.json
```

This installed adapter prepares each immutable bundle using the Codex plugin, then runs the existing `service-proposer` saved review cases and independent exact-finding grader. It authorizes at most four Luna turns, each with a 110-second timeout, read-only filesystem, disabled network and no approvals. Use it only when paid execution is intended and Codex authentication is already configured.

The checkout's `evaluate:app` command passes an installed `InstalledAdapter` to the test harness in [`scripts/evaluator-tests/runner.ts`](../../scripts/evaluator-tests/runner.ts). Your own application uses the public `runEvaluation` from `@acclimate/sdk/evaluation` or the installed CLI instead. Its `describe()` returns dataset/grader revisions, a fixed case inventory, and runtime identity including app-owned `configId`/`configRevision`. Its installed callbacks own execution and grading. The request must structurally match those values before any execution starts. A service request cannot name a script, module, URL, path or credential to execute. The CLI selects only names installed in its explicit allowlist.

The native example retains prepared inputs and reports `execution.uncertain` when its SDK await fails; a timeout/error is not proof that provider work stopped. It does not automatically execute the candidate after an uncertain parent run. The [native repository starter](../native-repository/README.md) adds persistent job locators and operator-reviewed quarantine recovery.

Each request has an owner-only journal scoped to service/project/bundle/request/evaluator. New journal writes also record the absolute journal root and refuse recovery from a relocated copy. A kernel file lock (Python 3 `fcntl`) grants exclusive process ownership. The helper saves attempt and idempotency keys before start, the execution marker before callbacks, and the exact report before submission. A response lost during start, report submission or finish can be recovered with the same private configuration and command. Keep the exact service URL, project, evaluator principal and original journal root for unfinished requests. Token rotation is possible only for the same authorized principal. Per-case outputs are private JSON files referenced by the report. Complete losses finish `completed`; retained infrastructure or grading failures finish `failed` with partial evidence.

If a process dies after execution starts without saving a report, another invocation refuses to execute again. Interrupt that request in the console and create a new request. Do not delete the journal to retry an execution. A lock file's presence or PID is never treated as proof that execution did or did not happen.
