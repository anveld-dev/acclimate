# Acclimate developer experience design

Revision D2 · 2026-11-16. Approval status and the exact reviewed digest are recorded in CONSENSUS.md.

This document is the normative implementation plan. Proposals are alternatives and supporting rationale, not additional requirements. Nothing here is implemented or runtime-qualified by this design exercise. The final revision and reviewer dispositions are recorded separately in `CONSENSUS.md`.

## 1. Intended outcome and release scope

An existing TypeScript or Python application can install a release, attach its actual agent, define one saved task and grader, export public configuration, execute a console-created request, inspect paired evidence, and run a CI quality policy without importing Acclimate repository internals. The developer does not implement attempt ownership, durable reporting, or response-loss recovery. A second authorized teammate can retrieve deliberately shared failed-case evidence after the worker is gone.

The DX release includes all six major critique areas: installed custom evaluator, connected onboarding, Python orchestration, CI verdicts, useful diagnostics/portable evidence, and a native existing-repository recipe. It also adds point-in-time evaluator capability checks and read-authorized delivery observations. A release is not complete when only the TypeScript happy path works.

Explicit follow-ups, not implied release capabilities: dynamic evaluator credential issuance or evaluation-only rights; cross-language takeover of unfinished journals; per-case checkpoint/resume; distributed execution; remote heartbeat storage; automatic instruction merging/native destination overlays; hosted artifact storage; statistical inference and multiple reward dimensions; in-place refresh/resumed-session qualification. Current static-grant restart overhead and lack of remote progress remain visible limitations. Section 16 defines follow-up acceptance without making it a hidden dependency.

## 2. Chosen interface and alternatives

Choose the [minimal evaluator module](proposals/evaluator-minimal.md), combined with the [common-caller starter](proposals/evaluator-common-caller.md). Keep lifecycle phases private. The [owned-session alternative](proposals/evaluator-flexible.md) is useful for schedulers that must separate execute/seal/commit, but it introduces ordering and lifetime concepts the first adopter should not learn. Advanced applications retain existing low-level clients and `compare`; the release does not add a public storage/worker adapter registry.

The module earns depth by keeping fixed inventory, verified versions, private state, exclusive ownership, exact request bodies, report submission and terminal reconciliation behind three operations. Its external seam is installed application execution/grading. Filesystem and transport adapters are internal. Pure descriptor/policy modules stay separate from Node-only execution so browser code cannot import process or filesystem dependencies.

### Package surfaces

| Surface | Responsibility |
| --- | --- |
| `@acclimate/sdk` | Existing delivery/client/types exports, plus shared descriptor/capability DTOs; backward compatible |
| `@acclimate/sdk/validation` | Pure public descriptor/handoff validation alongside payload validation; no Node imports |
| `@acclimate/sdk/evaluation` | Node-only `defineEvaluation`, `preflightEvaluation`, `runEvaluation`; typed errors/results |
| `@acclimate/sdk/evaluation/cli` | `evaluationMain` for an app-owned, statically wired entry point |
| `@acclimate/sdk/evaluation/policy` | Pure `checkComparison` and policy/result types |
| `@acclimate/sdk/evaluation/artifacts` | Explicit local export/verification; no automatic upload or URL fetching |
| `acclimate.evaluation` | Python equivalents `define_evaluation`, `preflight_evaluation`, `run_evaluation` |
| `acclimate.evaluation_cli`, `.evaluation_policy`, `.evaluation_artifacts` | Equivalent command/policy/export behavior in the existing wheel |

No package requires a native model SDK merely to import/describe/run deterministic callbacks. Durable TypeScript execution requires Node >=22.22, POSIX, and `python3` with `fcntl`; Python requires >=3.11, POSIX, and no Node or third-party runtime package. Supported durable storage is a private local filesystem with qualified flock/rename/fsync behavior; network filesystems and Windows are unsupported. Imports perform no filesystem, subprocess, credential, or network actions.

## 3. Definition and caller contract

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface EvaluationCase<I extends Json, E extends Json> {
  caseId: string;
  input: I;
  expected: E;
  repetitions?: number; // default 1
}
interface EvaluationDefinition<I extends Json, E extends Json, O extends Json> {
  configId: string;
  configRevision: string;
  datasetRevision: string;
  graderRevision: string;
  runtime: Readonly<Record<string, string>>;
  execution: 'model-free' | 'live';
  cases: readonly EvaluationCase<I, E>[];
  execute(args: {
    bundle: VerifiedBundle; caseId: string; repetition: number;
    input: I; signal: AbortSignal;
    context: ExecutionContext;
  }): Promise<ExecutionResult<O>>;
  grade(args: {
    output: O; expected: E; caseId: string; repetition: number;
    signal: AbortSignal;
  }): Promise<EvaluationGradeResult>;
}
interface EvaluationGradeResult extends GradeResult { explanation?: Json }
interface ExecutionContext {
  readonly requestId: string; readonly attemptId: string;
  readonly side: 'parent' | 'candidate'; readonly jobId: string;
  readonly privateJobDirectory: string; // Private locator, never emitted in diagnostics.
}
interface EvaluationApp<I extends Json, E extends Json, O extends Json> {
  readonly descriptor: Readonly<EvaluationDescriptor>;
  // Opaque definition; captured callbacks/private cases are not public fields.
}
declare function defineEvaluation<I extends Json, E extends Json, O extends Json>(
  definition: EvaluationDefinition<I, E, O>
): EvaluationApp<I, E, O>;
declare function preflightEvaluation(options: {
  app: EvaluationApp<any, any, any>;
  configPath: string;
  target: { bundleId: string; requestId?: string } | { handoff: EvaluationHandoff };
}): Promise<PreflightResult>;
declare function runEvaluation(options: {
  app: EvaluationApp<any, any, any>;
  configPath: string;
  handoff: EvaluationHandoff;
  allowLive?: boolean; // default false
  signal?: AbortSignal;
}): Promise<EvaluationRunResult>;
```

`any` above stands for the opaque app's captured generic parameters, not permission to skip runtime validation; actual declarations preserve captured generics. Python uses generic frozen dataclasses for Case/ExecuteInput/GradeInput/results, snake_case method arguments, and camelCase wire DTOs. Python's exact cancellation/async-misuse contract is in section 11. The app descriptor is a defensive deeply frozen value in TS and a defensive copy in Python, never a mutable reference into the definition.

Definition rules:

- Validate and capture private cases and callback references synchronously. Clone inputs, expected answers, and outputs separately for each side/repetition/grading call. Keep an immutable module-owned verified-bundle snapshot and give each execute callback a fresh deep copy of payload AND metadata; no mutable bundle object is shared across callbacks or recovery state. Mutating a callback's own copy cannot affect later invocations. Native filtering changes its owned prepared tree/effective view, not the canonical snapshot. The execution callback never receives `expected`; the grade callback does not receive version/side by default. This reduces accidental leakage/contamination but does not attest app code is blind or used the supplied content unchanged.
- JSON means finite IEEE-754 values, exact integers within ±(2^53−1), valid Unicode scalar strings, string-keyed plain objects and arrays. Reject cycles, undefined, exotic prototypes/custom serializers, dates, maps, bytes, nonfinite numbers, unpaired surrogates, and Python bool-as-repetition. Existing lower-level `compare` keeps its broader contract.
- Derive `expectedCases` once, in case declaration order then increasing zero-based repetition. Require unique nonempty bounded case IDs, repetitions 1–1000, and 1–1000 expanded pairs. Structural request matching compares inventory as a unique set, not order; execution uses the frozen local order. Runtime/dataset/grader/case bounds match existing authoring validation.
- Insert reserved runtime entries `configId`, `configRevision`, `execution`, `concurrency:'1'`, `gradeRetries:'0'`; reject caller collisions. Existing example descriptors retain their exact historical runtime maps through compatibility wrappers, not through rewriting unfinished requests. Dataset/grader/build revisions are explicit app assertions; no new cross-language canonical-content hash protocol is introduced.
- High-level execution is serial: for each frozen case/repetition, parent execute → parent grade → candidate execute → candidate grade, omitting grade only when no gradeable output exists. The next pair starts only after that sequence settles. No execution/grader retries. Implement a dedicated high-level serial loop or shared internal scheduler with this exact trace; unchanged `compare({concurrency:1})` interleaves execute/grade differently and is not a substitute. Existing lower-level compare behavior stays compatible. Reset app fixture state independently per side; fixed order is not an unbiased/randomized experiment. Capture inventory before any await. Trial and actual-agent definitions have different config IDs/revisions and execution identities.
- Existing `ExecutionResult` carries gradeable output, optional task-failure status and usage. `GradeResult` retains a finite scalar reward; add optional private `explanation: Json` to the high-level callback result only, saved as a local sidecar and omitted from the comparison wire DTO. Raw thrown messages are never public errors.
- Valid task failures can be graded; escaped `TaskExecutionError` without an output becomes task failure/missing grade. Other ordinary exceptions become infrastructure failure/missing grade. Invalid/oversized output becomes execution/artifact failure with no grade; invalid/nonfinite grade becomes grading failure. Unknown usage remains unknown. Safe fixed labels replace raw callback messages in new reports. Legacy reports keep their bytes unchanged.
- The app owns callback resource quiescence. Add `ExecutionUncertainError`: from EITHER execute or grade it escapes ordinary task/infra/grading classification, stops all subsequent callbacks, retains the marker/private artifacts, seals/submits no report, and returns recovery-required failure. The high-level loop must not swallow it through current compare catch blocks. A timeout/rejected native SDK await is not sufficient proof of termination.

Example application-owned definition and entry point:

```js
import { defineEvaluation } from '@acclimate/sdk/evaluation';
import { evaluationMain } from '@acclimate/sdk/evaluation/cli';
import { runExistingAgent } from './agent.mjs';

