# Alternative C: the application owns one evaluation entrypoint

Design proposal, 2026-11-16. This is an alternative interface for council integration, not an implemented interface or runtime qualification.

## Recommendation

Optimize for the developer who already has an agent and a test fixture: give their application one statically wired evaluation entrypoint. They define saved cases, an execution callback, and a grader once. The same entrypoint describes the installed evaluator, checks a request, and runs it with the supported durable runner.

Use `@acclimate/sdk/evaluation` as the installed module. The starter teaches `defineEvaluation` there and `evaluationMain` from the optional Node command helper `@acclimate/sdk/evaluation/cli`. The latter returns a process status after cleanup; it does not call `process.exit`. A closed command helper earns its place by sharing strict config/handoff argument parsing, redacted error formatting, and exit semantics across adopters instead of making each copy them. The integrated core can expose `define`/`preflight`/`run` programmatically, with the command helper acting only as their thin adapter. The starter does not teach lifecycle operations or a public journal abstraction.

This differs from a bare `runEvaluation` design by making an application definition and a runnable, application-owned command the adoption seam. It differs from a session/protocol object by keeping request phases internal rather than requiring the caller to advance them. Its depth comes from deriving identity/inventory, validating the request, coordinating durable execution, and formatting safe command results behind that seam. Locality comes from using one definition for the console descriptor and actual execution rather than maintaining two copies.

## Current evidence

- The public package has root, validation, and native-files exports; no evaluation subpath exists: `packages/sdk/package.json:5`.
- `InstalledAdapter` and the complete durable runner are under examples: `examples/evaluation/adapter.ts:6`, `examples/evaluation/runner.ts:51`.
- The runner already hides fixed version binding, journal ownership, start/submit/finish keys, saved reports, and refusal to reexecute an ambiguous attempt: `examples/evaluation/runner.ts:72–150`.
- The existing checkout CLI can select only three installed examples: `scripts/evaluate-app.ts:25`.
- The custom console form asks the adopter to paste a descriptor before showing how to produce it: `apps/console/src/components/improvement-workspace.tsx:873`.
- The lower-level comparison helper already accepts independent execution/grading callbacks and clones inputs: `packages/sdk/src/compare.ts:39`, `:130`.
- Current examples use repository-relative imports. Native preparation lifetime and explicit memory context are documented separately: `examples/native-integration.md:3–21`.
- The TypeScript persona identifies the missing packaged durable runner and undeclared `npx tsx` dependency: `docs/research/developer-experience-review/typescript-integrator.md`.

## Concrete caller interface

The following is the proposed declaration sketch. All returned public configuration is deliberately public; case input and expected answers remain application-owned.

```ts
import type { ExecutionResult, GradeResult, VerifiedBundle } from '@acclimate/sdk';

export interface EvaluationCase<Input, Expected> {
  caseId: string;
  input: Input;
  expected: Expected;
  repetitions?: number; // default 1; positive integer
}

export interface EvaluationDefinition<Input, Expected, Output> {
  configId: string;
  configRevision: string;
  datasetRevision: string;
  graderRevision: string;
  runtime: Readonly<Record<string, string>>;
  execution: 'model-free' | 'live';
  cases: readonly EvaluationCase<Input, Expected>[];
  execute(input: {
    bundle: VerifiedBundle;
    caseId: string;
    repetition: number;
    input: Input;
    signal: AbortSignal;
  }): Promise<ExecutionResult<Output>>;
  grade(input: {
    caseId: string;
    repetition: number;
    output: Output;
    expected: Expected;
    signal: AbortSignal;
  }): Promise<GradeResult>;
}

export interface InstalledEvaluation<Input, Expected, Output> {
  readonly descriptor: EvaluationDescriptor;
  // Opaque brand; callbacks, snapshots and expected answers are not public fields.
}

export function defineEvaluation<Input, Expected, Output>(
  definition: EvaluationDefinition<Input, Expected, Output>,
): InstalledEvaluation<Input, Expected, Output>;

export function evaluationMain<Input, Expected, Output>(
  evaluation: InstalledEvaluation<Input, Expected, Output>,
  argv: readonly string[],
): Promise<number>;
```

`EvaluationDescriptor` is the current dataset/grader/runtime/expectedCases shape, moved from examples to an importable module. `defineEvaluation` inserts `runtime.configId` and `runtime.configRevision` from the named fields; supplying those reserved runtime keys directly is rejected. It derives `expectedCases` from the actual case inventory. No separate case-ID manifest must be synchronized by the adopter.

Input/expected/output must be structured-cloneable. The definition is captured and cloned on construction so later mutation cannot alter the installed inventory. The grader receives expected data by internal case lookup; the execution callback does not receive expected answers through this interface. This reduces accidental answer leakage but does not attest that application code is blind. The grader does not receive parent/candidate identity by default; a team requiring that must choose the lower-level comparison helper deliberately.

