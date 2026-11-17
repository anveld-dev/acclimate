# TypeScript integrator persona review

This is a simulated, source-based persona review on 2026-11-16, not observed user research. No application or model-backed journey was executed. Findings describe current source behavior and likely developer consequences separately.

## Persona and job

I maintain a TypeScript service with an existing agent loop, tool credentials, and tests. I want Acclimate to deliver versioned instructions and skills, then compare a proposed change against a small dataset using my existing executor and grader. I expect to install a package in my service, add a few callbacks, and follow one documented path from a console request to reviewable results. I am comfortable owning execution; I do not want to become the author of an evaluation recovery protocol.

## Journey

1. The README establishes a useful boundary: my app keeps its SDK, tools and agent loop. I find installable tarballs through the console's App setup instructions.
2. I install `@acclimate/sdk`, obtain a content-read credential, and configure the five variables. The copied recipe resolves a channel, verifies a bundle, writes its files, reads them, and cleans up.
3. I still have to discover the native plugin route or manually connect the returned files to my app. The setup screen's successful result is a file-delivery check, not an agent consuming the new instructions.
4. I choose “My app's installed evaluator” in the console and must provide a public descriptor matching my installed runtime and case inventory. The service creates an immutable request; I copy its public handoff.
5. I look for the documented `InstalledAdapter` / `runEvaluation` API in my installed SDK. Those interfaces and the durable orchestration are repository examples, while my package exposes `compare` and raw lifecycle methods. I must pull in repository code or own the missing orchestration.
6. Once running, configuration drift and HTTP failures are difficult to diagnose through the provided CLI. Results contain private local output references, leaving further work before teammates can inspect the actual output behind a reward.

## Findings

### TS1 — High: the custom evaluator integration ends at a repository boundary

**Observed evidence:** `examples/evaluation/README.md:26` directs custom evaluators to the public SDK, and `:46` describes supplying `InstalledAdapter` to `runEvaluation`. The SDK's complete export list at `packages/sdk/src/index.ts:1` exposes `compare`, report types, and the raw client, but no adapter contract or durable request runner. The package export map and `files: ["dist"]` in `packages/sdk/package.json:5` do not expose the examples. The supplied runner at `examples/evaluation/runner.ts:98`–`:150` handles durable execution markers, exact report saving, submission, attempt ownership and finishing. Its journal additionally imports `scripts/private-state.js` and starts Python's `fcntl` lock helper (`examples/evaluation/journal.ts:6`, `:31`, `:58`).

**Developer impact, inferred:** An external app can use the supported raw endpoints, so custom evals are possible. However, “supply callbacks” understates the integration cost: installing the SDK does not deliver the documented high-level runner. Copying one example also pulls in further repository dependencies. Reimplementing the lifecycle risks losing the retry guarantees that make Acclimate valuable.

**Recommendation:** Ship a supported `@acclimate/sdk/evaluation` entry point or a separate runner package with generic adapter types, explicit runtime prerequisites, and an installed-package example. Keep adapter selection app-owned; packaging does not require executing code supplied by a service request.

**Acceptance criterion:** A clean external TypeScript project installs release artifacts and implements `describe`, `execute`, and `grade` without importing repository source. It consumes a console handoff, completes a deterministic paired eval, and recovers an interrupted report submission with the same durable attempt.

### TS2 — High: the evaluator removes the diagnostic information an integrator needs

**Observed evidence:** `examples/evaluation/adapter.ts:22` normalizes and compares the complete descriptor, then reports only “Request does not match installed fixture/application configuration.” The developer cannot see which of dataset revision, grader revision, runtime settings, or inventory differs. `scripts/evaluate-app.ts:41`–`:55` suppresses all errors containing `status`, plus unrecognized network/local failures, behind the same “Evaluation was not confirmed” message. In contrast the SDK preserves HTTP status, service code, and request ID (`packages/sdk/src/client.ts:181`–`:189`).

**Developer impact, inferred:** A one-field descriptor change, a wrong credential, a missing request, and a transport problem send the integrator toward private-journal inspection without an actionable distinction. This raises support burden and makes the first custom integration feel fragile.

**Recommendation:** Produce structured, sanitized diagnostics: lifecycle phase; safe HTTP status/code/request ID; mismatch field paths and bounded differences for the already-public descriptor; and whether execution could have started. Preserve credential and arbitrary-output redaction.

**Acceptance criterion:** A dataset-revision mismatch identifies that field before any callbacks run. Unauthorized, not-found, and transport failures produce distinct redacted codes and recovery guidance, with safe correlation IDs when present. Tests ensure tokens and arbitrary server messages never appear.

### TS3 — Medium: App setup has no concrete bridge from delivered files to an existing agent

