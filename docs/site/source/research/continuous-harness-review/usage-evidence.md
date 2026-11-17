# Usage evidence and the local harness demonstration

Review date: 2026-11-17. Acclimate source baseline: `3de5ac433a5a6b3d1406efaa51e50283ec66d402`. This is a source review of a recently executed local demonstration, not a new benchmark.

## Finding: delivery observations cannot serve as the learning dataset

**High priority for continuous learning; valid design for optional delivery telemetry.** The public receipt schema contains event, integration, bundle/version/digest, delivery stage, source and timestamps. Its last stage is `started`. There is no logical task/run/attempt identity, completion outcome, correction provenance, grade, tool trajectory, or resource usage ([schema](../../../packages/sdk/src/types.ts#L300-L318)). The reporter intentionally uses a memory-only queue, gives each observation a fresh UUID, and permits delivery to succeed without reporting ([implementation](../../../packages/sdk/src/reporting.ts#L24-L44)).

A connection with many `started` observations can therefore represent repeated smoke checks, retried harness setup, successful tasks, or tasks that later fail. Counting these observations as successful usage or learning opportunities would be a conceptual error. Do not change best-effort delivery telemetry into a mandatory execution dependency to fix this.

Add a separate app-owned **task outcome record**: stable run/attempt identity, pinned content and harness identities, completion/failure/uncertain status, retained trace reference/digest, observed token/cost data with unknown values preserved, authorized feedback provenance, and a reviewed eligibility decision for use in learning. An outbox or explicit durable export should handle collection. The app still owns execution; this does not require Acclimate to host it.

## What the local demonstration actually establishes

- Two connections fetched and prepared actual bundle content and emitted delivery receipts.
- A Codex SDK harness completed a live Luna task using the pinned content. Its saved final response addresses the fictional lost-payment-response scenario.
- A separate installed deterministic payment adapter executed six paired cases and submitted a complete comparison. Its scores describe a simulator, not the Codex harness response.
- The harness output retains model label, content version/digest and final response, but not its full SDK event stream, commands, resource-read evidence, final usage, or an independent grade ([original example](../../../examples/codex-agent.ts#L65-L91); [local output](../../../artifacts/local-harness-usage/codex-run.json)). The prompt requested reading instructions; the retained final response alone cannot prove the exact reads.
- Receipt history includes repeated delivery checks and starts while adapting the harness runner. It must not be presented as that many successful Codex tasks.

These facts prove live integration and one completed model response. They do **not** prove that production outcomes feed a learner, that the learner improves its own harness, or that a learned revision transfers to future tasks.

## Minimum demonstration that would establish a closed loop

Freeze a small fictional task set with separate development and audit cases. Execute a pinned baseline harness and persist outcomes/traces. Derive reviewed development feedback, create a bounded candidate with parent linkage, execute paired comparisons, and keep rejected attempts. Freeze the selected candidate before the separate audit. Record an explicit release decision under a versioned policy; start a fresh app job that resolves the released candidate and compare with a pinned-baseline control. Retain harness manifest, evaluation protocol and all run identities throughout.

The repository's existing [live learning qualification](../../../examples/self-improvement/README.md) already follows much of this experiment design. The missing production design is the durable interface and controller around ordinary app outcomes, rather than additional seeded receipts.
