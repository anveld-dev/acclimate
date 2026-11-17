# Alternative B: an owned evaluation session

Design proposal, 2026-11-16. This is the flexible alternative for the first design council, not an implemented interface or a claim of runtime qualification.

## Recommendation and scope

Provide an `EvaluationSession` module at the installed subpath `@acclimate/sdk/evaluation`. The application explicitly controls when execution occurs and when sealed evidence is submitted. The module owns the difficult protocol: descriptor agreement, immutable bundle verification, attempt ownership, exclusive local access, pre-execution persistence, exact report persistence/replay, and finish reconciliation.

This alternative deliberately exposes more ordering than a single `runEvaluation` call. It earns that cost for a real worker that must coordinate an external job, publish artifacts, apply its own quality policy, or separate a model budget window from service submission. It does not expose individual lifecycle mutations, journal writes, arbitrary report injection, or a general workflow engine.

Prefer the minimal alternative for the initial adopter if research shows nearly all apps execute and submit together. A session is useful flexibility only if those intermediate scheduling needs are part of the release scope. Do not ship two unrelated evaluator implementations: any eventual convenience runner must compose the same session implementation.

## Current source anchors

- `packages/sdk/src/index.ts:11` exports the lower-level comparison helper, but no durable evaluator module.
- `examples/evaluation/adapter.ts:6` defines the installed callback contract; `:22` compares descriptor identity structurally.
- `examples/evaluation/runner.ts:51` currently performs the complete operation in one call.
- `examples/evaluation/runner.ts:98` refuses an execution marker without a complete saved report; `:116` persists the marker before callbacks; `:131` persists the report before submission.
- `examples/evaluation/journal.ts:10` scopes journals by exact target and principal; `:100` binds them to their original absolute root.
- `packages/sdk/src/compare.ts:39` provides cloned paired inputs, callback concurrency, cancellation signals and grader retries; `:277` emits a complete immutable report object.
- `src/evaluations.rs:270` binds the start operation to principal/attempt. `:309` finishes with `completed` or `failed` according to comparison completeness; quality does not determine that state.
- `scripts/private-state.ts:60` performs owner-only atomic writes with file and directory synchronization.
- `packages/sdk/package.json:5` is the external export map; `scripts/build-packages.mjs:8` gives the SDK a self-contained compiled tree.

## External caller example

```ts
import {
  defineEvaluator,
  openEvaluation,
  readEvaluatorConfiguration,
} from '@acclimate/sdk/evaluation';

const evaluator = defineEvaluator({
  datasetRevision: 'checkout-cases-2026-11-16',
  graderRevision: 'exact-charge-v2',
  runtime: {
    configId: 'checkout-agent',
    configRevision: 'build-31',
    model: 'application-selected-model',
    writes: 'sandbox-only',
  },
  cases: savedCases,
  execute: async ({ bundle, snapshot, settings, signal }) => {
    return myAgent.runWithBundle({ bundle, snapshot, settings, signal });
  },
  grade: async ({ output, caseId }) => myGrader(output, caseId),
});

// Public intent, safe to copy into the console; contains no cases or callbacks.
const descriptor = evaluator.describe();

// Private filename is selected explicitly by this application.
const configuration = await readEvaluatorConfiguration(privateConfigFile);
const session = await openEvaluation({
  configuration,
  handoff: publicHandoff,
  evaluator,
});

try {
  const before = session.inspect();
  if (before.nextAction === 'execute') {
    // Schedule against this worker's own paid-call policy/budget window.
    await session.execute({ signal: shutdownSignal });
  }
  // Export is an intentional app-owned operation. This must not mutate the
  // sealed report or upload the private configuration/journal wholesale.
  const evidence = session.evidence();
  await publishRedactedEvidenceSidecar(evidence);
  const result = await session.commit();
  const verdict = myQualityPolicy(result.comparison);
  return { evaluation: result.evaluation, verdict };
} finally {
  await session.close();
}
```

The example assumes a sealed report is available; callers receiving an inspection action of `interrupt_new_request` must stop and use the explicit recovery process, not continue into `evidence()` or `execute()`. The runnable starter must show that branch in full. A quality failure does not prevent saving evidence and must not trigger promotion. An app may choose to perform its quality analysis before `commit`, but saving the report should be independent of its quality outcome.

