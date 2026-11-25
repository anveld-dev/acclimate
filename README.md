# Acclimate

**Acclimate versions and delivers an AI agent's instructions, skills and memory files.** It also improves them automatically from example tasks. It is open source under Apache-2.0 and self-hosted.

- **Delivery.** Publish the files as a bundle and release a version to a channel. The SDK fetches and verifies the released version each time your application starts a job. To undo a release, roll the channel back to an earlier version.
- **Learning.** Give a bundle tasks with expected answers. Each round proposes five candidate versions and scores them on the tasks. It then releases the one it selects or keeps the current version. Held-out tasks, which the optimizer never sees, check every release, and a confirmed drop reverts it. The loop is based on [Self-Improvement Memory (arXiv 2611.18856)](https://arxiv.org/abs/2611.18856).

Your application runs its agent with its own model credentials. Learning runs in a separate `acclimate-executor` container and uses the model provider that each workspace configures. The service stores that provider's API key encrypted. See [How Acclimate works](apps/docs/content/docs/index.mdx) for what each part does and sees.

## Run the local stack

Start Acclimate on your laptop to publish and deliver an example bundle. You need Docker Engine 26 or later with Compose v2.24 or later, Node.js with npm and Python 3.9 or later for the stack scripts.

```sh
npm run local:up
source .local/stack/env.sh
```

The first start pulls the released images. If none are published for your checkout's version, it builds from source, which takes 10 to 20 minutes. It then:

- prints the console URL and a login
- gives that login a ready `local-demo` workspace with an example bundle on the `stable` channel
- starts the executor
- writes the client settings to `env.sh`

Run `npm run local:trust` to trust the stack's HTTPS certificate in your browser. The [Quickstart](apps/docs/content/docs/get-started/quickstart.mdx) takes you from here to a delivered version, and [The local stack](apps/docs/content/docs/reference/local-stack.mdx) describes everything the stack sets up.

## Run a learning loop

Configure a model provider for the workspace and import about 50 tasks, so that each split reaches the 20 admitted tasks that learning needs. Then start learning on the bundle's **Learning** tab. Adopted versions are released automatically, with no approval step.

- On the local stack, [Run your first learning round](apps/docs/content/docs/tutorials/first-learning-round.mdx) sets up a model proxy and runs a round from one script. [`examples/learning/example-agent-tasks.jsonl`](examples/learning/README.md) gives the **Example agent** bundle 60 ready tasks.
- In the console, follow [Run a learning loop](apps/docs/content/docs/guides/learning-loop.mdx). It also covers reporting a production outcome from your application with `job.expect()`.
- On your own server, an operator sets the optimizer and starts the executor first. See [Enable learning](apps/docs/content/docs/operate/enable-learning.mdx).

## Deliver content to jobs

The SDK fetches and verifies the released version when your application starts a job, and prepares files for agent SDKs such as Codex or the Claude Agent SDK. In the console, **App setup** shows the client configuration for a bundle and channel. See [Deliver content to jobs](apps/docs/content/docs/guides/deliver-content.mdx) and the [native repository starter](examples/native-repository/README.md).

## Examples

[`examples/`](examples/README.md) holds programs you can run against the local stack. The [support agent](examples/support-agent/README.md) answers with the released bundle and reports a person's correction as a learning task. [Ticket triage](examples/ticket-triage/README.md) publishes a bundle, imports 64 labelled tickets and runs the learning loop from one script. Both come in TypeScript and Python, with [walkthroughs](apps/docs/content/docs/tutorials/first-learning-round.mdx) in the documentation.

## Operate or develop Acclimate

The service is written in Rust and stores bundles, versions and releases in PostgreSQL. The web console uses Keycloak sign-in. Each Acclimate release publishes service and console images to GHCR, and attaches the SDK tarballs and Python wheel to its GitHub Release. You can also build them from a checkout.

[Self-host Acclimate](apps/docs/content/docs/operate/self-host.mdx) · [Deployment files](deploy/README.md) · [Local development and verification](docs/development.md) · [Contributing](CONTRIBUTING.md)

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

[Architecture](docs/architecture/README.md) · [HTTP contract](contracts/README.md) · [Behavior tests](features/README.md) · [Product docs](https://acclimate.anveld.dev) ([source](apps/docs/README.md)) · [HTML documentation](docs/site/index.html)

Inspired by [AgentRun](https://github.com/Parcha-ai/agentrun) and [RRSI](https://github.com/google-research/rrsi).

## License

Acclimate is licensed under the [Apache License 2.0](LICENSE).
