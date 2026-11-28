# @anveld/acclimate-openai-agents-plugin

Deliver versioned Acclimate bundles into the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) (`@openai/agents`).

## Install

```sh
npm install @anveld/acclimate-sdk@0.3.0 @anveld/acclimate-openai-agents-plugin@0.3.0 @openai/agents
```

## Use

```ts
import { Agent, Runner } from '@openai/agents';
import { AcclimateClient } from '@anveld/acclimate-sdk';
import { prepare } from '@anveld/acclimate-openai-agents-plugin';

const delivery = await client.prepare({ workspaceId, bundleId, channel: 'stable', reporter });
const prepared = prepare(delivery);
try {
  const agent = new Agent({
    name: 'support-agent',
    instructions: prepared.instructions,
  });
  const runner = new Runner({ traceMetadata: prepared.traceMetadata });
  const detach = prepared.attach(runner);
  try {
    const result = await runner.run(agent, userRequest);
  } finally {
    detach();
  }
} finally {
  await prepared.cleanup();
}
```

Pass `{ includeSkillsInPrompt: false }` when registering `prepared.skillToolDefinitions` as tools (compatible with strict structured outputs).
