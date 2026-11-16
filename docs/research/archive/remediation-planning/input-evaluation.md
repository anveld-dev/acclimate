# App-owned behavioral evaluation handoff

**Planning input. The [reviewed plan](../../../architecture/productization/remediation/plan.md) and [review resolutions](../../../architecture/productization/remediation/review.md) take precedence where choices differ.**

Planning input, 2026-11-14. Implements the evaluation gaps in [current-audit.md](../../../architecture/productization/current-audit.md); no implementation or qualification is claimed here. Keep the existing request routes and state machine. Apps run installed code, hold credentials, choose cases and grade outputs. Acclimate records frozen intent, reported evidence and release decisions. No dispatcher, sandbox fleet, downloaded executable adapter, mandatory evaluator service or automatic acceptance.

## Current seams

- `apps/console/src/server/improvement.ts` hardcodes the same two presence fixtures as `examples/evaluate-request.ts`. The latter already verifies version bytes/parentage, starts an attempt, calls `compare`, submits and finishes.
- `src/evaluations.rs` checks principal, attempt, versions, settings and inventory on finish, but `ComparisonRequest` has no request association. Any old matching report from that principal can finish another request.
- `packages/sdk/src/compare.ts` already snapshots identities, cases/settings and grader inputs before callbacks. Extend that mechanism; preserve its isolated grading retries.
- `scripts/dev-console.ts` owns private `.local/console-demo/state.json`, an author token and a server-only console token. The copied evaluator command cannot currently use this setup. Connection delivery credentials are unsuitable for writes.
- Shared `evaluations::ListQuery` drives evaluation, proposal and comparison lists; all order by random UUID. Console polls the first request page and a selected proposal, leaving later-page active requests stale.

## One frozen, non-secret descriptor

Add these optional fields to existing request/report DTOs, with Rust `serde(default)` and TypeScript/Python optional keys. Preserve current top-level versions, `datasetRevision`, `runtime`, `graderRevision`, `expectedCases` and proposal association.

```ts
interface EvaluatorConfigIdentity {
  schemaVersion: 1;
  id: string;                    // locally installed app adapter/configuration
  digest: string;                // sha256 of canonical public descriptor below
  appRevision: string;           // pinned app/runtime implementation build
  casesDigest: string;           // exact snapshots + per-case settings + repetitions
  graderDigest: string;          // installed grader/rubric implementation + settings
  limits: { concurrency: number; timeoutMs: number; gradeRetries: number };
}
// EvaluationRequest and ComparisonRequest:
evaluatorConfig?: EvaluatorConfigIdentity;
// ComparisonRequest only:
evaluation?: { requestId: string; attemptId: string };
// EvaluationRequest only:
retryOf?: string;
```

The descriptor is `{evaluatorConfig without digest, datasetRevision, runtime, graderRevision, expectedCases}`. Define one canonicalization contract: recursively sorted object keys, inventory sorted by case ID/repetition, ordinary JSON primitives, integer-only limits, UTF-8, no trailing newline; hash with the existing `sha256:` format. Publish golden vectors in contracts for Rust and TS. `casesDigest` hashes the app's canonical case snapshots/settings/repetitions, not just case names. `graderDigest` covers grader implementation and configuration; `appRevision` identifies a reproducible installed build. Secrets, provider keys, local paths and case contents never belong in the public descriptor. Runtime includes model/provider identifier, sampling settings and write policy as explicit strings; capture every execution-affecting setting, including prompt assembly/tool revision, in the build/config identity.

Bound descriptor strings and maps using existing request limits; SHA fields must match the digest format. Require concurrency 1..64, timeout 1..300000 ms and gradeRetries 0..3. The app can choose lower limits and must enforce them. Service validates descriptor digest consistency, current inventory limits and matching identities; hashes remain app declarations, not execution attestation. No universal source-code hashing or service-side runtime verification.

