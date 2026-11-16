# Source audit: the details that matter

These source observations informed an earlier runtime exploration. The [current service design](../design/README.md) adopts only the content/versioning lessons, not its execution infrastructure.
**2026-11-13 · Read-only inspection, no test execution**

A worker may lose ownership after sending a request. The storage fence can reject its later writes, but cannot undo that request. This page traces that distinction and other design decisions to pinned source; inspection alone does not prove the tests pass.

## Claims and fencing are implemented in storage

AgentRun claims eligible work and advances its epoch in one transaction. Renewal checks time after locking and can't revive an expired lease. Writes check run ID, epoch, and deadline. PostgreSQL uses its clock. This protects state writes; it can't retract an external call. [Claim implementation][claims] · [Fence][fence].

The runner owns claims/commands; the harness loop can end, interrupt, or park. Shutdown can leave recoverable work; cancellation is final. The earlier Rust runtime proposal simplified that lifecycle. [Loop contract][contract].

## Durability has an ordering requirement

Barrier tests expect **intent → durable sync → dispatch → outcome**. Failed sync blocks dispatch. Inspecting the tests shows intended ordering, not passing behavior. A runtime adopting that ordering needs tested storage durability; it is not part of this content service's SDK contract. [Barrier tests][barriers].

## The model proxy is an enforcement point

The proxy keeps the provider credential, restricts routes, validates requests, checks admission, and allows unknown cost. A hard cap needs every paid route to pass through it. Another usable credential or egress path weakens that guarantee. [Proxy][proxy].

## Learning is more than appending memory

Checks restrict file paths/modes/sizes, host metadata, edits/deletes, and skill eligibility. Grading screens generality, injection, secrets, duplicates, conflicts, and risk. The commit API detects duplicate merges and changed evidence. Those are useful layers, not proof malicious content can't pass. [Checker][check] · [Grader][grade] · [Commit][commit].

Workflow dry runs synthesize model/tool responses and inspect the exercised path. They don't establish real output quality or full branch coverage. [Learning contract][learn].

Claimability tests cover parked work, commands, backoff, shutdown, and expiry. Learning tests cover reflection with completion, one draft repair, and the three-run skill-to-workflow prompt. They weren't run here. [Claim tests][claimtests] · [Learning tests][learntests].

## RRSI: exact selection semantics affect the product design

RRSI's floor uses the best accepted score. Within its noise band, cost or novelty can justify a small score drop. Equal-score candidates keep input order. Search acceptance doesn't imply statistically better quality or release readiness. [Selection][selection].

Cost averages positive observed tokens. Missing cost becomes zero relative change. Aggregation also relies on adapters for complete task/trial slots. The current service can validate reported inventory and cost completeness; it cannot certify remote execution. [Aggregation][aggregation].

Repeated baseline runs or a within-task bootstrap set the noise band. One observation per task can't reveal unseen within-task variance. Use repeated measurements and a positive minimum tolerance. [Calibration][calibration].

The history prompt is bounded: normally up to 40 recent records and at most four unmeasured ones. Keep the full ledger separately from proposer context. [History rendering][history].

The domain adapter cleanly owns execution, scoring, splits, traces, smoke checks, and guards. The current design leaves those functions in application code. Git branches, frontier files, and history aren't one atomic transaction; a channel update needs a recorded expected-old revision. [Domain][domain] · [Frontier writes][frontier] · [Round completion][round].

## Scope of confidence

These findings support the design and its acceptance tests. They don't establish throughput, savings, security, upstream test health, or improvement on this workload. Those need a prototype and representative experiments.

[claims]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/store/sqlite/store.ts#L1533-L1590
[fence]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/store/fence.ts#L1-L37
[contract]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/runner/loop-contract.ts#L49-L140
[barriers]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/run-adapters/test/barrier.test.mjs#L21-L117
[proxy]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/run-adapters/src/host/proxy.ts#L1-L75
[check]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/check.ts#L260-L317
[grade]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/grade.ts#L19-L108
[commit]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/commit.ts#L101-L127
[learn]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/SPEC.md#L84-L99
[claimtests]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/test/store-claimable.test.mjs#L8-L101
[learntests]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/test/runner-learning-end.test.mjs#L105-L214
[selection]: https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/selection.py#L97-L137
[aggregation]: https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/evaluate.py#L104-L135
[calibration]: https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/calibrate.py#L56-L114
[history]: https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/history.py#L166-L185
[domain]: https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/domain.py#L63-L117
[frontier]: https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/loop.py#L105-L117
[round]: https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/loop.py#L306-L346