**Observed evidence:** The main recipe imports only `AcclimateClient`, `resolveAndCache` and `prepareFiles`, reads the prepared files, and immediately cleans up (`apps/console/src/components/sdk-setup-recipes.ts:7`–`:25`). App setup describes fetching/preparing and starting an agent (`apps/console/src/components/sdk-setup.tsx:51`), but its primary check ends at the file count (`:224`). The native handoff exists elsewhere: `examples/native-integration.md:9` describes fresh Codex threads and explicit memory context; `examples/codex-agent.ts:43`–`:65` implements it using repository-relative imports.

**Developer impact, inferred:** The file check correctly proves only delivery. The missing next step is how I adapt my existing loop: native discovery, memory injection, cleanup lifetime, existing repository cwd, and pinning during a run. Developers may stop at “check passes” while their agent still consumes old local instructions.

**Recommendation:** Add an explicit “Connect your agent” step after the check. Offer one installed-package native example and a custom-loop example that consumes prepared content, marks where existing execution goes, and keeps cleanup after completion. Link the existing native mapping guide directly.

**Acceptance criterion:** Starting at App setup, an integrator can find and copy a recipe that actually supplies versioned instructions to their chosen runtime, records version/digest beside the app run, and shows the preparation lifetime. File delivery and model consumption remain separate claims.

### TS4 — Medium: output references do not provide a practical review handoff

**Observed evidence:** The supplied runner saves execution data into its private local journal and unconditionally reports `file:` URLs (`examples/evaluation/runner.ts:123`–`:127`). The console renders `outcome.outputRef` as plain text (`apps/console/src/components/evaluation-pair-row.tsx:40`–`:42`). The documentation accurately calls these private JSON files (`examples/evaluation/README.md:48`).

**Developer impact, inferred:** From another machine, a reviewer can see rewards and status but cannot inspect the generated answer or trace behind a regression. Using the stock runner also replaces any adapter-supplied output reference with its local file reference. Teams must invent their own private artifact distribution and retrieval convention.

**Recommendation:** Document and support an app-owned artifact resolver/export hook. Retain the local durable copy while allowing a separate stable, authorized review reference or a redacted export bundle with case/version identities. Do not make private evidence public by default.

**Acceptance criterion:** A teammate on a second machine can retrieve an intentionally shared failed case's output and grading context through a documented authorized flow, verify its case/version binding, and distinguish unavailable evidence from empty output.

### TS5 — Low: the copied TypeScript run command has an undeclared execution dependency

**Observed evidence:** App setup installs the SDK tarball but then tells the user to run `npx tsx delivery-check.mts` (`apps/console/src/components/sdk-setup.tsx:35`–`:40`). The SDK package has no `tsx` dependency or CLI (`packages/sdk/package.json:1`). The generated code uses TypeScript non-null assertions, so it is not simply a portable JavaScript example.

**Developer impact, inferred:** In a clean external app, the command depends on an already-installed `tsx` or an on-demand npm fetch and possibly a prompt. This can fail in a locked-down/offline setup, and does not make the tool version reproducible. This is setup friction, not evidence the SDK itself is broken.

**Recommendation:** Explicitly install a pinned development runner in the app, show how to use the project's existing TypeScript toolchain, or supply a plain `.mjs` recipe as the zero-extra-tool alternative.

**Acceptance criterion:** The displayed install and run instructions succeed from an otherwise empty external app using only documented prerequisites, with no implicit dependency download at execution time.

## What works well

- The integration boundary respects existing applications and provider credentials.
- Public installed-package APIs are sufficient for verified delivery; configuration is explicit and the console pre-fills project/bundle/channel selection.
- `compare` is a useful independent building block with ordinary execution and grading callbacks, fixed case pairs, concurrency limits, and separate execution/grading outcomes (`packages/sdk/src/compare.ts:37`, `:99`, `:198`).
- Channel resolution and exact verified content are distinct; offline fallback is explicit and does not hide authorization failures (`packages/sdk/src/cache.ts:103`).
- The example runner's recovery rules, ownership checks and exact report preservation are carefully designed. These strengths make packaging that runner more valuable.
- No automatic promotion or hidden model execution is implied by creating an evaluation request.

## Limits and checks

Reviewed current source, console-generated recipes, package metadata and documentation. No dependency installation, package build, service startup, browser session, external write or model call ran. A planned small CLI behavior probe was skipped because `node_modules/.bin/tsx` is absent in this checkout; all diagnostic findings above are static source observations, not reproduced runtime failures. Node reports v26.13.1, but that does not qualify the documented Node minimum. There were no `AGENTS.md` files returned by the repository search.

This review does not establish tarball build failure, SDK runtime defects, or measured completion/abandonment times. A TypeScript developer could deliberately choose the lower-level SDK and build a runner; the criticism concerns the documented high-level adoption path and its cost.

## Top three changes for this persona

1. Ship the durable evaluator integration as a supported installed-package API with one clean external-app example.
2. Add safe preflight/descriptor differences and phase-aware errors before developers spend time debugging journals.
3. Connect App setup to an actual agent-run recipe and then to that same app's first custom evaluation.