The app exports `describeEvaluation(): PublicEvaluationDescriptor` and `evaluateRequest(api, scope, requestId, installedAdapter)` from local code. `describeEvaluation()` produces a cloned frozen descriptor from installed case data/settings and build/grader identity. A `--describe` command emits only that descriptor. The runner compares the entire requested descriptor with its installed descriptor before start or execution and verifies exact bundle digests/parentage. Reject unknown configuration IDs or drift; never interpret a request as code, module paths, shell commands, fixture URLs or provider endpoints.

Console accepts a bounded public descriptor pasted/uploaded as JSON, validates it server-side, shows configuration/case/grader identities and declared limits, then creates the request using its verified candidate/parent. The local example launcher may supply a public default descriptor server-side. Remove duplicated `fixtureIdentity` constants: the console does not own evaluation cases. Do not run adapters inside the console to discover them. Presence fixtures can remain an explicitly named delivery-contract option; never silently substitute them when a behavioral configuration is missing.

## Small usable adapter and private command

Refactor `examples/evaluate-request.ts` into the handoff orchestration plus an explicitly imported example adapter. App callers can supply callbacks directly; CLI adapter selection is a fixed local allowlist. Suggested first configuration: `payment-retry-policy-v1`, a deterministic app that reads validated declarative rules from `memory/retry-policy.json` in each verified bundle and runs a locally installed payment simulator. Bundle text is data, never evaluated JavaScript. Include valid instruction/skill files so ordinary delivery also works.

Use four frozen scenarios: timeout before commit, timeout after commit with no idempotency key, timeout after commit with a key, and permanent failure. Run two repetitions each. The application emits a trace of attempts, committed charges and terminal disposition; its grader separately checks expected disposition, bounded attempts and at-most-one charge. Parent's unconditional retry produces a duplicate charge in the second case; candidate's policy stops uncertain non-idempotent retries while safely retrying keyed operations. Preserve the same instruction/skill presence in both versions. This demonstrates changed app behavior and observable reward, including the regression case where “never retry” sacrifices successful recovery. It qualifies this tiny deterministic application, not general native-agent quality.

```ts
const adapter = installed.paymentRetryPolicy; // checked-in import, not request supplied
const descriptor = adapter.describeEvaluation();
const request = await api.getEvaluation(project, bundle, requestId);
assertInstalledDescriptor(request, descriptor);
const [parent, candidate] = await fetchVerifiedRequestVersions(api, request);
const attempt = await journal.prepare(request); // durable attempt ID + mutation keys
await api.startEvaluation(project, bundle, request.id,
  { attemptId: attempt.id }, attempt.startKey);
const report = await compare({
  parent, candidate, ...adapter.comparisonOptions(),
  evaluatorConfig: descriptor.evaluatorConfig,
  evaluation: { requestId: request.id, attemptId: attempt.id },
  execute: adapter.execute, grade: adapter.grade,
});
await journal.saveReport(report); // exact bytes before submit; private app storage
const stored = await submitComparison(api, project, bundle, report, attempt.submitKey);
await api.finishEvaluation(project, bundle, request.id,
  { attemptId: attempt.id, comparisonId: stored.id }, attempt.finishKey);
```

Extend `CompareOptions` to accept and clone/freeze optional `evaluatorConfig` and `evaluation` before the first callback. Do not append mutable identity fields after execution. Existing compare calls remain valid. App adapter owns timeout/abort behavior, allowed effects, output artifacts and sanitization of errors. Regrade saved outputs without executing again; changed grader identity requires a new request/report. Output references remain bounded escaped text.

Add `npm run evaluate:local -- --requestID UUID --bundleID UUID`, implemented by `scripts/evaluate-local.ts`. Bundle ID is non-secret and explicit because the UI can select a bundle other than the launcher's seeded default. The helper reads the launcher's workspace-private config, fixes service/project from that config and checks the scoped request; it never accepts a service URL/token from the copied command. Use the same checked private-directory/file ownership, symlink and permission rules as the launcher. Share those functions in a small local-config module and validate existing config on reads, not only writes. Invoke the installed adapter in process with an SDK client; print only request/status/comparison IDs and allowlisted errors.