const app = defineEvaluation({
  configId: 'checkout-review', configRevision: 'build-31',
  datasetRevision: 'saved-retry-cases-2', graderRevision: 'exact-finding-1',
  runtime: { app: 'checkout-review', model: 'app-configured', writes: 'sandbox-only' },
  execution: 'live',
  cases: [{ caseId: 'lost-payment-response', input: { task: 'review fixture' }, expected: true }],
  execute: async ({ bundle, input, signal }) => ({
    output: await runExistingAgent({ bundle, task: input.task, signal }),
  }),
  grade: async ({ output, expected }) => ({ reward: Number(output.foundUnsafeRetry === expected) }),
});
process.exitCode = await evaluationMain(app, process.argv.slice(2));
```

The shipped starter includes runnable fixture agent/support functions and a separate, clearly marked actual-agent replacement seam. It uses compiled JavaScript/`.mjs` and documented local dependencies, never an implicit `npx` download. `allowLive`/`--live` is required for a definition marked live and rejected for model-free; application callbacks remain responsible for honestly declaring execution and enforcing their model/tool budgets.

## 4. Public handoff, private configuration, and preflight

Keep the current closed public handoff shape:

```ts
interface EvaluationDescriptor {
  datasetRevision: string; graderRevision: string;
  runtime: Record<string, string>;
  expectedCases: Array<{ caseId: string; repetition: number }>;
}
interface EvaluationHandoff {
  schemaVersion: 1; serviceUrl: string; projectId: string;
  bundleId: string; requestId: string; configuration: EvaluationDescriptor;
}
interface PreflightResult {
  schemaVersion: 1;
  status: 'ready' | 'blocked';
  authorization: 'verified' | 'denied' | 'unverified';
  checkedAt: string;
  checks: Array<{
    check: 'runtime' | 'privateConfig' | 'journalStorage' | 'lock' |
      'serviceIdentity' | 'evaluatorAccess' | 'descriptor' | 'versions';
    status: 'passed' | 'failed' | 'not_applicable' | 'unverified'; code?: SafeCode;
  }>;
  nextAction: SafeNextAction;
}
```

Private config keeps schemaVersion 1 with exactly `serviceUrl`, `projectId`, `evaluatorPrincipalId`, `evaluatorToken`, `journalRoot`. The app supplies its absolute filename explicitly; the module reads it with canonical parent/no-symlink/owner/size checks, owner-only directory 0700 and file 0600. No environment/home/launcher/sibling credential discovery. HTTPS is required except an explicitly configured same-host loopback HTTP hop. Credentials/query/fragment and non-root URL paths are invalid.

Before network activity, validate a handoff and require its exact service URL/project strings to match the explicit config. Never use handoff data to choose a credential source, local file, module, script, executable, shell argument, or adapter. Preserve the exact historical URL string in journal scope; do not normalize aliases/trailing slashes or relocate legacy state. The service request remains authoritative: verify IDs, descriptor, bound-evidence requirement, all parent/candidate IDs/digests, same bundle and direct parentage. Public runtime strings are rendered inertly and never interpreted as executable settings.

Preflight is nonexecuting, not globally read-only: it may create the configured private root and a dedicated short-lived probe directory, write/fsync/delete only its probe, and acquire a kernel probe lock. It never creates/claims an attempt, modifies an actual request journal, starts callbacks, mutates service data, or calls a provider. With a request it verifies exact versions/digests; before a request those checks are not applicable. Run repeats required checks under actual ownership; a prior successful preflight is not a reservation.

Add `GET /v1/projects/{projectId}/evaluation-capabilities`:

```ts
interface EvaluationCapabilities {
  schemaVersion: 1; projectId: string; principalId: string; checkedAt: string;
  readUnpublished: true; writeEvaluation: boolean;
  retainedEvaluationOperations: true;
}
```

Require current machine `read` authority and an existing project; reject human/console actors with 403 `machine_principal_required`. Determine `writeEvaluation` with the same token/project's existing write authorization, not a probe mutation. A read-only principal returns false. Invalid token is 401; missing read is 403; nonexistent authorized project is 404. Response is private/no-store, reveals no wider rights/identities, and makes no provider-readiness claim. `write` is currently broad project write, not a newly narrow eval-only right. The retained flag attests deployment support for section 6, not that a particular legacy operation has a retained result.

Both SDKs add a typed capability GET. Missing endpoint/retained flag means unverified/blocked and an upgrade instruction for the new guided runner. Raw existing clients remain usable against older services. Preflight must match the reported principal to config. Only the real currently authorized start/submit/finish operations can establish their actual outcomes.

Guided targets use the exact retained-routing grammar: project is 1–128 ASCII characters `[A-Za-z0-9._-]`, excluding dot/dotdot; bundle/request/attempt/comparison IDs are canonical lowercase hyphenated UUIDs generated by the supported path. Channels use the existing 1–64 character channel grammar. Validate before any guided mutation and share the predicate with canonical route generation and commands::rights. The capability endpoint returns 400 `guided_target_unsupported` for an out-of-grammar authorized project or guided principal over 1024 UTF-8 bytes, never retained=true; static legacy grants/raw reads keep their existing behavior. URL-encoded separators, Unicode/long projects and noncanonical UUID spellings cannot produce retained-ready guided targets. Do not silently fall back to transient idempotency on a marked guided write.

## 5. Durable execution and cancellation

The runner constructs its client from the private config, not a separately supplied client with a potentially different target. Under one scope lock it fetches the request, verifies frozen identities, creates/persists attempt and operation keys, obtains confirmed start ownership, verifies immutable bundle bytes, durably writes the execution marker, runs fixed paired callbacks, saves exact report bytes, submits, saves the comparison ID, finishes, re-fetches authoritative terminal state, and returns verified bindings. A retained operation response establishes that mutation's historical result, never current lifecycle state. After every start/finish replay and immediately before the marker/first callback, GET the authoritative request and recheck current status, owner/attempt and frozen binding. Before every later execute or grade callback, GET/check again. Observed interruption stops scheduling and prevents submission/finish; keep artifacts. An interruption racing after the last check cannot stop already-started external work; no atomic cancellation/lease guarantee is claimed. This cadence adds up to four lifecycle reads per pair and is an explicit initial performance tradeoff.

```ts
interface EvaluationRunResult {
  schemaVersion: 1;
  evaluation: Evaluation;
  comparison: Comparison | null;
  executionState: 'finished' | 'interrupted';
}
```

Completed and failed are normal saved lifecycle results. A confirmed interrupted request returns interrupted with no callback invocation; a local uncertainty throws a typed safe diagnostic. Returning an existing terminal result requires verification of request, evaluator principal, attempt, comparison and descriptor/version bindings. If local artifacts are missing, read/fetch terminal evidence without reconstructing outputs or executing. A conflicting local journal is an error, not permission to adopt the remote attempt.

| Durable fact | Allowed recovery |
| --- | --- |
| No journal; request requested | Create one attempt under lock, then claim |
| Attempt saved; no execution marker; same requested/running owner | Reconcile original start key/body; confirm ownership before execution |
| Execution marker; no sealed report | Refuse all callbacks; inspect original external job; explicit interruption/new request only after safe app decision |
| Sealed report; submit response unknown | Recover/replay same retained submit operation and exact bytes; never callbacks |
| Comparison ID saved; finish response unknown | Reconcile/replay original finish; re-fetch request |
| Completed/failed with exact binding | Return terminal evidence, no callbacks |
| Interrupted | Keep artifacts; no execute/submit/finish |
| Root/URL/principal/attempt/foreign format mismatch | Refuse; restore original supported state or inspect |

Signal cancellation stops scheduling new callbacks and is forwarded to active callbacks. Await actual callback settlement before releasing locks or allowing cleanup. If callbacks cooperate and quiesce, retain a truthful full-inventory incomplete report (unstarted outcomes infrastructure-failed/missing). Once sealed, cancellation does not discard the report; submission/finish can be retried without callbacks. If a callback ignores cancellation, retain ownership while waiting; external forced termination leaves an uncertain attempt. Lost lock-helper ownership stops scheduling/submission, signals callbacks and cannot be called proof of stopped external work. No Promise.race followed by cleanup, forced timeout claiming success, speculative reexecution, or automatic interruption.

Private artifacts are bounded independently: definition input+expected inventory <=16 MiB encoded, individual callback output/explanation <=1 MiB, total private case artifacts <=128 MiB per attempt, journal envelope <=4 MiB, any service request body <=2 MiB. Preflight computes a conservative maximum report size from declared inventory/identities and fixed bounded outcome fields; reject a definition whose maximum cannot fit. New runner error labels <=128 ASCII bytes and emitted outputRef <=1024 UTF-8 bytes. Output oversize/storage failure is infrastructure evidence when safely representable; if a whole report cannot be sealed, retain uncertainty and stop rather than silently truncating or rerunning. Local reports/output files are never logged wholesale.

Freeze JSON response budgets separately: evaluator HTTP transport streams at most 4 MiB decoded response bytes for ordinary JSON AND retained-operation envelopes, including create/get comparison responses; do not call unbounded response.json first. Raw bundle download keeps its existing separate payload bound. Ordinary clients gain an explicit `maxJsonResponseBytes`/`max_json_response_bytes` option with 4 MiB default (document Python's change from 2 MiB and TS's formerly unbounded JSON reads); guided runners always use 4 MiB. Guided principal ID <=1024 UTF-8 bytes, route <=512 ASCII bytes, UUID metadata canonical and timestamps <=64 bytes, so a 2 MiB admitted report plus comparison/operation wrappers fits this envelope. Oversize response retains saved report/keys and reports response_too_large, never callbacks. G06 tests request maxima through actual create, comparison GET, operation lookup and replay, plus over-budget responses. The 1000-pair bound is an upper protocol bound: large IDs/refs can fail conservative admission earlier with `definition.report_budget_exceeded`, estimated/max bytes and a reduce-inventory/ref-size instruction.

## 6. Exact replay, journals, and the 24-hour gap

Extend the existing retained operation machinery in `src/commands.rs` rather than inventing another queue or receipt store. Add write-authorized route entries for comparison creation and evaluation `start`, `finish`, `interrupt`; validate all route IDs. The new runner marks its start/submit/finish with `X-Acclimate-Durable-Operation: true`. Existing operation lookup/close uses the same canonical route, principal/project/key namespace and advisory lock. Extend the operation-result DTO to include `Comparison`. Keep operation result distinct from delivery receipt.

All marked and unmarked writers consult retained records/fences. Current effective authorization is rechecked on execution, lookup, close and replay. Same key/body returns its original result after transient dedup expires; different bytes conflict, and a closed operation cannot execute. Retained records must not be deleted by transient 24-hour cleanup. Existing PostgreSQL operation tables suffice; no new migration is needed for this release. Document storage/backup retention for these records.

Persist exact UTF-8 request bodies with keys before their first send; retries send those bytes, never reconstructed objects. Start/finish known bodies and report bytes use fixed allowlisted private filenames with length/hash metadata; credentials are added at transport time and never journaled. Extract shared internal HTTP transport so the runner can submit known typed operations with saved bytes and retained headers; do not publish a generic raw-request escape hatch or duplicate redirect/error/auth behavior.

Shared exclusion:

- Journal directory is SHA-256 of compact UTF-8 JSON scope with fields in this exact order: serviceUrl, projectId, bundleId, requestId, evaluatorPrincipalId. Preserve exact strings and validate Unicode. Check in ASCII, Unicode and escaping fixtures shared across languages; this is legacy scope encoding, not a general content-hashing protocol.
- Both runtimes use nonblocking exclusive `flock` on the same permanent `ownership.lock` inode. Never unlink active locks or infer ownership from PID/file presence. Atomic writes use same-directory private temp files, file fsync, replace and directory fsync. Reject symlink ancestors/targets, wrong ownership, unsafe permissions and bounded-read overflow.
- Keep TS `attempt.json` schema 1 readable at the original location. New TS journals add optional fixed-name `wireBodies` references and retained-operation state; legacy report serialization must remain exactly the original JS representation. Python uses `attempt.python.json` with `format:'acclimate-python-evaluation-1'`, its own exact-byte body files and the same scope lock. Under lock, each new runtime refuses a foreign journal; both existing means ambiguous. No cross-language unfinished takeover. Downgrading a new journal to an old runner is unsupported; keep originating release artifacts for pending work.
- Move TS journal/private-file implementation into package internals. Existing example wrappers call that single implementation and retain existing command flags/adapter allowlist. No default scans, moves, deletions, rekeying, or account substitution.

Historical operations were not all retained. For a legacy saved report with no confirmed comparison ID, first query the original operation key/path and compare the returned request fingerprint/bindings. A committed result can be preserved using the existing close/recovery machinery (commit wins over fence). `not_observed` after transient retention does not prove unsent. If no trustworthy retained/active receipt establishes the outcome, return `legacy.submission_unconfirmed` and require inspection; do not automatically resubmit a possibly committed legacy comparison, invent a new key, or rerun callbacks. Legacy start/finish may reconcile from their current state-bound request, but never claim original comparison identity was recovered without evidence. New retained operations have no wall-clock retry-window heuristic.

## 7. Safe diagnostics and commands

One shared code table supplies fixed messages and next actions. Diagnostic fields:

```ts
interface SafeDiagnostic {
  code: SafeCode;
  phase: 'configure' | 'preflight' | 'claim' | 'verify' | 'execute' |
    'submit' | 'finish' | 'inspect' | 'policy' | 'export';
  executionState: 'not_started' | 'may_have_started' | 'report_saved' | 'finished';
  nextAction: SafeNextAction;
  evaluationRequestId?: string;
  correlationId?: string; // <=128 allowlisted ASCII identifier, otherwise omitted
  httpStatus?: number;
  mismatchFields?: Array<'datasetRevision' | 'graderRevision' | 'runtime.configId' |
    'runtime.configRevision' | 'runtime' | 'expectedCases' | 'versions'>;
}
```

Freeze codes for config missing/schema/permissions/url, unsupported runtime/capabilities, denied access, principal mismatch, descriptor/version mismatch, unavailable service, journal busy/foreign/missing/relocated/invalid, lost ownership, uncertain execution/submission, legacy unconfirmed submission, interrupted request, invalid policy, incomplete evidence, unknown cost, nonfinite analysis, missing artifact and hash mismatch. Next actions are `fix_config`, `ask_operator`, `upgrade_service`, `retry_same_command`, `restore_original_journal`, `inspect_external_app`, `interrupt_then_new_request`, `review_terminal_evidence`. Choose from phase/durable facts, never merely HTTP status. A generic transport error after a marker cannot suggest fresh execution.

No raw error causes/stacks, arbitrary service codes/messages/details, runtime keys/values, provider output, case bodies/expected answers, local paths or tokens enter diagnostics. Fixed mismatch categories give useful differences without echoing accidentally secret public configuration. Evaluation IDs and HTTP correlation IDs have separate names. Secret canaries cover both errors and logs. Private app artifact contents are not automatically public diagnostics.

The app statically binds its definition and optional review mapper to `evaluationMain`. Closed commands:

```sh
node acclimate-eval.mjs describe
node acclimate-eval.mjs request --config /absolute/private/evaluator.json --bundle UUID --channel stable --payload candidate.json --intent /absolute/private/ci-intent.json --out evaluation-request.json
node acclimate-eval.mjs doctor --config /absolute/private/evaluator.json --bundle UUID
node acclimate-eval.mjs doctor --config /absolute/private/evaluator.json --bundle UUID --policy quality-policy.json
node acclimate-eval.mjs doctor --config /absolute/private/evaluator.json --handoff evaluation-request.json
node acclimate-eval.mjs run --config /absolute/private/evaluator.json --handoff evaluation-request.json --live
node acclimate-eval.mjs check --config /absolute/private/evaluator.json --handoff evaluation-request.json --policy quality-policy.json
node acclimate-eval.mjs status --config /absolute/private/evaluator.json --handoff evaluation-request.json
node acclimate-eval.mjs interrupt --config /absolute/private/evaluator.json --handoff evaluation-request.json --reason operator-reviewed
node acclimate-eval.mjs export --config /absolute/private/evaluator.json --handoff evaluation-request.json --out /absolute/private/new-export
node acclimate-eval.mjs export --config /absolute/private/evaluator.json --handoff evaluation-request.json --selection share-selection.json --out /absolute/private/new-export
node acclimate-eval.mjs verify-export --manifest /absolute/private/new-export/manifest.json
node acclimate-eval.mjs verify-export --manifest /absolute/private/new-export/manifest.json --read-config /absolute/private/reader.json --handoff independently-selected-request.json
```

`--live` is conditional on definition.execution. No command accepts an adapter module/path/URL from service data or dynamically discovers app code. `interrupt` is explicit operator intent; it does not cancel provider work. Its command helper saves the intended reason/key/body under a separate short-held command-intent lock, never the long-held evaluation lock, so interruption remains possible during a run. Repeating the same pending interrupt recovers; changed reason requires new intent/key. `describe` emits only descriptor JSON. Other commands emit exactly one bounded JSON result on stdout, or a versioned safe error envelope on stderr. `evaluationMain` returns a status after owned cleanup; it never calls process.exit. Python exposes the same commands/JSON/exit behavior.

The `request` command completes the headless CI path. It reads a trusted local candidate BundlePayload and the statically defined app descriptor, runs nonexecuting access/policy/budget checks, resolves the selected channel/base revision, then atomically persists a private locked intent containing exact config identity, base ID/digest/revision, payload/descriptor, operation keys/bodies and intended output. Before sending any mutation it owns that intent. It calls the existing durable createDraft route (generation 1 supplies the immutable direct-child snapshot), verifies returned snapshot bytes/parentage, then creates a retained evaluation request with that parent/candidate, descriptor and requireBoundEvidence:true. Persist confirmed draft/request IDs and emit the existing public handoff plus draftId/generation in the command result. No promotion/model call occurs.

Request retries use original intent/base/body/keys, not a newly resolved baseline. Changed payload/definition/target under the same intent is an error. Recover existing draft/request operation results BEFORE considering current channel drift. Channel conflict before draft creation stops with inspect/new-intent guidance; drift observed after an already committed candidate also stops new request creation. First-release CLI requires explicit new intent to select a new baseline; it never silently rebases/reuses an old candidate. A request already committed is recovered unchanged and labeled as pinned to its original base even if the channel later drifts; release still needs fresh CAS. Recover lost draft/request creation responses through their retained operations, including >24h. Write the public handoff atomically/no-symlink; repeated identical output is allowed, different existing content is rejected. Losing the private intent after uncertain creation is inspection-required, not permission to repeat creation under new keys. Both TS and Python ship a complete CI workflow: request → run → check → explicit export on failure, with no manual console authoring. The command adapter uses existing typed transports; it does not add a fourth core evaluator operation.

| Command | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| run | Confirmed completed, including loss | Invalid/config/access/protocol error before uncertainty | Confirmed failed/incomplete | Interrupted or recovery-required/uncertain |
| doctor | All applicable checks passed | Invalid input/local unexpected error | Denied/failed check | Unsupported/unverified capability |
| check | Policy pass | Invalid policy, wrong identity, access/transport error | Complete evidence violates policy | Incomplete/unknown/indeterminate analysis |
| export | Committed complete manifest | Invalid/redaction/export error | Reserved | No confirmed comparison or required local selection missing |
| verify-export | Local consistency verified | Malformed/path/hash failure | Reserved | Requested trusted provenance not established |

Status returns 0 for a successful read regardless lifecycle, with lifecycle in JSON; interrupt returns 0 only for confirmed intended interruption. Other failures follow safe operational/recovery categories. Forced signals retain shell semantics; graceful cancellation reports its actual durable state. Fix existing checkout evaluate:app's resolved-failed exit behavior with release notes; keep its legacy JSON fields additive-compatible. Operator promotion/rollback remains separate and unchanged.

`request` returns 0 only for a confirmed request/public handoff, 1 for invalid/denied/changed-intent input, and 3 for unconfirmed creation or baseline conflict needing inspection/new intent. It never starts callbacks or resolves quality.

Public SafeCode names are fixed by category: `config.missing`, `config.schema`, `config.permissions`, `config.url`, `runtime.unsupported`, `capabilities.unsupported`, `guided_target_unsupported`, `auth.denied`, `auth.principal_mismatch`, `descriptor.mismatch`, `version.binding_mismatch`, `service.unavailable`, `transport.response_too_large`, `journal.busy`, `journal.foreign`, `journal.missing`, `journal.relocated`, `journal.invalid`, `journal.ownership_lost`, `execution.uncertain`, `submission.unconfirmed`, `legacy.submission_unconfirmed`, `request.interrupted`, `request.base_conflict`, `request.intent_mismatch`, `policy.invalid`, `policy.inventory_incompatible`, `evidence.not_terminal`, `evidence.identity_mismatch`, `evidence.malformed`, `evidence.incomplete`, `cost.unknown`, `analysis.nonfinite`, `definition.report_budget_exceeded`, `artifact.missing`, `artifact.hash_mismatch`, `artifact.integrity`, `artifact.selection_invalid`, `artifact.mapper_failed`, `internal.error`. The earlier response_too_large description maps to transport.response_too_large. Source/server-specific errors are mapped to these names, never emitted unfiltered. This code set is shared conformance data, not independently invented per language. Command-helper output/logging guarantees apply to its own generated data; installed callbacks must honor the documented no-stdout/private-log contract and remain responsible for their own deliberate logging.

## 8. Explicit quality policy

The initial CLI `check` is online and bound-request only. It fetches the authoritative request/comparison from the trusted private-config service, verifies the request's terminal comparison, principal/attempt binding, parent/candidate IDs/digests, and app's expected descriptor, then calls the pure policy module. It never trusts `.complete` alone, an arbitrary input JSON file, or a comparison from a different request. Existing direct comparisons remain supported by raw clients/operator review; the new guided CI gate does not silently accept unbound legacy evidence.

```ts
interface EvaluationPolicyV1 {
  schemaVersion: 1; id: string; revision: string;
  metric: { name: string; unit: string; direction: 'higher' | 'lower' };
  aggregation: 'equal-case-means';
  minimumMeanImprovement: number;
  maximumCaseRegression: number;
  candidateThreshold?: number;
  requiredCases: string[];
  maximumCandidateTaskFailures?: number;
  cost?: { maximumCandidateUsd?: number; maximumIncreaseUsd?: number };
}
```

Reject unknown/duplicate JSON fields, nonfinite values, invalid schema/enums and duplicate/empty required cases. Thresholds have no implicit quality defaults. Maximum regression/cost limits are nonnegative; task-failure count is a nonnegative safe integer; empty cost:{} is invalid. Reject booleans in all numeric scalar fields in Python. Improvement may explicitly be negative. Required case absent from trusted app inventory is `policy.inventory_incompatible` (authoring error, doctor/check exit 1), never a content quality failure or a passed omitted case. Pure `checkComparison({comparison, expectedDescriptor, expectedBinding, policy})` requires explicit expected IDs/digests/request+attempt from its caller; it computes descriptive policy results only and makes no transport authenticity claim.

Calculation is deterministic: sort distinct case IDs by UTF-8 bytes and repetitions numerically. Recompute unique full inventory and paired completeness; infrastructure/missing/ungraded/nonfinite evidence is indeterminate. For each case average all repetitions separately for parent and candidate; then weight each distinct case equally. Orientation s is +1 higher / −1 lower; case improvement D=s*(candidateMean−parentMean). Require mean(D)>=minimumMeanImprovement, every D>=−maximumCaseRegression, and the optional oriented candidate mean>=oriented candidateThreshold. Count scored candidate task failures separately when that rule is present. Missing is never zero.

Use this exact recurrence in both languages, checking finiteness after every operation: `total=+0.0; for x in orderedValues: total=round64(total+x); mean=round64(total/count)`. No predividing terms, compensated/incremental means, locale sort, Python sum/fmean, fused reductions or hidden tolerance. Compute each case parent/candidate mean first, then `D=round64(s*round64(C-P))`; aggregate improvement is mean(D), not difference of aggregate means. Parent/candidate summary means average their case means by the same recurrence. Worst regression is max(0, max(-D)); sums for candidate/parent cost use the same sequential total, and increase is round64(candidateTotal-parentTotal). Nonfinite intermediates yield analysis.nonfinite/indeterminate. Inclusive thresholds compare these actual finite doubles. Fixtures [1e308,1e308] must be indeterminate under sum-then-divide even though predivision could avoid overflow.

Cost limits use all declared candidate costs and parent costs if increase is tested; required unknown cost is indeterminate. Without a cost rule, unknown cost is informational. Any unknown required check makes the final verdict indeterminate while retaining known failing checks; otherwise any failure fails, all pass passes.

Ordered check eligibility (after local schema validation): (1) malformed/duplicate trusted inventory, incompatible requiredCases or unsupported policy → authoring error/exit1; (2) access/transport failure → safe operational error/exit1; (3) requested/running/interrupted with no terminal comparison → evidence.not_terminal/indeterminate/exit3; (4) terminal comparison wrong binding/IDs/digests/descriptor or malformed duplicate/unexpected results → evidence.identity_mismatch or evidence.malformed/error/exit1; (5) terminal failed with a correctly bound partial comparison, or any missing declared result/grade/infra outcome → evidence.incomplete/indeterminate/exit3; (6) complete evidence with required cost unknown/nonfinite analysis → indeterminate/exit3; (7) complete known policy violation → fail/exit2; (8) all checks known/pass → pass/exit0. Pure policy follows the same authoring/identity/completeness ordering; it has no service lifecycle/network stage. Doctor --policy performs authoring validation only, never fabricating an evidence verdict. Completed losing runs remain run0/check2, failed incomplete runs run2/check3.

The verdict includes policy id/revision/exact-file digest, comparison ID, expected binding, individual rule outcomes, distinct-case and pair counts, parent/candidate means, oriented improvement/worst regression, known/unknown cost, and `interpretation:'descriptive-policy-check'`. No confidence/significance claim. Existing console history continues its per-pair descriptive mean, labeled as such; it must not masquerade as the separate equal-case policy calculation or a release approval. Store policy results as app/CI artifacts in this release, not authoritative service promotion permissions.

## 9. Portable review evidence

Exports are explicit sidecars, never changes to sealed report bytes, outputRefs or operation fingerprints. Preserve existing saved refs. New runs keep app-supplied bounded outputRefs as untrusted text, otherwise their private local file refs; neither is automatically fetched. The runner privately indexes its saved outputs/explanations by request/attempt/version/case/repetition/side with actual bytes/hash. Export only from that validated local index, never from arbitrary submitted refs or a recursive journal copy.

Freeze the installed artifact interface and its CLI binding:

```ts
type ArtifactRole = 'output' | 'grader-explanation';
interface ArtifactSelectionV1 {
  schemaVersion: 1;
  entries: Array<{ caseId: string; repetition: number; side: 'parent' | 'candidate';
    role: ArtifactRole; required: boolean }>;
}
interface ReviewMapperInput {
  identity: { requestId: string; attemptId: string; comparisonId: string;
    versionId: string; digest: string; caseId: string; repetition: number;
    side: 'parent' | 'candidate'; role: ArtifactRole };
  value: Json; // Only the registered role payload, never the execution envelope/expected data.
}
type ReviewMapper = (input: ReviewMapperInput) => Promise<
  null | { mediaType: 'application/json'; value: Json } |
    { mediaType: 'text/plain'; text: string }
