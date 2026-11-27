# @anveld/acclimate-cursor-plugin

Stage a verified Acclimate version for a local Cursor agent.

## Install

Install the plugin and its peer `@anveld/acclimate-sdk` at the same version. Install the optional `@cursor/sdk` peer when using the `/native` entry.

```sh
npm install @anveld/acclimate-sdk@0.3.0 @anveld/acclimate-cursor-plugin@0.3.0 @cursor/sdk@1.3.1
```

## Cursor local SDK delivery

`prepare` stages a verified version, or the result of `client.prepare()`, in a private job directory: its instruction becomes `AGENTS.md`, skills become `.cursor/skills/<name>/SKILL.md` (including supporting files), and only memory paths explicitly selected in `approvedMemoryPaths` are staged and returned. It does not overwrite an existing project. The host must call `cleanup()` after the agent is finished; the directory is removed, including any agent-created files, and a delivery passed to `prepare` is released too. Call `prepared.reportStarted()` when the run reaches `RUNNING` to keep the delivery's start receipt. These helpers require POSIX filesystem permissions. Cursor skill names must be lowercase letters, digits or hyphens.

The optional `native` entry exports `cursorLocalOptions`, which returns the native `local.cwd` and `local.settingSources: ['project']` fields for `Agent.create`. The application supplies its own API key, model, tool policy and prompt. Memory is not an SDK memory option: opt in to individual approved files in host-authored context. The example `examples/cursor-agent.ts` shows that selection, enables the local sandbox, accepts any `CURSOR_MODEL` and retains the result before cleanup; running it makes a provider call. Project settings can include hooks or MCP servers; this generated workspace contains only staged resources, but a host should assess any additional files it places there.

Cursor documents [local SDK options](https://cursor.com/docs/sdk/typescript), [AGENTS.md rules](https://cursor.com/docs/rules), and [project skills](https://cursor.com/docs/skills). `@cursor/sdk` 1.3.1 (the tested version) requires Node 22.13 or later. Its local agent loop runs in-process, but inference is hosted. Local sandboxing is off by default and is not a complete application authorization policy. Project skill availability does not prove invocation; the model chooses relevant skills unless explicitly invoked.

Qualification: offline tests check the actual SDK `AgentOptions` type and staged files, permissions, metadata and cleanup. They do not prove that Cursor's scanner discovers them, that a skill was invoked, or that a resumed agent reloads changed resources. Workspace scanning is cached by Cursor. Start a fresh agent for a new bundle and verify discovery in your deployment. A local workspace path does not upload files to a cloud agent; cloud delivery is not implemented or qualified. No provider session was run in this qualification.
