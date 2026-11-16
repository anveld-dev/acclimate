# Native plugin integration

Each `prepare(verifiedBundle)` function accepts only the SDK's `VerifiedBundle`. It creates a `0700` private temporary workspace and returns its path, version ID, digest, mapped instruction and skill locations, explicit memory file paths, and an idempotent `cleanup()` function. Call cleanup after the native session no longer needs the workspace.

All mappings use the SDK's shared payload validator for schema, portable relative paths, duplicate/case-colliding paths, file/directory conflicts, and payload size. Skill files must use `skills/<name>/...`; every skill tree needs a matching `skills/<name>/SKILL.md` whose frontmatter `name` matches and includes a description. Reference files remain under their relative paths beside `SKILL.md`. They reject more than one instruction because each native mapping has one instruction entry point. A preparation error removes its partial workspace.

## Codex

`packages/codex-plugin` places the instruction in `AGENTS.md`, skills in `.agents/skills/<name>/SKILL.md`, and memory under `.acclimate/memory/`. Start a **fresh** thread with `workingDirectory: prepared.cwd` and `skipGitRepoCheck: true`; set the model and other runtime policy in the application. Memory is a file the application must explicitly provide as context. It is not a Codex SDK `memory` option.

The optional paid smoke is `npm run test:codex`. It explicitly selects `gpt-6-luna`, uses normal local Codex authentication without inspecting credentials, disables network and web search, and runs read-only with approval set to never and a 110-second abort limit. Each expected marker is a fresh random UUID stored only in its prepared resource; the prompt names the markers but omits their values and explicitly invokes `$marker-check`. It asserts the returned values exactly. It also records the SDK version, returned item types, and whether any command item exposed a resource read. A passing answer is evidence that all three secret values were retrieved, though the SDK result has no direct skill discovery event. The default test suite is offline.

## Claude Agent SDK

`packages/claude-plugin` places instructions in `CLAUDE.md`, skills in `.claude/skills/<name>/SKILL.md`, and memory under `.acclimate/memory/`. Use a fresh SDK session with `cwd: prepared.cwd` and `settingSources: prepared.settingSources` (which is `['project']`). The host explicitly supplies approved memory as context or reads its prepared file. The package does not create a session or imply that memory is a native SDK option. `claudeSessionOptions` is imported from `@acclimate/claude-plugin/native` and typechecks against SDK 0.3.325.

## Pi coding-agent SDK

`packages/pi-plugin` returns the workspace plus resource descriptors for the prepared instruction, skill, and memory files. Import `createPiResourceLoader` from `@acclimate/pi-plugin/native` to create and reload the actual native loader, then let the application create the session. The helper uses optional peer `@earendil-works/pi-coding-agent` 1.5.2, which needs Node 22.19+. The package does not expose guessed `Pi` option fields or run the SDK. Supply memory as selected host context/resources.

These packages prepare future session inputs. Refreshing a bundle does not modify an already running or resumed session; create a fresh session or use a documented native reload action.
