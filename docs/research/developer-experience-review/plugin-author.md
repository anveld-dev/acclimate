# Coding-agent plugin author review

This is a simulated, source-based persona review, not observed user research. Scope: the current Codex, Claude, Pi, and Cursor preparation APIs, setup recipes, and native evaluation path. No provider session or deployed console was exercised.

## Persona and job

I maintain a coding agent integration for an existing repository. My application already owns tools, credentials, model selection, permissions, and session persistence. I want to deliver reviewed instructions and skills, prove the intended resources reach a fresh agent, and compare candidate changes using the same harness my users run. Later I need to support a second harness without silently changing memory policy or invalidating my eval.

My expected adoption path is: install SDK and plugin → resolve a pinned version → combine resources with the job's repository → start my native session → collect delivery and behavioral evidence → evaluate a candidate → release → apply it to new jobs while preserving existing sessions.

## Journey through the current product

1. README correctly says the application keeps its native SDK and loop. The console offers TypeScript/Python SDK installation and a model-free delivery check.
2. That check verifies staged bytes, then cleans them up. To start a native agent I leave the console and find `examples/native-integration.md`, plugin source, or a repository example.
3. Each native `prepare` produces a private temporary directory. Codex/Claude/Cursor session options point their working directory there; Pi builds a loader against that directory.
4. For Codex, I can copy a real application example and inspect historical marker-based session checks. Claude/Pi have native helper APIs and offline checks; Cursor has a separate README and opt-in example, with explicit qualification limits.
5. The built-in native eval invokes Codex/Luna over saved diffs. My real repository tools, memory selection, other model settings, and other harnesses require my own adapter implementation.
6. Channel refresh creates inputs for another fresh session. The docs explicitly decline hot reload; integration with existing session persistence remains my application work.

## Findings

### P1 — Existing-repository composition is the largest missing integration step

**Observed:** `prepareNativeFiles` creates a fresh directory using `mkdtemp`, writes only bundle resources, and recursively removes that entire directory on cleanup (`packages/sdk/src/native-files.ts:52`, `:55`, `:99`). Codex sets `workingDirectory: prepared.cwd` (`examples/codex-agent.ts:46`); the other native option helpers also use the prepared directory (`packages/claude-plugin/src/native.ts:4`, `packages/cursor-plugin/src/native.ts:5`, `packages/pi-plugin/src/native.ts:29`). Cursor's README explicitly says an existing project is not overwritten and cleanup also removes agent-created files (`packages/cursor-plugin/README.md:3`).

**Cross-check:** The generic public `prepareFiles(bundle, destination)` does support an app-selected existing private directory and removes only its own created files (`packages/sdk/src/prepare.ts:51`, `:65`, `:115`). It preserves bundle paths rather than applying the native plugin mappings. Its only implemented collision policy is `error` (`:56`). The shared native guide explicitly instructs starting in `prepared.cwd` and offers no destination/overlay hook (`examples/native-integration.md:3`, `:9`). The older design guide sketches a `workspace` parameter but labels that API unimplemented pseudocode (`docs/design/sdk-and-plugins.md:9`, `:19`); the current native APIs inspected have no such option.

**Impact:** My real coding agent needs a source checkout, dependency files, repository tools, and an output collection strategy. The happy path changes its cwd to a directory without those inputs. A developer must design repository composition and output collection before the first representative integration or eval, or implement native path mapping using generic preparation. Native cleanup's removal of the owned directory is explicit lifetime behavior, not a data-loss defect. The missing piece is a supported recipe showing how a host integrates that lifetime with repository work and retains its intended outputs.

**Recommendation:** Provide an owned job-workspace recipe that copies or prepares an explicitly selected checkout, resolves conflicts with existing native instruction/skill files, stages content, starts the native agent, and collects outputs before cleanup. Explain instruction precedence and tool-path handling. An overlay API is an option, not a prerequisite for documenting the journey.

**Acceptance:** An external consumer can run a native agent against a small existing repository, read source, produce a patch, retain that patch, and clean all temporary inputs using only the public recipe. Existing repository guidance has an explicit conflict policy.

### P1 — The native eval example does not become an eval of my installed agent without substantial reconstruction

**Observed:** The eval CLI allowlists only `payment-retry`, `presence-contract`, and `codex-luna-review` (`scripts/evaluate-app.ts:9`, `:25`). The native adapter imports plugin implementation from the repository, hardcodes Codex/Luna, creates a fresh read-only thread, and prompts against a saved diff (`examples/service-proposer/evaluation-adapter.ts:27`, `:38`, `:44`). The reusable adapter interface and runner live under `examples/evaluation`, not a published plugin API (`examples/evaluation/adapter.ts:6`, `scripts/evaluate-app.ts:5`). The installed configuration must match dataset, grader, runtime, and case inventory (`examples/evaluation/adapter.ts:22`).

**Impact:** Supporting Claude, Pi, Cursor, or my existing Codex execution settings means building another installed adapter and integrating request handling, grading, and durable execution. The supplied native score is about its saved task and harness configuration; it does not automatically answer whether my application's coding agent improves. App-owned execution is the right boundary, but the SDK-to-runner bridge is expensive to discover and assemble.

**Recommendation:** Ship a public custom native evaluator starter, with execution delegated to one host-provided callback. Include preparation, approved memory selection, runtime identity, case inventory, grading, durable submission, and failure recovery. Keep server requests declarative and the installed adapter allowlist explicit.

