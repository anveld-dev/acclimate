# Independent TypeScript installed-app review — round 2

Disposition: **APPROVE**.

Reviewed PLAN.md revision D2, SHA-256 `9bd400d28d8e07f1906273dd7ead095c9add3f273e5e33adc5045fe9e23462e1`, on 2026-11-16, together with RESOLUTIONS.md and the current-source extraction hazards identified in round one. I am satisfied with this revision's TypeScript installed-app/interface design. There are no unresolved TypeScript blocking objections.

This approval applies to that exact plan digest. Material changes require another review. It approves a specification and implementation plan, not implemented behavior, passing runtime gates or observed usability.

## Resolution of original blockers

| Finding | Disposition | Verified remedy |
| --- | --- | --- |
| TS-1 — CLI/artifact integration interface | Accepted/resolved | Section 9 now declares the static `evaluationMain(..., options.review.toReviewArtifact)` registration, closed data-only ArtifactSelectionV1, mapper identity/value/result types and the concrete `--selection` command. No selection means scalar-only; selected content without a mapper is an error; no executable/module discovery is introduced. G13/G22 require the actual installed consumer path. |
| TS-2 — VerifiedBundle isolation | Accepted/resolved | Section 3 requires a module-owned immutable verified snapshot and a fresh deep payload-and-metadata copy for each execute invocation. It explicitly excludes mutable bundles from shared callback/recovery state and limits native filtering to owned effective views. G09 covers attempted bundle mutation across repetitions and both languages. |
| TS-3 — Callback order and uncertainty escape | Accepted/resolved | Section 3 specifies parent execute → parent grade → candidate execute → candidate grade, with no next pair until settlement. It explicitly disallows treating unchanged low-level `compare({concurrency:1})` as equivalent. ExecutionUncertainError from either execute or grade bypasses ordinary failure classification, stops scheduling and prevents sealing/submission. G08/G09 test that trace and escape behavior. |

The nonblocking round-one interface refinements were also addressed: actual declarations preserve captured generics, high-level EvaluationGradeResult names the private explanation extension, the descriptor is defensive/deeply frozen, report admission has an actionable budget code, and implementation ownership is explicit.

## Material seams rechecked

- **External adoption:** the definition/describe/doctor/run path uses installed package surfaces and an app-owned static entry point. The new headless request command closes the former CI candidate/request-authoring gap without promotion or model calls. Its private intent freezes creation inputs/keys and recovers committed results before considering channel drift.
- **Package/module split:** descriptor and policy remain pure browser-safe modules; Node execution/CLI/artifact implementation stays on explicit subpaths. Package copying/export-map work and clean tarball/wheel consumer gates are mandatory. No dependency on examples/scripts is permitted in shipped output, and native peers are optional for deterministic use.
- **Lifetime and recovery:** explicit private config owns transport identity; exact bodies/keys and retained operations own response-loss recovery. Callback-resource quiescence, real cancellation versus uncertainty, and current lifecycle checks remain distinct. The new private ExecutionContext/native job record makes durable locators available without exposing arbitrary journal control or remote executable selection.
- **Portable evidence:** selected local content requires the exact originating scope, sealed report, confirmed authoritative comparison and index/file integrity before the mapper sees a role-only payload. Scalar-only export does not invent local-file inspection. Reader-config online verification requires an independently chosen handoff, not a manifest-selected credential target. These contracts are now usable by the documented external CLI caller.
- **Results and limits:** execution completion, quality policy and release authorization remain separate. Report/request/JSON-response budgets are now distinct and bounded; size failures cannot authorize execution replay. The fixed execution order and descriptive policy semantics do not imply unbiased statistical evidence.
- **Compatibility:** raw SDK clients and lower-level compare remain supported. Historical descriptors/journals are not silently rewritten with new reserved runtime keys. The dedicated compatibility wrapper and legacy unknown-submission rule are explicit; no cross-language takeover or downgrade promise is made.

## Remaining advice, not blockers

The interface is broader when the request command, policy and artifact helpers are counted, but their separation is coherent: ordinary app code still learns one definition and the three evaluator operations, while the CLI adapter handles the complete workflow. Keep the starter's default path short and expose evidence selection/native recovery as adjacent documented tasks rather than making every adopter understand them before their first deterministic run.

During implementation, compile both inferred and explicitly interface-typed TypeScript fixture inputs under strict mode. Ensure the JSON-value constraint does not force normal application interface types to add arbitrary index signatures; runtime JSON validation remains authoritative. This is a declaration usability check, not a reason to relax the stated persistence contract.

## Verification limits

Read the revised normative plan and objection ledger and checked its exact SHA-256. No dependency installation, implementation tests/builds, service requests, browser sessions, native providers or paid calls ran. Implementation must still satisfy the plan's acceptance gates, including public-interface and installed-consumer checks.
