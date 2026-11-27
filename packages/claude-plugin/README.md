# @anveld/acclimate-claude-plugin

Stage a verified Acclimate version as a Claude Agent SDK project: the instruction becomes `CLAUDE.md`, skills go to `.claude/skills/<name>/` with their supporting files, and memory files go to `.acclimate/memory/`.

## Install

Install the plugin and its peer `@anveld/acclimate-sdk` at the same version. Install `@anthropic-ai/claude-agent-sdk` to run Claude sessions.

```sh
npm install @anveld/acclimate-sdk@0.3.0 @anveld/acclimate-claude-plugin@0.3.0 @anthropic-ai/claude-agent-sdk@0.3.325
```

## Use

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AcclimateClient } from '@anveld/acclimate-sdk';
import { prepare } from '@anveld/acclimate-claude-plugin';
import { claudeSessionOptions } from '@anveld/acclimate-claude-plugin/native';

const delivery = await client.prepare({ workspaceId, bundleId, channel: 'stable', reporter });
const prepared = await prepare(delivery); // or prepare(verifiedVersion) from resolveAndCache
const abortController = new AbortController();
try {
  for await (const message of query({
    prompt,
    options: { ...claudeSessionOptions(prepared), model, abortController, permissionMode: 'dontAsk',
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'], sandbox: { enabled: true } },
  })) {
    if (message.type === 'system' && message.subtype === 'init') prepared.reportStarted();
  }
} finally {
  await prepared.cleanup(); // removes the workspace and releases the delivery
}
```

- `prepare(input, { baseDir })` accepts a verified version or the result of `client.prepare()`. With a delivery, `prepared.reportStarted()` queues its start receipt and `cleanup()` also releases the delivery directory.
- `claudeSessionOptions` returns `cwd`, `settingSources: ['project']` and the version's skill names. It omits `skills` when the version has none, because an empty list disables every skill in the Agent SDK.
- Memory is not an Agent SDK option. Give the session only the memory files you approve.

## Use your repository's Claude settings

By default the session runs in a fresh directory, so your repository's `.claude/settings.json`, MCP servers, hooks and subagents do not apply. Pass `baseDir` to copy them in:

```ts
const prepared = await prepare(delivery, { baseDir: '/absolute/path/to/your/repository' });
```

This copies `.claude/settings.json`, `.claude/agents/`, `.claude/commands/`, `.claude/hooks/`, `.claude/output-styles/` and `.mcp.json` (see `CLAUDE_PROJECT_OVERLAY`). The bundle still owns guidance: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/skills/` and `.claude/settings.local.json` are never copied, and a bundle file that collides with a copied file is an error. Symlinks are rejected. `prepared.overlayFiles` lists each copied file with its SHA-256; record them in your runtime identity, because hooks and MCP servers change behavior.

## Qualification

Offline tests cover staging, the overlay, receipts and the option types against the SDK. Live Claude sessions are not qualified by this package. See the Claude Agent SDK guide (Integrations section of the Acclimate docs) and `examples/claude-agent.ts`.
