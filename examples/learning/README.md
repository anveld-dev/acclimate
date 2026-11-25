# Sample learning tasks

`example-agent-tasks.jsonl` holds 60 tasks for the **Example agent** bundle that `npm run local:up` publishes in the `local-demo` workspace. That bundle is a support agent for a small software company. It answers in two short paragraphs and asks one clarifying question when the request is ambiguous.

Each line is one row:

| Field | Holds |
| --- | --- |
| `request` | The customer message, which becomes the task input. |
| `ideal_reply` | A reference reply that follows the bundle's instructions. |
| `rubric` | Four pass-or-fail criteria the ideal reply meets, each checkable from the reply alone. |

The requests cover billing, sign-in, bugs, exports, permissions, integrations and ambiguous requests. Because every row has its own rubric, the judge model uses those criteria as written and does not draft new ones.

## Import it

1. Start the local stack with `npm run local:up` and sign in to the console.
2. Open the **Example agent** bundle and go to the **Learning** tab. Set the task and judge models first if the loop is not configured yet.
3. Under **Import material**, choose `example-agent-tasks.jsonl` and select **Import tasks**.

The judge model converts the rows into task cards and the service splits them into evolve and held-out tasks. Each task then passes the admission check before it counts. Review the cards before you start a round. Importing the same file again returns the earlier import, and an edited copy sets aside the rows whose request is already a task with the reason `duplicate`.

The [support agent walkthrough](../../apps/docs/content/docs/tutorials/support-agent.mdx) runs an application on this bundle before and after a round. The [support agent example](../support-agent/README.md) is that application.
