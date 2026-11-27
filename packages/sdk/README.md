# @anveld/acclimate-sdk

TypeScript SDK for Acclimate, a self-hosted service that versions and delivers agent instructions, skills and memory. Requires Node.js 22.22 or later on Linux or macOS.

Install the version that matches your Acclimate service from npm.

```sh
npm install @anveld/acclimate-sdk@0.3.0
```

For offline installation, use a verified SDK tarball from a [GitHub Release](https://github.com/anveld-dev/acclimate/releases) or a checkout build.

```sh
npm install --offline --ignore-scripts /path/to/anveld-acclimate-sdk-0.3.0.tgz
```

Verify release artifacts against `SHA256SUMS`. From a checkout, run `npm ci --ignore-scripts` and `npm run build:packages`, then run `npm pack --workspace @anveld/acclimate-sdk` to create the tarball.

## Production outcomes

An application with workspace write access can call `job.expect(expected, { input, output })` after a production job. The SDK sends the pinned version and digest. The service assigns the task’s split and runs admission.

## Start a job with its connection’s release

```ts
import { AcclimateClient } from '@anveld/acclimate-sdk';

const client = new AcclimateClient({
  baseUrl: process.env.ACCLIMATE_URL!,
  token: process.env.ACCLIMATE_TOKEN!,
  scope: 'support-agent',
  connectionId: process.env.ACCLIMATE_CONNECTION!,
});
const prepared = await client.prepare({ workspaceId, bundleId, channel: 'stable' });
try {
  // systemPrompt renders the bundle exactly as learning rollouts see it.
  await runAgent({ systemPrompt: prepared.systemPrompt });
} finally {
  await prepared.cleanup();
}
```

## Entry points

| Import | Use |
| --- | --- |
| `@anveld/acclimate-sdk` | Client, delivery, payload validation helpers. |
| `@anveld/acclimate-sdk/validation` | Payload and native compatibility checks without Node file APIs. |
| `@anveld/acclimate-sdk/native-files` | Inspect and prepare bundle files for native harnesses. |

The `acclimate` command saves, publishes and releases bundles: `acclimate pull`, `publish`, `release` and `rollback`. It reads `ACCLIMATE_URL`, `ACCLIMATE_WORKSPACE` and `ACCLIMATE_TOKEN`, takes a bundle name with `--bundle` and prints one JSON line. Run `acclimate --help` for the flags.

## Documentation

- [TypeScript SDK reference](https://acclimate.anveld.dev/docs/reference/typescript-sdk)
- [Versioning and compatibility](https://acclimate.anveld.dev/docs/reference/versioning)

Licensed under Apache-2.0.
