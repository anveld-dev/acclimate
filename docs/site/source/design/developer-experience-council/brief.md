# Developer experience design council brief

Requested 2026-11-16. Deliver a finalized, implementation-ready plan addressing the [seven-persona review](../../research/developer-experience-review/README.md). This work designs the changes; it does not implement or deploy them.

## Process

1. Eight design agents independently propose interfaces and workstream designs grounded in current source. The coordinator integrates them and records tradeoffs.
2. A new batch of independent critique agents reviews the integrated plan against concrete acceptance criteria and failure scenarios. Each records blocking objections, nonblocking advice, and an explicit disposition.
3. The coordinator resolves objections, revises the plan, and asks each reviewer to check the exact final revision. Consensus requires explicit satisfaction from every critique reviewer on that revision. Silence, majority votes, and implied approval do not count.
4. Record the final plan's SHA-256, reviewer dispositions, objection resolutions, implementation sequence, acceptance gates, and deferred scope. Material later changes invalidate that consensus.

## Constraints

- Preserve application-owned agent execution, tools, model credentials, and grader behavior.
- Requests are public configuration and identity, never code/module/path/URL execution instructions.
- Preserve immutable versions/digests, fixed paired inventory, isolated inputs, attempt/principal/report binding, and explicit promotion with revision checks.
- Completion, quality-policy satisfaction, and release authorization have separate meanings.
- Preserve exact report replay and refusal to reexecute ambiguous attempts. Do not promise exactly-once model calls or infer stopped execution from a stale heartbeat.
- Human membership, published-content delivery, evaluator authority, and promotion rights remain distinct.
- Retain safe errors and private files; add useful diagnostics without logging arbitrary server/provider text, secrets, raw runtime configuration, or private paths.
- Support installed external consumers: documented package exports, release artifacts, runtime prerequisites, and Python capability scope must be explicit.
- Prefer a small public interface with lifecycle/recovery complexity hidden in a deep module. Specify error modes, ordering, ownership, cleanup, retry, cancellation, concurrency, performance limits, and compatibility as part of that interface.
- Scope must cover custom eval integration, first-comparison onboarding, Python orchestration, CI verdicts, diagnostics/evidence sharing, and existing-repository native integration. Separate advanced research/long-run features into explicit follow-ups if deferred.

## Dependencies and design vocabulary

Use module, interface, seam, adapter, depth, leverage, and locality precisely. Read `CONTEXT.md` for product domain language. In-process dependencies include descriptor normalization, comparison/policy computation, and error classification. Local-substitutable dependencies include private filesystem/journals, OS locks, and deterministic fixture execution. The Acclimate HTTP service is remote but owned: reuse the SDK client and an internal fake adapter for contract tests. Model/harness execution is true external: injected application callbacks, deterministic adapters in default tests, and opt-in separately reported live qualification.

The first three designers must explore genuinely different evaluator interfaces: minimal deep module, flexible application-owned orchestration, and common-caller application starter. Other designers specify the surrounding product journeys and operational contracts. The coordinator chooses one coherent interface, not all alternatives.

## Outputs

Each designer writes only their assigned file under `proposals/`, including source anchors, a concrete example, contracts and invariants, alternatives/rejected choices, compatibility/migration, file-level implementation scope, acceptance checks, risks, and decisions needed from integration. Do not edit application source, invoke paid models, inspect secrets, mutate external systems, run browsers, or spawn children.

The final plan and consensus ledger will live beside this brief. This is an agent design/review exercise, not real-person usability evidence or proof of runtime correctness.
