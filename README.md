# Acclimate

Acclimate versions the instructions, skills and approved memory your agent uses. When you change them, your application runs the old and new versions on the same saved tasks and grades the results. Your team can review the evidence before releasing the change.

## Evaluate a change

Install the TypeScript or Python SDK in your agent's environment. Add an application module with three exports: your cases, a function that runs your agent, and a function that grades its output. Save the proposed change in your workspace and download its evaluation request.

```sh
# In the directory containing application.py
python -m acclimate compare --config "$EVALUATOR_CONFIG" --handoff evaluation-request.json --live

# In the directory containing application.mjs or application.mts
./node_modules/.bin/acclimate-eval compare --config "$EVALUATOR_CONFIG" --handoff evaluation-request.json --live
```

The result shows the parent and candidate scores and how many pairs were graded. Add `--policy` with your application's policy file to check thresholds or measured costs. The same command can create a comparison directly from a bundle payload. [Connect your agent and run its first comparison](docs/getting-started.md) · [Run a PR check against a Git commit](examples/ci/README.md)

## Deliver and improve content

- Use **App setup** in the console to prepare pinned content for each new job. Coding agents can stage repository files, run a native harness and grade retained changes against frozen tests. [Native integration](examples/native-repository/README.md)
- Enroll a connection to propose changes from trusted outcomes and run development and held-out evaluations. Choose manual release or an automatic policy. [Connected learning](deploy/README.md#operate-connected-learning)
- Inspect comparisons, authorize a channel release or restore a reviewed version. [Review and release](tools/operator/README.md)

## Operate or develop Acclimate

The Rust API stores versions, evaluations and releases in PostgreSQL. The web console uses Keycloak sign-in. Operators distribute versioned SDK tarballs and a Python wheel, and provision credentials for evaluators. [Deployment](deploy/README.md) · [Evaluator access and recovery](docs/evaluator-operations.md) · [Local development and verification](docs/development.md)

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

[Architecture](docs/architecture/README.md) · [Wire contract](contracts/IMPLEMENTATION.md) · [Behavior tests](features/README.md) · [HTML documentation](docs/site/index.html) · [Qualification records](docs/implementation/full-roadmap.md)

Inspired by [AgentRun](https://github.com/Parcha-ai/agentrun) and [RRSI](https://github.com/google-research/rrsi).