Revision labels are still application assertions. Automatic hashing of arbitrary JavaScript objects is not introduced as a cross-language identity protocol in this slice. The starter explains when to bump each revision and records the application's build revision in public runtime settings.

## Exact application-owned example

`src/evaluation.ts` belongs to the adopter's application. `runExistingReviewAgent` is their existing function; Acclimate never imports it from a handoff.

```ts
import { defineEvaluation } from '@acclimate/sdk/evaluation';
import { evaluationMain } from '@acclimate/sdk/evaluation/cli';
import { runExistingReviewAgent } from './review-agent.js';

const review = defineEvaluation<{ diff: string }, boolean, boolean>({
  configId: 'checkout-review',
  configRevision: '1',
  datasetRevision: 'saved-retry-cases-v1',
  graderRevision: 'unsafe-retry-exact-v1',
  runtime: {
    app: 'checkout-review-build-2026-11-16',
    model: 'my-app-configured-model',
    sampling: 'my-app-review-settings-v1',
    writes: 'disabled',
    network: 'disabled',
  },
  execution: 'live',
  cases: [{
    caseId: 'unkeyed-retry',
    input: { diff: 'retry(() => charge(card));' },
    expected: true,
    repetitions: 1,
  }],
  execute: async ({ bundle, input, signal }) => {
    const result = await runExistingReviewAgent({
      instructions: bundle.payload.files
        .filter(file => file.kind === 'instruction').map(file => file.text),
      skills: bundle.payload.files.filter(file => file.kind === 'skill'),
      memory: [], // Explicit policy: this evaluation does not provide approved memory.
      diff: input.diff,
      signal,
    });
    return { output: result.unsafeRetry, usage: result.usage };
  },
  grade: async ({ output, expected }) => ({ reward: Number(output === expected) }),
});

process.exitCode = await evaluationMain(review, process.argv.slice(2));
```

The application interprets the skill resources. This is a custom-loop example, not a claim that arbitrary native harnesses accept these options. Native harness starters replace only `execute`, use the selected public plugin, await the full session inside the preparation lifetime, select memory explicitly, retain intended outputs, and clean up in `finally`. The native-repository workstream must supply the concrete repository composition recipe.

Model/runtime configuration passed to `runExistingReviewAgent` must agree with the declared public identity; the SDK cannot prove arbitrary callback behavior. Model credentials remain inside that function's existing authentication path and never enter the descriptor or Acclimate private configuration.

## Starter and command responsibilities

The release contains two ordinary starter files and their README, not a global plugin generator:

- `evaluation.ts`: the app-owned custom-loop skeleton above.
- `evaluation-wiring.ts`: a complete deterministic model-free adapter using a tiny, explicitly documented fixture executor. It uses a distinct `configId` and `runtime.model = 'none'`.
- The README says the wiring task proves orchestration, not behavioral quality. It then points to the exact callback to replace with the real app and the exact identity revisions to change.

The adopter uses their existing TypeScript build or a supplied `tsconfig` plus pinned TypeScript development dependency. Distributed starter instructions use compiled JavaScript:

```json
{
  "scripts": {
    "build:evaluation": "tsc -p tsconfig.evaluation.json",
    "eval": "node dist/evaluation.js",
    "eval:wiring": "node dist/evaluation-wiring.js"
  }
}
```

No runtime `npx` download is required. Installation is an explicit step with the exact release's SDK/plugin artifacts and the chosen toolchain. No starter reads `.local`, scans environment files, or supplies a default service or identity.

The application command is statically bound to one definition. Multiple evaluators use multiple app scripts or a local, explicit application registry written by that developer. `--module`, downloaded adapter code, global discovery, and a handoff-supplied executable name are unsupported.

### `describe`

```sh
npm run eval -- describe
```

Writes only the descriptor to stdout. Requires no private config, service, journal, provider auth, or execution callback. It does not run `execute` or `grade`. Application modules must avoid paid work or sensitive initialization at import time; ordinary JavaScript imports cannot be sandboxed by this library. A starter keeps provider creation inside execution.

The console accepts this descriptor. The console then exports the existing public handoff containing service URL, project, bundle, request ID and frozen configuration. No executable locator is added.

### `doctor`

```sh
npm run eval -- doctor --config /absolute/private/evaluator.json --handoff /absolute/handoff.json
```

Reads only the explicitly chosen private config and handoff. Checks private config format, canonical private storage, required Python/POSIX lock support, service/project agreement, installed descriptor agreement, fixed version existence/digests, and evaluator authority using a dedicated nonmutating capability check if the platform workstream adds one. It must not claim write authority merely because reads succeed. Until that check exists, it reports `write_authority: unknown` and the runbook requirement explicitly.

