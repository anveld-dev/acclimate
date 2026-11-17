# RRSI review: continuous harness improvement

Reviewed 2026-11-17. Read-only review of Acclimate at `3de5ac4` and RRSI at `be50316e1db05914068a973f322770ef08ed7ba1`. RRSI source was read from the existing reference checkout and its pinned GitHub pages were checked. No upstream experiments, tests or model calls were run. Findings below are design inferences, not reproduced performance results.

## Verdict

Acclimate has useful evidence and delivery primitives for content optimization. They do not yet describe a complete continuously improving executable harness. The most consequential mistake would be treating a bundle version as the whole harness identity or a completed comparison as proof of general improvement. The app-owned execution choice is compatible with RRSI and should stay.

## 1. High: a content version cannot identify an executable harness change

Acclimate's stored version identifies a parent and content digest; its payload is a list of text files ([types.rs](../../../src/types.rs#L15-L46)). That is a valid content artifact. The public comparison has a shared runtime description, validated for nonempty identity fields, rather than separate immutable execution manifests for each arm ([improvement.rs](../../../src/improvement.rs#L4-L16)). The native repository starter already freezes source bytes and asks applications to include the source, context-policy and memory digests in revisions; it explicitly describes those revisions as app assertions ([native starter](../../../examples/native-repository/README.md#L96)). Therefore claiming there is no provenance support would be wrong.

But a content digest alone cannot tell whether a gain came from a prompt edit, a changed context selector, a different tool implementation, or a changed harness program. The existing shape is especially awkward when the intended candidate deliberately changes those runtime mechanisms. RRSI's mutation vocabulary includes control flow, context management, tools and subagents, as well as prompts/skills/memory ([components.py, lines 44–46](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/components.py#L44-L46)).

**Remedy:** introduce an application-owned immutable `HarnessSnapshot` manifest that references content version/digest, executable code artifact, dependency lock, tool implementations/configuration, context/memory policy and model settings. Reference separate parent/candidate manifests in evidence. Keep the benchmark/grader and other experimental controls fixed and separately identified. Acclimate can store references and verify bindings without hosting or executing that code. A content-only optimization remains a supported special case, with equal executable/runtime manifests.

**Counterargument:** this is deliberately outside today's content-service scope. Correct; it becomes a design gap only when describing this product as a complete self-improving harness platform.

## 2. High: pairwise descriptive improvement is not a durable search decision

