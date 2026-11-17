# Python evaluator design proposal

First design council, 2026-11-16. This is a proposed interface and implementation plan, not an implemented or qualified capability. It addresses the [Python critique](../../../research/developer-experience-review/python-integrator.md) under the [council constraints](../brief.md).

## Decision

Ship Python-owned paired execution and durable request orchestration in the existing `acclimate-sdk` wheel, with no Node dependency and no third-party runtime dependency. Use the same conceptual interface as the selected TypeScript evaluator design, with Python names and synchronous callbacks. Keep platform-specific journal implementation private. Parity means the same observable evidence/recovery guarantees, not interchangeable unfinished journals.

The proposed public seam has three functions: `define_evaluation`, `check_evaluation`, and `run_evaluation`. They live in `acclimate.evaluation`; wire DTOs remain in `acclimate.types`. The coordinator should align these names with the selected TypeScript design rather than shipping a competing abstraction. Do not add an application plugin discovery mechanism or a shared service-side executor.

The module hides frozen inventory, paired input isolation, verified bundle resolution, identity comparison, lock ownership, durable attempt markers, exact submission bodies, report replay, and finish reconciliation. Its interface includes the supported platform, journal ownership, callback lifetime, failure taxonomy, and retry rules below.

## Current source constraints

- `python/acclimate/client.py:338` already exposes evaluation create/read/list/start/finish/interrupt methods; `:260` submits a comparison. These methods can remain backward compatible while gaining types.
- `python/acclimate/types.py:122` supplies `ComparisonRequest`; it does not yet define evaluation lifecycle DTOs. `py.typed` is already shipped (`python/pyproject.toml:14`).
- TypeScript `compare` freezes the case inventory, clones paired inputs, classifies execution versus grading failures, and retains a report row for every expected pair (`packages/sdk/src/compare.ts:130`). The Python high-level module must provide those guarantees, not ask its caller to recreate them.
- The installed runner records an execution marker before callbacks, saves the complete report before submission, and refuses replay if execution began without a saved report (`examples/evaluation/runner.ts:98`, `:116`, `:131`).
- Current journals bind exact service/project/bundle/request/principal and original absolute root, and use `fcntl.flock` on `ownership.lock` (`examples/evaluation/journal.ts:10`, `:31`, `:100`). Existing unfinished TypeScript attempts must not be adopted by guessing their serialization or ownership.
- Python's transport serializes a body once per `_request` call, but loading a report and calling it again serializes anew (`python/acclimate/client.py:85`). The new Python runner must durably retain the actual request-body bytes it submits.

## Caller interface

Illustrative spelling, to align with the chosen common TypeScript interface during integration:

```python
from pathlib import Path
from acclimate.evaluation import (
    Case, ExecutionResult, GradeResult,
    define_evaluation, check_evaluation, run_evaluation,
)

def execute(run):
    # This callback is app-owned. It can call the team's existing agent here.
    # The deterministic first task simply consumes the verified instruction.
    instructions = "\n".join(
        file["text"] for file in run.bundle["payload"]["files"]
        if file["kind"] == "instruction"
    )
    return ExecutionResult(output={"used_required_rule": "keep receipts" in instructions})

def grade(run):
    return GradeResult(reward=float(run.output["used_required_rule"]))

app = define_evaluation(
    dataset_revision="receipt-tasks-1",
    grader_revision="receipt-rubric-1",
    runtime={
        "configId": "receipt-agent", "configRevision": "1",
        "app": "receipt-agent", "model": "none", "writes": "disabled",
    },
    cases=[Case(case_id="receipt-rule", snapshot={"task": "save a receipt"}, settings={})],
    execute=execute,
    grade=grade,
)

# Export this PUBLIC descriptor for the console, without case bodies or credentials.
public_configuration = app.descriptor

# The application supplies the private evaluator config explicitly; no default discovery.
check = check_evaluation(app=app, handoff=public_handoff, config_path=private_config_path)
if not check.can_run:
    raise SystemExit(check.code)
result = run_evaluation(app=app, handoff=public_handoff, config_path=private_config_path)
print(result.request_id, result.status, result.comparison_id)
```

This first task is deliberately a contract fixture, labeled as such. The adjacent real-agent recipe replaces `execute`, passes prepared instructions/resources into the app's actual agent, waits for completion, and collects its output before cleanup. Its grader evaluates task behavior, not text presence. A recipe must never imply this fixture proves native quality.

