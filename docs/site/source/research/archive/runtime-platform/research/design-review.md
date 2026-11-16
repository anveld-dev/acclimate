# Design review

**Archived proposal — superseded by the smaller content service.** [Current overview](../../../../design/overview.md).
**2026-11-13 · All findings addressed**

For example, if a user cancels just after a worker commits an intent to send a request, that request may still go out. The design records this race and requires reconciliation; it does not claim cancellation can recall the request.

The independent review found three contract issues and two smaller clarifications. The design now handles all five. This is a documentation review, not a runtime test result.

## What changed

| Finding | Resolution |
| --- | --- |
| Cancel can race with a committed intent. A database fence can't stop a later network send. | Intent commit is the admission point. Cancel blocks new admissions; earlier admitted work may still send. Local containment and later reconciliation are separate checks. |
| A complete result may lack usage, so accounting can't always be finally settled before delivery. | Save `usage_unknown` and keep a conservative hold. The result can return while final settlement stays pending. |
| The first adapter may not support durable approvals/checkpoints. | Enable guarantees only after conformance tests pass. Ship an explicit lower tier or add a managed adapter. |
| Approval identity was tied to an attempt in one note. | Bind it to the logical effect and run/session. Attempts are audit context; resume revalidates ownership and policy. |
| Declared edit counts don't prove semantic diff size. | Treat the budget as search regularization, not a security boundary. Keep static edit-surface checks. |

See [effects and recovery](../design/runtime/execution.md#effects-and-recovery), [adapter admission](../design/runtime/execution.md#harness-adapter-contract), and [race checks](../design/roadmap.md#2-recover-effects-safely).

## Source checks

AgentRun's [fence predicate](https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/store/fence.ts#L29-L37) protects storage writes. Its [proxy](https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/run-adapters/src/host/proxy.ts#L1-L75) allows unknown usage/cost. RRSI's floor, cost branches, guards, and winner ordering match the [research summary](../../../rrsi.md#selection-exactly).

The fixes were checked against the docs and source. They haven't been proven in a running implementation or a second independent review.