Doctor does not start an attempt, execute a callback, invoke a grader, submit a comparison, or finish/interrupt a request. It may perform an ephemeral lock-support check under its configured private storage and remove its own probe. Its output separates checked, unknown, and blocked conditions. Any service-supplied case/runtime values are treated as untrusted, bounded public data.

### `run`

```sh
npm run eval -- run --config /absolute/private/evaluator.json --handoff /absolute/handoff.json --live
```

Uses the same validation as doctor, then the durable runner. `--live` is required for definitions marked live; model-free definitions reject it to expose accidental command/definition confusion. This is execution opt-in based on the app's declaration, not a guarantee that arbitrary callback code is cost-free. No model name is hardcoded by the generic module; repository live qualification retains its current Luna-only constraints.

An exact handoff cannot reconfigure the installed evaluator. A mismatch returns bounded differing field paths with no values by default. `serviceUrl` must exactly match the private config, preserving journal identity; aliases are not silently normalized across unfinished attempts.

CLI exit contract: `0` only for confirmed completed execution; `2` for failed/incomplete/interrupted evaluation; `1` for configuration, authorization, identity, transport, ownership, or uncertain-execution errors. A completed losing candidate still returns `0` from `run`. A separate application-owned policy-check step decides quality and never promotes. The CI workstream should settle a shared stable enumeration if more granularity is needed, rather than letting each CLI invent it.

## Hidden implementation and lifecycle contract

The module owns descriptor derivation, fixed case pairing, bounded cloneable inputs, immutable version resolution/verification, local journal ownership, attempt and idempotency keys, case output persistence, exact report submission, and terminal-state confirmation. Existing comparison and HTTP client modules remain implementation dependencies rather than copied algorithms.

The common path initially uses concurrency `1`, no execution retries, and no automatic reexecution after interruption. It does not expose a long list of tuning flags before first success. Concurrent operations against the same request use kernel lock ownership and one invocation fails busy before executing callbacks.

The journal remains schemaVersion 1 and retains its existing scope key order and hashing, absolute root binding, original principal, request snapshot, attempt, operation keys, and exact report. A saved report can be resubmitted/finished with the same command. A running request without its journal or an execution marker without a saved complete report is not resumed; the documented action remains inspect, explicitly interrupt, then create a new request. Do not delete journals to retry or promise exactly-once model calls.

Cancellation propagates one signal to app callbacks. It stops scheduling new work but cannot prove that a callback or remote model stopped. Cooperative callback exits become truthful partial/infrastructure outcomes when the runner can safely persist the report. A killed process or callback that does not settle leaves an ambiguous marker and follows the existing refusal rule. Cleanup waits for the callback's actual completion; no `Promise.race` may clean a workspace while a callback still uses it. Hard deadlines and process isolation remain application-owned and documented. An already-saved exact report is not discarded solely because the caller later cancels.

Error output is a stable safe envelope containing phase, category, optional bounded request ID, and documented action. Arbitrary server/provider messages, runtime values, case contents, expected answers, private paths and tokens are never echoed through default errors. Doctor/describe public output is explicit and separate from diagnostic logging.

## Dependency strategy and testing through the interface

- **In-process:** inventory derivation, structural matching, safe errors and command routing are behind the evaluation module's interface. Exercise them through `defineEvaluation`/the command interface, not separately exposed normalization knobs.
- **Local-substitutable:** real temporary private directories and real OS locks for ownership/recovery tests. Keep lock/filesystem seams internal and preserve the current Python `fcntl` dependency in this initial slice. The package must state POSIX plus Python 3 requirements; delivery-only imports must not spawn Python or reject unsupported evaluator platforms.
- **Remote but owned:** reuse `AcclimateClient`; use deterministic service fixture adapters and real disposable service tests for protocol binding. A fake transport may inject lost responses after durable service commits.
- **True external:** execution/grading callbacks are the app adapter seam. The default installed-consumer test uses a deterministic fake. Live native model qualification is opt-in, separately labeled and never required to prove the packaging/wiring slice.

## Implementation scope and migration

