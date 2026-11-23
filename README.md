# Acclimate

**Acclimate versions and delivers your agent’s instructions, skills and memory files.** Its learning loop, based on [Self-Improvement Memory (arXiv 2611.18856)](https://arxiv.org/abs/2611.18856), proposes, evaluates and releases improvements to enrolled bundles.

Your application still runs the agent for its own jobs. Acclimate versions the instructions, skills and memory files it uses, delivers the released version to the next job, and lets you point a channel back at an earlier version.

Each round proposes five candidates, screens them, evaluates the survivors and selects one to adopt or keeps the current release. An adoption releases the version and adds an attempt to improvement memory. The executor scores the retained version on held-out tasks for monitoring.

Acclimate is open source under Apache-2.0 and self-hosted. Your application runs its agents with its own model credentials. Learning rollouts run in the separate `acclimate-executor` container and reach the workspace's model provider through its gateway. The service stores that provider key encrypted. The service sends the harness and evolve feedback to the configured optimizer. Held-out inputs and expected answers are stored separately in the service.

## Run the local stack

Start Acclimate on your laptop to publish and deliver an example bundle. You need Docker with Compose v2.24+, Node.js with npm, and Python 3.9+ for the stack scripts.

```sh
npm run local:up
source .local/stack/env.sh
```

The first start pulls the released images, or builds from source in 10 to 20 minutes if none are published for your checkout's version. It prints the console URL and a login. It also gives that login a ready `local-demo` workspace with an example bundle on the `stable` channel, starts the rollout executor with its own credential, and writes the CLI settings to `env.sh`. To run learning rounds, export the optimizer settings (`ACCLIMATE_MODEL_ENDPOINT`, `ACCLIMATE_MODEL_TOKEN`, `ACCLIMATE_MODEL` and optionally `ACCLIMATE_MODEL_REASONING_EFFORT`) and, for a model proxy on your laptop, `ACCLIMATE_PROVIDER_HTTP_HOSTS` before `npm run local:up`. The stack keeps them for later starts. Run `npm run local:trust` to trust its HTTPS certificate in your browser. [Run Acclimate locally](apps/docs/content/docs/get-started/run-locally.mdx)

## Run a learning loop

1. On the workspace's **Members** page, under **Model provider**, configure an OpenAI-compatible model provider, its key and allowed models. Wait for the executor to verify that each model answers and reports token usage.
2. Open the released bundle’s **Learning** tab. Choose its channel, task model and a different judge model.
3. Import CSV, JSONL, a spreadsheet or pasted examples. Each task pairs an input with an expected answer or grading criteria. Review the task cards and confirm held-out material. Use **Try task** to inspect an executor run before starting a round.
4. Start learning once at least 20 evolve tasks and 20 held-out tasks pass admission. The same floor applies on resume.

The executor runs each rollout in a fresh sandbox and grades it outside the sandbox. An exact-match task scores 1 or 0. A criteria task is judged three times: it passes when at least two judgments pass every criterion, and its score is the share of criteria met. The service scores candidates on evolve tasks and automatically releases the selected version to the channel, with no approval step. Held-out scores monitor regressions. A held-out drop after an adoption raises a console alert. When a second measurement confirms a clear drop, the service reverts the release and emails verified workspace administrators. Inspect the round, usage and release history in the console or roll back an adopted round.

An application with workspace write access can call `job.expect(expected, { input, output })` after a production job. The SDK sends the pinned version and digest. The service assigns the task’s split and runs admission.

`npm run local:up` does the executor setup for you: it creates the executor token, builds the runner and executor images, sets the provider encryption key and starts the executor. A production deployment does these steps itself. Run the `acclimate-executor` container with a provisioned token mounted through `ACCLIMATE_EXECUTOR_TOKEN_FILE` and access to the Docker socket. Build the chat runner image and configure gVisor (`runsc`). Set `ACCLIMATE_PROVIDER_ENCRYPTION_KEY` on the service to a 64-character hex key so workspace provider credentials can be encrypted at rest. [Deployment guide](deploy/README.md#first-start) The reference model setup is CLIProxyAPI with a Codex sign-in. [CLIProxyAPI setup](deploy/README.md#cliproxyapi-with-codex-sign-in)

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