**Acceptance:** An installed-package consumer replaces the execution callback with each supported harness without modifying Acclimate's checkout, submits a paired report, and sees the same version/runtime identity in the console. A model-free fake harness verifies wiring separately from paid behavioral tests.

### P2 — Console setup ends before selecting and starting a native harness

**Observed:** The console install flow supplies the generic SDK tarball (`apps/console/src/components/sdk-setup.tsx:70`). Its generated check imports `prepareFiles` and reads each staged file (`apps/console/src/components/sdk-setup-recipes.ts:7`, `:19`). Native preparation appears only as a brief reference in a cache disclosure (`apps/console/src/components/sdk-setup.tsx:294`). The shared native guide covers Codex/Claude/Pi but omits Cursor (`examples/native-integration.md:7`, `:13`, `:17`); Cursor documentation is separate.

**Impact:** A successful file-read check is useful, but it leaves a coding-agent adopter without the next copyable step: plugin installation, peer SDK, fresh-session options, memory choice, and observable start. The user must infer which repository artifacts form the supported integration path.

**Recommendation:** Add a harness selector after the generic delivery check and link a single canonical guide covering all four plugins. Give each harness a complete installed-package recipe, not repository-relative imports, and show the transition from file delivery to native start and then behavioral eval.

**Acceptance:** Starting from the console's setup page, a developer can find the correct plugin tarball/peer requirements and a runnable native recipe for any of the four harnesses without searching repository source.

### P2 — Memory policy changes shape when adding another harness

**Observed:** Codex/Claude/Pi `prepare` stage all memory and return it for host selection (`packages/codex-plugin/src/index.ts:15`, `packages/claude-plugin/src/index.ts:18`, `packages/pi-plugin/src/index.ts:22`). Pi's native loader accepts selected source paths separately and defaults to none (`packages/pi-plugin/src/native.ts:7`). Cursor filters memory at preparation via `approvedMemoryPaths`, defaulting to none (`packages/cursor-plugin/src/index.ts:18`, `:23`, `:32`). The Codex example lists every prepared memory file in its prompt (`examples/codex-agent.ts:60`); the native eval prompt mentions skill files and saved diff without selecting memory (`examples/service-proposer/evaluation-adapter.ts:44`).

**Impact:** Replacing the plugin is not enough to preserve equivalent memory exposure. An application following defaults can stage or expose a different subset; a native eval may assess a different context policy from the live app. These choices are explicit in individual APIs, but there is no single cross-harness recipe making their consequences easy to compare.

**Recommendation:** Document a common host approval policy and show its implementation for each plugin. Record the selected memory set or policy revision in evaluator runtime identity, alongside harness/model settings. Standardize the host-facing selection shape where useful without implying native SDK memory options.

**Acceptance:** A two-memory fixture selecting only one file produces an explicit, auditable selection across all four recipes; switching harnesses or moving from app execution to eval does not silently change that selection.

### P2 — Qualification evidence is careful but fragmented across harnesses

**Observed:** Codex has a dated live session record that distinguishes fresh/resumed marker observations from discovery events (`packages/codex-plugin/QUALIFICATION.md:3`, `:13`). Cursor separately states that its offline checks do not prove scanner discovery, invocation, or resumed reload (`packages/cursor-plugin/README.md:9`). The native guide describes offline Claude option and Pi loader integration, while the console explicitly says delivery reports do not prove model consumption (`examples/native-integration.md:15`, `:19`; `apps/console/src/components/sdk-setup.tsx:264`).

**Impact:** A plugin author has to reconcile package source, several docs, model restrictions, historical runs, and local unit tests to answer “what has actually been demonstrated for this harness?” Healthy limits are clearly stated, but they are difficult to compare or turn into a deployment checklist.

**Recommendation:** Maintain one capability/qualification matrix: file staging, SDK helper/type compatibility, live resource retrieval, skill invocation, behavioral eval, fresh session, resumed session, and in-place reload. Link each cell to its evidence and provide an opt-in harness-specific consumption probe. Preserve the distinction between delivery and quality.

**Acceptance:** Every advertised harness has a concise evidence status and a documented probe that reports the pinned version/digest and observed resource markers without claiming undocumented discovery events or reload behavior.

## Strengths to retain

- The preparation modules are small and leave native credentials, tools, policy, and agent loops with the application.
- Shared compatibility checks reject invalid skill layouts and report structured issues before staging; Cursor-specific naming rules are explicit (`packages/sdk/src/compatibility.ts:26`, `:37`, `:50`).
- Private workspaces, exclusive file creation, partial-failure cleanup, and idempotent cleanup form a sensible foundation for safe job preparation.
- Native helpers type against actual SDK interfaces rather than inventing memory or session fields.
- Documentation is unusually honest about offline evidence, fresh-session pinning, optional receipts, and the limits of resumed-session observations.

## Verification and unknowns

I inspected the source and docs cited above. No applicable `AGENTS.md` was found in the repository search. I attempted the seven targeted plugin unit-test files with `node_modules/.bin/tsx --test ...`; the command exited 127 because `node_modules/.bin/tsx` is absent. I did not install dependencies, execute tests successfully, start provider sessions, or exercise live discovery. Current provider behavior and any deployed integration are therefore unverified. Missing capability claims above are scoped to the inspected public APIs and supplied recipes, not to what a custom host could implement.

## Top three fixes

1. Document and verify the existing-repository job workspace, including output collection before cleanup.
2. Provide an installed-package custom native evaluator starter using the application's real execution callback and explicit context policy.
3. Connect console setup to harness-specific recipes and one qualification matrix.
