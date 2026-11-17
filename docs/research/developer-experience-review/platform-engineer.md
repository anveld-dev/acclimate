# Platform engineer: team onboarding and evaluation operations

Date: 2026-11-16. This is a simulated, source-based persona review, not observed user research or a live deployment assessment.

## Persona and job

I run an internal agent platform for several application teams. I need to deploy Acclimate once, give each team the correct access, let developers diagnose their own content delivery, and recover evaluations without accidentally repeating paid or stateful work. I expect a clear distinction between human membership, delivery credentials, evaluator identity and release authority, plus enough operational information to tell whether an evaluator is working.

## Journey through the current product

1. **Install the control plane.** I follow `docs/development.md:7` into `deploy/README.md:9`. Even development uses PostgreSQL, Keycloak, production identity configuration and HTTPS. The configuration is explicit, but onboarding crosses multiple guides and private configuration files before an application developer can try the complete console flow.
2. **Give a team a workspace.** Machine grants can register projects at startup but do not create human membership (`deploy/README.md:42`). An exact configured operator creates a workspace or explicitly adopts a memberless one. This separation is coherent and auditable.
3. **Connect the app.** An administrator creates a bundle/channel connection and issues one-time content-read and optional receipt-write credentials (`apps/console/src/components/workspace-connections.tsx:484`). This supports published delivery, not evaluating unpublished candidates.
4. **Enable the team's first evaluation.** The console tells the team to ask me for a separate read/write evaluator machine principal (`apps/console/src/components/improvement-workspace.tsx:1362`). I edit the startup grant configuration and hand credentials over privately; the developer separately installs the checkout, writes a private evaluator JSON file, and chooses a durable journal path.
5. **Diagnose a run.** The service records requested/running/completed/failed/interrupted states, but the actual application owns execution. Service readiness does not establish evaluator health. A run marked running requires checking the external process and its private journal.
6. **Recover an interrupted host.** A saved complete report can be submitted again using the original identity/path. Execution that started without a saved report must not run again under that request; I record an interruption and create another request. The rules prioritize avoiding accidental replay but need an operational recipe to make them practical across workers.

## Findings

### PLAT-1 — P1: evaluator onboarding requires control-plane configuration changes

**Observed evidence.** Delivery Connections issue only `content-read` and `receipt-write` credentials (`apps/console/src/server/integration-core.ts:18`, `apps/console/src/server/integration-core.ts:199`). The eval setup explicitly requires a separate project read/write machine principal and explains that delivery credentials cannot evaluate unpublished candidates (`apps/console/src/components/improvement-workspace.tsx:1362`). Machine grants come from `ACCLIMATE_AUTH`, parsed once during startup into `AppState` (`src/main.rs:78`, `src/main.rs:109`); authentication consults that in-memory grant list (`src/auth.rs:102`). The deployment template supplies only an empty grant array (`deploy/service.env.example:11`); the full grant shape is documented separately in `contracts/IMPLEMENTATION.md:9`.

**Developer impact.** The first successful delivery integration does not give a team a self-service path to evaluation. Each new evaluator principal, project grant or token change requires platform involvement and service configuration/restart. With one Rust process per database and coordinated restarts, a routine team onboarding task becomes a shared service operation. This is a lifecycle/ergonomics limitation, not a claim that delivery tokens should gain evaluator powers.

**Recommendation.** Add an explicit evaluator provisioning path with project-scoped read/evaluation authority, stable principal identity and operator-managed credential rotation. As an incremental improvement, provide one exact operator runbook and a secret-safe grant validator that explain the current restart requirement, copy the public project ID into a template, and validate configuration before execution.

**Acceptance criterion.** Starting from a workspace and an ordinary connection, a team can identify the precise evaluator provisioning action and responsible role, receive only the required authority, and verify access without running a model. A documented rotation preserves the principal needed for pending reports; no delivery credential can read unpublished candidates.

### PLAT-2 — P1: “running” lacks a signal of evaluator liveness or progress