The SDK policy computes an oriented mean change and worst case regression against a single parent, then applies configured thresholds ([policy.ts](../../../packages/sdk/src/evaluation/policy.ts#L625-L646)). The twenty-round qualification also compares each candidate to its immediate incumbent, with one development repetition; it accepts equal-quality size reduction and uses separate final audit tasks ([run.ts](../../../examples/self-improvement/twenty/run.ts#L263-L283), [audit](../../../examples/self-improvement/twenty/run.ts#L364-L370)). Those are honest, useful tests. They are not a general noise-calibrated selection policy for an indefinite stochastic search.

Repeated adaptive trials can select a candidate that won by noise, and a sequence of locally allowed regressions can drift away from an earlier stronger checkpoint. RRSI keeps a best accepted score floor and explicitly calibrates unchanged-baseline variation; its selection may intentionally accept a slightly lower score for cost or novelty within the noise band ([selection.py, lines 97–137](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/selection.py#L97-L137), [calibrate.py, lines 85–108](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/calibrate.py#L85-L108)). That is a search heuristic, not a statistical release guarantee.

**Remedy:** add a versioned, app-owned search policy and recorded decision: campaign, evaluation regime, incumbent, best validated checkpoint, candidate set, measurements, guard results, uncertainty/retest rule, cost budget and chosen winner or abstention. Revalidate against a stable checkpoint periodically and after benchmark/model regime changes. Treat adaptive search and a release audit as different evidence uses. Do not implement RRSI's exact constants as product defaults, and do not call policy `pass` “statistically proven.” Existing `descriptive-policy-check` labeling is correct.

## 3. High for continuous operation: holdout use has no reusable campaign lifecycle

The twenty-round example correctly separates development, audit and fresh release tasks and explicitly stops if its final audit fails. It says not to feed audit answers back ([run.ts](../../../examples/self-improvement/twenty/run.ts#L32-L58), [final audit](../../../examples/self-improvement/twenty/run.ts#L364-L370)). However, the protection lives in this one-shot example: the generic policy interface has required cases but no split role, audit exposure history, or reserve/retire lifecycle ([policy interface](../../../packages/sdk/src/evaluation/policy.ts#L5-L17)).

A continuously running application that repeatedly submits a revised candidate to the same “held-out” set can adapt to those outcomes even if it never pastes the answer text into a proposer prompt. RRSI offers separate evolve and held-out domain hooks; they are an interface convention, not a strong access isolation mechanism ([domain.py, lines 60–75](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/domain.py#L60-L75)).

**Remedy:** represent dataset identity, split purpose, exposure counts and campaign/release epoch explicitly. Keep audit answers and detailed traces outside the optimizer's permitted evidence; allow a bounded audit cadence and retire or rotate exhausted holdouts. The app can enforce access. The service should preserve an auditable declaration and avoid presenting repeated audits as fresh generalization evidence.

## 4. Medium: release squashing loses search ancestry from the stored version graph

The twenty-round example creates the final candidate with the original published version as its parent, while using the accepted incumbent's bytes. It stores `sourceAcceptedVersionId` in a local artifact ([run.ts](../../../examples/self-improvement/twenty/run.ts#L351-L363)). This is deliberate and is necessary for the current direct published-parent comparison. It is not a content corruption bug.

But a later reader traversing only persisted version parents cannot recover the accepted search path from the released version. Rejected proposals and comparisons remain stored, yet their role in the final selection is not a first-class immutable record. RRSI records the winner, rejected/lost candidates and trajectory as explicit search history ([loop.py, lines 304–344](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/loop.py#L304-L344)).

**Remedy:** keep content-parent semantics, but add `derivedFrom`/source snapshot references plus a campaign decision ledger. Persist the linkage currently present only in `release-candidate.json`. Distinguish “search incumbent”, “release candidate” and “deployed channel” instead of overloading one parent or channel for all three.

## 5. Medium: arbitrary evidence strings are a weak interface for cumulative learning

The current twenty-round loop has a useful feedback producer, including development corrections, retained rejected findings and examples to preserve. It must flatten these into at most twenty strings of 4096 characters for the proposal interface ([feedback.ts](../../../examples/self-improvement/twenty/feedback.ts#L15-L49), [proposal use](../../../examples/self-improvement/twenty/run.ts#L223-L248)). That works for this small benchmark, but it leaves evidence provenance, filtering and context limits as bespoke caller work.

RRSI keeps a full history while rendering a bounded view emphasizing measured outcomes and limiting unmeasured gate failures ([history.py, lines 166–185](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/history.py#L166-L185)). Its component attribution is heuristic; copying it would not prove causation.

**Remedy:** give the application a typed evidence artifact/reference interface: outcome/trace digest, originating job and harness snapshot, dataset split, approved/sanitized feedback view, hypothesis, decision and reusable lesson. Render bounded proposer context from that ledger. This does not require uploading private raw traces or promoting every observed behavior to approved memory.

## Preserve these distinctions

- App-owned execution is sound. RRSI's core delegates running/scoring/traces to domain adapters; central hosted execution is not required ([domain contract](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/domain.py#L28-L42)).
- Keep complete expected-case inventory and explicit unknown costs. RRSI aggregation derives expected count from returned task records, and its relative-cost helper returns zero change when either side has no cost ([evaluate.py, lines 104–135](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/evaluate.py#L104-L135)); those behaviors should not replace Acclimate's stronger checks.
- Preserve immutable inputs, exact evidence binding, pinned in-flight jobs and deliberate release authorization.
- A tapering edit budget bounds each proposal, not total harness size. It can be one optimizer policy, not a permanent limit on which mechanisms a harness may learn ([schedule.py, lines 28–50](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/schedule.py#L28-L50)).
- Search novelty and score are allowed to guide experiments. Neither is sufficient authorization for unattended production rollout.