`public_handoff` is a parsed/validated public object or explicitly supplied file with schema version, service URL, project, bundle, request, and frozen descriptor. Reading it never chooses a Python module, executable, endpoint to fetch code from, credential source, or filesystem journal root. App source imports its own definition.

### Types

- `Case[Snapshot, Settings]`: frozen dataclass with `case_id: str`, `snapshot`, `settings`, and `repetitions: int = 1`. The definition snapshots their values immediately; a frozen dataclass alone does not recursively freeze a caller's list/dictionary.
- `ExecuteInput[Snapshot, Settings]`: verified bundle, case identity/repetition, private clone of snapshot/settings, cooperative cancellation context. The same immutable version identity is available for app logging; it is not a model-consumption attestation.
- `GradeInput[Output]`: private cloned output and case identity/repetition. It may expose the same explicit version context as the final TypeScript interface; the SDK makes no blinded-grading claim. Apps retain private rubric/expected answers in installed code or fixtures.
- `ExecutionResult[Output]`: output; execution status `completed | task_failed` (default completed); optional intentionally public error label and usage. Escaped exceptions are classified by the runner, not treated as arbitrary public messages.
- `GradeResult`: finite reward and optional intentionally public error label. A scored task failure is allowed. Missing grades remain `None`, not zero.
- `EvaluationDefinition`: immutable captured definition and descriptor value. `expectedCases` is derived from the cases/repetition counts, never independently handwritten by the caller. Returning the descriptor returns a copy; mutating it does not change a defined evaluation.
- `EvaluationCheck`: safe findings with code, phase, and `can_run`; records checks as `verified`, `unverified`, or `failed` rather than treating a successful read as proof of write authority or installed model readiness.
- `EvaluationResult`: request ID, attempt ID if known, status, comparison ID if known, evidence completeness, and safe recovery classification. No quality-pass or release decision is inferred from status.
- `EvaluationError`: stable code/phase, bounded mismatch field paths or inventories as allowed by the common redaction policy, optional safe service correlation ID, and next action. Original file paths, private JSON, raw provider messages and tokens do not appear in its string/repr or CLI output.

Add `EvaluationRequest`, `Evaluation`, `StartEvaluationRequest`, `FinishEvaluationRequest`, `InterruptEvaluationRequest`, and page DTOs with camelCase wire keys and `Literal` statuses in `acclimate.types`. Annotate all existing lifecycle methods without changing their call signatures. Add draft/integration DTO coverage in a follow-up or the same release if required by packaging; it is not a prerequisite for completing the Python eval path.

## Frozen inputs and comparison behavior

1. Validate and capture the complete definition before the first network call. Reject duplicate/empty case IDs, bool-as-integer repetitions, repetitions outside 1–1000, more than 1000 total pairs, invalid descriptor fields, and non-finite numbers.
2. The new high-level interface accepts a documented portable JSON value subset for snapshots/settings/output: null, booleans, finite IEEE-754 numbers, strings without unpaired surrogates, arrays, and string-keyed objects. Reject cycles, arbitrary Python objects, non-string dictionary keys, and integral values outside the exact shared integer range of JavaScript (`±(2**53-1)`). Private Python callers can hold non-JSON context in closures; it does not enter serialized paired inputs.
3. Derive inventory in case declaration order then increasing zero-based repetition. Matching a request compares descriptor runtime keys structurally and case identities as a set with unique membership, retaining local execution order. Do not establish a new generic cross-language canonical-hashing protocol.
4. Snapshot case values through validated JSON encoding/decoding at definition creation. Prepare independent copies for every side/repetition and every grade attempt. Never share a mutable snapshot, settings object, or output between callbacks.
5. Resolve the exact parent and candidate through existing verified delivery helpers, validate all four version/digest bindings, same bundle, and direct parentage before marking execution started. Cached transport fallback is not enabled implicitly.
6. Initial high-level runners execute serially with no execution retry and no grader retry. That matches the stock durable runner's conservative settings, simplifies Python async/side-effect behavior, and makes initial parity achievable. A later concurrency option must define the same callback-bound semantics in both languages; do not silently expose Python-only parallel behavior. Low-level TypeScript compare remains backward compatible.
7. A normal callback result may indicate `task_failed` and still be graded. A `TaskExecutionError` without gradeable output produces task failure/missing grade. Any other escaped callback exception produces infrastructure failure/missing grade. Invalid output serialization gives grading failure or execution-artifact failure according to the shared fixture contract; invalid/non-finite grades give grading failure. Invalid usage becomes unknown according to the current comparison helper's policy. Default public errors are safe labels; detailed application diagnostics remain app-controlled/private.
8. Complete the full declared inventory, recording failed/missing outcomes rather than silently excluding cases. Cancellation records unstarted outcomes as infrastructure failure/missing, not as an omitted successful task. Preserve fixed paired case coverage and service validation.

