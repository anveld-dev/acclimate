# @acclimate/sdk

TypeScript SDK for Acclimate, a self-hosted service that versions and delivers agent instructions, skills and memory. Requires Node.js 22.22 or later on Linux or macOS.

Install a verified SDK tarball from a GitHub release or a checkout build.

```sh
npm install --offline --ignore-scripts /path/to/acclimate-sdk-0.1.0.tgz
```

Verify release artifacts against `SHA256SUMS`. From a checkout, run `npm ci --ignore-scripts` and `npm run build:packages`, then run `npm pack --workspace @acclimate/sdk` to create the tarball. Registry installation with `npm install @acclimate/sdk` requires a separate registry publication.

## Test an evaluator adapter

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
npx acclimate-eval try --payload ./bundle --live
```

## Run a learning loop

Release a bundle and configure the service optimizer. Set `ACCLIMATE_URL`, `ACCLIMATE_WORKSPACE` and `ACCLIMATE_TOKEN` for a machine principal with `evaluate` and `promote`. Save a default-exported `defineLoop` configuration in `acclimate.loop.ts`, then run `npx acclimate learn`. Use `openai()` for OpenAI-compatible Chat Completions or supply your own executor. For a loop with an app-managed held-out split, use `acclimate-learning`.

Use `createAcclimate().job(bundle, { channel, input })` to pin the release for a production job. After running the job, call `await job.expect(expected)` as the enrolled app principal to record a known answer for the evolve split.

## Start a job with its connection’s release

```ts
import { AcclimateClient } from '@acclimate/sdk';

const client = new AcclimateClient({
  baseUrl: process.env.ACCLIMATE_URL!,
  token: process.env.ACCLIMATE_TOKEN!,
  scope: 'support-agent',
  connectionId: process.env.ACCLIMATE_CONNECTION!,
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
| `@acclimate/sdk` | Client, delivery, payload validation helpers. |
| `@acclimate/sdk/validation` | Payload and native compatibility checks without Node file APIs. |
| `@acclimate/sdk/evaluation` | `defineEvaluation`, `tryEvaluation` and the application adapter types. |
| `@acclimate/sdk/learning` | Configure a learning loop, serve evaluations and report outcomes. |
| `@acclimate/sdk/native-files` | Inspect and prepare bundle files for native harnesses. |
| `@acclimate/sdk/evaluation/manifest` | Create and restore an application manifest. |
| `@acclimate/sdk/evaluation/cli` | Run evaluator commands against an application adapter. |
| `@acclimate/sdk/evaluation/app-cli` | Load and run an installed application adapter. |

`acclimate-eval` provides `try`, `describe`, `coverage`, `doctor`, and `pull`.

## Documentation

- [TypeScript SDK reference](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/reference/typescript-sdk.mdx)
- [Evaluator CLI reference](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/reference/evaluator-cli.mdx)
- [Versioning and compatibility](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/reference/versioning.mdx)

Licensed under Apache-2.0.
