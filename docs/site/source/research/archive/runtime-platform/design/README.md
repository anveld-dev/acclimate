# Acclimate design guide

**Archived proposal — superseded by the smaller content service.** [Current overview](../../../../design/overview.md).
**This is a proposal. The runtime and SDK do not exist yet.**

Imagine an app asking an agent to review a pull request. Acclimate is intended to run that review, save its history, and test changes that could make later reviews better.

Start with the [overview](overview.md) for one job and one improvement. Then follow [how evals run](evaluation/workflow.md) to see how reviews are compared, or use the [roadmap](roadmap.md) for the build order and demos.

When you need a contract, pick the part you are working on:

- **Run and operate jobs:** [execution and recovery](runtime/execution.md), [deployment and operations](runtime/production.md), and [qualification](runtime/qualification.md).
- **Connect an app or harness:** [SDKs and plugins](integrations/sdk.md) and the [process protocol](integrations/protocol.md).
- **Measure and improve:** [task and score contracts](evaluation/contracts.md) and [improvement and selection](evaluation/selection.md).

Names and methods are draft contracts. [Research](../../../README.md) holds source evidence and limitations.
