# Adoption and product-scope re-review

Disposition: **APPROVE**.

Reviewed PLAN.md revision D2, exact SHA-256 `9bd400d28d8e07f1906273dd7ead095c9add3f273e5e33adc5045fe9e23462e1`, on 2026-11-16. This approval applies only to that document revision and covers the adoption/product-scope perspective. It is approval of an implementation plan, not proof of implemented behavior, live reliability, or observed usability.

## UX-1 — accepted as resolved

D2 provides the missing headless preparation journey rather than requiring a manually created console handoff:

- PLAN.md:254 specifies the app-owned `request` command with explicit bundle/channel/candidate-payload/private-intent/public-output selections.
- :270 defines durable preparation: validate the locally installed definition and payload, resolve/freeze baseline/revision, persist the intent and exact operation data before mutation, create the immutable candidate using the existing durable draft route, verify its parent/content, create a retained request with `requireBoundEvidence:true`, and emit the normal handoff.
- :272 requires original-intent recovery before channel-drift decisions, rejects changed payload/definition/target under the same intent, preserves already committed request identity, forbids silent rebasing, and documents lost-intent uncertainty. It also states the complete request → run → check → export workflow ships in both languages without console authoring.
- :284 defines request-command exits independently from execution/quality.
- G20 at :527 explicitly qualifies clean external TypeScript and Python headless preparation, >24-hour creation-response-loss recovery, intent mismatch, baseline drift, and the rest of the workflow.

I checked current `src/drafts.rs:133–168`: the existing create operation accepts baseVersionId/baseRevision/payload, compares the current channel under transaction lock, and creates a direct-child immutable snapshot. That is a credible existing primitive for the proposed preparation rather than a hypothetical new candidate API. The plan's retained operation changes and original-intent rules make the response-loss requirement explicit.

These changes satisfy the minimum remedy and acceptance criterion from journey-r1. A future implementation must still qualify the actual tests; their presence in the plan is not a test pass.

## Rewalk and scope assessment

The interactive path remains coherent: acquire an exact release → configure delivery and evaluator access → verify content → attach the actual app → describe locally defined tasks/grading → preflight → save a candidate → create/download a request → run paired callbacks → inspect coverage and outcomes → check a separate app-owned quality policy → use separate release authority.

The newly specified headless path supplies the equivalent authoring/preparation step for CI without adding another public evaluator lifecycle or a service-selected executable. The reader-config verifier and explicit selection/mapper contract make second-person artifact review more concrete. Native durable job locators make uncertainty guidance actionable rather than merely advising the user to inspect an unnamed lost workspace. Python quiescence examples and cross-language gates retain the promised scope.

The release is substantial, but the work packages, dependency sequence, and all-language external-consumer gates make it a coherent milestone. Deferring dynamic credential management, remote heartbeat storage, per-case resume, arbitrary repository overlays, and statistical inference remains reasonable because none is required to claim the narrower supported journeys, and each limitation stays explicit. The plan does not claim static-grant restart overhead or remote progress has been solved.

The prior presentation advice remains nonblocking: teach a short initial command sequence, put administrator release handoff/source-build instructions on one canonical page, and qualify a working integration slice early without advertising incomplete parity. Those are implementation/documentation execution details within the existing plan.

## Final disposition

No unresolved blocking adoption/product-scope objection remains for D2 at the hash above. I am satisfied with the plan and approve it for implementation planning.

Source/document review only; no production source changes, model calls, browser use, external mutations, or runtime test claims.
