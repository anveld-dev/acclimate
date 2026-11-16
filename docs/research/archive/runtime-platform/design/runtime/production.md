# Deployment and operations

**Archived proposal — superseded by the smaller content service.** [Current overview](../../../../../design/overview.md).
[Design guide](../README.md)

**Proposed design · No runtime built yet**

For example, an operator releases a tested review package to a small canary cohort, watches its results, then records an expansion or rollback. This is proposed behavior. The first target is one organization with scoped projects and environments. Local mode is for development; hostile multi-tenancy is outside v1.

## Deployment

Run a modular Rust control plane, Linux task/eval workers, and separate proposal/build/grading roles. Each has scoped authority and its own capacity budget. PostgreSQL owns state, work claims, and release transactions; object storage holds immutable packages and evidence.

The [eval walkthrough](../evaluation/workflow.md#what-runs-where) locates the containers, adapter, gateway, and grader. Workers call authenticated control-plane interfaces rather than writing the database directly. Provider keys stay in trusted gateways.

Start with the PostgreSQL work queue and transactional outbox. A later broker may wake workers; it cannot override database ownership. Multiple control-plane instances need the same transaction rules and tested failover before claiming high availability.

## The improvement artifact

A candidate is a frozen **HarnessPackage**. An **AgentVersion** binds that package to its model configuration, declared tools, and adapter requirements. A run pins that AgentVersion plus its effective policy.

| Package content | Purpose |
| --- | --- |
| `manifest.json` | Schema version, content digests, parent package, change types, entry point, and compatibility requirements. |
| `instructions/` | System/task instructions the harness loads. |
| `skills/` and `memory/` | Reusable procedures and scoped, approved knowledge. |
| `config/` | Context handling, routing, limits within granted policy, and tool configuration. |
| `workflows/` | Validated workflow artifacts, when that feature is supported. |
| `harness/` | Task-harness code or a built executable/image reference, when code evolution is enabled. |

Only changed/supported content needs to be present. The manifest resolves the complete package explicitly; omitted content never means “load whatever is latest.” Every runtime-loaded blob is covered by the package digest.

Keep these records alongside the package, with their own authoritative writers:

- **Proposal:** source runs, hypothesis, parent, diff, component tags, and checks.
- **Build provenance:** exact source, toolchain/dependency inputs, builder identity, and output digests.
- **Evaluation evidence:** task/split and grader versions, expected trial slots, raw results, quality/cost measurements, uncertainty, and failed guards.
- **Release decision:** candidate/evidence digests, policy revision, approver or authorized controller, and expected old deployment revision.
- **Deployment record:** environment/channel, assigned version, rollout state, and rollback history.

A candidate's own report cannot approve itself. The release module validates evaluator-owned evidence and build provenance. Changed bytes require new evidence. Sign or attest package provenance and release authorization; verify the expected identity before admitting a package.

Memory and skill changes go through the same versioning path as code changes. Case-specific task data stays in scoped storage rather than silently becoming shared agent memory. External facts that change at runtime are data, not frozen claims of reproducibility.

## Improvement lifecycle

`Proposed → Built → Screened → Evaluated → Search-accepted → Audit-evaluated → Release-approved → Canary → Active`

[Improvement policy](../evaluation/selection.md) defines editable scope and search selection. [Evaluation](../evaluation/workflow.md) tests frozen candidates; rejected/inconclusive outcomes stay recorded. Candidate code builds in isolation, never as a replacement for the control plane, trusted adapter, grader, or permission/release policy.

## Rollout and rollback

Keep deployment channels such as `staging`, `canary`, and `stable`. Promotion is an atomic update against the expected deployment revision, recorded with its evidence and authorization.

1. Validate the frozen package and adapter compatibility.
2. Run the declared release checks, including a fresh, separately controlled audit evaluation for every v1 release and operator approval.
3. Assign a bounded canary cohort using a stable assignment key. Persist each run's assignment at creation.
4. Watch quality, critical failures, latency, recovery, and cost against the rollout's declared limits.
5. In v1, the authorized release operator records expansion or rollback against the expected deployment revision. The rollout controller records a hold automatically when required signals are missing, inconclusive, or below the planned sample count; it never expands on missing evidence. A declared critical breach stops new candidate assignments and requires an operator decision before resuming.

Each real job gets one version. Don't duplicate live writes to compare candidates. Use isolated replay or non-writing shadow work for additional evidence.

Rollback changes future assignments. Running jobs stay pinned unless an operator explicitly cancels them. Emergency permission revocation blocks new admissions; it cannot undo external work already admitted. Keep the previous known-good package and its compatible runtime dependencies available throughout the rollback window.

## Reliability and overload

The [runtime](execution.md) owns atomic commands/events, leases, approvals, and effect accounting. Publish submission-key scopes/retention and event-cursor behavior through the SDK. Stop new admissions when required storage, policy, or budget authority is unavailable.

Keep production capacity reserved separately from improvement. Bound queues, concurrency, retries, deadlines, and project/campaign quotas. Unknown usage keeps a conservative hold; worker loss cannot erase it.

For upgrades, drain workers, checkpoint only supported sessions, and reconcile unresolved effects. Keep compatible native runtimes/checkpoint formats available for pinned runs. Test schema migrations and their rollback limits.

## Access and data handling

Authenticate humans and workloads from the first server milestone. Authorize by organization, project, environment, and action. Keep separate rights for submitting work, executing it, answering approvals, evaluating candidates, and releasing versions.

Use scoped secret references and workload identities; provider secrets stay in trusted gateways. Record which secret version/scope was used, not its value. Encrypt transport/storage, audit sensitive mutations and artifact access, and apply trace/input/output retention rules. Run evidence reaches improvement only under its data-access policy; redaction alone doesn't grant access.

V1 assumes a trusted organization with sandboxed task execution. Containers are not a claim of hostile tenant isolation. Stronger isolation and tenant separation need their own design and qualification.

## Operations and production readiness

Publish deployment-specific objectives before launch: control-plane availability, queue/start delay, recovery time, approval delivery, artifact durability, backup loss window, restore time, and retention. Distinguish platform reliability from model/task quality and provider failures.

Dashboards and alerts cover stuck queues, expired ownership, unknown effects/costs, budget exhaustion, old approvals, failed builds/evaluations, rollout regressions, artifact integrity, and backup/restore health. Every event carries the relevant run, attempt, effect, package, evaluation, and deployment IDs.

Before real workloads, prove:

- Restart, worker loss, duplicate delivery, and stale-owner behavior against PostgreSQL.
- Approval, cancellation, and budget contention through the actual gateway/adapter.
- Isolation and access controls with denied cross-scope requests.
- Package verification, evidence integrity, canary assignment, and rollback.
- Load shedding, bounded resources, and provider failure behavior.
- Database plus artifact backup/restore, including compatible package retention.

Keep runbooks for uncertain external effects, failed upgrades, provider outages, credential revocation, stuck campaigns, and rollback. Assign an operational owner. Until those checks and objectives are met, the system is a prototype even if its happy path works.

## Small interfaces, production rules inside

Operations such as `submit_run`, `admit_effect`, and `advance_deployment` own authorization, ordering, idempotency, and transactions. Clients provide intent and expected revisions; they don't assemble raw storage mutations. Test those same interfaces with PostgreSQL/storage and controlled fakes.
