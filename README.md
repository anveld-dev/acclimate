# Acclimate

**Acclimate improves your agent's harness on its own and delivers each version to your jobs.** It runs the self-improvement loop from [arXiv 2611.18856](https://arxiv.org/abs/2611.18856). Each round it scores the released version on your evolve cases, writes five candidate changes from the scores, traces and errors, screens them, evaluates the survivors and releases the one the selector adopts. An improvement memory records what each change was meant to fix and what it fixed, so later rounds, and later models, build on it.

Your application still runs the agent and grades its work. Acclimate versions the instructions, skills and memory files it uses, delivers the released version to the next job, and lets you point a channel back at an earlier version.

Versioned delivery is available now. The self-improvement loop ships in a later phase.

Acclimate is open source under Apache-2.0 and self-hosted. Your agents, prompts, tasks, and model credentials stay in your environment.

## Run the local stack

Start Acclimate on your laptop to publish and deliver an example bundle. You need Docker with Compose v2.24+, Node.js with npm, and Python 3.9+ for the stack scripts.

```sh
npm run local:up
source .local/stack/env.sh
```

The first start pulls the released images, or builds from source in 10 to 20 minutes if none are published for your checkout's version. It prints the console URL and a login. It also gives that login a ready `local-demo` workspace with an example bundle on the `stable` channel, and writes the CLI settings to `env.sh`. Run `npm run local:trust` to trust its HTTPS certificate in your browser. [Run Acclimate locally](apps/docs/content/docs/get-started/run-locally.mdx)

## Deliver content to jobs

**Deliver content to jobs.** The SDK fetches and verifies the released version when your application starts a job, and prepares files for agents such as Codex or the Claude Agent SDK. In the console, **App setup** shows the client configuration for a bundle and channel. [Native integration](examples/native-repository/README.md)

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
