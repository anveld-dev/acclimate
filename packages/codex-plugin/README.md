# @anveld/acclimate-codex-plugin

Stage a verified Acclimate version where Codex discovers it: the instruction becomes `AGENTS.md`, skills go to `.agents/skills/<name>/` with their supporting files, and memory files go to `.acclimate/memory/`.

## Install

Install the plugin and its peer `@anveld/acclimate-sdk` at the same version. Install `@openai/codex-sdk` to run the Codex example.

```sh
npm install @anveld/acclimate-sdk@0.3.0 @anveld/acclimate-codex-plugin@0.3.0 @openai/codex-sdk@0.169.0
```

## Use

```ts
import { Codex } from '@openai/codex-sdk';
import { prepare } from '@anveld/acclimate-codex-plugin';

const prepared = await prepare(delivery); // client.prepare() output or a verified version
try {
  const thread = new Codex({ env }).startThread({
    workingDirectory: prepared.cwd,
    skipGitRepoCheck: true,
    model,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
  });
  const turn = await thread.runStreamed(prompt, { signal });
  for await (const event of turn.events) {
    if (event.type === 'thread.started') prepared.reportStarted();
  }
} finally {
  await prepared.cleanup();
}
```

`prepare` returns the workspace, version ID and digest, the mapped instruction and skill paths, memory files, `reportStarted()` (a no-op returning `null` for a plain verified version) and an idempotent `cleanup()`. Start a fresh thread for each version; a running or resumed thread does not pick up a new version. Codex also reads `CODEX_HOME` (global `config.toml`, MCP servers and `AGENTS.md`); the native repository starter gives each job an isolated `CODEX_HOME` that holds only authentication.

See [QUALIFICATION.md](QUALIFICATION.md) for the recorded live check and the Codex guide (Integrations section of the Acclimate docs).
