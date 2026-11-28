# @anveld/acclimate-langchain-plugin

Deliver versioned Acclimate bundles into [LangChain.js and LangGraph.js](https://js.langchain.com/).

## Install

```sh
npm install @anveld/acclimate-sdk@0.3.0 @anveld/acclimate-langchain-plugin@0.3.0 @langchain/core
```

## Use

```ts
import { AcclimateClient } from '@anveld/acclimate-sdk';
import { prepare } from '@anveld/acclimate-langchain-plugin';

const delivery = await client.prepare({ workspaceId, bundleId, channel: 'stable', reporter });
const prepared = prepare(delivery);
try {
  const result = await graph.invoke(
    { messages: [prepared.systemMessage, { role: 'user', content: userRequest }] },
    prepared.runnableConfig({ configurable: { thread_id: jobId } }),
  );
} finally {
  await prepared.cleanup();
}
```

`prepared.runnableConfig()` merges Acclimate's version metadata, tags, and `callbackHandler` (which calls `reportStarted()` on chain/LLM start) into your `RunnableConfig`.
