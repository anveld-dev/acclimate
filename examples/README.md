# Examples

Each example runs against an Acclimate service. The quickest service is the [local stack](../apps/docs/content/docs/get-started/run-locally.mdx), started with `npm run local:up`. The documentation has a walkthrough for each learning example under [Examples](../apps/docs/content/docs/examples/index.mdx).

| Example | Shows | Needs |
| --- | --- | --- |
| [`support-agent/`](support-agent/README.md) | An application that answers with the released bundle and reports a person's correction as a learning task, in TypeScript and Python. | A machine token with read and write, and an OpenAI-compatible model. |
| [`ticket-triage/`](ticket-triage/README.md) | A script that publishes a bundle, imports 64 labelled tickets, starts the learning loop and reports each round, in TypeScript and Python. | A machine token with read, write and promote, a verified model provider and an optimizer model. |
| [`learning/`](learning/README.md) | 60 support tasks with their own grading criteria, ready to import in the console. | The local stack's **Example agent** bundle. |
| [`delivery-check.ts`](delivery-check.ts), [`delivery_check.py`](../python/examples/delivery_check.py) | Preparing a released version for a connection and reading back the verified files. | A connection and its content-read credential. |
| [`publish.ts`](publish.ts) | Creating a bundle, its first version and its first release from a payload file. | A machine token with write and promote. |
| [`claude-agent.ts`](claude-agent.ts), [`codex-agent.ts`](codex-agent.ts), [`cursor-agent.ts`](cursor-agent.ts) | Running a coding agent on prepared files with the native plugins. See [native integration](native-integration.md). | The agent's SDK and credentials. |
| [`native-repository/`](native-repository/README.md) | A starter that stages an existing repository for Codex, Claude, Cursor or Pi, with an offline replay harness. | Node.js 22.22 or later. |
| [`self-improvement-memory/`](self-improvement-memory/README.md) | A parked experiment that used the removed application-side loop. It does not run on this build. | |

Run the TypeScript examples from the repository root with `npx tsx`, after `npm ci --ignore-scripts`. The Python examples need Python 3.11 or later and the SDK, installed with `python -m pip install ./python`.
