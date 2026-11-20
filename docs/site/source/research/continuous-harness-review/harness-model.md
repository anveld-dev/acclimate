# Harness model review

Reviewed current Acclimate source on 2026-11-17, with read-only AgentRun `077b2fa1c831bdd2bbcb7ed7a0435914f48486b5` and RRSI `be50316e1db05914068a973f322770ef08ed7ba1` clones. No application changes, provider calls or experiments were performed. Findings distinguish implementation facts from recommendations for the new goal of a continuous self-improving harness.

## Assessment

Acclimate has a defensible **content revision and delivery** abstraction. It does not yet have a complete **harness revision** abstraction. The distinction is explicitly documented: [README.md:3](../../../README.md#L3) leaves the native SDK, tools, credentials and agent loop in the application. Keeping execution there is sound; treating the content digest as the identity of everything that was evaluated would be unsound.

The highest-confidence existing design restriction is narrower still: the automated proposer cannot add or remove any file, or change its kind. That prevents discovery of new skills or memory notes even within today's content scope.

## 1. High: automated proposals freeze the artifact inventory

**Evidence.** [src/improvement.rs:207](../../../src/improvement.rs#L207) requires a nonempty allowed-path set. At lines 239–243, every path must already exist in the parent. `validate_edits`, [src/improvement.rs:420](../../../src/improvement.rs#L420), rejects different file sets at lines 427–428 and kind changes at line 432. [ProposalRequest:56](../../../packages/sdk/src/types.ts#L56) exposes only the parent, allowed paths, hypothesis and string evidence.

**Failure scenario.** A coding agent repeatedly does manual steps that should become a new reusable skill. The proposer can rewrite existing content, but it cannot introduce `skills/new-helper/SKILL.md`, associated helper files or a new memory note. A prerequisite human must create a placeholder. Likewise the loop cannot prune an obsolete skill; it can only empty or edit its text. This is a genuine restriction in the existing learning interface, not merely the absent ability to optimize runtime code.

**Upstream comparison.** RRSI explicitly models structural edits for tools, skills, memory and subagents ([component vocabulary](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/components.py#L28-L46)). AgentRun's learning contract accepts new notes and whole skill/workflow drafts ([SPEC:125](https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/SPEC.md#L125-L145)). Their exact machinery need not be copied to support creation and retirement.

**Counterargument.** Fixed paths constrain mutation and simplify review. That is useful policy, but should be one mutation policy rather than the only available proposal model.

**Remedy.** Add a bounded artifact-change contract: edit existing paths, create under explicit prefixes, delete/retire explicit artifacts, and validate the final snapshot against native compatibility rules. Keep exact parent binding and immutable candidate digests. Gate helper code separately from prose. Start with new skill and memory artifacts; runtime-code evolution can remain application owned.

## 2. High for the expanded goal: a bundle version is not a harness version

**Evidence.** [BundlePayload:8](../../../packages/sdk/src/types.ts#L8) stores only files whose kinds are instruction, skill or memory. [VersionMetadata:21](../../../packages/sdk/src/types.ts#L21) binds the content digest. Evaluations additionally record a public string-map `runtime` ([types.ts:236](../../../packages/sdk/src/types.ts#L236)); [defineEvaluation:137](../../../packages/sdk/src/evaluation/definition.ts#L137) freezes that declared descriptor while the executable callbacks remain application functions at lines 159–165. This is descriptor consistency, not automatic measurement of installed SDK/tool/code/environment identity.

The repository starter already has stronger local evidence: source manifest hash, context-policy revision and selected-memory hash in [repository-job.mjs:504](../../../examples/native-repository/repository-job.mjs#L504). Explicit Codex model/config/environment are supplied separately in [harnesses.mjs:54](../../../examples/native-repository/harnesses.mjs#L54). Those are useful foundations, not evidence that a single shared harness revision exists.

**Failure scenario.** The same bundle is run after an application deploy changes tools, prompt assembly, memory selection or SDK version. A content digest alone cannot tell the learner whether a reward change was caused by its edit, and a channel rollback restores content without restoring those other factors. Runtime descriptors can encode these revisions by convention, but the generic interface does not require them and delivery receipts omit them entirely.

**Upstream comparison.** RRSI defines the mutable harness as prompts, control flow, tools, memory and context management, and candidates as Git revisions ([README:15](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/README.md#L15-L36)).

**Remedy.** Introduce an application-generated, immutable `HarnessRevision` manifest referencing content version/digest plus runner revision, native mapping revision, tool contract revision, model configuration, context/memory policy and relevant source/environment fingerprints. Exclude credentials. Bind execution observations and comparisons to it. Separate invariant evaluator/grader identity from candidate-varying harness identity: otherwise changing the harness configuration either violates the frozen evaluator descriptor or gets hidden inside an untracked callback. Acclimate can store references and hashes while execution remains in the application.

**Scope qualification.** This is not a bug in a deliberately content-only product. It becomes a conceptual gap if the product claims to version, roll back or continuously optimize the entire harness.

## 3. High: delivery receipts cannot serve as the learning experience stream

**Evidence.** [DeliveryReceiptRequest:300](../../../packages/sdk/src/types.ts#L300) records bundle identity, source and one of resolved/downloaded/verified/prepared/started. It has no execution/job/session identity, completion, task outcome, reward, trace reference or usage. The SDK creates a fresh event ID for each stage ([reporting.ts:37](../../../packages/sdk/src/reporting.ts#L37)); its binding is the bundle resolution, not a run. Reporting is expressly memory-only and optional ([reporting.ts:24](../../../packages/sdk/src/reporting.ts#L24)). Latest connection observation is one recently received receipt, ordered by server receive time ([integrations.rs:138](../../../src/integrations.rs#L138)), not an aggregate run state.

**Failure scenario.** Multiple concurrent jobs use the same bundle. A started receipt and a later receipt from another job cannot establish which task succeeded or failed. Nine started receipts are nine reported starts, not nine successful learning episodes. A real Codex response saved locally establishes execution happened; without a joined result/trace record it does not create feedback from which the service can learn.

**Remedy.** Preserve these lightweight delivery receipts. Add a distinct application-owned experience contract with stable execution ID, harness revision, task-family/input fingerprint, started/finished/failed facts, result/trace references, usage and feedback provenance. Support explicit retention/redaction/export rather than uploading raw private traces automatically. A learner should consume selected completed experiences and external feedback, never infer success from delivery stage.

**Counterargument.** The application may already own telemetry. Good: accept durable external references with provenance and a defined feedback import, rather than duplicate the runtime or make delivery failure depend on telemetry availability.

## 4. Medium: file kind conflates resource role with native instruction loading

**Evidence.** `FileKind` has only three values ([types.ts:1](../../../packages/sdk/src/types.ts#L1)); all instruction files map to one native instruction path ([native-files.ts:55](../../../packages/sdk/src/native-files.ts#L55)). Every non-generic target therefore allows at most one instruction file ([compatibility.ts:26](../../../packages/sdk/src/compatibility.ts#L26)); generic target bypasses those checks at line 16. Codex maps this to `AGENTS.md` ([codex-plugin:18](../../../packages/codex-plugin/src/index.ts#L18)).

**Failure scenario.** A generic bundle stores `AGENTS.md` plus a declarative JSON policy as instruction files and works in a simulator. It later fails native preparation because both are treated as top-level agent instructions. Calling it a generic bundle correctly makes no native compatibility promise, but the current kind vocabulary gives generic callers no neutral resource/configuration role. Reclassifying arbitrary config as memory or inventing a skill just to transport it distorts the domain.

**Remedy.** Distinguish instruction entrypoint, skill package, selected memory and ordinary resource/configuration. Have an explicit versioned delivery manifest define which bytes are native-loaded, supplied to tools or kept as data. Maintain native-target validation. Do not silently concatenate arbitrary JSON into `AGENTS.md` or silently switch native delivery to generic delivery.

**Counterargument.** Native delivery can deliberately reject multi-instruction bundles. That guard is valid; the resource taxonomy and explicit mapping interface are the area to improve.

## 5. Medium: approved-memory bytes lack an experience lifecycle

**Evidence.** Memory is a file kind. Native preparation returns every memory file ([native-files.ts:96](../../../packages/sdk/src/native-files.ts#L96)). The basic Codex example supplies their paths to a prompt as approved memory ([codex-agent.ts:62](../../../examples/codex-agent.ts#L62)). The repository starter improves this with explicit selection and a context-policy revision ([repository-job.mjs:430](../../../examples/native-repository/repository-job.mjs#L430)). No per-memory provenance, applicability, supersession or retirement is represented in the bundle type.

**Upstream comparison.** AgentRun has typed note metadata, supersession/status/origin ([SPEC:42](https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/SPEC.md#L42-L50)) and bounded relevance-based selection with launch-time omissions recorded ([SPEC:113](https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/SPEC.md#L113-L123)). That design has tradeoffs; it nevertheless distinguishes stored knowledge from the context actually supplied.

**Failure scenario.** Continual lessons accumulate, contradict one another, or apply to one task family only. Approval of a file does not establish universal relevance. If content-only provenance is sufficient initially, the application can implement all this, but the learner still needs a reproducible memory-selection record to explain measured changes.

**Remedy.** Keep immutable approved snapshots. Give learned records source-experience references, applicability, supersession/retirement and review state, then version the selection policy and record the effective selected set per execution. Generalized lessons should be candidates subject to checks; do not directly persist every reflection as approved memory.

## Preserve these choices

- Application-owned execution, credentials and model clients; neither AgentRun nor RRSI implies that Acclimate must host a runtime.
- Immutable content snapshots and exact version/digest evidence binding.
- Separate publication authority from evaluation and quality evidence.
- Native preparation failures instead of silently changing context delivery semantics.
- Private evaluation artifacts and deliberate review exports. The SDK already exposes explicit non-attestation ([artifacts.ts:88](../../../packages/sdk/src/evaluation/artifacts.ts#L88)); do not replace honest provenance with an implication that stored reports prove execution.

## Smallest coherent direction

Keep `BundleVersion` as immutable content. Add a referenced `HarnessRevision`, joined `Execution`/`Experience` records, and an artifact mutation policy that permits bounded creation and retirement. A continuous campaign can then select experiences, propose changes, evaluate exact harness revisions and publish eligible content for fresh jobs. This supports the user's objective without turning Acclimate into AgentRun's hosted runtime or pretending to reproduce RRSI's research optimizer.
