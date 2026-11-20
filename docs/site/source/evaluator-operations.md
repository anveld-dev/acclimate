# Evaluator operations

Use the local evaluator tools to develop the application adapter. Use the learning evaluator to serve work for an enrolled bundle.

From the installed application module's directory, use `acclimate-eval describe` to print its public descriptor, `coverage` to inspect the inputs it fingerprints, and `try --payload PATH` to run one case against a local payload. For Python use `python -m acclimate` with the same commands. Keep cases, expected results and provider credentials in the application environment.

`pull` downloads a released payload, and `doctor` checks application setup and access. These commands take a private `--config` file. For example:

```json
{
  "schemaVersion": 1,
  "serviceUrl": "https://api.example",
  "workspaceId": "my-workspace",
  "evaluatorPrincipalId": "machine:app-tools",
  "evaluatorTokenFile": "/private/acclimate-token",
  "journalRoot": "/private/acclimate-journal"
}
```

Keep the config and token file readable only by their owner. Use a machine token scoped to the workspace. See the [CLI reference](../apps/docs/content/docs/reference/evaluator-cli.mdx) for local commands.

## Serve the learning loop

Install the TypeScript SDK in the application project. Create a module that default-exports the evaluator callbacks and its held-out cases. This model-free example echoes a field so you can verify setup before wiring the app's agent.

```js
export default {
  execution: 'model-free',
  async execute({ input }) {
    return { output: input.action };
  },
  async grade({ output, expected }) {
    const passed = output === expected;
    return { score: passed ? 1 : 0, passed };
  },
  heldOut: [
    { caseId: 'private-1', input: { action: 'escalate' }, expected: 'escalate' },
  ],
};
```

The production `execute` callback receives the verified version, its prepared instructions, skill and memory files, the input, case ID, rollout index (0–4) and abort signal. Return `{ output, trace? }`. The `grade` callback receives output, expected result, case ID, rollout and signal. Return a finite score from 0 to 1 and a boolean `passed`. Keep real held-out cases in the evaluator's private store.

Compute the commitment locally.

```bash
acclimate-learning held-out --app ./learning-app.mjs
```

In the console, release a version on the intended channel and open the bundle's **Learning** tab as an administrator. Enroll with the channel, app principal ID, domain, benchmark, policy model and the printed digest and case count. Give the app principal `evaluate` on the workspace and use its ID and token in the evaluator config above. Add setup cases through the console or with `addEvolveCases` from `@acclimate/sdk/learning`. A running loop waits for its first live evolve case.

```bash
acclimate-learning --config /private/evaluator.json --bundle "$ACCLIMATE_BUNDLE" --app ./learning-app.mjs
```

Add `--live` for a module that declares live execution. To embed the runner, call `serveLearningLoop` with the config path, bundle ID and app module. Its `caseConcurrency` option controls parallel cases within one item and defaults to one. Work items are served serially. Each case runs five rollouts and the evaluator sends a whole-case report as soon as that case finishes.

Keep `journalRoot` on persistent private storage. A restart uses the saved attempt ID under `learning/<bundleId>/<evaluationId>.json` and skips cases the service already received. The evaluator continues polling while paused or stopped. A pause lets the active round finish. A stop cancels open evaluations and the runner aborts their callbacks when they disappear from the work feed.

Queued evaluations expire after `ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS` (default 7 days). Started evaluations expire after `ACCLIMATE_LEARNING_EVALUATION_SECONDS` (default 24 hours). The runner captures at most 16 KiB of trace and 4 KiB of error text per evolve rollout by default. Held-out rollouts send only scores and pass flags. A held-out commitment mismatch fails that monitoring evaluation with `learning.held_out_mismatch`.

A custom evaluator can poll `GET /work`, claim work with `POST /evaluations/{evaluationId}/start`, then send case results with `POST /evaluations/{evaluationId}/report`. Both writes require idempotency keys. See the [work protocol](architecture/self-improvement-memory/evaluator-and-contracts.md#evaluator-work-protocol) for request fields, attempt reuse and the pinned split.