The module never imports an adapter by a request-supplied name, file, module, URL, shell string, or callback reference. `evaluator` is a real object created by installed application code.

## Concrete proposed interface

```ts
type EvaluatorDefinition<TSnapshot, TSettings, TOutput> = {
  datasetRevision: string;
  graderRevision: string;
  runtime: Readonly<Record<string, string>>;
  cases: readonly ComparisonCase<TSnapshot, TSettings>[];
  execute(input: {
    bundle: VerifiedBundle;
    caseId: string;
    repetition: number;
    snapshot: TSnapshot;
    settings: TSettings;
    signal: AbortSignal;
  }): Promise<ExecutionResult<TOutput>>;
  grade(input: {
    output: TOutput;
    caseId: string;
    repetition: number;
    signal: AbortSignal;
  }): Promise<GradeResult>;
  execution?: { concurrency?: number; gradeRetries?: number };
};

interface Evaluator<TSnapshot, TSettings, TOutput> {
  describe(): EvaluationDescriptor;
  // Opaque branded implementation; no public mutable callbacks/cases.
}

type EvaluatorConfiguration = {
  schemaVersion: 1;
  serviceUrl: string;
  projectId: string;
  evaluatorPrincipalId: string;
  evaluatorToken: string;
  journalRoot: string;
};

type EvaluationHandoff = {
  schemaVersion: 1;
  serviceUrl: string;
  projectId: string;
  bundleId: string;
  requestId: string;
  configuration: EvaluationDescriptor;
};

type SessionInspection = {
  requestId: string;
  attemptId: string | null;
  phase: 'ready' | 'executing' | 'sealed' | 'submitted' | 'finished' | 'uncertain';
  nextAction: 'execute' | 'commit' | 'none' | 'interrupt_new_request';
  // Counts are local observations, not service liveness or execution attestation.
  observedOutcomes: number;
  expectedOutcomes: number;
};

interface EvaluationSession {
  inspect(): SessionInspection;
  execute(options?: { signal?: AbortSignal }): Promise<void>;
  evidence(): SealedEvidence;
  commit(): Promise<{ evaluation: Evaluation; comparison: Comparison }>;
  close(): Promise<void>;
}

declare function defineEvaluator<S, T, O>(
  definition: EvaluatorDefinition<S, T, O>,
): Evaluator<S, T, O>;

declare function readEvaluatorConfiguration(
  filename: string,
): Promise<EvaluatorConfiguration>;

declare function openEvaluation<S, T, O>(options: {
  configuration: EvaluatorConfiguration;
  handoff: EvaluationHandoff;
  evaluator: Evaluator<S, T, O>;
}): Promise<EvaluationSession>;
```

`SealedEvidence` contains a deep-cloned `ComparisonRequest`, a manifest of locally retained output artifact IDs/digests and case/version associations, and an explicit completeness description. It contains no credentials. It is private application data and must never be automatically logged or assumed publishable. A separate artifact export design must decide redaction, destinations and share authorization. Local paths, if required for authorized reading, remain in an explicitly private object rather than diagnostics or console JSON.

Use three entry-point exports, with methods carrying the explicit worker protocol. No session constructor or journal implementation becomes public. The ordinary SDK import remains free of filesystem/process initialization; importing the evaluation subpath is also side-effect-free until a function is called.

## Interface invariants and ordering

