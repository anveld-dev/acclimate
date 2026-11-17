# Continuous self-improving harness: concept review

Review date: 2026-11-17. Acclimate baseline: `3de5ac433a5a6b3d1406efaa51e50283ec66d402`. This review assesses the user's broader goal of a continuous self-improving harness. It does not silently replace the current content-service product contract.

The [connected-service review](connected-service.md) examines the subsequently implemented learner at `2951785`, including automatic rollout, field rollback and feedback across releases.

See the [second-pass counter-review](second-pass/README.md) for corrections and a smaller implementation recommendation. It supersedes broad interpretations of the fixed-file and harness-identity findings below.

## Verdict

Acclimate has useful foundations for improvement, but its production concepts currently describe **versioned content delivery with app-run evaluation and deliberate release**. A continuous harness learner needs additional concepts. The most concrete restrictive design is that the automated proposer cannot create or remove a file. The largest missing design is a durable cycle connecting actual task outcomes to bounded experiments and future deployment.

Keeping execution in the application remains a sound choice. A hosted runtime, general workflow engine, or adoption of all of AgentRun is not required. Conversely, starting a Codex task and recording delivery receipts does not close a learning loop.

## Prioritized findings

| Priority | Finding | Practical failure | Smallest useful change |
| --- | --- | --- | --- |
| High | The proposer edits only existing file text | It cannot invent a new skill or helper, retire an obsolete file, or restructure memory | Add a capability-scoped mutation policy with bounded add/edit/delete operations, native validation and exact parent preconditions |
| High | Content version is not full harness identity | The same content digest can execute with changed app code, tool schemas, SDK/model settings or context assembly | Add an immutable app-owned harness manifest referencing content digests, executable/config artifacts and the relevant environment contract |
| High | Delivery telemetry is not task feedback | `started` observations cannot tell the learner which task failed, why, or whether it completed | Separate task outcomes and authorized feedback from best-effort delivery receipts; retain correlated traces and usage |
| High | Continuous search is example-controller state | A process restart or multiple learners have no shared production campaign incumbent, trial budget or decision history | Persist campaigns, rounds, evaluated candidates, accepted/rejected decisions and resumable controller checkpoints |
| High before automated release | Complete evidence is not a quality decision | An authorized caller may release complete but losing evidence; a threshold pass on repeatedly reused cases can overfit | Preserve completion/search/release separation; add an explicit versioned automated-release policy and independent audit protocol when automation is desired |

Additional medium-priority issues are the lack of an ordinary resource/configuration file role, memory applicability/supersession metadata, fixed parent-before-candidate execution order, and release-squash provenance retained only in local controller artifacts. These should be addressed through explicit delivery mappings, controlled experiment protocols, and search-to-release references; they do not justify replacing the existing content store.

These are priorities relative to continuous learning, not claims that the existing content product violates its documented contract. Exact evidence and qualifications are in the specialist notes below.

## Concepts to keep

- Immutable parent-linked content snapshots, exact digest/request/attempt binding, complete expected-case inventories, explicit missing grades and unknown costs.
- Fresh jobs resolve releases; existing jobs keep pinned inputs. Do not mutate running jobs as an implicit effect of learning.
- A search incumbent and a released channel are different states. Exploration may accept tradeoffs that are unsuitable for release.
- Evaluation completion, descriptive policy results and authorization to publish remain separate decisions. An explicit machine-authorized policy can automate a release without deleting that separation.
- Application-owned execution and graders. Improve the shared interfaces rather than building an execution platform merely to collect evidence.

## Proposed model

1. **Harness revision:** an immutable manifest that binds content plus the app-owned executable/configuration artifacts used to run it. An opaque digest proves artifact identity; it does not prove honest execution or freeze a changing hosted model.
2. **Task run and outcome:** stable run/attempt IDs, harness/content revisions, task cohort, terminal or uncertain status, trace references/digests, observed resource usage and app-approved corrections. Untrusted trajectories are observations, not policy authority.
3. **Learning campaign:** objective and constraints, eligible development evidence, protected audit cohort, proposer mutation capabilities, budget/deadline, incumbent and release target, controller owner/checkpoint.
4. **Experiment:** frozen parent/candidate identities, evaluator/dataset/grader/protocol identities, expected trials and paired-run schedule. Record failures and unknowns, not only winners.
5. **Search decision:** accepted/rejected/indeterminate with policy identity and reasons. Keep it independent of release.
6. **Release decision:** candidate and comparison/audit references, policy or human authority, expected channel revision and rollout/rollback criteria. New task outcomes provide subsequent monitoring evidence.

This can initially be one deep application-side learner module backed by a durable journal, using existing service proposal/evaluation/channel interfaces. New server records should follow demonstrated cross-process needs; do not introduce a general scheduler or workflow language speculatively.

## What to borrow upstream

AgentRun provides a concrete end-of-run reflection/check/grade/merge pattern and keeps the host as the writer of learned notes. Its grader establishes a learning policy verdict, not proof of broad task improvement. [Pinned learning contract](https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/SPEC.md).

RRSI provides a search loop over executable harness changes, trial histories, screening, selection and an incumbent distinct from the current candidate. Its search acceptance can trade score, cost and novelty within a noise band; it should not be copied as production release authorization. Its ref/history writes are also not a transactional deployment model. [Pinned loop](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/loop.py), [selection](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/selection.py).

## Recommended sequence

1. First build a reproducible app-owned closed-loop example on one fictional domain. Reuse the existing twenty-round qualification, but feed correlated normal task outcomes and retain campaign checkpoints. Preserve held-out audit and a pinned-baseline control.
2. Add structural proposal operations under explicit capabilities. Bind experiments to the complete harness manifest and evaluator artifacts before expanding what the learner can change.
3. Introduce campaign durability and an explicit automated-release policy only after the end-to-end example exposes the necessary state transitions and recovery requirements.
4. Add multiple independent task families, repeated-baseline noise measurement, randomized/counterbalanced paired execution and recurring fresh audit cohorts. Require measured transfer to fresh jobs before claiming continuous improvement.

## Evidence and specialist reports

- [AgentRun research](agentrun.md)
- [RRSI research](rrsi.md)
- [Harness model](harness-model.md)
- [Evaluation integrity](evaluation.md)
- [Lifecycle](lifecycle.md)
- [Local usage evidence and its limits](usage-evidence.md)

The reviewers inspected pinned upstream clones and current Acclimate source. No upstream benchmark, new paid evaluation, or application implementation change was performed for this review. Recommendations are design inferences, not reproduced upstream results.