Launcher provisions a separate private evaluator token/principal with existing `read` + `write`, persists it atomically mode 0600, and adds it to local static auth on startup. Keep author credentials for setup and console credentials server-side. Existing state lacking this token is upgraded on the next launcher startup; helper reports “restart npm run local” rather than borrowing the console token. Current `write` remains broad within this trusted local app boundary; a dedicated evaluator right is deferred until external delegation. No credential is returned by console APIs, embedded in the descriptor/command, or logged. External applications use their own private configuration and credentials with the same SDK handoff; this helper is a local setup bridge, not a universal credential manager.

Store journal/cache/artifacts in private `.local/console-demo/evaluations/<request-id>/` with scoped identity and exact report bytes. A rerun reconciles the request and journal: terminal means inspect only; same running attempt resumes submission/finish if a saved report exists. A running attempt without complete durable outputs reports uncertain execution and requires interruption/new request; never silently rerun paid execution. Persist attempt/mutation keys before their corresponding calls and replay identical bodies after uncertain responses. Conflicting evaluator/attempt cannot be adopted. App process crash does not trigger server reassignment.

Keep a second optional installed retry-review adapter around the existing `examples/service-proposer/{dataset,grader}.ts` and `Model.review` seam for real native runs. It uses the app's existing runtime and private provider configuration. Qualification is explicit opt-in, Luna only (`gpt-6-luna` or `gpt-5.6-luna`), bounded cases/time/concurrency and no fallback. Default helper and CI make zero paid calls. Neither deterministic success nor a tiny Luna sample establishes broad improvement.

## Association, compatibility and transitions

Keep `POST /evaluation-requests`, `GET` list/detail and `/{id}/start|finish|interrupt`; keep current conditional row locks, idempotency and permission rechecks. Add no worker endpoint. On bound comparison creation, lock/read its scoped request and require running status, current evaluator principal and exact attempt, matching versions/digests, descriptor, dataset/runtime/grader and inventory. Repeat these checks in finish; creation validation must not replace transition-time checks. Interrupt/create races serialize on the request row. If interruption wins after a report was stored, evidence remains inspectable and finish conflicts.

Finish requires `comparison.evaluation == {requestId: current ID, attemptId: current attempt}` as well as all existing checks. A complete inventory sets completed even if the candidate loses; incomplete sets failed and retains evidence. Same-attempt start replay and identical terminal finish replay retain existing semantics; another attempt, principal or comparison conflicts. One request has one attempt; explicit reruns create another request. `retryOf` must identify an existing same-scope terminal request with the same version/config identity; changing configuration is a fresh evaluation, not replay. It is informational lineage, not an execution queue.

Compatibility is deliberate: old requests deserialize without `evaluatorConfig`; runners can still support their explicitly installed legacy fixture identity, but newly submitted evidence must carry request/attempt binding to finish them. Old unbound comparisons continue to create/read/list and support existing direct evidence-backed promotion checks; display “Historical comparison; no evaluation request association.” They cannot finish any request, and no migration guesses an association from settings/timestamps. Do not backfill old reports or change their meaning. New behavioral console requests require the descriptor; generic SDK legacy creation remains accepted. Service-first rollout is required because old strict deserializers reject new fields.

No association columns are necessary: optional binding/config live in the existing immutable JSON bodies and are validated transactionally. Allocate the next migration number centrally; add chronological covering indexes for evaluations, proposals and comparisons on `(project_id, bundle_id, created_at DESC, id DESC)`, replacing UUID-order scope indexes only where redundant. No data rewrite. Update Rust/TS/Python DTOs, OpenAPI and comparison fixtures together; preserve legacy fixtures and add bound/configured ones. Existing release revision, candidate parent/digest, promotion and draft-generation checks remain authoritative.

## Visibility and explicit reruns

List in descending `(created_at, id)` order using keyset predicate `(created_at,id) < (:time,:id)`, `limit + 1`, same public `Page<T>` shape. New opaque cursor encodes version, collection, project, bundle, UTC timestamp at database precision and UUID; reject malformed or scope/collection mismatch. For old UUID cursors, look up that ID in the same authorized collection/scope and derive its timestamp; unknown IDs return a clear invalid-cursor error. Continue from that chronological boundary, with no promise to preserve the old random ordering. Stable tie-breaking covers equal timestamps and insertions do not move the next-page boundary.

