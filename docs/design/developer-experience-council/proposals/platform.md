# Platform, evaluator access, and operational UX proposal

Status: first council proposal, 2026-11-16. Design only. Grounded in current source; no live deployment or production configuration was inspected.

## Decision

Release one should make the current evaluator operating model explicit, testable, and diagnosable before adding another credential control plane. Add a small read-only evaluator-capability interface, private local preflight, safe structured diagnostics, an operator provisioning/rotation runbook, a durable worker recipe, and read-authorized delivery observations. Keep static evaluator grants in this release. Defer dynamic evaluator credential issuance and service-stored heartbeat/progress, with the limitation stated in product copy.

This is deliberately a deep module proposal: the evaluator caller sees one preflight result and one recovery disposition; auth classification, private-path validation, lock probing, version checks, and retry rules stay in the implementation. Do not expose independent switches that allow callers to claim readiness after skipping one of those checks.

## Current source and constraints

- `src/main.rs:78-81,109-112` parses `ACCLIMATE_AUTH` once and stores an immutable grant list. `src/auth.rs:102-129` authenticates a token and checks its exact project's right. Rights are `read`, `write`, `propose`, `promote`; there is no evaluator-only right.
- `src/auth.rs:8-35` allows separate tokens for the same principal/project, rejects one token mapped to multiple principals, and rejects duplicate token/project rows. This enables same-principal overlap rotation without a new auth model.
- `src/auth.rs:42-101,343-389` distinguishes console transport/session membership and rechecks effective session authority. A human editor's rights cannot stand in for the app evaluator principal.
- `src/integrations.rs:228-279` handles Connections credentials independently. Content-read credentials read released channel content; they do not authorize arbitrary unpublished candidate reads or evaluator mutations.
- `src/evaluations.rs:255-324` requires write authority for transitions and binds start/finish to principal/attempt. `src/evaluations.rs:337` and comparison submission validate the exact report binding.
- `examples/evaluation/journal.ts:10-26,31-44,48-116` scopes durable state to exact service/project/bundle/request/principal and the original absolute journal root, uses kernel `flock` ownership, and writes owner-only state. Python 3 plus `fcntl` is an existing TypeScript-runner dependency.
- `examples/evaluation/runner.ts:88-117,131-150` permits exact report recovery but refuses running-without-journal or started-without-report reexecution.
- `src/commands.rs:15-54,158-204,275` retains durable operation records only for its explicit route allowlist. Comparison creation and evaluation start/finish/interrupt are not currently in that list; their ordinary idempotency expires after 24 hours. Same-attempt start and same-comparison finish are state-idempotent, but a lost comparison submission response retried after that expiry can create a second identical comparison record.
- `scripts/evaluator-config.ts:24-44` currently collapses permissions, JSON/schema and URL issues. `scripts/evaluate-app.ts:41-55` drops useful safe API categories and request IDs.
- `src/integrations.rs:122` requires admin for listing integration metadata, while receipt GET uses project read at `:390`. `apps/console/src/server/integration-core.ts:96-104` rejects non-admin before loading the combined management/observations UI.
- `deploy/README.md:40-50` defines one Rust process, readiness versus provider health, coordinated upgrades and retained identity. These remain constraints.

## 1. Exact evaluator capability snapshot

Add an owned-service seam:

```http
GET /v1/projects/{projectId}/evaluation-capabilities
Authorization: Bearer <evaluator token>
```

```ts
interface EvaluationCapabilities {
  schemaVersion: 1;
  projectId: string;
  principalId: string;
  checkedAt: string; // server RFC3339 timestamp
  readUnpublished: true;
  writeEvaluation: boolean;
}
```

### Authorization and response semantics

