# @anveld/acclimate-pi-plugin

Stage a verified Acclimate version for a Pi coding-agent session: the instruction becomes `AGENTS.md`, skills go to `.agents/skills/<name>/` with their supporting files, memory files go to `.acclimate/memory/`, and `resources` describes each staged file.

## Install

Install the plugin and its peer `@anveld/acclimate-sdk` at the same version. Install the optional `@earendil-works/pi-coding-agent` peer when using the `/native` entry.

```sh
npm install @anveld/acclimate-sdk@0.3.0 @anveld/acclimate-pi-plugin@0.3.0 @earendil-works/pi-coding-agent@1.5.2
```

## Use

```ts
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { prepare } from '@anveld/acclimate-pi-plugin';
import { createPiResourceLoader } from '@anveld/acclimate-pi-plugin/native';

const prepared = await prepare(delivery); // client.prepare() output or a verified version
try {
  const modelRuntime = await ModelRuntime.create();
  const { session } = await createAgentSession({
    cwd: prepared.cwd,
    modelRuntime,
    model: modelRuntime.getModel('anthropic', modelId),
    tools: ['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls'],
    resourceLoader: await createPiResourceLoader(prepared, ['memory/approved.md']),
    sessionManager: SessionManager.inMemory(prepared.cwd),
    settingsManager: SettingsManager.inMemory(),
  });
  prepared.reportStarted();
  await session.prompt(prompt);
  session.dispose();
} finally {
  await prepared.cleanup();
}
```

`createPiResourceLoader` loads only the staged instruction and skills, disables extensions, prompt templates, themes and ambient context files, and appends only the memory paths you approve. See the Pi guide (Integrations section of the Acclimate docs).
