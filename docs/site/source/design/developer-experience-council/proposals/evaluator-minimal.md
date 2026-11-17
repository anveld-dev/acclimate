# Alternative A: three-operation installed evaluator module

Design proposal, 2026-11-16. This is a source-grounded design, not implemented behavior or qualification evidence. It addresses the [council brief](../brief.md) and the [TypeScript persona review](../../../research/developer-experience-review/typescript-integrator.md).

## Recommendation

Add the Node-only `@acclimate/sdk/evaluation` subpath with three operations: `defineEvaluation`, `preflightEvaluation`, and `runEvaluation`. Hide attempt claiming, private journals, verification, paired execution, exact submission, and recovery behind that interface. Keep the existing lower-level `compare` and lifecycle client for applications with genuinely different orchestration requirements. Do not ask the first adopter to choose a storage adapter, attempt ID, idempotency keys, comparison submit strategy, or recovery policy.

The module's leverage is its removal of consequential orchestration from every caller. Its locality comes from moving the existing runner and private-state implementation into one installed package rather than copying it into starters. Its seam is application-supplied execution and grading against verified bundles and immutable case inputs.

## Current source and constraints

- The existing export list has `compare` and `submitComparison`, but no durable runner: `packages/sdk/src/index.ts:11`.
- The current adapter takes ordinary cases, execution, grading, and public descriptor: `examples/evaluation/adapter.ts:5`.
- Request identity, execution marker, exact report persistence, and finish checks already exist: `examples/evaluation/runner.ts:50–151`.
- The journal currently imports repository scripts and spawns a Python `fcntl` lock helper: `examples/evaluation/journal.ts:6`, `:31`, `:58`.
- Node package output copies only `packages/sdk/src`: `scripts/build-packages.mjs:7–11`. A packageable extraction must remove imports into `examples` or `scripts`.
- Descriptor normalization is pure and is imported into console source today: `examples/evaluation/adapter.ts:15`, `apps/console/src/lib/evaluation-config.ts:1`.
- The server's terminal state reflects evidence completeness: `src/evaluations.rs:309–317`. A complete losing candidate is a valid completed evaluation.

## Concrete interface

The exact exported names are a design choice. Exported type declarations do not add callable operations.

```ts
import type {
  Comparison, Evaluation, EvaluationDescriptor, VerifiedBundle,
} from '@acclimate/sdk';
import {
  defineEvaluation, preflightEvaluation, runEvaluation,
} from '@acclimate/sdk/evaluation';

type JsonValue = null | boolean | number | string |
  JsonValue[] | { [key: string]: JsonValue };

interface EvaluationDefinition<S extends JsonValue, C extends JsonValue, O extends JsonValue> {
  datasetRevision: string;
  graderRevision: string;
  runtime: Record<string, string>; // Includes public configId/configRevision.
  cases: readonly {
    caseId: string;
    snapshot: S;
    settings: C;
    repetitions?: number; // Default 1; total expanded inventory <= 1000.
  }[];
  execute(input: {
    bundle: VerifiedBundle;
    caseId: string;
    repetition: number;
    snapshot: S;
    settings: C;
    signal: AbortSignal;
  }): Promise<{
    output: O;
    executionStatus?: 'completed' | 'task_failed';
    error?: string | null;
    outputRef?: string | null;
    usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
  }>;
  grade(input: {
    output: O;
    caseId: string;
    repetition: number;
    signal: AbortSignal;
  }): Promise<{ reward: number; error?: string | null }>;
}

interface EvaluationApp<S extends JsonValue, C extends JsonValue, O extends JsonValue> {
  readonly descriptor: Readonly<EvaluationDescriptor>;
  // Opaque module-owned definition; callers cannot replace callbacks after creation.
}

// Private config-file schema, not a required object callers construct in code.
interface EvaluatorConfigFile {
  schemaVersion: 1;
  serviceUrl: string;
  projectId: string;
  evaluatorPrincipalId: string;
  evaluatorToken: string;
  journalRoot: string;
}

interface EvaluationHandoff {
  schemaVersion: 1;
  serviceUrl: string;
  projectId: string;
  bundleId: string;
  requestId: string;
  configuration: EvaluationDescriptor;
}
type RequestSelection =
  | { bundleId: string; requestId: string }
  | { handoff: EvaluationHandoff };

declare function defineEvaluation<S extends JsonValue, C extends JsonValue, O extends JsonValue>(
  definition: EvaluationDefinition<S, C, O>,
): EvaluationApp<S, C, O>;

interface PreflightResult {
  checks: readonly {
    code: string;
    status: 'passed' | 'failed' | 'unknown' | 'not_applicable';
  }[];
  startAuthority: 'confirmed' | 'denied' | 'unknown';
  executionState: 'not_started';
}
declare function preflightEvaluation<S extends JsonValue, C extends JsonValue, O extends JsonValue>(
  options: {
    app: EvaluationApp<S, C, O>;
    configPath: string; // Explicit absolute owner-only config file.
    target: { bundleId: string; requestId?: string } | { handoff: EvaluationHandoff };
  },
): Promise<PreflightResult>;

interface EvaluationRunResult {
  evaluation: Evaluation; // Returned completed/failed status is preserved.
  comparison: Comparison | null;
  executionState: 'finished';
}
declare function runEvaluation<S extends JsonValue, C extends JsonValue, O extends JsonValue>(
  options: {
    app: EvaluationApp<S, C, O>;
    configPath: string; // Parsing and validation stay inside the module.
    request: RequestSelection;
    signal?: AbortSignal;
  },
): Promise<EvaluationRunResult>;
```