1. Authenticate with the same current machine-grant implementation used for evaluation execution. Require project `read` using `actor(..., "read")`; do not use the Connections content-access path.
2. Reject console/human actors (`actor.user_id !== None`) with 403 `machine_principal_required`. A browser must not submit or relay the app's evaluator credential. Browser editors can continue creating requests through their ordinary authoring rights.
3. Within the authorized project read transaction, require the workspace/project row to exist. Derive `writeEvaluation` from `actor(..., "write")` for this same token/project and immutable request state. A valid read-only grant returns 200 with `false`; missing/invalid credentials remain 401, and missing project read remains 403. No mutations or provider requests occur.
4. Return only the authenticated caller's principal, selected project and the two relevant permissions. Do not enumerate other projects, tokens, grants, operator identities, user membership, credential metadata, or wider rights. Enforce `Cache-Control: private, no-store`.
5. `writeEvaluation: true` means the present static grant satisfies the write authorization used by evaluation transitions and comparison submission. It does **not** mean an evaluation-only credential exists: current `write` also grants other project writes. State that plainly in the operator guide.
6. This is a point-in-time authorization snapshot. It neither reserves access nor bypasses reauthorization during real mutations. It says nothing about provider credentials, installed agent correctness, evaluator process liveness, case feasibility, or future availability.
7. A 404/unsupported older service is `capabilities_unsupported`, not `writeEvaluation: true` and not a successful readiness check. Guided setup asks for a service upgrade. Existing raw SDK/lifecycle integrations remain available against older services; the new guided path has a documented minimum service release.

SDK additions: `client.getEvaluationCapabilities(projectId)` and Python `get_evaluation_capabilities(project_id)` with one shared wire shape in the contract. No database migration, operation result, idempotency key or durable command record is needed: this is an authenticated GET with no application state changes. The additional error code `machine_principal_required` must be mapped by safe diagnostic classification, not parsed from prose.

### Why a new GET is warranted

Reading a candidate establishes read access, not write permission. `/ready` establishes control-plane readiness, not app authority. A deliberately failing write probe would still be a mutation attempt with idempotency and audit implications. A read-only endpoint derived from the real authorization implementation is the smallest honest improvement; a generic who-am-I/all-rights endpoint is unnecessary.

## 2. Preflight interface and truthful UX

The evaluator module should offer `preflightEvaluation({ app, handoff?, config })` or an equivalent method in the selected core interface. Keep the following result semantics regardless of the chosen name:

```ts
interface EvaluationPreflight {
  status: "ready" | "blocked";
  authorization: "verified" | "denied" | "unverified";
  checks: Array<{
    check: "runtime" | "privateConfig" | "journalStorage" | "lock" |
           "serviceIdentity" | "evaluatorAccess" | "descriptor" | "versions";
    status: "passed" | "failed" | "not_checked";
    code?: SafeEvaluationCode;
  }>;
  nextAction: SafeNextAction;
}
```

The actual evaluator callback interface and public names belong to the integrated evaluator design. Do not add a second independently configured client/token/URL combination to preflight; it must use the identical validated config and client construction as the real run.

### Ordering and side effects

1. Validate supported runtime and the explicit private config file before reading its contents. Use owner checks, canonical parent paths, bounded reads, no symlinks, accepted HTTPS/explicit private loopback URL rules, and schemaVersion 1 exactly as the current config contract.
2. Check local journal storage at the caller-selected original canonical root. Existing roots must be private; missing roots may be created privately, matching current behavior. Probe exclusive kernel lock acquisition with a new private probe name and remove only that probe. This performs local filesystem writes; call it **nonexecuting preflight**, not globally read-only. Do not lock or rewrite an actual request journal during this probe.
3. Call the capabilities GET. Verify exact `projectId` and configured evaluator principal, `readUnpublished` and `writeEvaluation`. Reject identity drift before any start call. A request-bound preflight then GETs the request, verifies its full frozen descriptor, and fetches/verifies both immutable versions and parentage. No request means version checks are `not_checked`; this result is “evaluator access checked,” not “this evaluation is ready.”
4. For a new `requested` request, every required check must pass for status `ready`. For running/terminal requests, do not call them “ready to execute”: use the runner's recovery inspection, state exactly whether only saved-report recovery is possible, and preserve its ownership rules.
5. Do not invoke execute/grade callbacks, model discovery, model requests, provider credential discovery, or service mutation methods. Application definition loading remains explicit local application code; Acclimate does not dynamically import a file named by the request.
6. Do not persist preflight status as an authorization token or treat a copied result as authoritative. The console can display “app reported checks passed” with its age if the adopter shares a sanitized report, but real run-time authorization remains mandatory. A successful request-bound preflight is a current configuration/readiness check, not assurance that the next network call or model will succeed.

### UX before request creation