## Durable state and exact replay

Use a Python-private implementation in `acclimate/_evaluation_journal.py`. No journal adapter is exposed initially: only one storage model is supported, and exposing storage internals would ask every caller to learn the recovery protocol again.

### Shared exclusion, separate ownership formats

Agree with the minimal evaluator designer on the following cross-language contract:

- Scope serialization uses exactly the ordered fields `serviceUrl`, `projectId`, `bundleId`, `requestId`, `evaluatorPrincipalId`, compact JSON UTF-8, no whitespace/ASCII-only escaping, and valid Unicode strings. Preserve the exact configured URL and IDs; do not normalize paths, rewrite URL spellings, or introduce NFC normalization.
- Hash those bytes with SHA-256 to select the same scope directory as current TypeScript journals. This ordering must have a checked-in fixture containing non-ASCII IDs/escaped characters as well as ordinary UUIDs. Python uses `ensure_ascii=False` and fixed insertion order; the fixture is authoritative.
- Both implementations acquire a nonblocking exclusive `fcntl.flock` on the same `ownership.lock` inode before inspecting or modifying attempt state. POSIX ownership/0600/0700/no-symlink checks apply. Never unlink the lock while it is in use, infer ownership from a PID, or regard file presence as execution proof.
- Keep current TypeScript `attempt.json` schema 1 unchanged. Python writes `attempt.python.json` with an explicit `format: "acclimate-python-evaluation-1"`. Before state mutation or callback execution, Python refuses an existing TypeScript attempt; the new TypeScript runner similarly refuses an existing Python attempt. Both refuse if both files exist, with a safe foreign/ambiguous-journal error.
- Python-to-TypeScript and TypeScript-to-Python takeover of an unfinished request is unsupported. Status can be inspected with raw read methods. Recovery must use the originating supported runtime, same principal, exact scope, and original absolute root. Changing language requires resolving/interruption of the old request and a new request; deleting or moving its journal is not a migration procedure.
- Foreign-format refusal is checked under the shared lock even if the service still says requested: a lost start response can otherwise make two runtime-specific journals diverge. Independent requests/principals do not share an attempt; existing service checks reject an ownership mismatch.

### Python journal fields

The private JSON envelope stores format, original absolute journal root, exact scope, frozen request/version descriptor, attempt ID, idempotency keys, execution marker, comparison ID, completion marker, and references to fixed-name private request-body files. Bodies are stored as exact UTF-8 bytes, each with length and SHA-256. Fixed allowlisted filenames prevent a journal from directing arbitrary file reads; request targets are reconstructed from the validated scope and known lifecycle operation, not read as arbitrary URLs.

State writes use exclusive owner-only temporary files in the same directory, flush + `fsync`, atomic replace, and parent-directory `fsync`, with no symlink ancestors/targets. Read sizes are bounded. Request-body files are individually bounded by the service's 2 MiB request limit; the envelope has a smaller documented cap independent of case output artifacts. Do not duplicate a 2 MiB body as base64 inside a 4 MiB envelope. Persist a body before publishing its reference in the envelope. An unreferenced body after a crash is not sufficient evidence to resume execution or submit a guessed report.

Use a private encoded-body path inside the existing HTTP client implementation: the runner validates and prepares a lifecycle mutation once, persists the exact bytes and key, and passes those same bytes on every retry/recovery. The internal transport accepts only known typed lifecycle operations from the runner. It adds credentials at send time; credentials never enter the journal. Public raw/low-level client signatures remain unchanged, and no public arbitrary raw POST entry point is introduced.

### Lifecycle transitions