`defineEvaluation` validates and snapshots definitions synchronously. It derives `expectedCases` from the cases instead of accepting a second inventory that can drift. It preserves input order for execution and treats inventory as a set for descriptor matching, consistent with the existing adapter. The returned descriptor is deeply frozen ordinary public JSON, suitable for serialization. Module-owned callback references and case snapshots are captured once; the descriptor is not executable and does not serialize callbacks.

The durable module deliberately narrows snapshots/settings/outputs to finite JSON values. Existing lower-level `compare` retains its broader structured-cloneable input contract. The narrower installed runner contract makes persistence and Python parity explicit: no `undefined`, dates, maps, typed arrays, cycles, infinities, custom serializer behavior, or functions. Applications convert such values in their callbacks. A runner output is bounded to 1 MiB encoded UTF-8; a report remains bounded by the service's 2 MiB request cap. Outputs are separate private files rather than embedded wholesale in the attempt journal. Write a full inventory report with infrastructure/grading failure when a callback output is invalid or oversized; never reinterpret that case as a quality zero.

The module initially runs one execution/grading callback at a time and never retries execution callbacks. `gradeRetries` is fixed to zero for the installed runner; advanced users retain lower-level `compare`. Concurrency is not a hidden runtime override: a descriptor declaring a concurrency setting other than `1` is rejected by this runner before execution, and its documentation states the serial contract. This restriction can be broadened later with an explicit descriptor/version change.

## Caller example

```ts
import { readFile } from 'node:fs/promises';
import { defineEvaluation, preflightEvaluation, runEvaluation } from '@acclimate/sdk/evaluation';
import { runExistingAgent } from './agent.js'; // Trusted, app-installed import.

const app = defineEvaluation({
  datasetRevision: 'refund-tasks-3',
  graderRevision: 'exact-action-2',
  runtime: {
    configId: 'refund-agent', configRevision: 'build-127',
    model: 'app-selected-model', concurrency: '1', writes: 'fixture-only',
  },
  cases: [{
    caseId: 'duplicate-refund',
    snapshot: { request: 'Refund order A twice' },
    settings: { expectedAction: 'one-refund' },
    repetitions: 2,
  }],
  execute: async ({ bundle, snapshot, signal }) => ({
    output: await runExistingAgent({ bundle, task: snapshot.request, signal }),
  }),
  grade: async ({ output }) => ({ reward: Number(output.action === 'one-refund') }),
});

// In a separate descriptor command: stdout is public configuration, not credentials.
await writePublicDescriptor(app.descriptor);

// The wrapper reads JSON; it never imports code named by the handoff.
const handoff = JSON.parse(await readFile(selectedHandoffFile, 'utf8'));
const configPath = selectedAbsolutePrivateConfigFile;
const check = await preflightEvaluation({ app, configPath, target: { handoff } });
displaySafeChecks(check);
const result = await runEvaluation({ app, configPath, request: { handoff } });
displayExecutionStatus(result.evaluation.status);
// The separate CI policy module evaluates result.comparison. No release occurs here.
```

