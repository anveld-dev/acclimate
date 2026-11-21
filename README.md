# Acclimate

**Acclimate versions and delivers your agent’s instructions, skills and memory files.** Its learning loop, based on [Self-Improvement Memory (arXiv 2611.18856)](https://arxiv.org/abs/2611.18856), proposes, evaluates and releases improvements to enrolled bundles.

Your application still runs the agent and grades its work. Acclimate versions the instructions, skills and memory files it uses, delivers the released version to the next job, and lets you point a channel back at an earlier version.

Each round proposes five candidates, screens them, evaluates the survivors and selects one to adopt or keeps the current release. An adoption releases the version and adds an attempt to improvement memory. The evaluator scores the retained version on private held-out cases for monitoring.

Acclimate is open source under Apache-2.0 and self-hosted. Your application runs the agents and keeps its own model credentials. The service sends the harness and evolve feedback to the configured optimizer. Held-out inputs and expected answers stay with the evaluator.

## Run the local stack

Start Acclimate on your laptop to publish and deliver an example bundle. You need Docker with Compose v2.24+, Node.js with npm, and Python 3.9+ for the stack scripts.

```sh
npm run local:up
source .local/stack/env.sh
```

The first start pulls the released images, or builds from source in 10 to 20 minutes if none are published for your checkout's version. It prints the console URL and a login. It also gives that login a ready `local-demo` workspace with an example bundle on the `stable` channel, and writes the CLI settings to `env.sh`. Run `npm run local:trust` to trust its HTTPS certificate in your browser. [Run Acclimate locally](apps/docs/content/docs/get-started/run-locally.mdx)

## Run a learning loop

Install the TypeScript SDK from a verified tarball or build it from a checkout. [SDK installation](packages/sdk/README.md) The built-in `openai()` adapter and service optimizer use OpenAI-compatible Chat Completions endpoints. For Codex, sign in through CLIProxyAPI and set `OPENAI_BASE_URL=http://127.0.0.1:8317/v1`. Set `OPENAI_API_KEY` if your proxy requires one. [CLIProxyAPI setup](apps/docs/content/docs/guides/learning-loop.mdx#use-codex-through-cliproxyapi) Set `ACCLIMATE_URL`, `ACCLIMATE_WORKSPACE` and `ACCLIMATE_TOKEN` using a machine token with **Promote** and **Evaluate**. With a bundle released and the service optimizer configured, save this as `acclimate.loop.ts`.

```ts
import { defineLoop, exact, openai } from '@acclimate/sdk/learning';

export default defineLoop({
  bundle: 'support-agent',
  channel: 'stable',
  agent: openai({ model: 'gpt-6.2-sol', parse: text => JSON.parse(text) as { action: string } }),
  cases: './cases.jsonl',
  grade: exact('action'),
});
```

Add labeled tickets with `input` and `expected` fields to `cases.jsonl`, then run `npx acclimate learn`. The CLI splits cases by a stable hash and needs at least one case in each split. Python users can define and run the same loop with `python -m acclimate learn`. [Learning loop quick start](apps/docs/content/docs/guides/learning-loop.mdx)

Use the enrolled app principal to report a known answer for a production job. It becomes an evolve case for the next round.

```ts
import { createAcclimate } from '@acclimate/sdk';

const job = await createAcclimate().job('support-agent', { channel: 'stable', input: ticket });
// Run the agent with the files from job.prepare(...), then:
await job.expect({ action: 'refund' });
```

To move to a new model, change `openai({ model })` and run `npx acclimate learn` again. The loop records the new setting and keeps its improvement memory, so later rounds build on what earlier models learned.

## Deliver content to jobs

The SDK fetches and verifies the released version when your application starts a job, and prepares files for agents such as Codex or the Claude Agent SDK. In the console, **App setup** shows the client configuration for a bundle and channel. [Native integration](examples/native-repository/README.md)

## Operate or develop Acclimate

The Rust API stores bundles, versions and releases in PostgreSQL. The web console uses Keycloak sign-in. Each release publishes service and console images to GHCR, and attaches the SDK tarballs and Python wheel to its GitHub Release. You can also build them from a checkout.

[Self-host Acclimate](deploy/README.md) · [Local development and verification](docs/development.md) · [Contributing](CONTRIBUTING.md)

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

[Architecture](docs/architecture/README.md) · [HTTP contract](contracts/README.md) · [Behavior tests](features/README.md) · [Product docs site](apps/docs/README.md) · [HTML documentation](docs/site/index.html)

Inspired by [AgentRun](https://github.com/Parcha-ai/agentrun) and [RRSI](https://github.com/google-research/rrsi).

## License

Acclimate is licensed under the [Apache License 2.0](LICENSE).
