# Acclimate

**Ship changes to your agent's prompts, skills, and memory like code: versioned, A/B-graded on your own tasks, gated before release, and roll-backable.**

Each change to your agent's instructions, skills, or approved memory becomes an immutable version. Your agent runs the current version and the new one on the same saved tasks, your grader scores both, and the change is released only when the paired results clear your bar. If a release goes wrong, you release the earlier version again.

**How it differs from eval tools.** promptfoo, Braintrust, LangSmith, and Inspect run evaluations and track scores. Acclimate covers what happens around the evaluation. It versions the agent's content, pairs each change with the version it replaces, gates the release on those results, and delivers the released version to your application's next job. Your application still runs the agent and grades its work, so an existing eval suite can serve as the grader.

Acclimate is open source under Apache-2.0 and self-hosted. Your agents, prompts, tasks, and model credentials stay in your environment.

## Try it locally, no server

Install the SDK in your agent's project (Node.js 22.22+, or Python 3.11+ for the Python SDK; see [install](apps/docs/content/docs/get-started/install.mdx)). Add an application module, `application.mjs` or `application.py`, that exports your saved `cases`, an `execute` function that calls your agent with the version it is given, and a `grade` function that returns a numeric reward. Put the current instructions in a `parent` folder and your edit in a `candidate` folder. Each folder is a [payload](apps/docs/content/docs/concepts/glossary.mdx): files under `skills/` become skills, files under `memory/` become memory, and the rest become instructions.

```sh
./node_modules/.bin/acclimate-eval try --live --payload candidate
./node_modules/.bin/acclimate-eval compare --local --parent parent --candidate candidate --live
# Python: python -m acclimate try … and python -m acclimate compare --local …
```

`try` runs one case and checks every value your callbacks return. `compare --local` grades both versions on the same cases with the same pairing as a service comparison and prints the parent and candidate scores. Nothing is sent to a server, and the advisory report is never release evidence. Omit `--live` when your adapter exports `execution` as `model-free`. [Quickstart](apps/docs/content/docs/get-started/quickstart.mdx)

## Run the local stack

To record comparisons and review them in the console, start Acclimate on your laptop. You need Docker with Compose v2.24+, Node.js with npm, and Python 3.9+ for the stack scripts.

```sh
npm run local:up
source .local/stack/env.sh
```

The first start pulls the released images, or builds from source in 10 to 20 minutes if none are published for your checkout's version. It prints the console URL and a login. It also gives that login a ready `local-demo` workspace with an example bundle on the `stable` channel, and writes the CLI settings to `env.sh`. Run `npm run local:trust` to trust its HTTPS certificate in your browser. [Run Acclimate locally](apps/docs/content/docs/get-started/run-locally.mdx)

## Run your first live comparison

Add an application module to your agent's project. It exports your saved `cases`, an `execute` function that calls your agent with the version it is given, and a `grade` function that returns a numeric reward. Then save the published version, edit it, and compare:

```sh
./node_modules/.bin/acclimate-eval pull --config "$EVALUATOR_CONFIG" --bundle "$BUNDLE_ID" --out candidate.json
# Edit candidate.json
./node_modules/.bin/acclimate-eval compare --config "$EVALUATOR_CONFIG" \
  --bundle "$BUNDLE_ID" --channel stable --payload candidate.json --name first-change --live
```

Python users run the same commands with `acclimate` (or `python -m acclimate`) from the Python SDK, which needs Python 3.11+. The result shows the parent and candidate scores and how many pairs were graded, and the change appears in the console under **Changes**. `--live` lets the evaluator call your agent with its own credentials. [Quickstart](apps/docs/content/docs/get-started/quickstart.mdx) · [Join a team's workspace](apps/docs/content/docs/get-started/join-a-team.mdx) · [Glossary](apps/docs/content/docs/concepts/glossary.mdx)

## After the first comparison

- **Gate releases.** Add a quality policy with `--policy` to check thresholds and measured costs, and run the same check on pull requests. [Evaluate a change](apps/docs/content/docs/guides/evaluate-a-change.mdx) · [Gate pull requests with the GitHub Action or CI wrapper](examples/ci/README.md)
- **Review and release.** Inspect comparisons in the console, release a version to a channel, or roll back to an earlier one. From a terminal, `acclimate-operator` ships in the SDK. [Review and release](tools/operator/README.md)
- **Deliver content to jobs.** The SDK fetches and verifies the released version when your application starts a job, and prepares files for agents such as Codex or the Claude Agent SDK. In the console, **App setup** shows the client configuration for a bundle and channel. [Native integration](examples/native-repository/README.md)
- **Learn from outcomes.** A connection can report job outcomes and approved corrections so the service proposes changes and schedules comparisons. [Connected learning](deploy/README.md#operate-connected-learning)

## Operate or develop Acclimate

The Rust API stores versions, evaluations, and releases in PostgreSQL. The web console uses Keycloak sign-in. Each release publishes service and console images to GHCR, and attaches the SDK tarballs and Python wheel to its GitHub Release. You can also build them from a checkout.

[Self-host Acclimate](deploy/README.md) · [Evaluator access and recovery](docs/evaluator-operations.md) · [Local development and verification](docs/development.md) · [Contributing](CONTRIBUTING.md)

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
