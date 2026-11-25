# Ticket triage

One script that runs a learning loop end to end over the API. It publishes a bundle whose instructions only say "reply with the queue", imports 64 labelled tickets as exact-match tasks, starts learning and reports each round. The [walkthrough](../../apps/docs/content/docs/tutorials/first-learning-round.mdx) explains each step and shows a real run.

| File | Contents |
| --- | --- |
| `bundle/instructions.md` | The starting instructions. They do not name the queues. |
| `tickets.csv` | 64 tickets with `input` and `expected` columns. The expected value is one of eight queue names. |
| `loop.ts`, `loop.py` | The same script in TypeScript and Python. |

## Run it

The script needs a service with an optimizer model, an executor, and a verified model provider on the workspace. The [local stack](../../apps/docs/content/docs/reference/local-stack.mdx) started with a [model provider](../../apps/docs/content/docs/tutorials/first-learning-round.mdx#connect-a-model-provider) has all three.

| Variable | Value |
| --- | --- |
| `ACCLIMATE_URL`, `ACCLIMATE_WORKSPACE` | The service address and the workspace. `source .local/stack/env.sh` sets both for the local stack. |
| `ACCLIMATE_TOKEN` | A machine token with read, write and promote. With it, the task list holds evolve tasks only and counts the held-out ones. |
| `TASK_MODEL`, `JUDGE_MODEL` | Two different models from the provider's allowed models. `env.sh` sets them to the first two of `ACCLIMATE_PROVIDER_MODELS`. |
| `ACCLIMATE_BUNDLE_NAME`, `ACCLIMATE_SCOPE`, `ACCLIMATE_CACHE` | Optional. The bundle's name (`Ticket triage`), the client's cache scope, and the directory that caches verified versions. |

From the repository root:

```sh
npx tsx examples/ticket-triage/loop.ts
# or
python examples/ticket-triage/loop.py
```

Running it again reuses the bundle, its learning settings and the import, and goes back to watching. It starts a loop only when the loop has never run, so a loop you paused or stopped stays that way. Learning runs on the service, so stopping the script does not stop it. Pause or stop learning on the bundle's **Learning** tab.

## The split

The service assigns each row to evolve or held-out by a hash of the file's bytes and the row number. This file puts 32 tickets on each side, with every queue at least three times on both. Changing any byte of the file changes the split.