`selected*` values come from the application's own argument parser. This is an illustrative integration, not a complete CLI. A shipped starter supplies the parser, public output writer, error presenter, and exact `.mjs` commands, so adopters do not invent those pieces. It can be built to plain JavaScript and run without an implicit `npx` download. Config parsing remains private behind `configPath`; callers do not need an undocumented `readEvaluatorConfig`, an API-client construction step, or a separate credential reader. Requiring a file rather than adding a second in-memory config mode keeps the first interface and its private-file contract smaller. Low-level SDK clients remain available for apps needing a different secret-injection mechanism.

## Preflight and authority

Preflight performs no service mutation and never invokes execution or grading. It checks config schema and explicit trusted URL, project selection, local filesystem permissions/canonical path, lock-helper availability, app definition, service read connectivity, selected request descriptor, and immutable version availability/digests where a request is supplied. It can create and clean a dedicated private probe directory to test filesystem and locking prerequisites; it must not create an attempt, execution marker, or request claim. Before a request exists, request matching is `not_applicable`.

The service currently exposes no nonmutating evaluator write-authority proof. Successful GETs confirm read access only. Therefore the initial implementation returns `startAuthority: 'unknown'` unless the platform design adds an explicit authenticated capability endpoint. A UI or CLI must never turn that unknown into “ready to execute.” `runEvaluation` repeats required checks, then its authorized start operation is the final current authorization check before callbacks. Even a capability endpoint would be a point-in-time observation subject to revocation, not a reservation.

An untrusted handoff cannot redirect credentials: its service URL and project must exactly match the explicitly supplied trusted configuration before any request to the handoff target. The helper never resolves an adapter/module/endpoint from handoff fields. URLs retain existing HTTPS/private-loopback rules. Config values are never read implicitly from environment, old launchers, home directories, or sibling files.

## Error interface

Rejected operations throw a module-generated error carrying a typed, sanitized envelope rather than arbitrary server/provider text:

```ts
interface EvaluationFailure {
  code: 'config.invalid' | 'config.permissions' | 'lock.unavailable' | 'lock.busy'
    | 'request.mismatch' | 'auth.denied' | 'resource.missing'
    | 'transport.unconfirmed' | 'execution.uncertain' | 'journal.foreign'
    | 'journal.invalid' | 'cancelled.before_start';
  phase: 'configure' | 'preflight' | 'claim' | 'verify' | 'execute' | 'submit' | 'finish';
  executionState: 'not_started' | 'may_have_started' | 'report_saved';
  requestId?: string; // Validated server correlation identifier, not raw header text.
  mismatchFields?: readonly string[]; // Fixed schema paths, no runtime values/keys.
  nextAction: 'fix_configuration' | 'retry_same_command'
    | 'inspect_original_worker' | 'interrupt_and_create_request';
}
```

The exact final code inventory should align with the CI/platform proposals, rather than having multiple envelopes. Field differences report allowlisted schema paths and inventory counts, not raw public runtime values: developers sometimes accidentally place secrets in supposedly public settings. Logs do not include error causes, stack traces, private filesystem paths, raw HTTP bodies, arbitrary service messages, or callback output. Detailed private artifacts remain available to the owning application. A returned `failed` evaluation is a normal saved lifecycle result but must yield nonzero process status in the supplied CLI. `completed` does not imply policy satisfaction.

## Durable state and recovery

The new module initially retains the existing protocol and its conservative recovery rules:

1. Obtain exclusive kernel file-lock ownership before reading or writing attempt state. Capture the app definition before the first await.
2. Read the request and compare descriptor, version/digest, attempt, and evaluator principal identities. A terminal matching evaluation can be inspected without callbacks; no prior callback execution is inferred from absence of a process.
3. Save attempt ID and start/submit/finish keys before claiming. Confirm that the server's running attempt belongs to this principal.
4. Verify exact pinned parent/candidate bundles and parentage before any callback. Persist `executionStarted` before the first callback, with fsync/atomic replacement semantics.
5. Persist private outputs as callbacks complete, but do not advertise them as resumable checkpoints. Build and durably save the exact full comparison request before submission.
6. Submit with the same saved key/body, persist comparison ID, finish with the same key/body, and verify returned identities before returning.
7. A running request without its original journal or a marker without a complete report yields `execution.uncertain`. It never reruns. The remedy is inspect the original worker, explicitly interrupt when appropriate, then create a new request. Deleting a journal is not a retry strategy.

Serial callback scheduling is not a claim of exactly-once execution. Process death, external side effects, client cancellation, and server idempotency retention all limit what can be proved. Exact report retries follow the service's actual idempotency retention contract; the design must not imply indefinite response-loss recovery after retention expires without a server guarantee. Old complete report bytes are not reformatted or rebuilt during migration/recovery.

### Cancellation and ownership

An already-aborted signal before claim performs no service mutation. Cancellation while running stops scheduling new callbacks, propagates the signal to active callbacks, and awaits their actual settlement before cleanup/releasing the lock. It records unscheduled work as infrastructure/missing outcomes, saves the resulting incomplete report, and finishes as `failed` when possible. If the process dies before that report is durable, ordinary ambiguous-execution recovery applies. No `Promise.race` may release the lock or delete a prepared directory while an ignored-abort callback is still operating. The application owns callback deadlines and process termination; an uncooperative callback can keep this process waiting. Revoked locks or late service interruption also prevent further callbacks and report mutation where detectable; neither proves an already-running external task stopped.

### Existing journals and cross-language exclusion

Keep TypeScript schema-1 journals readable at their original canonical absolute root, using the exact existing scope values and key identity. Preserve ordering of scope serialization fields: `serviceUrl`, `projectId`, `bundleId`, `requestId`, `evaluatorPrincipalId`. New code must not invent a different directory hash, move/copy unfinished state, silently rotate principal identity, or resubmit a reconstructed report.

Python should use the same scope-hash directory and `ownership.lock` path with the same POSIX flock semantics, but a distinguishable Python-owned journal format. Both implementations must refuse foreign journals rather than take over another language's attempt. Cross-language conformance means equivalent wire semantics, mutual exclusion, and safe recovery outcomes; it does not require byte-identical language serialization or cross-language replay. This choice was discussed with the Python design lane.

Legacy journals without a recorded root remain resumable only through the documented explicit selection of their known original path. The first successful write adds the root as today. Do not scan old state to discover or auto-migrate it.

## Packaging and dependency strategy

Choose a SDK subpath over a separate runner package for the first release. The runner relies closely on SDK wire types, validation, verified delivery, and comparison semantics; shipping them together reduces version coordination. Node-only loading stays behind `@acclimate/sdk/evaluation`, so the root package and console do not acquire lock/process imports. Move browser-safe `EvaluationDescriptor` to SDK wire types and share pure validation through an existing pure subpath; the console must not import the Node evaluator module.

The initial OS contract is POSIX plus Python 3 `fcntl`, matching the existing lock implementation. Delivery-only SDK imports do not require Python. State this prerequisite in the evaluator package reference, starter, preflight, and release manifest. Replacing locks with PID files or stale-file TTLs is rejected. Removing Python via a native lock dependency is a separately qualified portability change, not necessary to fix package usability.

| Dependency category | Treatment |
| --- | --- |
| In-process descriptor/comparison logic | Internal pure implementation, tested through the public module interface |
| Local-substitutable journals/filesystem/locks | Real private temporary directories and real process contention in deterministic tests |
| Remote but owned Acclimate HTTP | Reuse SDK client; private port with production adapter and deterministic fake adapter; external-consumer tests exercise actual HTTP shape |
| True external agent/grader | App-supplied callbacks; deterministic installed app in default tests, opt-in live qualification separately reported |

No public storage/transport registry is needed for this release. Internal ports are not user-facing extension promises. No callback is dynamically loaded by the evaluator from service-originated data.

## Evidence ownership