>;
declare function evaluationMain(app: EvaluationApp<any, any, any>, argv: readonly string[],
  options?: { review?: { toReviewArtifact: ReviewMapper } }): Promise<number>;
declare function exportReviewEvidence(options: {
  configPath?: string; readConfigPath?: string; // Exactly one.
  handoff: EvaluationHandoff; outputDirectory: string;
  selection?: ArtifactSelectionV1; toReviewArtifact?: ReviewMapper;
}): Promise<ReviewExportResult>;
declare function verifyReviewExport(options: {
  manifestPath: string;
  online?: { readConfigPath: string; expectedHandoff: EvaluationHandoff };
}): Promise<ReviewVerificationResult>;
```

`--selection` reads a closed data-only JSON file with the above shape, <=2 MiB, <=4000 entries. Reject duplicates, unsupported roles, undeclared case/repetition/side and any executable/path/URL fields; no selection means no raw content. Selected roles require a statically registered mapper; absence is configuration error/exit1. An empty selection is scalar-only. Python mirrors these types/names. Scalar-only export fetches the authoritative comparison and does not open/create/require any journal or mapper, so it works after loss of the worker. A content selection requires the original evaluator config/runtime/journal; read-config with nonempty selection is an error. Scalar fallback never silently fulfills a requested content selection.

For online read-only verification define a separate owner-only ReaderConfigV1 `{schemaVersion:1,serviceUrl,projectId,readToken}` at an explicit absolute path. Apply existing private file/URL bounds; no evaluator principal or journal root is required. The independently supplied expected handoff must match that trusted service/project before network use. Authenticate only project read; do not call write-requiring evaluator preflight, probe journal storage, or require the originating principal. `check`/`status` may use mutually exclusive --read-config in place of --config with these same read-only semantics. Manifest data alone cannot select its own trusted target. Online verification confirms the authoritative request/comparison projection, not output execution truth.

When content is selected, under the originating lock require its scope/root/principal/attempt and confirmed comparison ID to match the authoritative terminal request/comparison. Validate the sealed body bytes/hash, then structural equality of every report wire field with the authoritative comparison (ignore only server-added metadata and object-key order; keyed unique inventory/results must match exactly). Require index report hash/binding and each selected original file's recorded size/hash before mapper invocation. Missing local sealed report/index yields content unavailable; different report/comparison, corrupt bytes, alias/symlink or wrong role binding is an integrity error. Give the mapper only the role value and immutable identity, not config/journal/expected data or a callback envelope. Redaction returns new bytes/hashes and never changes original files or sealed report. Mapper failure affects export, not evaluation. Optional high-level explanation is a private indexed role. No secret-detection guarantee or automatic uploads.

```ts
interface ReviewManifestV1 {
  schemaVersion: 1; kind: 'acclimate-review-export';
  projectId: string; bundleId: string; requestId: string; attemptId: string;
  comparisonId: string;
  parent: { versionId: string; digest: string };
  candidate: { versionId: string; digest: string };
  localInspection: 'not_requested' | 'validated' | 'unavailable';
  projection: { file: 'comparison-review.json'; sha256: string; bytes: number };
  entries: Array<{
    caseId: string; repetition: number; side: 'parent' | 'candidate';
    roles: Array<{
      role: 'output' | 'grader-explanation'; selected: boolean; required: boolean;
      availability: 'exported' | 'not_shared' | 'missing' | 'unavailable';
      file?: { path: string; sha256: string; bytes: number;
        mediaType: 'application/json' | 'text/plain' };
    }>; // Exactly one row for each of the two roles.
  }>;
  exporter: { name: 'acclimate-evidence'; version: string };
}
```

Projection includes exact comparison/version/binding IDs, complete expected inventory, outcome statuses/rewards/usage and missingness. Exclude service URL, submitter, raw runtime/dataset/grader strings, arbitrary errors, original outputRefs, local paths, config/journal/locks, prompts, outputs and raw logs. Case IDs are declared public identities; docs require opaque non-sensitive names. Render/export strings inertly and bound all fields.

Per-role status is normative: unselected → selected:false/required:false/not_shared, no local inspection; selected existing artifact released by mapper → exported plus exactly one file; selected known absent role/file → missing/no file; selected artifact whose originating journal/index is unavailable → unavailable/no file; mapper intentionally withholds → not_shared/no file. required:true is legal only for selected roles. Any required role not exported returns exit3 and commits NO complete manifest; optional missing/unavailable/withheld roles commit with explicit status and warning counts. A failed integrity check is exit1, never optional missing. Default scalar-only exports mark both roles unselected/not_shared and state localInspection:'not_requested' at manifest level; they do not pretend to know whether local files exist. Content exports state localInspection:'validated' or 'unavailable'. Include selection counts (required, exportedRequired, optionalMissing) in the result. This permits output-exported/explanation-not-shared and distinguishes explanation-required-but-missing. Every expected case/side has both role rows even when nothing is shared.

Create a new owner-only output directory outside config/journal/prepared roots; no overwrite. Fixed generated filenames come from hashed structured identity, never a raw case ID/path. Reject traversal/symlinks/nonregular/duplicate/case-colliding paths and overlapping roots. Individual released artifact <=1 MiB, entire export <=64 MiB, manifest <=2 MiB, <=1000 pairs and two roles per side. Write/hash files atomically, manifest last. Failed partial staging has no complete manifest and is removed or explicitly left incomplete privately.

`verifyReviewExport` validates closed schemas, all byte lengths/hashes, unique identities, complete side inventory and manifest/projection agreement. It treats content as inert JSON/text and never follows URLs or executes HTML. Local consistency is not authenticity. With an explicit config and expected selection, optional online verification fetches the authoritative comparison and recomputes the projection. That confirms scalar binding, not that redacted output bytes are true execution traces. Offline CI gating and execution attestation are unsupported in this release.

CI uploads only the export directory through its existing authenticated artifact mechanism with explicit ACL/retention. Never upload its parent, journals, private config, expected answers or provider credentials. Teammates download through that authorization and run local/optional online verification using their own read authority. The console initially shows artifact availability limits and retrieval instructions; browser artifact import/hosting is deferred.

## 10. One connected onboarding journey

README separates Connect an existing agent, Try a model-free comparison, Operate a deployment, and Develop Acclimate. The offline trial is a shipped deterministic application fixture needing no service/OIDC/provider and labeled simulated; it cannot create release evidence. Existing-workspace adoption does not send the developer through deployment/cutover history.

Keep the current App setup route; do not add a new onboarding dashboard or persistent wizard. Show installation, access, delivery verification and Connect your agent as visible adjacent sections. Language selector offers TS/Python; runtime examples offer supported custom/Codex/Claude/Pi/Cursor paths, with Python custom-app support stated clearly. Show exact matching release artifacts, compatible native peers and runtime prerequisites. No invented download endpoint or implicit npx fetch.

After delivery success say “Verified content delivered. Connect your app below to use it in an agent run.” A runnable fixture and marked actual-agent seam show instruction attachment, skills/reference exposure, explicit approved memory, awaited lifetime, output retention, version/digest recording and cleanup. Receipt observations and file reads remain distinct from model consumption. Link to Compare a change preserving workspace/bundle/channel without executing or creating a request.

Before request creation show the identity checklist: published delivery credential from Connections, optional separate receipt writer, project read/write evaluator from service operator, and separate release authority. Provide a public operator request template with service/project/bundle/purpose/required rights only. Explain static grant changes/restarts and fixed durable journal prerequisites early. Browser never receives or checks the evaluator secret.

Eval form begins with no selected evaluator. Primary action: use my app's evaluator, run describe, paste public configuration. Secondary disclosure: checkout examples with truthful purposes and prerequisites. Remove both UI default payment selection and server `configuration ?? localEvaluationDescriptor` fallback for new authoring. Validate known simulator policy presence before its action. Never claim custom structural validity means installation/provider readiness. Remember public config only in actor/service/selection-scoped mounted workflow state, not localStorage; existing pending-operation form matching and exact command bodies remain.

Require saved immutable candidate/current parent, explicit config and current edit authority/no pending conflict. Display evaluated saved generation where available. Later edits cannot change an existing request; channel drift requires refresh, not automatic rebase or substitution. Preserve existing operation result/fence recovery and comparison/version bindings.

Offer Copy request JSON and Download request JSON using the existing public envelope. Shell instructions contain fixed app command and placeholder paths, not interpolated arbitrary runtime strings. State “Request created · run in your app,” not a readiness claim. Running means app reported start; remote progress is unknown in this release. Failed/interrupted show safe recovery guidance; interruption copy says it does not stop an external job or charges. Completed shows coverage, rewards and separate quality/release meanings.

## 11. Python parity and typed workflows

Python ships in the same DX acceptance milestone, with its own paired runner, JSON isolation, exact-byte mutation transport, private journals, capability checks, safe diagnostics, command helper, policy calculation and export verification. No Node sidecar. Annotate existing evaluation lifecycle methods with TypedDict/Literal request/response types while preserving signatures. Add required typed capability/policy/manifest DTOs and page results. Draft/integration type completeness beyond touched methods is follow-up, not a claim of full feature parity.

The Python starter is a real installed-wheel consumer using package imports, local fixtures and the app's execute/grade. The guide includes obtaining/building the wheel and the actual-agent context seam. Its async recipe offloads the complete synchronous run, retains its worker task, forwards a cooperative threading cancellation context and awaits actual termination before cleanup; cancelling an await alone is not cleanup authorization. Callback timeouts/budgets and native memory semantics remain application-owned.

Freeze Python cancellation: `run_evaluation(..., cancel_event: threading.Event | None=None, allow_live: bool=False)` creates an event if absent. Callback inputs expose `cancellation: CancellationContext` with `is_cancelled()->bool` and `raise_if_cancelled()->None`. The latter raises `CallbackCancelled`; throwing that exception certifies app-owned external work is quiescent and causes stopped scheduling plus truthful incomplete evidence. If the app cannot certify quiescence it must throw ExecutionUncertainError instead. Cancellation flags by themselves never prove quiescence. Equivalent TS callbacks may throw CallbackCancelled after cleanup; AbortSignal remains their notification mechanism.

At define time reject inspect.iscoroutinefunction on a callback or its callable __call__. At runtime reject inspect.isawaitable, asyncio Future/Task or concurrent.futures.Future anywhere in execute/grade return data as execution.uncertain, before normal invalid-JSON classification; an awaitable may already own external work. Never seal/submit or automatically clean based on that misuse. An inert returned coroutine may be closed solely to suppress warnings, without changing the conservative uncertain result. Ordinary invalid JSON values after a quiescent callback remain ordinary safe infrastructure/grading failure. Numeric reward/cost/token/policy values reject Python bool explicitly.

The shipped async wrapper uses a private worker task that the caller never cancels directly, and drains through repeated cancellation:

```python
cancel_event = threading.Event()
worker = asyncio.create_task(asyncio.to_thread(
    run_evaluation, app=app, config_path=config_path, handoff=handoff,
    cancel_event=cancel_event, allow_live=allow_live,
))
cancelled = False
while True:
    try:
        result = await asyncio.shield(worker)
    except asyncio.CancelledError:
        cancelled = True
        cancel_event.set()
        if worker.cancelled():
            # Actual thread completion is no longer tracked: retain/quarantine.
            raise ExecutionUncertainError() from None
        continue  # Another caller cancellation repeats this drain, never cancels worker.
    except BaseException:
        if cancelled:
            raise asyncio.CancelledError() from None
        raise
    else:
        if cancelled:
            raise asyncio.CancelledError()
        return result
