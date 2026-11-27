# Support agent

A small application that answers one support request with the bundle released on a channel, in TypeScript (`agent.ts`) and Python (`agent.py`). Both send the bundle with the SDK's system prompt helper, so the model sees what the learning loop scores. The [walkthrough](https://acclimate.anveld.dev/docs/tutorials/support-agent) goes from the first answer to an improved release driven by imported evaluation tasks.

## Run it

| Variable | Value |
| --- | --- |
| `ACCLIMATE_URL`, `ACCLIMATE_WORKSPACE` | The service address and the workspace. `source .local/stack/env.sh` sets both for the local stack. |
| `ACCLIMATE_TOKEN` | A machine token with read access. |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `AGENT_MODEL` | An OpenAI-compatible base URL such as `https://api.openai.com/v1`, its key, and the model that answers. `env.sh` sets them when the stack was started with a [model provider](https://acclimate.anveld.dev/docs/reference/local-stack#run-learning-rounds). |
| `ACCLIMATE_BUNDLE_NAME`, `ACCLIMATE_CHANNEL` | Optional. The defaults are `Example agent`, which the local stack publishes, and `stable`. |

From the repository root:

```sh
npx tsx examples/support-agent/agent.ts "I was charged twice this month."
# or
python examples/support-agent/agent.py "I was charged twice this month."
```

The reply goes to standard output and the version that produced it to standard error.

## Tasks for this agent

[`../learning/example-agent-tasks.jsonl`](../learning/README.md) holds 60 tasks for the same bundle. Import them on the bundle's **Learning** tab (or via `POST /learning/tasks/import`) to build the evaluation suite and run learning rounds.