1. Add `packages/sdk/src/evaluation.ts` as the public export facade, with private implementation under `evaluation/`. Move descriptor, adapter, runner, journal, safe config/error support into that module's implementation. Prefer generic `defineEvaluation` over exposing `InstalledAdapter<unknown>`.
2. Add `./evaluation` and the optional `./evaluation/cli` in `packages/sdk/package.json`. Existing root/validation/native-files imports stay compatible. Do not export the Node/Python-dependent evaluation module through the browser-safe root merely for convenience. The programmatic runner takes the explicit config path and reuses strict configuration reading; callers must not reconstruct its rules in their shell wrapper.
3. Remove duplicated runtime algorithms from `examples/evaluation`; make included examples call the installed-supported module through repository-compatible source imports that build into the same implementation. Keep thin compatibility wrappers for existing checkout commands and preserve their explicit allowlist. The wrapper does not grow `--module`.
4. Move private helpers out of `scripts/` into SDK internals where used by the runner; scripts import the shared implementation rather than the installed package reaching back into repository files. Test full self-contained emitted package contents.
5. Add versioned starter source/readme assets to the release artifact inventory and manifest. `scripts/build-packages.mjs` must package all new evaluation implementation files; `scripts/packaging/verify.mjs` must import and execute the new subpath from an isolated tarball consumer.
6. App setup links to the actual release starter and presents describe → preflight → run → review. Keep example-only evaluators explicitly chosen. Public handoff schema remains version 1 if no wire field changes are required.
7. Preserve unfinished journal recovery under the same exact config and root across package upgrade. Include a schema-1 fixture generated by the old implementation in the external-consumer recovery test. New implementation must not silently relocate or rewrite a legacy journal during doctor.

The explicit migration tradeoff is that a compiled application starter adds one local file and build command but removes the need to install Acclimate's entire checkout, synchronize descriptor JSON by hand, or reproduce the runner's lifecycle. An adopter who already has a TypeScript toolchain can omit the supplied build setup.

## Acceptance gates

1. A clean external app installs only documented release artifacts and pinned toolchain, compiles the starter, and runs `describe` with network unavailable and no credentials. It performs zero callbacks.
2. Descriptor inventory exactly matches unique case/repetition pairs. Changing runtime/case identity produces an actionable mismatch before any callbacks, and expected answers never appear in descriptor/handoff or execution input.
3. A deterministic two-case/two-version fixture produces a bound comparison visible to the console. Its labels explicitly state wiring evidence. Replacing only execution with the existing app keeps the request/report protocol unchanged.
4. Doctor is shown failing for wrong project, denied/read-only evaluator authority, unsafe config permissions, missing lock runtime, and descriptor drift without starting a request or printing sensitive values. If authority checks are not implementable in the first platform slice, unknown is not presented as passed.
5. Test loss of start, submit, and finish responses, concurrent invocation, old journal recovery, relocated journal rejection, interrupted requests, and execution markers without complete reports. Callback counts demonstrate no speculative reexecution.
6. A completed losing candidate returns run success; failed/incomplete execution does not. Policy checking and promotion remain separate commands/authorization decisions.
7. Cancellation while an app callback is active cannot clean its prepared files early. An ignoring callback is documented as requiring application-owned process management rather than claimed terminated.
8. Installed package exports/types have no `examples/` or `scripts/` imports and import successfully without optional native model SDK peers. Delivery-only imports do not acquire evaluation dependencies.
9. The native adapter recipe keeps memory selection explicit and retains output before cleanup. It does not claim file delivery proves model consumption.

## Rejected choices and tradeoffs

- **Generic global `acclimate eval --module path`:** convenient, but introduces executable discovery, process configuration, bundling and allowlist concepts before first success. A local application command already provides the trusted binding.
- **Console-authored callback code:** shifts execution and credentials away from the application and violates the current request model.
- **Public start/submit/finish session as the default:** flexible but makes the adopter learn a protocol rather than attach an agent. Keep low-level SDK calls available for deliberate advanced use.
- **Publish the current example runner unchanged:** fixes exports but leaves `unknown` callbacks, duplicated inventory, hidden Python dependency and descriptor authoring burden intact.
- **A generator that installs packages or edits an existing project:** adds mutation/configuration complexity to a design task that a versioned copyable starter can satisfy. Can be reconsidered after observing actual onboarding.
- **Registry publication as a requirement:** exact artifacts and matching install commands solve the immediate acquisition problem without assuming a publishing service exists.
- **Parallel execution/checkpointed resume now:** adds external side-effect semantics and new recovery claims before the supported durable common path is shipped.

## Decisions needed from integration

1. Choose whether common-caller `defineEvaluation` becomes the canonical public application adapter contract or a convenience layer over the minimal alternative. Do not ship two competing definitions with diverging identity rules.
2. Agree one nonmutating effective evaluator-authority query with the platform workstream; otherwise doctor must report write authority unknown.
3. Agree the shared CLI result/error/exit envelope and policy command with CI. This proposal's small exit map is illustrative until reconciled.
4. Agree starter distribution location and exact release-version handoff with onboarding/packaging. No unannounced package-registry assumption.
5. Agree whether signal/callback semantics are added to the packaged runner now or deferred explicitly. The starter must never imply early cleanup safely stops external execution.
6. Keep the minimal custom-loop starter independent of native-repository composition and Python parity, while requiring concrete examples for those journeys before declaring the whole DX plan complete.
