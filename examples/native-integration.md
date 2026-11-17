# Native plugin integration

Start with the [installed existing-repository starter](native-repository/README.md) when your agent needs source files, existing tools and a retained patch. It uses the public SDK/plugin tarballs, an explicit frozen source inventory, selected memory, durable private job locators and a persistent worker TMPDIR. Its fake task is runnable without model credentials; [qualification status](native-repository/QUALIFICATION.md) keeps that wiring evidence separate from real provider behavior.

Each `prepare(verifiedBundle)` function accepts only the SDK's `VerifiedBundle`. It creates a `0700` private temporary workspace and returns its path, version ID, digest, mapped instruction and skill locations, explicit memory file paths, and an idempotent `cleanup()` function. Call cleanup after the native session no longer needs the workspace.

All mappings use the SDK's shared payload validator for schema, portable relative paths, duplicate/case-colliding paths, file/directory conflicts, and payload size. Skill files must use `skills/<name>/...`; every skill tree needs a matching `skills/<name>/SKILL.md` whose frontmatter `name` matches and includes a description. Reference files remain under their relative paths beside `SKILL.md`. They reject more than one instruction because each native mapping has one instruction entry point. A preparation error removes its partial workspace.

## Codex

`@acclimate/codex-plugin` places the instruction in `AGENTS.md`, skills in `.agents/skills/<name>/SKILL.md`, and memory under `.acclimate/memory/`. Start a **fresh** thread with `workingDirectory: prepared.cwd` and `skipGitRepoCheck: true`; set the model and other runtime policy in the application. Memory is a file the application must explicitly provide as context. It is not a Codex SDK `memory` option.

The optional paid smoke is `npm run test:codex`. It explicitly selects `gpt-6-luna`, uses normal local Codex authentication without inspecting credentials, disables network and web search, and runs read-only with approval set to never and a 110-second abort limit. Each expected marker is a fresh random UUID stored only in its prepared resource; the prompt names the markers but omits their values and explicitly invokes `$marker-check`. It asserts the returned values exactly. It also records the SDK version, returned item types, and whether any command item exposed a resource read. A passing answer is evidence that all three secret values were retrieved, though the SDK result has no direct skill discovery event. The default test suite is offline.

## Claude Agent SDK

`@acclimate/claude-plugin` places instructions in `CLAUDE.md`, skills in `.claude/skills/<name>/SKILL.md`, and memory under `.acclimate/memory/`. Use a fresh SDK session with `cwd: prepared.cwd` and `settingSources: prepared.settingSources` (which is `['project']`). The host explicitly supplies approved memory as context or reads its prepared file. The package does not create a session or imply that memory is a native SDK option. `claudeSessionOptions` is imported from `@acclimate/claude-plugin/native` and typechecks against SDK 0.3.325.

## Pi coding-agent SDK

`@acclimate/pi-plugin` returns the workspace plus resource descriptors for the prepared instruction, skill, and memory files. Import `createPiResourceLoader` from `@acclimate/pi-plugin/native` to create and reload the actual native loader, then let the application create the session. The helper uses optional peer `@earendil-works/pi-coding-agent` 1.5.2, which needs Node 22.19+; the complete Acclimate starter requires Node 22.22+. The package does not expose guessed `Pi` option fields or run the SDK. Supply memory as selected host context/resources.

## Cursor SDK

`@acclimate/cursor-plugin` maps the instruction to `AGENTS.md` and skills to `.cursor/skills`. Pass an explicit `approvedMemoryPaths` list to preparation; other memory is not staged. `cursorLocalOptions` from `@acclimate/cursor-plugin/native` supplies the supported `local` workspace fields. The app owns `Agent.create`, credentials, model, permissions and startup. These option/preparation checks are offline evidence; they do not qualify a live Cursor job.

## Existing repositories and cleanup

Native preparation creates a new resource-only workspace. It does not merge into your current checkout. The repository starter copies an allowlisted snapshot into that owned workspace, deliberately rejects root/nested guidance conflicts, filters both memory files and returned context metadata, and extracts declared text results before cleanup. It never copies `.git`, runs install lifecycle scripts, or changes the source repository.

A native SDK promise rejecting or timing out does not by itself establish that its external work stopped. The starter records launch intent and the private workspace before launch, quarantines uncertainty, and cleans only after confirmed termination/results retention. An explicit local operator recovery callback must verify termination before deleting quarantined files; an old PID or record age is insufficient.

These packages prepare future session inputs. Refreshing a bundle does not modify an already running or resumed session; create a fresh session or use a documented native reload action.