```

Only actual run settlement authorizes its normal cleanup. A process/event-loop forced teardown is outside graceful drain and leaves the durable marker/quarantine; no loop retries a canceled worker indefinitely. Tests cancel the outer task twice while a fake thread holds its files/lock, then demonstrate actual quiescent settlement. Sync callers can signal the event without adopting asyncio.

Shared conformance fixtures cover descriptor/set matching, inventory expansion, paired statuses, serial order, numeric policy order, safe errors/exits, scope hash/flock exclusion, body bytes versus hashes, export projections and path validation. Equivalent JSON does not need identical cross-language serialization; each persisted digest identifies its actual stored bytes. Foreign journal refusal is tested in both directions with real processes. No unfinished journal portability claim.

## 12. Native existing-repository recipe

Keep existing native plugin signatures and owned-temp cleanup. Ship an external-consumer repository-task starter using public `prepare(bundle)`, then exclusive copying of a frozen explicit regular-file source inventory into prepared.cwd. The app supplies source root/revision and tasks locally; a request cannot choose a repository URL/ref/path or install command. No SDK-managed Git worktrees/clones, live repository overwrite, automatic copyback/commit/push or instruction merge.

Recipe limits: <=1000 source files, <=1 MiB each, <=16 MiB total; <=100 declared result files, <=1 MiB each, <=8 MiB total. Portable relative paths, no symlink roots/ancestors/files, nonregular files, traversal, prefix/case collisions, `.git` segments/submodules, implicit dependencies/credentials/build outputs. Require a quiescent source or app-owned immutable snapshot and hash actual file bytes/sizes/modes before either side; both use the same captured source bytes. This is cooperating private application code, not a hostile same-user filesystem sandbox.

Freeze `repository-source-policy-v1`: reject every dot-prefixed source path segment, plus any AGENTS.md or CLAUDE.md basename case-insensitively at any depth. This conservatively excludes .git/.acclimate/.agents/.claude/.cursor/.pi, .env and dot-scoped hook/MCP/control configuration; there are no implicit exceptions. Also reject every staged-resource ancestor/descendant collision. The first small source fixture deliberately uses ordinary src/tests/package files; hidden configuration/dependencies requiring exceptions need a separately reviewed versioned app recipe. The policy governs imported project content, not a claim to sandbox ambient host/user harness configuration. Host SDK/session/tool policy remains explicit app configuration and recorded runtime identity. Pre-existing repository guidance must be consciously reviewed into a bundle or an app-owned versioned composition policy; no silent merge. Source-manifest digest, contextPolicyRevision including source-policy version and selected-memory digest are local task/build identity, declared before describe/request creation.

Selected memory is an explicit app list, checked against bundle paths. For this recipe, prune unselected prepared memory in the owned disposable tree before session/loader startup AND derive a fresh immutable EffectiveContext containing only selected memory text/paths/resources. Pass only EffectiveContext to the harness adapter, not unfiltered prepared.memoryFiles or original Pi resource arrays. Honor Cursor approvedMemoryPaths and Pi loader selection consistently. File pruning alone is insufficient because returned metadata may retain text. Original bundle digest identifies original verified bytes; effective selection is separately recorded, never mislabeled a complete byte-identical tree.

Complete starter helpers implement inventory freeze/copy, native fake execution, bounded result/patch collection, retention and cleanup. Retain allowed results, source/context/bundle bindings and before/after hashes outside prepared.cwd before cleanup; never archive the whole tree or journal. Use the shared review exporter for deliberately released content. The app's harness adapter confirms external termination before success or cleanup; uncertainty quarantines private workspace and throws ExecutionUncertainError. Normal cleanup removes only plugin-owned root and leaves original source/retained artifacts unchanged.

Durable native locator: before invoking execute, the runner creates/fsyncs context.privateJobDirectory under the originating scope journal's jobs/<jobId>, writes a binding record (request/attempt/case/repetition/side/version), and makes that narrow read-only context available to the app. jobId is generated from those captured identities, never caller paths. The shipped native helper writes an owner-only job.json there: first allocating, then prepared with canonical cwd/source/context hashes, then launch_intent BEFORE calling the harness. Persist any acknowledged external handle separately; absent acknowledgment remains possible launch, not proof it never ran. Record monotone confirmed_stopped, results_retained and cleaned facts after each actual event, using fsync/atomic replace. Launch is forbidden until the prepared locator and launch intent are durable outside cwd. Crash between temp allocation and locator cannot have launched work.

Add a matching private ownership marker in prepared.cwd tied to jobId. Recovery inspection reads only known private records and displays locators to the authorized local operator; public diagnostics include jobId, not paths/handles. App-native recovery helper may clean only after original worker/external termination is established and canonical path+marker still match. Never infer stop from age/PID reuse/missing handle.

Choose one concrete persistent workspace algorithm: the dedicated native worker launches with OS TMPDIR set to an explicitly configured private persistent local workspace parent, separate from config/export roots. Before calling the unchanged plugin.prepare, the complete starter validates os.tmpdir() equals that canonical owned 0700 parent, and afterwards verifies prepared.cwd is its direct private child. Do not fall back to the system ephemeral temp directory in this recipe. Plugins already allocate through os.tmpdir(); no relocation, rebasing of returned metadata, new plugin destination option or global library environment mutation is needed. This is documented worker OS configuration, not credential discovery. Prepared absolute paths remain valid and the original cleanup function retains sole normal ownership. Recovery tooling verifies the persistent root and marker before any explicit post-stop deletion. Native job records are <=64 KiB; the source manifest is separately bounded <=1 MiB. No automatic age-based cleanup touches unresolved jobs. Restores require one authoritative physical volume and confirmed original-worker termination, not two independent copies with the same pathname. First patch fixture is bounded UTF-8 text additions/modifications/deletions only.

All four harnesses get installed import/peer/loader/fake-resource tests and an honest evidence ledger. These tests establish wiring only. Existing dated Codex/Luna smoke is not qualification of the new repository recipe; no new live behavior is claimed without separately authorized provider tests. App runtime/model choices stay app-owned; project live-test policy remains explicit.

## 13. Operator and observation workflow

Keep static grants for this release. Publish one operator runbook and secret-safe stdin/file-based grant validator that does not open a listener, contact a provider or dump configuration. Evaluator needs exact project read+write, no propose/promote. Explain broad write authority and restart overhead. Add a replacement token under the same principal/project for overlap, validate/restart, update only the worker token preserving exact scope/root/attempts, preflight, drain old clients, then remove old token and restart. Revocation is not job termination. Emergency revocation retains uncertain-work guidance.

Durable worker recipe uses a dedicated nonroot UID, pinned release, owner-only config and local persistent journal volume at the same canonical absolute mount across restarts; include TS Python-lock dependency. Back up private journals independently from PostgreSQL; qualified restore preserves mount/scope and first confirms original worker termination. Multiple unrelated request workers are allowed, with one owner per request and app-owned budgets. Disposable CI workers cannot resume running requests without the original journal: expose status/explicit interrupt and a new-request decision, never automatic paid replay.

Separate read-authorized delivery observations from Connections credential management. Add project-read GET `/v1/projects/{projectId}/integration-observations` with existing bounded cursor pagination. Each row returns integration ID/name/bundleId/channel/enabled and latestObservation:null or {eventId,stage,versionId,digest,occurredAt,receivedAt}. Select exactly one retained receipt by descending server (receivedAt,eventId); all observation fields come from that row, never combine stage from version A with metadata from B. Keep app occurredAt distinct from server receivedAt, apply existing 30-day retention, and show delayed/out-of-order reports honestly. No credentials, issuer/user metadata or administration actions. Reuse current effective read authorization; readers/editors can discover observations while issuance/revocation stays admin-only. Missing means unknown, never consumption proof. No migration required; qualify query bounds/index use on existing tables before release.

## 14. Distribution, compatibility, and rollout

Release build extends current SDK export maps/declarations and self-contained package copying; no compiled imports escape into examples/scripts. Move pure descriptor logic out of examples into shared SDK validation and migrate console imports. Keep root delivery/browser imports free of Node evaluator code. Native peer SDKs remain optional. Python wheel stays standard-library-only.

Extend the existing versioned release manifest with exact SDK/plugin/wheel filenames, SHA256SUMS, runtime/platform prerequisites, supported capability feature flags, starter archive names, and compatible peer versions. The console uses build-shipped public release metadata produced by this pipeline; it does not read developer disks or pretend artifact download exists. Paths remain explicitly replaceable release-directory placeholders. Package a model-free trial and JS/TS/Python custom evaluator/native/CI starters. TS source starter toolchain is pinned; compiled JS works without a TS runner.

Deploy additive server capability/retained-route/observation support first; no new schema migration. Then release SDK/wheel/starters and console together. Old console and existing raw clients continue functioning. New guided runner requires capability+retained support, otherwise blocks before execution with upgrade guidance. Keep new example descriptors separate from old saved requests. Resume historical TS requests only through a compatible original-definition wrapper at the original root/principal; do not silently regenerate revisions, add reserved runtime fields, or translate journals.

Record checkout CLI exit-status correction, new error schema, new high-level JSON limits, platform/runtime prerequisites and legacy replay limitations in release notes. Rollback the console/packages independently only when no new incompatible journal is handed to an old runner; keep pinned originating worker images for pending work. Database records and channels are not rewritten by a UI/package rollback. No registry publication, deployment, or source implementation is authorized by completing this design task.

## 15. Implementation work packages and release gates

The coordinator owns shared contract/types, manifests, operation route inventory and integration. Work packages may implement nonoverlapping files after these contracts are frozen; this document does not start implementation agents.

| Package | File-level scope | Depends on |
| --- | --- | --- |
| A Contract/server | packages/sdk/src/types.ts, contracts/IMPLEMENTATION.md, src/commands.rs, src/evaluations.rs, src/integrations.rs, operation DTOs/tests; capability+retained routes+observation projection | Frozen contract |
| B TS evaluator | packages/sdk/src/evaluation/{index,definition,runner,journal,config,errors,cli}.ts, internal private-state/transport, examples compatibility wrappers, scripts/evaluate-app.ts/config | A DTOs and retained behavior |
| C Python evaluator | python/acclimate evaluation/CLI/types/client/private journal/policy/artifacts, python README/examples/tests | A and shared conformance fixtures |
| D Policy/evidence | packages/sdk/src/evaluation/{policy,artifacts}.ts, common behavior fixture specifications, TS CI starter/docs and result schemas; C implements Python equivalents against those fixtures | B contract, A bound evidence |
| E Onboarding/distribution | README, docs/getting-started.md, console sdk-setup/recipes/improvement/evaluation-config/observations, SDK export map/manifests/build/packaging/release manifest | A–D stable interfaces |
| F Native starter | examples/native-integration.md, complete external repository starter and harness/fake adapters, memory/context/retention fixtures | B/D and existing plugins |

Freeze shared names/types first, then A and package internals, then starter/console integration, then external-consumer qualification. C/D can progress on shared fixtures while A/B land. E/F must use final installed imports rather than temporary source imports. One integration owner runs broad checks after focused interface gates; keep live qualification separately opt-in.

Mandatory acceptance matrix:

| ID | Observable release gate |
| --- | --- |
| G01 | Clean external tarball and wheel consumers run two versions/two tasks, export descriptor, consume console handoff, submit bound comparison; no repository imports or implicit downloads |
| G02 | Pure/browser imports build without fs/child_process/Python/native SDK; durable missing-runtime preflight fails before claim |
| G03 | Wrong service/project/principal/descriptor/parent/digest/foreign journal stops callbacks; missing capabilities blocked/unverified; long/Unicode/dot/encoded-separator project and noncanonical IDs never retained-ready |
| G04 | Capability read-only/write/denied/human/revoked/project cases and private/no-store behavior match actual transition authorization; no probe mutation/provider |
| G05 | Two real processes and both languages contend on one flock/scope fixture; original-root/foreign-format/unsafe-path cases refuse takeover |
| G06 | Start/submit/finish response-loss faults replay exact bytes/keys and preserve original comparison ID beyond24h; changed-body/closed/revoked/unmarked writes cannot bypass retained state; historical start replay held across interruption yields zero callbacks after authoritative read; maximum report through create/get/operation envelopes and >4MiB response faults remain recoverable |
| G07 | Legacy no-receipt response-loss never claims original identity or silently retransmits after unknown retention; known receipt/state can be recovered without callbacks |
| G08 | Forced loss after marker and before full saved report refuses callbacks; graceful/ignored/uncertain cancellation preserves actual lifetime and no speculative cleanup |
| G09 | Input/expected/output AND VerifiedBundle metadata/payload mutation isolation, exact parent-execute/parent-grade/candidate-execute/candidate-grade trace, execute/grade uncertainty escape, bounds/status/unknown usage identical in both languages |
| G10 | CLI matrix covers complete loss, incomplete, interruption, wrong config, uncertain submit, policy pass/fail/indeterminate; no command promotes |
| G11 | Policy fixtures cover direction, unequal repetitions, required case absent trusted inventory=authoring error, requested/running/interrupted=indeterminate, partial failed evidence, scored task failure, null cost, bool/fractional count rejection, invalid identities, sum-then-divide overflow, rounding-sensitive mixed magnitudes and exact threshold equality |
| G12 | Secret canaries in config/runtime keys/HTTP errors/callback errors/output do not enter safe diagnostics, default projections, logs or upload selections |
| G13 | Explicit selection+static mapper via documented CLI; per-role output/explanation mixed statuses and required omission disposition; scalar-only without journal; selected corrupt/index/report/comparison/file binding rejected before mapper; mapper never receives envelopes/expected data; path/hash faults cannot create trusted provenance |
| G14 | Native task reads existing source and selected resources, retains patch before cleanup, leaves source unchanged; conflicts, memory exclusion and uncertain termination behave as specified across fake harnesses |
| G15 | Console begins with explicit evaluator choice, no server default; saved generation/pending recovery/channel drift remain correct; request download contains public intent only |
| G16 | Read-only member sees delivery observations but cannot issue/revoke credentials; delayed/out-of-order/versionA-versus-B receipt fields come from one (receivedAt,eventId)-selected row; missing/expired receipts unknown |
| G17 | Python async recipe keeps unrelated task responsive, drains through two caller cancellations with lock/files retained until quiescence; async functions/callables and returned coroutine/future/nested futures cannot become ordinary completed/failed evidence or cleanup authorization |
| G18 | Operator provisioning/overlap rotation/fixed-mount recovery rehearsed on disposable resources; same principal and exact saved identity retained |
| G19 | Release manifest/starter/artifact checksums and installed imports verified from clean consumers; original schema-1 TS compatibility fixtures pass |
| G20 | Clean external TS and Python PR workflow creates durable draft/candidate and bound request headlessly, recovers creation-response loss >24h, rejects changed intent/payload/descriptor and channel drift without rebasing, then run/check/export without console authoring |
| G21 | Native crash after launch intent/acceptance/retention/stopped facts has a private durable job locator; operator finds workspace and never cleans/replays uncertain work; persistent TMPDIR/root/marker validated; dot/control/case variants rejected and unselected memory absent from files AND effective metadata |
| G22 | Second reviewer with read-only config and independently selected handoff verifies downloaded projection online without journal/write/live requirements; manifest-chosen target or different request/scalars rejected; self-consistency never labeled execution authenticity |

Use public-interface deterministic callbacks and faulted internal transport for ordinary checks; real private files/processes qualify OS locks and lifetimes. Disposable PostgreSQL/service checks qualify actual authorization, transaction/replay and interruption races. Existing UI/pending-operation and packaging suites remain required. Offline tests establish wiring/protocol behavior; provider consumption, quality and visual usability are distinct evidence. Do not claim the release qualified until these gates actually run and their results are recorded.

## 16. Defined follow-ups and limits

- Remote progress: later add optional request/attempt/principal-bound observations separate from lifecycle, server receipt time, monotone sequence and bounded counts. Fresh/stale/absent mean reported activity/unknown, never stopped or safe replay. Observer failure cannot change execution. Requires its own DTO/migration/retention and authorization review before implementation. First release exposes safe local phases and honest remote unknowns.
- Dynamic evaluator credentials: later design managed issuance/rotation and narrower rights, preserving stable pending-attempt identity and revocation semantics. First release's runbook does not remove restart overhead or broad write authority.
- Research: later add named multi-metric analysis and paired, task-aware uncertainty methods with explicit assumptions. First release has explicit scalar policy direction/units and descriptive means only; no confidence claim or automatic release.
- Checkpointed recovery: later design authenticated per-outcome state and unknown in-flight semantics. Existing private output files alone never authorize resume. Retained operation results solve HTTP response loss, not exactly-once external effects.

The design is finalized only after the independent critique council explicitly accepts the exact document digest with no unresolved blocking objection. Consensus certifies a reviewed plan, not implementation correctness or real-person usability.