1. `defineEvaluator` synchronously clones and freezes the descriptor inputs and case inventory, derives `expectedCases` once, rejects duplicate/empty IDs and more than 1,000 pairs, and captures callbacks. The caller never separately types the expanded inventory. `describe()` returns a defensive clone.
2. Cases/settings must satisfy the comparison helper's cloneability contract. The starter should use JSON-compatible private cases for Python interoperability, but this alternative does not silently narrow existing lower-level `compare` to JSON.
3. `runtime.configId` and `runtime.configRevision` remain required public identity fields. Execution settings affecting outcomes, including concurrency and grader-retry count, are normalized into reserved public runtime keys before descriptor generation. Apps cannot override conflicting reserved keys. The exact reserved names must be settled once by the integrator.
4. `openEvaluation` validates the explicit configuration and handoff before I/O. The handoff's service/project must match the configured trusted target. It constructs its own SDK client from that configuration; it does not accept an unrelated client whose real endpoint could differ from the journal scope.
5. `openEvaluation` performs read-only remote request lookup, structural descriptor agreement, and immutable version verification; it may create private directories and acquire a local lock, but it does not claim/start an attempt or invoke callbacks. A read-only preflight cannot prove all write privileges. Report that write authority is unverified until the start operation confirms it.
6. The current server request is authoritative. A handoff mismatch is rejected even if its private configuration is structurally valid. URLs, IDs, parentage, digests and descriptor fields remain bound to the frozen request.
7. `execute` saves an attempt ID and exact lifecycle keys, reconciles/claims the same server attempt, then durably saves the execution marker before the first callback. At most one execution operation is active per session; duplicate concurrent calls fail with `session.busy` before further work.
8. `execute` owns both versions' callbacks and report construction. There is no public `start`, `markExecuted`, `appendOutcome`, `seal(report)`, or `submit(report)` method. Such methods would push integrity constraints back onto every caller.
9. Once a complete local report object exists, save its exact serialized bytes and operation keys durably before exposing `evidence()` or allowing `commit`. Report mutation after this point is forbidden, including changing output references after an upload.
10. `commit` submits the sealed bytes, reconciles a lost response using the original idempotency key and service state, records the confirmed comparison ID, then finishes the exact attempt. It invokes no execution/grading callbacks. A repeated `commit` returns the same confirmed result after rechecking access/binding.
11. A completed or failed remote request is a terminal fact, but it is not proof that an arbitrary local report belongs to it. Verify principal/attempt/comparison/version/config identity before returning terminal evidence. If no matching local report remains, terminal metadata is readable but `evidence()` reports `evidence.local_missing`; fetch the bound comparison for `commit`'s terminal return and never reconstruct outputs or execute anew.
12. A service interruption during execution prevents successful submission/finish. Local artifacts may still be retained, but do not relabel the interrupted request as completed. Recovery remains explicit.

## Local durable state and recovery

| Local state | Remote state | Allowed action |
| --- | --- | --- |
| No journal | requested | Read/preflight; `execute` may create one attempt and claim it |
| Saved attempt, no execution marker | requested/running with same owner/attempt | Reconcile/start with same key, then execute |
| Execution marker, no sealed report after process loss | any nonterminal state | `uncertain`; no execution or commit; retain files and explicitly interrupt/create a request |
| Sealed report, no confirmed comparison ID | running, same owner/attempt | Commit exact report with original key; no callbacks |
| Confirmed comparison ID, finish unconfirmed | running | Repeat finish with original key |
| Sealed and finished | completed/failed, exact binding | Return saved terminal evidence; no callbacks |
| Original root/target/principal differs | any | Reject; restore original supported configuration or investigate |
| Remote interrupted | interrupted | Retain artifacts; no execute/commit; explicit new request |
| Local state conflicts with terminal remote binding | completed/failed | Reject identity conflict; never overwrite or adopt another attempt |

The phase enum is the public interpretation of internal facts, not a replacement server lifecycle. `sealed` can contain infrastructure/grading failures; complete local serialization does not mean complete evaluation evidence or passing quality.

Retain v1 journal location hashing and exact scope normalization for existing requests. Do not reorder serialized scope fields or normalize an old service URL during migration: either change would point to a different journal identity. New connection validation can require canonical URLs for new requests, but recovery must use a precisely recognized legacy representation. Add a versioned migration reader only if storage layout must change; it must first validate and lock the original path, then write a separately versioned format atomically without changing attempt or operation keys. Never silently scan old directories, relocate unfinished state, or use a new human identity.

Per-outcome checkpoint/resume is explicitly deferred. The initial design preserves current conservative recovery. Recorded output files support human investigation but do not establish a complete saved grade or authorize replay.

## Cancellation, concurrency and lifetime

