# @anveld/acclimate-ai-sdk-plugin

Deliver versioned Acclimate bundles into [Vercel AI SDK](https://ai-sdk.dev/) applications (`generateText`, `streamText`, `ToolLoopAgent`, and `wrapLanguageModel`).

## Install

```sh
npm install @anveld/acclimate-sdk@0.3.0 @anveld/acclimate-ai-sdk-plugin@0.3.0 ai
```

## Use

```ts
import { generateText, wrapLanguageModel } from 'ai';
import { AcclimateClient } from '@anveld/acclimate-sdk';
import { prepare } from '@anveld/acclimate-ai-sdk-plugin';

const delivery = await client.prepare({ workspaceId, bundleId, channel: 'stable', reporter });
const prepared = prepare(delivery);
try {
  const model = wrapLanguageModel({ model: baseModel, middleware: prepared.middleware });
  const result = await generateText({
    model,
    prompt: userRequest,
    experimental_telemetry: { isEnabled: true, ...prepared.telemetry },
  });
} finally {
  await prepared.cleanup();
}
```

Pass `{ includeSkillsInPrompt: false }` and call `prepared.createSkillTools(jsonSchema)` (passing `jsonSchema` from `'ai'`) to expose `list_acclimate_skills` and `read_acclimate_skill` for progressive skill disclosure.