Show the requirements while choosing the evaluator: release artifact/runtime, installed local app definition, dedicated evaluator principal with read+write, stable private journal root, and separate app-owned model credentials if paid execution is intended. The console can show the selected project and exact requested permission set in an operator handoff. It cannot verify the app's credential by checking the current human's rights or by accepting a token into a form.

## 3. Operator provisioning and same-principal rotation

Release-one provisioning is explicit, not self-service. Provide `deploy/evaluator-worker.md` and `tools/operator` guidance with the following steps:

1. The team supplies the selected public project ID and a stable dedicated evaluator principal identifier. An operator chooses a strong token privately through their secret manager; no generation into logs or chat.
2. The operator adds exactly `{token, principalId, projectId, rights:["read","write"]}` to the private deployment grant configuration. Do not add propose/promote, reuse login/console transport secrets, or assign a human principal to an old machine-owned attempt. Current scope is the whole project, not one bundle; disclose that limitation.
3. Introduce a secret-safe deployment check command `acclimate-service check-access-config` that runs the same `validate_grants` and `AccessConfig::from_env` validators but exits before database connection, migration, worker startup or socket bind. It consumes injected runtime environment as current startup does and prints only an allowlisted success/error code. No file content, token, principal name or URL appears. Keep it separate from a narrower JSON-syntax validator so it also catches reserved login/console credential overlap.
4. Apply the changed configuration by the documented coordinated service stop/start. This is an operator action, not something a developer setup wizard performs. Existing immutable records and memberships remain unchanged. Run normal readiness plus the app's nonexecuting preflight before considering provisioning complete.
5. Deliver the evaluator private config through the team's secret channel; the browser only receives public handoff data. Stable evaluator identity and stable private storage must be supplied before starting work.

### Rotation

The current grant validator permits two different tokens for one principal/project. Use that capability rather than changing ownership:

1. Add the replacement token with the **same exact** principal/project and required rights while retaining the old token; validate and restart.
2. Update the evaluator's private config to the replacement token only, preserving exact service URL, project, principal, journal root, request IDs, attempt and operation keys. Run preflight. Existing in-process clients using the old token remain authorized during overlap, allowing their calls to drain.
3. After old workers are quiescent, remove the old token; validate and restart again. A surviving old client may be denied after removal; it retains its durable saved report, and the same-principal replacement token may recover it. Removing a token does not stop an already-running model call or erase its side effects.
4. A compromised-token emergency can skip overlap, but the runbook then explicitly identifies interruption/uncertain execution and retained state. Revocation never authorizes a new principal to take over an existing attempt.

This addresses discovery, correctness and support load. It does not remove restart overhead. Dynamic managed evaluator credentials, rotation without restart, narrower evaluation-only authority, and service-side worker enrollment are a separate security/operating-model design, not an implicit addition to this release.

## 4. Durable evaluator worker recipe

Support Linux/macOS POSIX local filesystems for release one. The TypeScript worker currently requires installed `python3` with `fcntl`; Python implementations should acquire `flock` on the exact same lock file with identical exclusive/nonblocking behavior. Until package implementation replaces this mechanism and separately qualifies the replacement, list this dependency in install/preflight guidance. A PID file is never an ownership proof.

Sharing the scope hash and lock is mutual exclusion, not cross-language journal compatibility. Release one keeps the existing TypeScript `attempt.json` schema and a separately marked Python journal format; each implementation detects and refuses a foreign journal before starting or resuming, including when a foreign complete report exists. Recovery uses the original language's runner. Cross-language conformance checks observable protocol semantics, not interchangeable on-disk bytes or unfinished-attempt takeover.

The deployment recipe pins:

- a non-root dedicated OS UID, private configuration directory and files;
- private persistent journal/cache storage mounted at a fixed canonical absolute path (example `/var/lib/acclimate-evaluator/journals`, owned by that UID, mode 0700; private files mode 0600);
- identical service URL string, stable evaluator principal/project and private root across worker replacements;
- immutable application/release dependency versions and installed local adapters;
- graceful cancellation/drain behavior, local logs containing safe phases/counters rather than case data, and retained private outputs;
- encrypted/operator-controlled backups and retention for evaluator journals independently of PostgreSQL backups;
- only one active owner per request lock; many unrelated request workers may coexist subject to application resource budgets.