- Concurrency defaults to 1 and remains bounded at 64 active callbacks across execution and grading, matching the current helper. Grade retries default to 0 and remain bounded at 3; they regrade cloned saved output without executing again.
- `execute`'s signal stops scheduling new callbacks and is passed into started callbacks. The module awaits started work settling before sealing the resulting incomplete report. Unscheduled outcomes remain explicit infrastructure/missing results, never fabricated zero rewards.
- Aborting a signal is cooperative. A callback that ignores it can keep the worker active; no timeout can truthfully claim that remote work stopped. Document that strict isolation/termination is application-owned. Killing the evaluator process leaves uncertain execution, not an automatically retryable attempt.
- `close` releases the lock and secrets only when no execution/commit operation is active. Calling it while active fails with `session.busy`; it does not drop ownership while callbacks are still working. The normal `finally` runs after awaited operations settle.
- Unexpected lock-helper exit marks ownership lost, stops new callbacks and propagates cancellation to active callbacks. No report submission occurs after ownership loss. The process can wait for its own callbacks to settle, but cannot claim remote execution ended. Durable markers continue to forbid another process replaying them.
- Methods after a successful close reject with `session.closed`. A caller must reopen explicitly and pass the original configuration to reconcile.

## Diagnostics and retries

Use an `EvaluationError` with a stable safe code, phase, request ID when validated, optional safe HTTP status/service code/correlation ID, `executionMayHaveStarted`, and `nextAction` enum. Do not print raw error causes, arbitrary runtime keys, full server messages, credentials, private paths, case IDs, or descriptor values by default.

Descriptor mismatch diagnostics identify only predefined field categories such as `datasetRevision`, `graderRevision`, `runtime.configId`, `runtime.other`, and `expectedCases`, plus counts. Unknown runtime key names and case IDs can themselves contain private text. A private app debugger may inspect both explicit public descriptors in memory; CLI output should remain bounded and redacted.

Suggested stable codes include `config.schema`, `config.permissions`, `handoff.target_mismatch`, `descriptor.mismatch`, `auth.denied`, `resource.not_found`, `transport.uncertain`, `journal.busy`, `journal.identity_mismatch`, `execution.uncertain`, `session.busy`, `session.closed`, and `evidence.local_missing`. Retry metadata directs the operator to `retry_same_configuration`, `fix_configuration`, `restore_original_journal`, `interrupt_new_request`, or `inspect_terminal_binding`; it never authorizes a fresh attempt ID under an already running request.

The library does not own CI exit codes. The installed-app CLI maps returned `failed`/`interrupted` states to execution failure, and separately runs an explicit policy checker against comparison evidence. `completed` alone is not a quality pass; neither command promotes a channel.

## Dependency strategy, depth and locality

- In-process: descriptor normalization, fixed inventory expansion, paired result validation, phase derivation, error categories. Test through the evaluator/session interface.
- Local-substitutable: private filesystem, atomic writes, kernel locks and child-lock-helper lifetime. Implementation details stay behind the seam. Use real private temporary directories and independent child processes in contract tests; an in-memory filesystem cannot qualify OS ownership behavior.
- Remote but owned: existing `AcclimateClient` internal transport adapter. Use deterministic fake transport for failure schedules and disposable real service tests for actual permission/idempotency/row-lock binding. Do not expose a giant fake service port solely for testing.
- True external: installed execution/grading callbacks supplied by the app. Tests use deterministic callbacks, counters, fake usage and injected failures. Live harness runs remain explicit, separately reported qualification.

Deleting this module would spread journal keys, markers, replay rules and finish reconciliation across every worker; that is the depth it earns. Its extra phase concepts buy scheduling control, while execution integrity remains local to one implementation.

## Implementation scope and compatibility

