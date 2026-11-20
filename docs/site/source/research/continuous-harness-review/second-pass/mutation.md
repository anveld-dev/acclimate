# Second pass: mutation model and artifact transactions

2026-11-17. Source inspection only; no tests, provider calls or upstream experiments executed. This challenges the first pass's mutation recommendations rather than assuming every restriction is a bug.

## 1. High for autonomous discovery: the proposer freezes the file inventory, but does not prohibit learned executable helpers

**Confirmed restriction.** Proposal allowed paths must be existing parent files ([improvement.rs:239](../../../../src/improvement.rs#L239)). The worker independently rejects a different path set or changed file kind ([improvement.rs:420](../../../../src/improvement.rs#L420)). The model protocol explicitly disallows new files/removals/renames ([proposal_edits.rs:6](../../../../src/proposal_edits.rs#L6)). Exact anchors, overlap rejection, and preservation of untouched bytes are intentional controls, with tests asserting rejection of missing/disallowed paths ([proposal_patch.rs:45](../../../../tests/proposal_patch.rs#L45)).

**Correction to broad interpretations.** This is not a ban on learning code, tools, or non-prose bytes. The repair qualification creates an empty Python helper file before the proposal ([repair/run.ts:79](../../../../examples/self-improvement/repair/run.ts#L79)); the proposer then fills that allowed file. Empty-file insertion is explicitly tested ([proposal_patch.rs:64](../../../../tests/proposal_patch.rs#L64)). The model can therefore author a helper once a controller scaffolds its path. Claims that the system cannot improve executable skill behavior at all should be rejected.

**Failure scenario.** An ordinary production run discovers a repeated task deserving a new skill. Without bespoke scaffolding, the proposer cannot add its manifest, helper or references. It cannot autonomously remove a now-obsolete artifact either. The initial artifact inventory determines the reachable search space.

**Minimal remedy.** Keep exact-text editing as a supported policy. Add explicit parent-bound structural capabilities for creation and retirement under authorized prefixes, with limits on final snapshot bytes/files and changed artifacts. This is a goal-driven expansion, not a fix for an untrusted-path escape.

**Counterargument.** A deliberately fixed reusable skill can improve indefinitely without structural changes. For that narrower use case the current policy is sufficient; do not force broader rights on every learner.

## 2. High design requirement for that expansion: add/delete must produce one atomic package-consistent candidate

**Evidence.** Native compatibility discovers skills by directory and requires exact `skills/<name>/SKILL.md` with matching metadata ([compatibility.rs:102](../../../../src/compatibility.rs#L102), [compatibility.rs:145](../../../../src/compatibility.rs#L145)). Native mapping moves every skill resource under the harness-specific skill root ([native-files.ts:55](../../../../packages/sdk/src/native-files.ts#L55)). The console already treats package rename as a single full-payload transformation, moving every child and updating the manifest name ([rename-skill-package.ts:3](../../../../apps/console/src/lib/rename-skill-package.ts#L3)). Current proposals validate target compatibility before inserting a version and commit candidate/version state together ([improvement.rs:403](../../../../src/improvement.rs#L403), [improvement.rs:411](../../../../src/improvement.rs#L411)).

**Failure scenario if the first remedy is implemented naively.** Separate calls create a manifest, move helpers and delete old files one by one. Intermediate snapshots are incomplete; an evaluator can bind to a different package than intended; stale operations can accidentally delete a later replacement. Deleting only a manifest leaves orphaned skill resources. A package rename must also account for references in instructions and skill text, which the existing console helper does not generally rewrite.

**Minimal remedy.** Apply a bounded mutation envelope to one exact parent, construct the entire final payload in memory, validate whole-snapshot path/kind/native invariants, then save a single immutable child with the existing transaction discipline. Package create/replace/retire/rename can be typed conveniences. Rename requires an explicit reference-update plan or a retained alias, plus semantic smoke checks; syntax cannot prove all references are correct. Add and delete operations **are sufficient as primitives when atomic and final-state validated**. A general workflow engine or multi-call artifact transaction protocol is unnecessary.

**Counterargument and classification.** This is a requirement on the proposed expansion, not a current partial-write bug. Current snapshots already offer the right atomic unit. Drafts deliberately allow incomplete native metadata while a person repairs it ([drafts.rs:55](../../../../src/drafts.rs#L55)); automated evaluation/publication should keep its stricter compatibility check. Do not globally forbid useful incomplete drafts.

## 3. High policy gap for automatic release: path and syntax validity are not executable-behavior capabilities

**Evidence.** The generic payload validator checks count/size, safe paths, three file kinds and collisions ([bundles.rs:4](../../../../src/bundles.rs#L4)). Native compatibility checks layout and manifest metadata; it does not classify helper code behavior. The proposal validator constrains *where* text changes, not *what executable effects* changed bytes may request. The repair example adds a separate Python AST preflight and retains failures ([repair/run.ts:133](../../../../examples/self-improvement/repair/run.ts#L133), [inspect_helper.py:1](../../../../examples/self-improvement/repair/inspect_helper.py#L1)); that is domain-specific controller logic, not a generic service guarantee.

**Failure scenario.** A learner is allowed to edit an existing helper or SKILL.md. It can change subprocess/network/file-access instructions within that path without changing file kind, adding a file or violating byte limits. A later harness with broad tool permissions may perform those effects. Consequently, granting only `editExisting` does not imply that the search is limited to harmless prose; expanding to `createSkill` is not the first point at which executable behavior appears.

**Minimal remedy.** Make the application-owned learning policy state the allowed behavior/effect envelope separately from artifact mutation rights: runtime tool grants, data access, execution environment, task/timeout/cost limits and required preflights. Treat structural/native checks as validity checks. Keep behavioral evaluation and release authority independent. An immutable manifest should bind that policy and the actual mapping used. Helper AST checks can be useful evidence but must not be described as hostile-code isolation.

**Counterargument and classification.** Applications already own tool authority, and the repository explicitly avoids promising hostile-tenant isolation. No demonstrated privilege escalation or actual unsafe execution is claimed. The conceptual error would be advertising existing-file restrictions or a native-compatible skill as a safety/behavior capability guarantee when building an automatic learner.

## Decision

Retain immutable full-snapshot candidates, exact parent binding, native validation and transactional persistence. Broaden mutation by explicit policy, not by relaxing validators globally. Correct the first review's shorthand: the system can already learn executable helper content, while autonomous artifact discovery and retirement remain blocked. Structural operations should operate atomically over a package-consistent final snapshot, with separate application-owned behavioral authority.
