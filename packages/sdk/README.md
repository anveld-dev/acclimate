# @acclimate/sdk

TypeScript SDK for [Acclimate](https://github.com/anveld-dev/acclimate), a self-hosted service that versions an agent's instructions, skills and memory, compares versions on saved cases, and gates releases on the results.

Requires Node.js 22.22 or later on Linux or macOS. The durable evaluator also needs `python3` with `fcntl` for its journal lock.

```sh
npm install @acclimate/sdk
```

For an air-gapped install, verify the release files against `SHA256SUMS` and run `npm install --offline --ignore-scripts /path/to/acclimate-sdk-0.1.0.tgz`.

## Evaluate a change

Put an `application.mjs` (or `application.mts`) next to your agent. It exports the saved cases, a callback that runs your agent with one version of its instructions, and an independent grader.

```js
// application.mjs
import { runAgent, scoreResult, savedCases } from './support-agent.mjs';

export const cases = savedCases; // [{ caseId, input, expected }]

export async function execute({ version, input, signal }) {
  const result = await runAgent({ files: version.payload.files, task: input, signal });
  return { output: result.answer, usage: result.usage };
}

export async function grade({ output, expected }) {
  return scoreResult(output, expected); // { reward: 0..1, explanation? }
}
```

```sh
npx acclimate-eval describe
npx acclimate-eval compare --config "$EVALUATOR_CONFIG" --handoff "$HANDOFF" --live
```

## Deliver a pinned version to a job

```ts
import { AcclimateClient } from '@acclimate/sdk';

const client = new AcclimateClient({
  baseUrl: process.env.ACCLIMATE_URL!,
  token: process.env.ACCLIMATE_TOKEN!,
  scope: 'support-agent',
});
const prepared = await client.prepare({ workspaceId, bundleId, channel: 'stable' });
try {
  await runAgent({ instructions: prepared.instructions, skillFiles: prepared.skillFiles });
} finally {
  await prepared.cleanup();
}
```

## Entry points

| Import | Use |
| --- | --- |
| `@acclimate/sdk` | Client, delivery, payload validation and comparison helpers. |
| `@acclimate/sdk/validation` | Payload and native compatibility checks without Node file APIs. |
| `@acclimate/sdk/evaluation` | `defineEvaluation`, `runEvaluation` and the application adapter types. |
| `@acclimate/sdk/evaluation/*` | Quality policy, review artifacts, analysis, manifests, progress and CLI entries. |
| `@acclimate/sdk/learning` | Connected learning reporters and the learning worker. |

The package installs two commands: `acclimate-eval` for evaluations and `acclimate-learning` for the connected learning worker.

## Documentation

- [TypeScript SDK reference](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/reference/typescript-sdk.mdx)
- [Evaluator CLI reference](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/reference/evaluator-cli.mdx)
- [Versioning and compatibility](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/reference/versioning.mdx)

Licensed under Apache-2.0.