1. Add `packages/sdk/src/evaluation.ts` as the installed entry point and `packages/sdk/src/evaluation/` internal modules for definition/session/journal/config/error behavior. Move reusable private-state routines into SDK internals and let scripts import supported internal wrappers where appropriate; do not ship a compiled dependency on repository `scripts/`.
2. Add `./evaluation` to SDK package exports and declaration output. Keep default SDK delivery imports unchanged. Document the current evaluator prerequisite: POSIX plus Python 3 with `fcntl`; Windows is explicitly unsupported for this first durable implementation. Do not claim packaging alone removes that dependency.
3. Replace `examples/evaluation/runner.ts` with a compatibility wrapper calling the session implementation. Retain all current fixed-descriptor fixtures and CLI adapter allowlist behavior until examples switch to the new starter. An explicit deprecation period avoids breaking unfinished requests or downstream copied examples.
4. Move the public descriptor type into a browser-safe SDK types module. The console must not import Node evaluator code; browser-safe exports contain no config reader, fs, child process, or credential types that are instantiated at import.
5. Update `scripts/evaluate-app.ts` to use the supported module and safe error serializer. A custom external app imports its installed evaluator object itself; there is no new generic `--adapter-module` loader.
6. Extend packaging verification with an external app that installs only SDK tarballs, runs a deterministic request and deliberately loses start/submit/finish responses. Inspect compiled imports for repository-private paths.
7. Add an installed app example with explicit CLI commands `describe`, `preflight`, `run`, and `check`. The CLI is app-owned source, not a request-selected executable. Preflight reports what it checked and leaves write authority unknown until mutation confirmation; it does not consume a request.

No Rust wire change is needed for the core session. A future heartbeat observation protocol, durable artifact store, or richer metrics are separate changes and must not be smuggled into the initial evaluator extraction.

## Acceptance gates

1. Installed external app: define one task/execute/grade adapter, derive its descriptor, consume a handoff, execute parent/candidate and view the bound comparison without repository imports.
2. Failed preflight: wrong target, mismatched configuration, private-path errors and missing runtime prerequisites invoke zero callbacks and do not start the request.
3. Lost responses: start, comparison submission and finish response loss all reconcile under original keys; callback counts prove no rerun.
4. Crash boundary: termination after the durable marker and before a sealed report makes the next session uncertain and rejects execute/commit. Retained output does not change that rule.
5. Ownership: two processes cannot execute the same journal; lock-helper loss prevents further scheduling/submission and does not claim external cancellation succeeded.
6. Worker orchestration: an app can seal results, intentionally publish a redacted sidecar and commit later, with identical report bytes before and after publication.
7. Cancellation: incomplete outcomes remain explicit; grade retries do not increase execution calls; active callbacks are awaited and cleanup does not remove files they still use.
8. Terminal semantics: a complete losing candidate is saved as completed; incomplete evidence is saved as failed; neither becomes an automatic release or quality pass.
9. Migration: original v1 journal scope/root/keys recover through the supported module; relocated or changed-principal journals are refused with actionable safe categories.
10. Redaction/packaging: diagnostics contain no token, raw callback error, private filename or unknown runtime text; browser imports remain Node-free; tarball consumers need no checkout files.

## Alternatives rejected

- Exposing raw claim/start/append/seal/submit operations: moves protocol integrity and ordering into each app, reducing depth.
- A public pluggable journal store in v1: distributed object storage needs different ownership and consistency guarantees; one filesystem implementation does not justify an external storage seam.
- Arbitrary worker/module/path selection from handoff: turns public intent into code execution and violates installed-app ownership.
- Uploading traces then mutating an already saved report: breaks exact replay and historical evidence binding. Use a separately versioned sidecar locator/manifest.
- Automatic resume from individual output files: a saved output is not proof that grading and all external effects completed.
- Treating signal abortion or heartbeat expiry as stopped execution: unsupported for remote callbacks.
- Making all apps use this session: the low-level comparison helper remains valid for apps intentionally managing their own protocol; the first-value starter should prefer the selected council interface.

## Integration decisions required

1. Choose session flexibility or the minimal runner as the first public story; do not require novice users to learn both.
2. Reserve exact public runtime key names for concurrency and grader retry identity, including compatibility rules for existing descriptors.
3. Agree on a private `SealedEvidence` manifest and external redacted sidecar mapping without mutating the report.
4. Decide whether v1 journal compatibility is in-place read/write preservation or a narrowly specified explicit migration; preservation is lower risk.
5. Decide the installed-app CLI verdict envelope/exit codes once across TypeScript/Python/CI workstreams.
6. Keep preflight honest: current read-only routes cannot prove every write privilege. Add a separately reviewed capability endpoint only if the integrated operator design requires a fully verified permissions preflight.
