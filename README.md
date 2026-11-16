# Acclimate

A small Rust service for improving and delivering an agent's instructions, skills, and approved memory. Your application keeps its native SDK, tools, credentials, and agent loop.

- **Web console:** TanStack Start in `apps/console`; content editing, evaluation handoff and releases. Uses Keycloak sign-in and explicit production configuration.
- **Service:** immutable versions, scoped access, proposals, comparison reports, channel promotion and rollback in PostgreSQL.
- **TypeScript SDK:** verified local caching, safe file preparation, and paired app-run comparisons.
- **Plugins:** Codex, Claude, Pi and Cursor file mappings. Codex has live Luna session checks; Claude options and Pi resource loading have offline checks.

[Behavior tests](features/README.md) · [Console setup](apps/console/README.md) · [Keycloak setup](deploy/keycloak/README.md) · [Setup](docs/development.md) · [Architecture](docs/architecture/README.md) · [Open the HTML docs](docs/site/index.html) · [Wire contract](contracts/IMPLEMENTATION.md)

The [production-only plan](docs/architecture/production-only/plan.md) and [parallel implementation](docs/architecture/production-only/parallel-work.md) describe the current cutover.

The [productization checklist](docs/architecture/productization/remediation/README.md) maps the latest fixes to acceptance checks. The [shipping ledger](docs/architecture/productization/remediation/shipping-evidence.md) separates local results, actual Luna runs and external gates that still need qualification.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

The service also needs PostgreSQL and operator-configured access grants. Follow the setup guide for PostgreSQL, OIDC, service credentials and the public HTTPS endpoints. There is one production identity path; `local` and `demo` no longer provision an operator account. All model-backed development examples accept only Luna models. Other tests use deterministic callbacks or a local fixture provider.

Inspired by [AgentRun](https://github.com/Parcha-ai/agentrun) and [RRSI](https://github.com/google-research/rrsi). This release improves content files; it does not host your agents or automatically promote a candidate. TypeScript tarballs and a thin Python wheel build locally. The five-stage roadmap is implemented and locally qualified. In-place reload, live Claude/Pi/Cursor providers, the container runtime, and distributed proposer execution are not qualified by these checks.


`npm run pack:verify` checks the SDK/plugin tarballs in a clean external app. Python's SDK is in [python](python/README.md). The [improvement example](examples/improvement/README.md) uses Luna to draft one skill change, compare both versions, and save the artifacts for review. It stops before promotion.


The [whole roadmap record](docs/implementation/full-roadmap.md) covers the complete acceptance path. Use [operator commands](tools/operator/README.md) for verified review, proposal requests, history, explicit promotion and rollback; [deployment recipes](deploy/README.md) cover the PostgreSQL, Rust API, web console and TLS proxy stack. `npm run qualify:full-roadmap` is the default model-free end-to-end check; `:live` explicitly authorizes the five-turn Luna qualification.

The [live learning qualification](examples/self-improvement/README.md) goes beyond wiring checks: it measures learned instructions, skills and memory on separate policy tasks, then checks that a released version improves a fresh Codex/Luna job. It uses disposable PostgreSQL, retains failed attempts, and requires explicit `--live` authorization for model calls. The [larger stress-test record](docs/research/self-improvement-stress-test.md) covers twenty proposal rounds, 12,288-record audits, retained failures and the qualified skill helper.
