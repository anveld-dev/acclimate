# Acclimate

A small Rust service for improving and delivering an agent's instructions, skills, and approved memory. Your application keeps its native SDK, tools, credentials, and agent loop.

Start with the task you want to complete:

- [Connect an existing agent and run its first comparison](docs/getting-started.md). Use an existing workspace and the installed TypeScript/Python evaluator starter.
- [Try a model-free comparison](examples/evaluation-starter/README.md#install-and-try-without-a-service). The shipped trial needs no service, identity provider, or model credential and is clearly simulated.
- [Operate a deployment](deploy/README.md) or [provision an evaluator](docs/evaluator-operations.md). Keep application adoption separate from operating the platform.
- [Develop Acclimate](docs/development.md). Repository builds and qualification commands are below.

- **Web console:** TanStack Start in `apps/console`; content editing, evaluation handoff and releases. Uses Keycloak sign-in and explicit production configuration.
- **Service:** immutable versions, scoped access, proposals, comparison reports, channel promotion and rollback in PostgreSQL.
- **TypeScript and Python SDKs:** verified delivery and installed application-owned paired evaluators, with explicit lifecycle recovery, CI quality policies, and deliberate review exports.
- **Continuous learning:** an app-owned durable learner (`@acclimate/sdk/learning`) connects scoped task feedback, candidate comparisons, audit history and reviewer releases. Try the [recurring model-free qualification](examples/continuous-learning/README.md).
- **Plugins:** Codex, Claude, Pi and Cursor file mappings. Codex has live Luna session checks; Claude options and Pi resource loading have offline checks.

[Behavior tests](features/README.md) · [Console setup](apps/console/README.md) · [Keycloak setup](deploy/keycloak/README.md) · [Setup](docs/development.md) · [Architecture](docs/architecture/README.md) · [Open the HTML docs](docs/site/index.html) · [Wire contract](contracts/IMPLEMENTATION.md)

For a coding repository, use the [native repository starter](examples/native-repository/README.md). For PR checks, use the [CI starter](examples/ci/README.md). Evaluation completion, an application quality-policy pass, and release authorization are separate decisions; evaluators do not promote a channel.

## Develop and verify

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

The service also needs PostgreSQL and operator-configured access grants. Follow the setup guide for PostgreSQL, OIDC, service credentials and the public HTTPS endpoints. There is one production identity path; `local` and `demo` no longer provision an operator account. All model-backed development examples accept only Luna models. Other tests use deterministic callbacks or a local fixture provider.

Inspired by [AgentRun](https://github.com/Parcha-ai/agentrun) and [RRSI](https://github.com/google-research/rrsi). This release improves content files; it does not host your agents or automatically promote a candidate. TypeScript tarballs and a thin Python wheel build locally. The five-stage roadmap is implemented and locally qualified. In-place reload, live Claude/Pi/Cursor providers, the container runtime, and distributed proposer execution are not qualified by these checks.

The [production-only plan](docs/architecture/production-only/plan.md) and [parallel implementation](docs/architecture/production-only/parallel-work.md) describe the identity cutover. The [productization checklist](docs/architecture/productization/remediation/README.md) and [historical shipping ledger](docs/architecture/productization/remediation/shipping-evidence.md) distinguish earlier local checks, actual Luna runs, and external gates. New evaluator/repository wiring checks do not imply native model quality or a qualified public deployment.


`npm run pack:verify` checks the SDK/plugin tarballs in a clean external app. Python's SDK is in [python](python/README.md). The [improvement example](examples/improvement/README.md) uses Luna to draft one skill change, compare both versions, and save the artifacts for review. It stops before promotion.


The [whole roadmap record](docs/implementation/full-roadmap.md) covers the complete acceptance path. Use [operator commands](tools/operator/README.md) for verified review, proposal requests, history, explicit promotion and rollback; [deployment recipes](deploy/README.md) cover the PostgreSQL, Rust API, web console and TLS proxy stack. `npm run qualify:full-roadmap` is the default model-free end-to-end check; `:live` explicitly authorizes the five-turn Luna qualification.

The [live learning qualification](examples/self-improvement/README.md) goes beyond wiring checks: it measures learned instructions, skills and memory on separate policy tasks, then checks that a released version improves a fresh Codex/Luna job. It uses disposable PostgreSQL, retains failed attempts, and requires explicit `--live` authorization for model calls. The [larger stress-test record](docs/research/self-improvement-stress-test.md) covers twenty proposal rounds, 12,288-record audits, retained failures and the qualified skill helper.