Do not claim support for network filesystems or arbitrary container restore locations: flock and durable rename/fsync behavior require qualification. The root is not movable merely because a volume was backed up. If a worker is intentionally migrated, preserve its canonical mount point and identity and establish the original process has stopped; the kernel lock protects only cooperating processes using the same storage.

### Recovery decision table

| Observed durable/request state | Allowed action | Never infer |
| --- | --- | --- |
| Requested, no execution marker | Resume the same owned journal and exact start key, or create/claim it following the runner's existing rules | Lock/PID metadata proves prior callbacks did not run |
| Running, original journal, no execution marker | Reconfirm same principal/attempt and frozen versions; execution can proceed only through the runner's marker-before-callback ordering | “Running” means callbacks already started |
| Execution marker, no complete saved report | Refuse callbacks; inspect/cancel the external app, record interruption, and use a new request after an explicit operator/app decision | New request makes prior side effects safe to repeat |
| Complete saved report, submit/finish response uncertain | Submit/finish exact bytes and original operation keys with same principal; never execute callbacks | Timeout means mutation did not commit |
| Running, missing/relocated journal | Refuse recovery; restore original authorized storage/identity or inspect/interrupt | A copied journal in another path grants ownership |
| Request interrupted | No new execution or comparison finish on that request; retain private evidence, inspect the external app, then decide whether new work is safe | Interrupting the record cancels a provider operation |
| Request completed/failed | Read and report terminal status; quality policy is separate | Completed means candidate won or may be released |

The candidate/parent preparation lifetime remains inside the application execution lifetime. Shutdown must not remove files a still-running callback requires. Cancelling an await cannot be described as proof that native process/provider work stopped. The core evaluator design must specify how its returned state and logs represent that uncertainty.

### Retained operation contract for the supported runner

The recovery table's exact saved-report retry prevents repeat application callbacks, but current service retention does not guarantee recovery of the **original comparison ID** after a submission response has been lost for more than 24 hours. The integrated design must make that distinction explicit.

Recommended small server addition: extend `src/commands.rs`'s sole route/rights allowlist to comparison creation and evaluation `start`, `finish`, and `interrupt`, each with the existing `write` right and validated scoped bundle/request UUIDs. The new installed runner marks its start/submit/finish writes for retention through the existing durable-operation header and reuses its persisted exact bytes/keys. Existing operation records, lookup/close/fence behavior, current-effective authorization and unmarked-writer receipt checks then apply without a new table. The operation result wire union gains `Comparison` if it does not already include it; SDK/Python operation readers must understand that addition.

Release-one acceptance must include a lost submission response recovered after ordinary dedup expiry, producing the original comparison identity and no extra callbacks/row. Retained routes must recheck present permissions on replay and reject altered bytes under the same key. Old in-flight journals created before this retained contract may lack a recoverable receipt after expiry: never invent or backfill an unobserved historic result. Document their legacy limitation and provide inspected recovery rather than claiming the new guarantee retroactively. If the coordinator defers this extension, revise product copy and tests to promise no repeat callbacks but permit a duplicate identical comparison record after the old window; do not promise stable comparison identity.

## 5. Safe diagnostic contract

One structured diagnostic module serves SDK exceptions, evaluator commands and console-renderable summaries:

```ts
interface SafeEvaluationDiagnostic {
  code: SafeEvaluationCode;
  phase: "configure" | "preflight" | "claim" | "execute" | "submit" | "finish" | "inspect";
  nextAction: "fix_config" | "ask_operator" | "retry_read" | "retry_saved_report" |
              "inspect_external_app" | "interrupt_then_new_request" | "upgrade_service";
  requestId?: string; // validated service correlation UUID only
  field?: "schemaVersion" | "serviceUrl" | "projectId" | "evaluatorPrincipalId" |
          "journalRoot" | "datasetRevision" | "graderRevision" | "runtime.configId" |
          "runtime.configRevision" | "runtime" | "expectedCases";
}
```

Freeze allowlisted codes for at least: `config_missing`, `config_permissions`, `config_schema`, `config_url`, `runtime_unsupported`, `lock_unavailable`, `evaluator_busy`, `capabilities_unsupported`, `access_denied`, `principal_mismatch`, `descriptor_mismatch`, `version_binding_mismatch`, `service_unavailable`, `journal_missing`, `journal_relocated`, `execution_uncertain`, `submission_uncertain`, `report_binding_mismatch`.

