# What we're building

**Archived proposal — superseded by the smaller content service.** [Current overview](../../../../design/overview.md).
[Design guide](README.md)

**Proposed design.** Acclimate runs agent tasks reliably, then tests changes that might make future tasks work better.

The model itself isn't retrained. We change the **harness** around it: instructions, skills, approved memory, context settings, and eventually task-harness code.

## One normal job

An app asks for a pull-request review through a client SDK. Rust picks the approved version, gives a worker the job, and tracks its state and budget. The worker runs the selected harness through an adapter in a sandbox. Model/tool requests pass through a controlled gateway. The app gets a saved review and run history. The intended production sandbox is a restricted Linux container on a worker host; if required isolation is unavailable, the worker rejects the job instead of running it locally. See [execution and isolation](runtime/execution.md#process-supervision-and-isolation).

An **adapter** translates one native harness's SDK or protocol. It lets us use Claude, Codex, Pi, or fx without rewriting each agent loop in Rust.

## One improvement

Suppose reviews often miss retry bugs. The improvement job proposes `skills/retry-review.md`, which tells the agent how to inspect retry paths.

| Step | What it produces |
| --- | --- |
| Propose | A hypothesis, file diff, and new frozen package. |
| Test | Current/candidate runs on the same tasks in separate sandboxes. |
| Grade | Scores and explanations from a separate grader. |
| Choose | A recorded keep/reject/inconclusive decision. |
| Release | A fresh audit evaluation, operator approval, and rollout record. |

The new skill only reaches future jobs after release. It doesn't rewrite an active agent's memory. Candidate changes cannot replace the adapter, grader, permissions, or release rules.

[How evals run](evaluation/workflow.md) shows the containers, files, and grading flow in detail.

<!-- diagram:overview-loops -->

## Who writes what?

| Author | Their part |
| --- | --- |
| Application developer | Uses the client SDK to submit work, follow events, and read outputs. |
| Harness integrator | Implements an adapter using a native SDK/RPC. |
| Task/domain author | Supplies task snapshots, setup, and output collection. |
| Grader author | Defines how saved outputs are scored. |
| Rust platform | Owns scheduling, permissions, budgets, durable records, and deployment. |

Python and TypeScript helpers make plugins easier to write. Other languages can use the same process protocol. A plugin is an integration; a sandbox is the isolated environment it runs in. Neither a native plugin nor MCP alone supplies our recovery or release guarantees.

## Terms you'll see

A **HarnessPackage** is a frozen set of harness files. An **AgentVersion** combines it with model/configuration and adapter requirements. A **run** is one task; an **attempt** is one worker episode of that run. An **evaluation** is a planned comparison; a **trial** is one version/task/repetition. A **campaign** groups improvement work under one budget.

**Next:** [How evals run](evaluation/workflow.md), then [SDKs and plugins](integrations/sdk.md).