| Durable/local state and service observation | Action |
| --- | --- |
| No attempt, service requested | Capture definition/request, generate attempt/operation keys, persist start body and journal; start request |
| Saved start body, start response lost | GET request; if still requested retry exact start bytes/key; if running verify exact attempt/principal |
| Running, no execution marker | Verify bundles/bindings; fsync execution marker before first callback |
| Execution marker, no referenced complete report body | Refuse execution and submission; inspect/interrupt and create a new request |
| Referenced complete report body, no comparison confirmation | Validate report binding; submit exact saved body/key without callbacks |
| Comparison confirmed, finish response lost | Retry exact saved finish body/key or verify matching terminal service state |
| Matching completed/failed request | Return observed terminal state; do not execute or treat a failed report as a quality pass |
| Interrupted request or mismatched attempt/principal/comparison | Refuse mutation/execution, return actionable safe error |
| Unknown/foreign/corrupt/relocated journal | Refuse; no recovery by deleting the marker, changing principal, or copying state |

The complete report must be durably referenced before submission. If report serialization or saving fails after execution, leave the marker and refuse future reexecution. Outputs can be saved per case for diagnosis, but are not resumable callback checkpoints. Artifact export can select safe data through the separate evidence design; private journals are never a default share bundle.

## Sync, async, cancellation, and lifetime

Python 3.11+ and POSIX are explicit support requirements. The evaluator module uses native `fcntl`; it does not shell out or depend on the TypeScript lock helper. The rest of the wheel's transport-only functions retain their existing platform scope. The module is importable on unsupported platforms, but attempting filesystem eval checks/runs raises a safe platform error.

Initial callbacks and runner are synchronous. Async applications put the entire run, including prepare/execute/result capture/cleanup, in one worker thread via `asyncio.to_thread`, rather than offloading only a fetch and then letting cleanup race a background execution. Async model clients can be driven by an app-owned worker adapter; the SDK does not call `asyncio.run` inside a running event loop.

An optional `threading.Event` cancellation signal is checked between callbacks and supplied through the execution context. Request cancellation stops scheduling new callbacks; an already active callback must cooperate. A callback that ignores cancellation may continue indefinitely, retain its files, and hold the lock. Document model/process timeout configuration as an app responsibility; the SDK cannot force-stop arbitrary Python callbacks or establish that an external effect did not occur.

If the async await is cancelled, cancelling the thread is not implied. The documented recipe retains/observes the worker task until actual completion (including application-shutdown coordination), signals cooperative cancellation, and does not release prepared files or start another attempt early. Hard process termination leaves the durable marker; it requires the refusal/interrupt-new-request path above. Do not add an automatic timeout that declares an active side-effecting callback stopped.

No service heartbeat is used to authorize recovery. Optional future progress reporting is best effort and distinct from ownership and evidence completion.

## Preflight and diagnostics

`check_evaluation` performs definition validation, explicit private-config parsing, handoff service/project agreement, supported platform/private storage checks, descriptor diffing, request read/binding checks, and exact version readability/digest verification. It invokes no app callbacks and makes no service mutation. It can create/lock an owner-only local scope directory while inspecting storage; this is disclosed local setup, not evaluation start.

The current service has no read-only endpoint that proves future start/submit write authorization. Initially return that capability as `unverified` until the platform design adds an actual check; GET success must not become a green write-permission claim. A run always revalidates under lock and verifies successful start ownership before callbacks. Preflight is a point-in-time check, not a reservation.

Share stable safe errors with TypeScript: definition invalid, handoff mismatch, descriptor mismatch (field paths), unsafe local config, unsupported platform, busy, foreign journal, relocated journal, ambiguous execution, denied, missing resource, transport uncertain, and report/attempt mismatch. Redact raw `ApiError` text/details and private filesystem exceptions. Reuse bounded HTTP status/code/request ID only under the common explicit allowlist. Detailed callback output/errors remain private by default and require deliberate evidence export.

## Packaging and compatibility

- Add `acclimate/evaluation.py`, `acclimate/_evaluation_journal.py`, and internal transport/file support; explicit imports avoid putting runner setup into generic delivery imports.
- Keep `acclimate-sdk` package/wheel and Python >=3.11; retain zero third-party runtime dependencies. Type checking tools are development dependencies only.
- Link exact wheel artifact names/checksums from the release manifest. Python README offers obtaining the release artifact and a source-build command, without promising registry publication.
- Add an external installed-wheel example that imports only `acclimate` exports and uses a deterministic app callback. No `PYTHONPATH` or source-relative imports in the acceptance consumer.
- Existing low-level Python client methods remain available. Type annotations are additive; accepted requests continue using camelCase wire keys.
- Legacy TypeScript journals remain with their original runner. No automatic journal migration, service-side wire schema change, new quality interpretation, credential privilege expansion, or implicit paid execution is required by this Python scope.