Never serialize exception causes, raw API messages/details, private paths, config contents, arbitrary runtime key/value strings, token material, snapshots, outputs or grader errors into the public diagnostic envelope. Descriptor mismatches identify a fixed top-level field or safe known runtime field; unknown runtime key differences use `field:"runtime"` rather than echoing attacker-controlled keys. Human messages and remediation instructions come from the code table. Invalid/missing service correlation IDs are omitted. Request/evaluation IDs may be returned separately in explicitly public command results; correlation `requestId` is not the evaluation request identity.

The code describes a failure category, not a blanket retry policy. `service_unavailable` while reading may permit read retry; after submit it must map to `submission_uncertain` and exact-report recovery. Preserve the operation phase when classifying errors. A config error before callbacks and an unknown execution outcome require different actions.

## 6. Read-authorized delivery observations

Add `GET /v1/projects/{p}/integration-observations?bundleId={uuid}&channel={channel}&cursor={uuid}&limit={1..100}`. This is a read projection over existing integration metadata, separate from the admin credential-management route:

```ts
type IntegrationObservation = Pick<Integration,
  "id" | "projectId" | "bundleId" | "channel" | "displayName" | "enabled" | "createdAt">;
// Response uses existing Page<IntegrationObservation> shape.
```

Require project read transaction/current membership, validate optional bundle/channel filters, scope all rows to that project, order/paginate exactly like current integration listing. Do not return `credentials`, secret hashes, issuance/revocation metadata, evaluator grants, or an aggregate that merges receipt claims into verified execution. No schema migration is required. Existing read-authorized receipt GET supplies each selected integration's paginated history; its retention/read behavior is unchanged in this release.

The console uses this projection for current read/editor members and the existing admin route for management. Separate observation state types from full management integration state so secret-bearing mutations cannot accidentally be wired into a viewer page. Server commands recheck live membership and admin role for every issuance/revocation; hiding buttons alone is insufficient. Keep labeling: “app reported prepared/started,” “no observation,” and “delivery is not proof of model consumption.” A non-admin must be able to debug the reported version without becoming an administrator.

## 7. Progress visibility: explicit follow-up

Release one emits safe local progress phases and completed/expected pair counts from the installed runner, suitable for CI logs and application monitoring. It does not add remote heartbeat storage or reinterpret lifecycle `updatedAt` as liveness. The console must say “App reported running; check evaluator logs. Last status change …” rather than suggesting a current health signal.

A separately reviewed follow-up may add app observations bound to current principal/request/attempt, monotonic sequence and server receive time, with bounded counts, TTL/retention, and best-effort failure isolation. It must distinguish never observed/recent/stale, never infer cancellation or authorize replay, and never let optional observation failure change execution/report success. This follow-up needs a database migration, authenticated bounded mutation/replay semantics and protocol tests; do not quietly include an underspecified heartbeat endpoint in release one.

## Alternatives rejected

- A “successful candidate GET means evaluator ready” flow: read access cannot establish write authority.
- A dummy start/finish or write-to-check probe: mutates state and can leave durable attempts, so it cannot be advertised as nonexecuting readiness.
- Issuing evaluator credentials through the existing Connections secret-kind enum: those credentials intentionally scope released delivery and cannot inherit unpublished/project-write rights without a new credential/security design.
- Exposing the whole machine grant list or a generic all-rights introspection endpoint: not required by the caller and adds information/implementation surface.
- Automatically moving journals into each CI checkout or deleting them on failure: violates current recovery identity and can repeat external effects.
- Heartbeat-expiry automatic takeover: no observation is proof the external app stopped.

## Implementation files and order