**Observed evidence.** An evaluation exposes status, evaluator principal, attempt, comparison, error and timestamps, with no heartbeat or case progress fields (`src/evaluations.rs:35`). Routes cover create/read/list/start/finish/interrupt (`src/evaluations.rs:72`), and state timestamps change only on a changed transition (`src/evaluations.rs:324`). The installed runner starts the attempt and then runs the full comparison before submitting its report (`examples/evaluation/runner.ts:101`, `examples/evaluation/runner.ts:118`, `examples/evaluation/runner.ts:135`). The deployment guide correctly says `/ready` does not prove queue progress or provider availability (`deploy/README.md:40`).

**Developer impact.** I cannot tell from Acclimate whether a long-running evaluation is executing case 5, waiting on a model, or has lost its host. “Last updated” is effectively a state-transition timestamp, so age alone is ambiguous. Developers escalate to platform staff, who must correlate the external host and private journal manually. This is an observability gap; the service is intentionally not the agent executor.

**Recommendation.** Offer optional app-reported heartbeat/progress observations bound to request, attempt and principal, plus a worker/job reference and last-observed timestamp. Display “last reported activity” separately from lifecycle state. A stale observation should mean liveness unknown and offer recovery guidance; it must not automatically rerun or cancel the app.

**Acceptance criterion.** An operator can distinguish a fresh app observation, an old observation and no observation, and see safe case counts or the external job link. A lost heartbeat never claims execution stopped or authorizes replay.

### PLAT-3 — P1 for ephemeral runners: recovery depends on retaining the original journal location

**Observed evidence.** The journal identity includes exact service URL, project, bundle, request and evaluator principal (`examples/evaluation/journal.ts:10`). New writes retain the absolute journal root; reads reject a relocated copy (`examples/evaluation/journal.ts:100`, `examples/evaluation/journal.ts:105`). Locks require Python 3 with POSIX `fcntl` (`examples/evaluation/journal.ts:31`, `examples/evaluation/journal.ts:58`). If a running attempt has no journal, or execution began without a complete saved report, the runner refuses reexecution (`examples/evaluation/runner.ts:90`). Output references are local `file:` URLs (`examples/evaluation/runner.ts:123`). The guide accurately documents these restrictions (`examples/evaluation/README.md:48`).

**Developer impact.** A team that chooses a temporary CI workspace or disposable container path can lose its recovery ability with the worker. Archiving the journal and restoring it under another checkout path does not satisfy the current contract. Service database backups alone do not cover these evaluator artifacts. The restrictions protect against duplicate execution, but the deployment guide primarily describes the control-plane stack rather than a durable evaluator worker.

**Recommendation.** Publish an evaluator worker deployment recipe with a private persistent volume mounted at a fixed canonical absolute path, required Python/POSIX dependencies, stable principal and service naming, journal/trace retention, and a recovery decision table. Expose a read-only, secret-safe journal inspection command. Preserve the no-reexecution rule.

**Acceptance criterion.** The recipe demonstrates successful recovery of a saved report after restarting a disposable worker with the same fixed mount and identity. It separately demonstrates that execution without a saved report refuses replay and leads to an explicit interruption/new request. Explain that copying to a different path is unsupported.

### PLAT-4 — P2: non-admin developers cannot use the Connections UI to debug delivery

**Observed evidence.** Console connection context rejects every non-admin project member before constructing the page state (`apps/console/src/server/integration-core.ts:96`). Service integration listing likewise requires admin (`src/integrations.rs:122`). Yet delivery receipt reads themselves use project read authorization (`src/integrations.rs:390`, `src/integrations.rs:54`), and ordinary current members satisfy that right (`src/auth.rs:375`). The UI combines credential management and the app-reported delivery history (`apps/console/src/components/workspace-connections.tsx:484`, `apps/console/src/components/workspace-connections.tsx:662`).

