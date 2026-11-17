# Second pass: smallest coherent continuous learner

Reviewed 2026-11-17 at Acclimate `3de5ac433a5a6b3d1406efaa51e50283ec66d402`. Read all first-pass reports and checked the implementation evidence below. This is a skeptical design review, not an experiment. No application edits, tests, model calls or upstream benchmarks were performed.

## Verdict

The first review correctly identifies missing production integration, but its priority labels can imply a larger redesign than the goal requires. A continuously improving harness can keep its executable code fixed and improve its instructions or existing skills. It does not need to mutate every mechanism that RRSI can mutate. First deliver one resumable application-owned learner using the existing content, evaluation and release interfaces. Add central concepts only when that interface cannot express the demonstrated need.

The real requirements are durable learning decisions, trustworthy eligible feedback, stable experiment identity, and measured benefit on fresh tasks. Their ownership and storage location are implementation choices.

## 1. Uphold the mutation restriction; downgrade the claim that it blocks continuous improvement

The automated proposer really does require identical file sets and kinds ([improvement.rs:420](../../../../src/improvement.rs#L420)); its request names existing allowed paths. This blocks **repertoire growth** through that proposer. It does not block continuous refinement of an existing instruction, skill, or memory file. The twenty-round controller actually performs that narrower search and checks its candidate against an incumbent ([run.ts:265](../../../../examples/self-improvement/twenty/run.ts#L265)).

Nor is file creation absent from the platform: `CreateVersionRequest` accepts a full payload and parent ([types.ts:33](../../../../packages/sdk/src/types.ts#L33)), and the controller already calls `createVersion` with independently assembled bytes for the final release candidate ([run.ts:352](../../../../examples/self-improvement/twenty/run.ts#L352)). An application-owned proposer can therefore publish a new immutable candidate through the normal write interface, subject to its own capability checks and existing payload/native validation. This is a different authority from the bounded server proposer and should be explicit.

**Revised judgment:** high priority if autonomous creation of new skills is an acceptance requirement; otherwise a documented search policy restriction. Do not require add/delete/move and arbitrary executable mutation before demonstrating continuous fixed-file learning. If structural learning is needed, begin with bounded creation of a complete skill or memory artifact; deletion/rename/code evolution can wait for a real use case. Broadening a learner's authority is not itself an improvement in learning quality.

## 2. Uphold experiment identity; a new server `HarnessRevision` resource is optional

A content digest does not cover app code, tools or model/context choices. That distinction must remain explicit. But the current descriptor accepts application-owned runtime fields ([types.rs:118](../../../../src/types.rs#L118)), copies them into a frozen descriptor ([definition.ts:137](../../../../packages/sdk/src/evaluation/definition.ts#L137)), and compares the descriptor on request/report binding ([runner.ts:80](../../../../packages/sdk/src/evaluation/runner.ts#L80)). A canonical private manifest digest can already be carried there, with a retained local manifest and readable revision labels.

The repository starter already captures source, context-policy and selected-memory identities ([repository-job.mjs:504](../../../../examples/native-repository/repository-job.mjs#L504)); its documentation explicitly instructs the app to freeze source and include those identities in its declared revision ([README:94](../../../../examples/native-repository/README.md#L94)). Thus “no provenance support” would be false.

**Revised judgment:** require one app manifest convention and validation at resume, not immediately a new server resource. For a content-only campaign, fix the executable/tool/model protocol and bind its manifest digest. When a campaign intentionally changes those mechanisms, record separate parent/candidate manifest digests and keep the evaluator protocol invariant. The existing runtime map can express those references even though it does not validate their semantics. A dedicated wire type becomes useful for interoperability across independent apps, search over executable artifacts, or server-side policy enforcement. It is not a prerequisite for the first honest loop. A digest still does not attest that execution happened.

## 3. Uphold durable decisions; reject mandatory campaign server tables and automatic promotion

The example has process-local incumbent and decision assembly, then writes round artifacts ([run.ts:276](../../../../examples/self-improvement/twenty/run.ts#L276)). That is not a resumable recurring learner. Persisting the next action and exact external-operation identities before dispatch is necessary. However, neither this fact nor multi-round search requires the content service to acquire a scheduler or central campaign database.

Existing evaluator journals already retain request, attempt, idempotency keys, execution marker, report and completion ([journal.ts:58](../../../../packages/sdk/src/evaluation/journal.ts#L58)). A controller can own a small durable journal around those operations: campaign policy/manifest, observation cursor, incumbent, candidate/report references, decision, audit exposure, budget reservation, release intent and stop state. Start with one authoritative worker/store; introduce distributed ownership only when deploying multiple controllers.

Release authorization also exists: promotion records reviewer/evidence and uses an expected channel revision ([types.ts:37](../../../../packages/sdk/src/types.ts#L37), [channels.rs:157](../../../../src/channels.rs#L157)). Continuity of proposing and evaluating does not require unattended production release. An always-running learner may queue reviewed candidates. If automatic release is explicitly wanted, an application principal with narrow promotion authority can execute a versioned release policy while retaining the existing checks. Do not redefine `completed` to mean `better`, or make evaluation success implicitly grant release authority.

**Revised judgment:** high-priority production integration gap, not proof that the central domain model must be replaced. A separate persistent application learner module is the minimal addition.

## 4. Downgrade a new file kind from prerequisite to a demonstrated portability issue

The native preparer rightly limits instruction files to one; skill files already support a package tree with a required `SKILL.md` ([compatibility.ts:26](../../../../packages/sdk/src/compatibility.ts#L26)). A generic bundle that labels both `AGENTS.md` and a JSON data file as instructions cannot be assumed portable to native preparation. The recent local failure establishes that mismatch, not that continuous learning is impossible.

For a fixed-harness pilot, keep app configuration in the versioned app manifest/source inventory, and place skill-specific data under its actual skill package when that role is true. Do not relabel arbitrary data as memory merely to pass validation. A neutral resource role or explicit delivery mapping is justified if independently delivered non-skill data is part of the product contract. Avoid changing file kinds, all native mappings and both SDKs just to accommodate a simulator's temporary JSON policy placement.

## 5. Uphold the semantic distinctions; typed storage and a second model are optional

Delivery receipts stop at `started` and cannot establish task outcomes ([types.ts:300](../../../../packages/sdk/src/types.ts#L300)). Keep that telemetry honest. A learner must consume correlated task outcomes and explicitly eligible corrections; successful fetches or a plausible final answer do not prove improvement.

But `evidence: string[]` ([types.ts:56](../../../../packages/sdk/src/types.ts#L56)) can carry a bounded rendered view of an application-owned experience ledger. First define eligibility, scope, source authority and provenance in that ledger; retaining JSON envelopes and digests locally is sufficient for one application. A new central `Experience` table or mandatory model admission call is not the missing guarantee. Typed metadata cannot make an untrusted claim authoritative. Human admission or deterministic domain checks can be adequate for the first loop.

The current once-used audit deliberately stops on failure ([run.ts:364](../../../../examples/self-improvement/twenty/run.ts#L364)). Preserve that; do not report that the repo has no holdout. For recurring operation, retain audit exposures and stop or rotate the audit regime rather than retry until a selected candidate passes.

## Minimal product and acceptance test

**Product:** one application-owned learner with a durable journal, a fixed installed harness/evaluator, existing content/version/evaluation interfaces, and explicit release review. It continually ingests eligible task outcomes and tests bounded changes to one existing skill. It retains rejected decisions and does not require new server schemas, generalized workflows, or executable mutation.

A meaningful integration qualification should exercise:

1. Freeze a baseline content version, app/evaluator manifest, objective, eligible development cohort, untouched audit cohort, and finite budget. Persist their identities before launching work.
2. Execute normal fictional app tasks with stable run/attempt IDs; retain actual terminal outcomes, usage with unknown values allowed, and trace references. Produce one authorized correction from an observed baseline failure; reject an untrusted planted instruction as learning input.
3. Persist a proposal intent/idempotency key, generate a bounded edit to an existing skill, and retain its immutable candidate. Evaluate candidate and incumbent on matching development tasks in fresh jobs under a recorded protocol. Require one deliberately regressing candidate to remain recorded and unselected.
4. Terminate the controller after report acceptance but before its local search-decision commit. Resume the same campaign from the stored operation identities, reconcile the report, and record exactly one search decision without rerunning already completed native work. If launch completion is uncertain, quarantine/reconcile rather than treating it as safe to repeat. Verify the budget survives restart.
5. Freeze the selected candidate, consume the separate audit once, and queue an explicit release review. A failed audit stops the release; it never feeds detailed audit answers back into another proposal within that audit epoch.
6. Approve a release using the current expected channel revision. Verify a concurrent channel change rejects stale release intent. A fresh app job must resolve the released content; an already prepared job must retain the old version. Compare a fresh candidate job with a pinned-baseline control and retain its measured result.
7. Admit a second batch of ordinary outcomes and begin the next bounded round in the same persistent campaign. Demonstrate the loop is recurring rather than a one-shot seeded benchmark. Hold releases for review unless automated rollout was explicitly configured.

First run deterministic fixtures to qualify state/recovery semantics; then opt into bounded live SDK runs to validate the native integration and actual learned behavior. Neither kind of run was performed during this review. Passing the test establishes this narrow learner, not broad transfer, statistical certainty under indefinite search, or equivalence to AgentRun/RRSI.