The runner continues to retain private local outputs. It should retain an app-supplied `outputRef` when present rather than unconditionally replace it, and separately index its local copy in a private sidecar manifest. The wire reference remains untrusted text and is never fetched automatically. Without an app ref, the initial runner can keep its existing local `file:` reference; the evidence-sharing lane should specify a separate explicit redacted export/manifest operation and durable CI artifact recipe. An export failure must not change a saved report's execution outcomes or trigger callbacks again. Existing saved reports retain their exact old references.

This proposal deliberately avoids an arbitrary artifact upload callback in the critical execution/report transaction. A post-run, app-owned export seam has clearer retry and privacy behavior. If the integrated plan requires a stable application artifact locator before submission, it must specify its idempotency, failure, and report-binding semantics explicitly.

## Implementation scope

1. `packages/sdk/src/types.ts`: shared public descriptor type, without a second fork of wire DTOs.
2. `packages/sdk/src/evaluation/index.ts` and internal files: three operations, config validation, descriptor capture, diagnostics, runner, private-state extraction, journal handling. No imports into `examples` or `scripts`.
3. `packages/sdk/package.json`: add `./evaluation` export to its built index. Keep existing root/validation/native-files exports unchanged.
4. `examples/evaluation/{adapter,runner,journal}.ts`: become thin compatibility imports/wrappers for documented source consumers, retaining public example descriptors and trusted local adapter selection. They stop owning a second implementation.
5. `scripts/evaluate-app.ts` and `scripts/evaluator-config.ts`: adopt the shared module and shared safe diagnostics, preserve existing flags/config shape, fix shell status for returned failed evaluations, and deprecate no old behavior silently.
6. `apps/console/src/lib/evaluation-config.ts`: import only pure SDK contract/validation. No Node evaluator module in the browser dependency graph.
7. `scripts/packaging/verify.mjs`: install actual tarball into a clean app, import the evaluator subpath, execute deterministic fixture callbacks, and confirm no source-tree imports leak into distribution.
8. `packages/sdk/tests/evaluation/`: public-interface behavior tests; relocate current runner/journal test cases into that suite, avoiding two owners of the same protocol tests.

## Acceptance gates

- Clean installed external consumer: define app, export descriptor, use a console-shaped handoff, run two versions/two cases, inspect bound comparison; no repository imports, implicit model calls, or implicit dependency download.
- Browser-safe console build: descriptor validation loads without `fs`, `child_process`, lock helpers, or Python execution.
- Wrong URL/project, descriptor drift, digest mismatch, wrong principal, wrong attempt, unavailable lock, and foreign journal all stop before callbacks with distinct safe codes.
- Response loss at start, submit, and finish recovers with stable identities and exact saved request bodies; callback count does not increase on saved-report recovery.
- A killed run after marker without report refuses all callbacks on retry. Same test with another language shares lock exclusion and refuses foreign takeover.
- Cancellation with a cooperative callback produces a saved incomplete report. Cancellation with an ignored signal never releases ownership/cleans inputs until the callback actually settles.
- Returned `failed` yields nonzero CLI status; completed losing evidence remains completed and requires a separate quality-policy decision.
- Existing schema-1 journals at original paths recover without migration into another directory, descriptor edits, or key regeneration.
- Secret canaries in private config, arbitrary HTTP errors, runtime settings, callback exceptions, and output do not appear in public diagnostic envelopes.
- POSIX/Python prerequisite absence is detected before claim; delivery-only imports still operate without that dependency.

## Tradeoffs and decisions for integration

The minimal design gives strong depth and locality at the cost of serial execution, a specific private filesystem strategy, and no public orchestration/storage adapters. A flexible design may expose stages, but making each adopter choose ordering and recovery diminishes the main benefit identified in the review. A standalone companion package would isolate prerequisites more visibly, but the subpath already isolates runtime loading and avoids another versioned artifact.

The coordinator must settle: whether a read-only capability endpoint is in scope; the shared error-code/CLI exit inventory; exact initial output/storage limits; whether preserving app output references or a new logical artifact scheme is preferred; whether Python ships full orchestration in the same milestone; and which existing example compatibility wrappers remain supported. These are explicit integration decisions, not unresolved implementation guesses hidden in the interface.