**Developer impact.** A developer with workspace read/editor access can inspect bundle content but cannot open the console's delivery diagnostic view without an administrator. Some raw receipt access exists if they already know the integration ID, so this is a console discovery/access mismatch, not a total absence of receipt access. Platform staff become the intermediary for routine “which version did my app report?” questions.

**Recommendation.** Separate safe delivery observations from credential administration. Let read-authorized members discover a minimal connection identity and its receipt history while keeping issuance/revocation, secret handling and sensitive administration restricted to admins. Retain the accurate distinction between an observation and proof of model consumption.

**Acceptance criterion.** A read-only member can view the connection name, bundle/channel and reported version/activity, while credential actions remain unavailable and unauthorized at the API. No secret or administrative credential metadata is included in that observation view.

### PLAT-5 — P2: secret-safe errors omit actionable diagnostic categories

**Observed evidence.** All private config errors collapse into a single long schema/permissions instruction (`scripts/evaluator-config.ts:14`, `scripts/evaluator-config.ts:26`, `scripts/evaluator-config.ts:42`). The same path handles bad permissions, unknown fields, unsupported URLs, malformed JSON and missing files. CLI errors outside a fixed message allowlist—including service errors with a status—become “Evaluation was not confirmed. Inspect the request and private journal before retrying” (`scripts/evaluate-app.ts:41`). Connection failures similarly collapse most conditions to a refresh instruction (`apps/console/src/server/integration-core.ts:47`).

**Developer impact.** Operators have to reproduce failures or privately inspect multiple files to learn whether the problem is ownership, URL shape, identity mismatch, authorization, or an unavailable service. This increases support load precisely when the evaluator is already difficult to observe. Redaction is useful; safe reason categories are still possible.

**Recommendation.** Keep arbitrary provider/service messages and secret values suppressed, but expose stable safe codes such as `config.parent_permissions`, `config.schema`, `config.url`, `auth.denied`, and `request.identity_mismatch`, plus the failing phase and safe server request ID when available. Add a nonexecuting `doctor`/preflight mode that validates local configuration and read access without starting an evaluation.

**Acceptance criterion.** Distinct permission, malformed JSON, invalid URL, unauthorized grant and report-binding failures produce distinct documented safe categories. Tests continue to prove that tokens, configuration contents, provider text and private paths never appear in output. Preflight does not start an attempt or invoke callbacks.

## Strengths to preserve

- Human session authority, delivery credentials, evaluator identity and promotion authority are explicitly separated.
- One-time secrets have explicit lost-response recovery and confirmed revocation before replacement (`apps/console/src/components/workspace-connections.tsx:542`).
- Requests, attempts, principals and reports are bound together; crash recovery refuses speculative reexecution.
- Receipt history says “unknown” when nothing has been observed and explicitly avoids claiming model consumption (`apps/console/src/components/workspace-connections.tsx:670`).
- Deployment docs distinguish readiness, real provider qualification and synthetic/local checks rather than overselling them.

## Top three changes

1. Make evaluator provisioning and permission verification an explicit product/operator workflow.
2. Add app-reported evaluator liveness/progress, with clear unknown/stale semantics and an external job reference.
3. Provide a durable evaluator-worker recipe and safe inspection/recovery tooling for its journals.

## Verification and limits

Reviewed current tracked documentation, service auth/evaluation/integration code, evaluator runner/journal/config code and console integration/setup source. No repository `AGENTS.md` was found by the scoped file search. No private credential files were read, no services deployed, no external requests made, and no paid execution or browser testing performed.

Attempted the existing focused offline check `node_modules/.bin/tsx --test scripts/evaluator-config.test.ts`; it could not run because this checkout has no `node_modules/.bin/tsx` (exit 127). No test pass is claimed, and dependencies were not installed just for this source review. Operational friction and likely support costs are inferences from the implementation, not measured user outcomes. Hosted deployment behavior, real OIDC connectivity, actual evaluator recovery on infrastructure, and team-scale support volume remain untested.