## Implementation map and acceptance gates

1. **Wire contracts:** add evaluation DTOs in `python/acclimate/types.py`, annotate the six lifecycle methods and listing in `client.py`; cross-check frozen TypeScript/Rust fixtures. Strict type-check fixture rejects snake_case wire keys, missing finish fields and unsupported statuses.
2. **Definition/comparison module:** implement frozen JSON-safe definitions, derived inventory, serial paired callbacks and classified results. Pure tests verify mutation isolation per side/repetition/grade, identical repeated input, finite grades, task versus infrastructure failures, missing usage, aborted unstarted cases, and inventory bounds/bool rejection.
3. **Private persistence/client send path:** implement shared scope fixture and `flock`, format rejection, atomic envelope/body persistence and exact encoded-body submission. Fault injection proves no callback before durable marker, no callback after uncertain execution, and exact replay bytes/keys after process-level response loss.
4. **Cross-language exclusion:** subprocess tests on each supported OS run TS-versus-Python contenders against one scope. Exactly one acquires ownership; a later opposite-runtime invocation refuses a foreign-format attempt even when service state is requested. Both languages reject relocated roots and corrupt/both-format states. Fixtures are shared; tests exercise public entry points rather than internal write ordering alone.
5. **Service conformance:** deterministic local HTTP fixtures verify create/read/start/submit/finish behavior and wire types; a disposable real-service acceptance creates a two-case parent/candidate request and inspects bound evidence. Preserve denial checks, direct-parent binding, exact request/attempt identity, failed partial evidence and completed losing candidates.
6. **External wheel gate:** install only the produced wheel in a clean Python 3.11+ environment, no Node available. Execute deterministic callbacks, inspect a saved comparison, simulate lost report/finish responses, and verify no repeated callbacks. Run the same semantic scenario vectors against TypeScript. Do not compare raw JSON serialization bytes across languages.
7. **Async recipe gate:** delay a fake callback/transport while a second coroutine makes progress; cancel the await and demonstrate that the worker remains active until it actually stops, owns its files/lock throughout, and leaves no false completion. Explicit cleanup remains within the worker lifetime.
8. **Docs/CLI gate:** Python-first instructions explain wheel acquisition, private config, public descriptor, app wiring, recovery decision table and optional explicit promotion separately. If an app-owned Python CLI is supplied, it uses the common CI exit contract; runner completion alone never promises quality or release approval.

## Alternatives rejected and follow-up scope

- **Only raw endpoints plus a recipe:** leaves the recovery and pairing protocol duplicated in every app; it does not address the major Python critique.
- **Invoke a Node sidecar:** simpler reuse but fails a Python-only installed consumer and increases operational prerequisites. Optional interoperability recipes can remain, but are not Python parity.
- **Automatic cross-language journal adoption:** adds a new byte-level mutation/migration protocol without improving the first supported Python workflow. Shared exclusion and explicit refusal deliver the needed safety at smaller scope.
- **Public arbitrary journal/store adapters:** defers correctness to callers and expands the interface before a second supported storage implementation exists.
- **First-release parallel async callbacks:** introduces scheduling/cancellation semantics that are unnecessary to prove first-value parity. Serial synchronous execution is explicit, and app-owned external timeouts remain necessary.
- **Transparent framework attachment:** the application owns tools, context/memory policy and its loop. Provide concrete recipes, not guessed framework options.

Deferred features are resumable per-case execution, distributed workers/storage, full cross-language attempt takeover, native async transport/runner, multi-metric statistics and automatic artifact-store integration. These must not be implied by the first-release interface.

## Integration decisions for the coordinator

1. Align the three Python names and definition/result types with the selected evaluator design; retain descriptor generation and run/check behavior, not two parallel Python abstractions.
2. Freeze the scope serialization fixture and foreign-journal rejection in the TypeScript extraction as well as Python. The minimal evaluator designer has agreed to the shared-lock/separate-format stance.
3. Require internal encoded-body replay for new Python journals. A parsed dictionary plus a fresh idempotency key is not an equivalent recovery guarantee.
4. Define the common safe-error vocabulary, CI exit contract, high-level JSON subset and initial serial execution stance once. TypeScript's existing low-level compare interface need not become narrower.
5. Decide whether preflight write authority remains explicitly unverified initially or is backed by a new read-only platform capability check. Do not let onboarding claim it is checked through an ordinary read.