Add console bridge `action: 'request', id` using existing SDK `getEvaluation`. Merge by ID and sort chronologically after every page/direct response. Poll the head page for discovery and directly fetch **all known active IDs**, including records loaded from later pages, freshly created requests and a request ID persisted in the route. Poll a selected proposal directly as today. Bound concurrency (four), back off to 15 seconds, abort/ignore stale results on scope change/unmount, keep page cursors independent of head refresh, and show per-record stale/error state without dropping records. A denied/404 record is no longer polled; errors never imply completion. Add request route state so reopening a known later-page request fetches it directly.

“Create evaluation” is a new user intent with a fresh operation key; “Retry uncertain submission” reuses its exact saved body/key. A terminal request exposes “Run again” creating a new linked request/key; ordinary identical clicks must not reuse the in-memory signature key indefinitely. Integrate with the shared pending-operation recovery policy rather than inventing a second browser secret store. After any create response, insert/track that returned request immediately before discovery polling.

## Required evidence and ownership

| Owner / change | Meaningful acceptance evidence |
| --- | --- |
| Service + contracts: optional config/binding, finish checks, migration and cursor codec | Real PostgreSQL tests reject old matching unbound report, request A's bound report for B, wrong attempt/principal/config/case digest, interruption/finish race and revoked access; accept same-key replay, retain incomplete evidence and read/promote historical reports. Test old JSON rows and old cursor compatibility. |
| SDK: DTOs and `compare` identity capture | Mutation during awaited execute cannot relabel config/binding; both versions receive identical frozen cases/settings; grader retry does not rerun execute. Installed-package consumer submits a bound report against real service. |
| App/example + launcher: descriptor, adapter, helper and journal | Real service + disposable PostgreSQL + test-owned private config: save valid parent/candidate, create via console bridge, run exact copied helper command, observe duplicate-charge parent failure/candidate success over eight pairs, retrieve bound report and completed request, then explicit reviewed release. Assert parent/candidate both pass presence checks. Also prove losing candidate remains complete and release is never automatic. |
| Console: descriptor form, request detail, retry and polling | Component/API tests plus existing browser harness: 25+ requests with UUID order deliberately different from creation order, equal timestamps, page traversal without duplicates, insert while paging, later-page running record becomes terminal through direct polling, reload selected request, scope switch cancels stale updates, run-again yields a new ID and uncertain retry reuses the old one. |
| Local recovery and privacy | Disposable helper process tests reject unsafe config/link/permissions, wrong workspace/bundle/descriptor and absent evaluator principal before execution; tokens absent from descriptor/stdout/UI/command. Drop start/submit/finish responses and restart helper: replay exact journaled commands without repeating execution. Crash without a saved report leaves running/unknown until explicit interruption. |

Dependencies/conflicts: request/DTO changes precede adapter and console integration; service deploy precedes new clients. Coordinate shared `src/types.rs`, `src/evaluations.rs`/`src/improvement.rs`, SDK exports, Python types and OpenAPI with contract owners. Pagination changes affect proposal/comparison lists too and must ship as one codec contract. `improvement-workspace.tsx` also belongs to diff/ambiguous-write remediation; use that owner's pending-operation and route conventions. `scripts/dev-console.ts` and root scripts overlap setup diagnostics/local recovery; share private config/process helpers and preserve ownership-restart behavior. Compatibility validation owns native file rules; reuse its public validation before execution instead of redefining skill metadata rules here. Root owns package scripts/lockfiles and migration numbering.

Done means the deterministic behavioral path is runnable from the local console's copied command with no manual credential export, bound evidence cannot be reused to finish another request, an explicit rerun creates a new request, and known active records keep updating across pages. Run targeted Rust, SDK, helper, console and deterministic end-to-end gates; live Luna qualification is optional and separately disclosed.