1. Freeze capability/diagnostic/projection shapes in `packages/sdk/src/types.ts` and `contracts/IMPLEMENTATION.md`; add matching Python types. Coordinate with evaluator and CI lanes for one error envelope/exit mapping.
2. Add `src/evaluator_access.rs` (or a focused owned auth module) and register its capability GET in `src/lib.rs`; reuse existing auth/read transaction helpers. Add read projection handler in `src/integrations.rs`. Extend retained evaluator operation routing in `src/commands.rs` if adopting the recommended original-comparison recovery contract. No migration in release one.
3. Add SDK/Python client methods and public types, package contract fixtures and clean external consumer checks.
4. Implement nonexecuting preflight in the selected evaluator module; move private diagnostic classification alongside the package's private config/journal implementation rather than importing repository scripts from published output.
5. Add the check-only startup mode before any database/startup effects in `src/main.rs`; reuse `validate_grants`/`AccessConfig::from_env`. Record separate command docs and model-free CLI tests.
6. Add `deploy/evaluator-worker.md`, the static evaluator grant/rotation runbook and clearly scoped provisioning checklist. Link them from App setup and request creation prerequisites.
7. Split console read observation context/rendering from admin management in `apps/console/src/server/integration-core.ts`, `integration-actions.ts`, `workspace-connections.tsx`, and navigation access checks. Avoid altering existing creation/issue operation receipts and pending recovery.
8. Qualify the public module via the gates below, then update guide minimum versions. Deploy server additions before clients/console that require them. Old clients and the existing journal schema continue working.

## Acceptance and failure checks

- Capability fixtures: a read+write static evaluator returns exact principal/project and true; read-only returns false; wrong project/no read is denied; a delivery credential and browser session cannot masquerade as evaluator machine authority; unknown scope cannot enumerate projects; successful calls create no rows or attempts and invoke no provider.
- Current authority: same-principal token rotation changes effective capability results after the coordinated restart; removal denies subsequent writes even after a past preflight passed. There is no cached authorization bypass.
- Preflight fixtures: malformed config, unknown fields, insecure URL, bad owner/mode, symlinked parent, unsupported platform/missing lock dependency, busy probe, identity mismatch, descriptor drift, version/digest/parent mismatch and old-service endpoint absence all produce distinct safe codes without callbacks or start/submit/finish calls.
- Side-effect classification: preflight creates only explicitly documented owner-only local probe/storage files and cleans probe files; it never changes real attempt journals or service lifecycle state.
- Sentinel leakage: plant tokens, paths, provider/error messages and arbitrary runtime keys in failing fixtures; none appears in public stdout/stderr/envelopes. Correlation UUID and fixed safe field names survive.
- Lock/recovery: two TypeScript processes and TypeScript-versus-Python contenders cannot own the same request simultaneously. Death releases kernel ownership but does not erase execution markers. Lost submit/finish responses recover exact bytes/keys; missing/relocated/started-without-report cases refuse callbacks.
- Retention horizon: newly marked runner writes recover the original comparison after a submission response is lost beyond the ordinary 24-hour dedup window. Historic unmarked requests are tested separately and do not inherit a fabricated receipt.
- Foreign-format recovery: either runner refuses an existing foreign-language journal, including a complete saved report, without callbacks or service mutations. Shared locking does not implicitly authorize takeover.
- Durable-worker recipe: replace a disposable worker retaining the original mount/UID/URL/principal and recover a saved report; restore at a different canonical path and receive an explicit refusal. Service database backup alone is not presented as evaluator recovery.
- Access validator: valid grants return success without database/socket/model work; duplicate pairs, token/principal ambiguity, unknown rights, and login/console token reuse fail safely.
- Delivery observations: read members can discover minimal scoped connection metadata/history, admin-only mutations still deny them even with handcrafted requests, cross-project filters are denied, and no credential metadata appears in the projection. Membership removal takes effect on the next request.
- Product copy: unsupported preflight, provider readiness, missing/stale observations, and uncertain execution never render green “ready/running/consumed” claims. No automated release, external cancellation or replay is introduced.

## Open decisions for the coordinator

1. Select the evaluator module's final public preflight/run names and integrate the diagnostics envelope with CI's result/exit contract. The semantic distinctions above are required; names are not.
2. Confirm the two additive service GETs are release-one scope. Without evaluator capabilities, report write authority as unverified and do not claim request readiness. The delivery projection can move to a follow-up if necessary, but then explicitly retain the non-admin debugging limitation in release notes.
3. Decide whether `check-access-config` is a service binary subcommand or a dedicated installed operator executable. It must reuse the production validator and perform no startup effects; a source-only script would recreate the packaging critique.

Dynamic evaluator credential management, evaluation-only rights, remote progress observations, network-filesystem workers and freely relocatable journals are deferred designs, not promises made by this proposal.
