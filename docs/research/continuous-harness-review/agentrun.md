# AgentRun continuous learning: source review and Acclimate implications

Read-only research, 2026-11-17. AgentRun is pinned by [`.repos.json`][ac-pin] to `077b2fa1c831bdd2bbcb7ed7a0435914f48486b5`; the supplied `.repos/agentrun` clone reports that exact HEAD. Acclimate was inspected at `3de5ac433a5a6b3d1406efaa51e50283ec66d402`. Upstream links below pin the inspected revision; they make no claim about the latest release.

Online verification succeeded: GitHub serves the [pinned commit][ar-pin], and direct HTTP reads of `check.ts`, `grade.ts`, `commit.ts`, `runner/learning-loop.ts`, `learning.ts`, and `learn-bench/README.md` returned HTTP 200 and matched the local files byte for byte. No upstream or application code, tests, model calls, builds, or deployments were run. Runtime statements are static traces of implementation, not reproduced behavior. Only this research file was written.

**Assessment:** Acclimate already has a sound content and release substrate for an application-owned learning loop. It is not a continuous learning controller by itself. The clearest present contract defect for that goal is that its proposer cannot add a file. The larger missing concepts are an authorized experience record, lesson admission distinct from performance evaluation, and persistent selection history across attempts. Keeping execution, tools, and grading in the application is deliberate and compatible with solving those gaps.

## What AgentRun actually does

| Stage | Inspected behavior | Primary source |
| --- | --- | --- |
| Enable and seed | The server learning switch defaults on, but the agent definition must enable learning. `true` permits notes, skills, and workflows; `"notes"` permits notes and skills. Each run receives a pinned learning-folder commit, separate from the agent revision. A run can use learning without producing more through `"use"`. | [`learning.ts`, L1–78][ar-learning]; [`run-launch.ts`, L51–65][ar-launch]; [`learning-end.ts`, L76–84][ar-end] |
| Serve retained knowledge | Notes are copied into the run and selected for prompt context. The default note budget is 8,000 UTF-8 bytes. Beyond budget, BM25 ranks notes against the initial input; relevant notes are supplied whole while they fit, followed by summary lines. No lexical match falls back to recency. Pending, retired, and superseded notes are excluded. Learned skills have a separate budget and do not displace revision-defined skills. The launch records omissions and offered resources. | [`learning.ts`, L9–26, L61–71][ar-learning]; [selection and serving, L586–635][ar-selector]; [`run-launch.ts`, L51–65][ar-launch] |
| Reflect | At an eligible run end, the host asks the same run for bounded note/skill/workflow blocks. It parses the answer, never harvests arbitrary files the agent wrote. Stops, faults, exhausted budget, and unknown spend under a cap can skip reflection. A completed run using only successful learned workflows can skip it as having nothing new. | [`reflect-hook.ts`, L97–160][ar-reflect-hook]; [`learning-end.ts`, L170–183][ar-workflow-skip]; [`SPEC.md`, L125–147][ar-spec] |
| Check and repair | Static checks constrain paths, encoding, regular files, sizes, counts, host-owned metadata, secret shapes/values, and invisible characters. Notes are normally additions with explicit supersession. Only a completed job may contribute a skill. Item-local problems can remove individual items; secret or untrusted-encoding problems can reject the entire answer. One re-ask can repair an unparseable answer or a workflow dry-run failure. | [`check.ts`, L260–317][ar-check]; [`SPEC.md`, L166–218][ar-spec]; [`reflect-hook.ts`, L161–187][ar-reflect-repair] |
| Check generality | An optional Jev call scores each proposed note for applicability beyond its originating input; default threshold 0.5. No provider or a failed pre-check sends the notes to the main grader instead. Failure is recorded and potentially charged spend becomes unknown; this is a fallback to another check, not a claim that generality passed. | [`general.ts`, L12–80][ar-general]; [`learning-loop.ts`, L441–498][ar-loop] |
| Grade admission | A model judges generality, planted instructions, secrets, duplicates, contradictions, risky rules, and skill/workflow suitability. Risky items are held pending owner approval. Parsed decisions must cover the expected items; retained items require `general: true`. A detected planted instruction vetoes the whole proposal. This is semantic admission, not a measured parent-versus-candidate task comparison. | [`grade.ts`, L19–98, L613–665, L674–end][ar-grade]; [`learning-loop.ts`, L511–560][ar-loop] |
| Commit and recover | A separate learning run journals the verdict before the merge and reuses that verdict on recovery. The folder writer uses compare-and-swap and bounded recomputation, checks relevant blobs, settles duplicate/new-name collisions, marks superseded notes, and rebuilds the index. A source run/round already committed is recovered rather than merged twice. Folder unavailability parks the learning run; a semantic merge conflict is dropped. This does not promise exactly-once provider billing. | [`learning-loop.ts`, L422–424, L555–624][ar-loop]; [`commit.ts`, L107–136, L192–235][ar-commit]; [`folder.ts`, L843–874][ar-folder]; [`learning-ask.ts`, L59–123][ar-ask] |
| Reuse procedures | After a learned skill has been **offered** to enough earlier runs, reflection may request its conversion to a workflow. This counts exposure, not demonstrated invocation or benefit. Learned workflows are offered as a tool, checked again at runtime, and restricted to supported model/tool/decision nodes. Model nodes use fresh sessions; paid work shares the run's accounting/cap. | [`learning-end.ts`, L276–314][ar-draft-trigger]; [`learned-workflow.ts`, L1–25][ar-workflow] |

AgentRun's separate learning bench evaluates sequential `teach`, `repeat`, `change`, and `plant` steps with learning on and off. It waits for each lesson to settle before the next step; by default the benchmark owner approves pending items. It measures follow rate, stale rules, workflow reuse, wrong keeps, and costs. These are benchmark mechanics, not a per-merge production performance gate, and benchmark approval behavior must not be mistaken for unattended production authorization. No benchmark result was independently reproduced here. [Bench definition and runner behavior, L3–58][ar-bench].

## Findings for Acclimate

Severity is relative to the requested **continuous self-improving harness**: **High** blocks that behavior or makes an automated acceptance claim unsound; **Medium** limits sustained learning or leaves an important boundary ambiguous. These are not claims of a currently exploitable production vulnerability. Each finding distinguishes the current product contract from the expanded goal.

### 1. High — the proposal contract cannot grow the learned repertoire

**Evidence.** `create_proposal` requires every allowed path to exist in the parent. `validate_edits` requires identical file sets and kinds. The provider edit envelope explicitly forbids new files, removals, and renames. Consequently an empty/new memory collection cannot gain a separately named lesson, nor can repeated experience create a new skill directory through the service proposer. AgentRun explicitly supports new notes and a new skill, with bounded counts and host-validated metadata. [Acclimate request validation][ac-proposal-create], [candidate validation][ac-proposal-files], [provider edit grammar][ac-edits]; [AgentRun addition checks][ar-check].

**Why it matters.** The proposal mechanism currently tunes an operator-selected existing vocabulary. Calling it a general mechanism for learning new reusable skills hides a real limitation. The helper repair experiment needed an operator to introduce an empty allowed script path before the proposer could fill it—evidence of the constraint, not evidence that scripts are unsupported. [Recorded repair procedure][ac-stress].

**Counterargument / scope.** Authors can add files through normal drafts or version publication, and fixed-file tuning is a defensible first release. This does not block every learning experiment or manual content workflow.

**Minimal remedy.** Extend the bounded proposal grammar with an explicitly authorized create operation, constrained by path prefix, file kind, count, bytes, and native compatibility. Reconstruct candidates on the host; forbid overwriting an existing path through create. Keep deletion/rename deferred if unnecessary. New resources remain candidates requiring the existing review/release path. No application execution service is needed.

### 2. High for unattended learning — observations and admitted lessons are collapsed into prose

**Evidence.** Acclimate's proposal request carries `hypothesis` and `evidence: Vec<String>`; a bundle file carries only `path`, `kind`, and `text`. The worker validates payload shape, allowed edits, and compatibility before creating a candidate. It has no mandatory semantic-admission result identifying a lesson's authority, originating job, generality, contradictions, or rejected source instructions. The design calls a learned memory a text edit “with provenance,” but these wire types guarantee container authorship and version ancestry, not structured provenance for each retained claim. [Proposal types][ac-request], [file types][ac-types], [worker validation][ac-worker], [memory design][ac-memory].

AgentRun separates what the user said, trigger input, proposed items, structural check outcomes, semantic verdicts, and the later commit. Its explicit planted-instruction and risky-rule distinctions are useful concepts even though its model judgment is fallible. [Reflection source capture][ar-end], [admission rubric and parser][ar-grade].

**Failure example / inference.** A fetched page's request to skip a check can be summarized into “approved feedback,” then become a shared memory edit. A better task score on ordinary fixtures does not establish that the lesson came from an authorized source. Conversely a legitimate scoped preference should not become a global rule merely because it was retained. Path validation and a digest solve neither problem.

**Counterargument / scope.** Today's explicit human release is a real admission boundary, feedback is opt-in, and applications can structure evidence inside the existing strings. It would be incorrect to say Acclimate silently publishes model memories today. Human review can remain the default. [Current review and opt-in contract][ac-memory].

**Minimal remedy.** First define an application-side experience envelope: source event/job identity; exact bundle version/digest; task outcome; authorized excerpts; source category/authority; intended user/project scope; and retention classification. Separately record item-level admission decisions such as accept, reject, or needs-review, with reasons and source references. Keep raw traces private. A bounded JSON envelope in evidence plus a retained sidecar is enough to pilot the concept; a central trace store and a second mandatory model are unnecessary. A semantic model check can assist admission but cannot certify factual truth or replace source authority.

### 3. High capability gap, deliberate service scope — there is no shared continuous selection controller

**Evidence.** The reusable proposal object describes one queued/running/succeeded/failed generation job. The reusable evaluator runs a declared parent/candidate evaluation. Neither object represents the incumbent across a sequence, rejection-derived evidence, a cumulative learning budget, or why search stopped. Those concepts exist in the application-specific twenty-round experiment: it retains rejected mistakes, chooses an incumbent, records accept/reject decisions, and protects a final audit from proposer feedback. [Proposal types][ac-request], [evaluator interface][ac-eval-types], [twenty-round selection][ac-twenty], [feedback construction][ac-feedback].

**Why it matters.** A proposal worker retry is not a learning iteration. Repeatedly requesting edits without preserving rejected-candidate findings can reproduce failed ideas. Improving against only the latest noisy sample can also discard earlier correct behavior. The repository's larger experiment explicitly reports both problems; it does not establish that the shared service/SDK already handles them. [Stress-test observations][ac-stress].

**Counterargument / scope.** The service deliberately defers campaign scheduling and automatic search; that is consistent with application ownership of execution and grading. The real experiments already demonstrate that callers can compose the existing APIs. Their existence refutes “Acclimate cannot support iterative learning.” [Current scope decisions][ac-scope], [selection example][ac-twenty].

**Minimal remedy.** Extract an optional application-owned controller pattern from the experiment. Persist experience IDs, incumbent and candidate identities, admission outcomes, comparison IDs, rejected findings, proposal errors, selection-policy revision, spend completeness, and stop reason. Bound iteration count, total spend/time, and no-progress retries. Preserve rejected findings and representative already-correct cases; reserve fresh audit inputs for the selected candidate. Recover mutations using existing operation identities. The Rust service can continue storing ordinary proposals/comparisons/releases; it need not schedule jobs, acquire application runtime leases, or run a universal agent loop.

### 4. High if automated — comparison completeness is not an acceptance decision

**Evidence.** `validate_comparison` determines completeness from the expected inventory and scored, non-infrastructure-failed outcomes. Promotion checks completeness, exact candidate/parent identities and digests, and the current parent/revision. It does not compare rewards or require a passing policy verdict. A complete comparison with a consistently worse candidate therefore satisfies the evidence portion of the release command. This follows directly from inspected conditions; it was not exercised against a server. [Completeness calculation][ac-complete], [promotion conditions][ac-release].

The checkout already has `EvaluationPolicyV1`: metric direction, equal-case aggregation, minimum improvement, maximum regression, required cases, optional task-failure and cost bounds. It explicitly returns a descriptive policy check. It is incorrect to report that Acclimate has no acceptance-policy machinery. [Policy interface][ac-policy], [calculation][ac-policy-calc].

**Counterargument / scope.** This is intentional for a deliberate human release: the reviewer may accept a tradeoff, seed content, or restore an older version. A service supporting arbitrary application rubrics should not silently reinterpret reward direction. Existing release binding is stronger than simply trusting a “pass” label.

**Minimal remedy.** Keep human review and explicit unevaluated reasons. For an application-owned automatic selector, require an explicit acceptance decision bound to the exact policy revision/digest, comparison, candidate/parent digests, and inventory. Unknown required costs/grades yield indeterminate, not accept. Invoke promotion only after that decision passes; retain it with controller history. Add server-enforced policy authorization only if the product promises centrally enforced automatic release. Do not replace the existing parent/revision check with a permissive merge of independently evaluated changes.

### 5. Medium — immutable file history is insufficient as a long-lived memory policy

**Evidence.** Acclimate versions whole files and correctly distinguishes verified/prepared content from proof of use. Its delivery receipt schema stops at `started`; native preparation stages memory files for the host and does not itself retrieve relevant claims or verify agent adoption. AgentRun adds active/pending/superseded/retired state, explicit supersession, budgeted serving, and omitted-resource records on top of git history. [Acclimate file model][ac-types], [receipt schema][ac-receipts], [native staging][ac-native], [AgentRun states and serving][ar-spec], [selector][ar-selector].

**Why it matters / inference.** A retained file may contain obsolete or differently scoped claims. More accumulated Markdown can increase context cost while making the applicable rule harder to find. An evaluation that exposes a small complete memory and production that selects or omits different content are testing different effective inputs even when the stored bundle is identifiable. Delivery integrity remains necessary but cannot answer whether the relevant lesson was selected or used.

**Counterargument / scope.** The host already owns context construction, private mutable memory, and native loading. Small bundles may need no retrieval layer. State and supersession can be represented within versioned content; Acclimate does not need a separate memory database or a claim that it can attest internal model attention.

**Minimal remedy.** Specify an optional learned-item convention with scope, source references, active/superseded/retired state, and validity/revalidation conditions. Give the application a bounded selection/compaction policy and record its revision, selected/omitted resources, and effective-input digest in evaluation artifacts. Use the same serving path during evaluation and later jobs. Describe observations precisely as offered, opened, invoked, or output-verified; none alone proves causal contribution. Test changed-rule and irrelevant-note pressure as well as repeated tasks. These are application/library responsibilities, not a requirement for hosted retrieval.

### 6. Medium — distinguish executable skill resources from changes to the trusted harness

**Evidence.** The design limits v1 to text and excludes evolving executable harness code. The actual repair experiment improved behavior by proposing `skills/payment-triage/scripts/triage.py` and delivering it as a skill resource; the native staging code maps skill resources without interpreting their contents. Thus “file-only learning” does not mean “natural-language-only learning.” [Design boundary][ac-improvement], [implemented procedure experiment][ac-stress], [native mapping][ac-native]. AgentRun also retains procedures, but its learned workflow path explicitly forbids code nodes and shell/executor calls and rechecks allowed tools at runtime. [Learned workflow restrictions][ar-workflow], [executable-node checks][ar-executable].

**Why it matters.** Treating improved prompts as the only admissible learning target would exclude the mechanism that helped this repository's larger test: a reusable calculation/retrieval procedure. Equally, treating executable skill content as permission to mutate the runner, grader, credentials, or tool gates would cross the trusted boundary.

**Counterargument / scope.** Existing support already allows UTF-8 skill resources and makes their execution the application's responsibility. The design's phrase “executable harness code” can reasonably mean the trusted runtime rather than every script. This is a terminology and capability-contract gap, not proof the implementation needs AgentRun's workflow DSL.

**Minimal remedy.** Explicitly document three learning targets: declarative instructions/facts; procedures packaged as skill resources; and trusted harness infrastructure. Support the first two within compatible bundles, with host-declared dependencies and execution limits. Keep infrastructure, judge changes, and permission changes outside ordinary content proposals. Evaluate resource invocation and final task behavior independently. Do not add a workflow engine solely to reproduce upstream's procedure representation.

## Upstream limits that should not become Acclimate requirements

1. **Admission is not empirical improvement.** The production learning loop goes from semantic verdict to commit without a paired task regression gate. The separate bench measures behavioral effects. A synthetic workflow dry run checks the exercised wiring path and explicitly says nothing about answer quality or unvisited branches. Preserve Acclimate's paired comparisons instead of relabeling semantic admission as performance evidence. [Loop, L511–609][ar-loop]; [dry-run implementation, L604–634][ar-dry]; [bench][ar-bench].
2. **Atomic writing does not guarantee current semantic compatibility.** `readMain` supplies active note summaries and full superseded notes, but records graded blob identities only for superseded notes. Merge rechecks touched blobs and structural constraints, and recomputes duplicates on the current folder; it does not rerun semantic grading on every main change. **Inferred, untested interleaving:** two proposals with different filenames and contradictory new rules can both grade against the same earlier memory, then commit sequentially without a touched-blob conflict. Summaries also cannot expose every contradiction hidden in a body. For automatic admission, bind semantic approval to the memory snapshot or revalidate against intervening changes. Acclimate's existing requirement that released evidence match the current parent avoids directly copying this hazard. [Grade read set, L341–362][ar-read-main]; [merge conflict predicate, L198–224][ar-commit-conflicts]; [write recomputation, L843–874][ar-folder]; [Acclimate release binding][ac-release].
3. **Offered or technically successful is not demonstrated effective.** Workflow extraction counts offered skills, not successful invocation. Reflection can be skipped after only successful learned-workflow tool calls without an independent task-quality check in that predicate. These are cost-saving heuristics, not evidence of mastery or freedom from drift. Retain later task feedback and changed-rule audits even when procedure execution succeeds. [Exposure trigger][ar-draft-trigger]; [skip predicate][ar-workflow-skip].
4. **Model checks are bounded judgments.** The generality pre-check can fall back to the main grader, and the grade model can default to the agent's own model. Secret matching and planted-instruction grading are useful defenses, not an independent guarantee that facts are true or that every hostile instruction is found. Keep explicit provenance and authorization boundaries rather than copying a promise of safe autonomous memory from the existence of a grader. [Generality fallback][ar-general]; [model selection][ar-end]; [rubric][ar-grade].

## Preserve the content-platform boundary

The following omissions are **not design mistakes**: no managed application agent sessions, sandbox fleet, model gateway, tool authorization service, workflow executor, or hot-reload/deployment controller. AgentRun needs these because it executes work; Acclimate deliberately serves content to native application runtimes. Its immutable bytes/digests, native compatibility checks, version-pinned preparation, app-reported comparison labeling, and atomic evidence-bound release are useful foundations to preserve. [Product scope][ac-scope], [current concepts][ac-context], [release implementation][ac-release].

The smallest coherent extension is an application-owned sequence:

```text
authorized experience → proposed lesson → structural + semantic admission
→ immutable candidate → paired task evaluation → recorded selection decision
→ deliberate channel release → later job using the same serving policy
```

Experiences, lessons, proposals, comparisons, and release decisions answer different questions. They can share existing files and records initially. Conflating their meanings is the design error; declining to own the application's runtime is not.

[ar-pin]: https://github.com/Parcha-ai/agentrun/commit/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5
[ar-learning]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learning.ts#L1-L78
[ar-selector]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learning.ts#L586-L635
[ar-launch]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/run-launch.ts#L51-L65
[ar-end]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/runner/learning-end.ts#L76-L135
[ar-reflect-hook]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/runner/reflect-hook.ts#L97-L160
[ar-reflect-repair]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/runner/reflect-hook.ts#L161-L195
[ar-workflow-skip]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/runner/learning-end.ts#L170-L183
[ar-spec]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/SPEC.md
[ar-check]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/check.ts#L260-L317
[ar-general]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/general.ts#L12-L80
[ar-grade]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/grade.ts
[ar-loop]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/runner/learning-loop.ts#L420-L624
[ar-commit]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/commit.ts#L107-L235
[ar-read-main]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/commit.ts#L341-L362
[ar-commit-conflicts]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/commit.ts#L198-L235
[ar-folder]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/folder.ts#L843-L874
[ar-ask]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/runner/learning-ask.ts#L59-L123
[ar-draft-trigger]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/runner/learning-end.ts#L276-L314
[ar-workflow]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learned-workflow.ts#L1-L25
[ar-executable]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/skills.ts#L649-L665
[ar-dry]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/src/learn/skills.ts#L604-L634
[ar-bench]: https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/learn-bench/README.md#L3-L85
[ac-pin]: ../../../.repos.json#L4
[ac-context]: ../../../CONTEXT.md#L1
[ac-types]: ../../../src/types.rs#L15
[ac-request]: ../../../src/types.rs#L96
[ac-proposal-create]: ../../../src/improvement.rs#L207
[ac-proposal-files]: ../../../src/improvement.rs#L420
[ac-edits]: ../../../src/proposal_edits.rs#L6
[ac-worker]: ../../../src/improvement.rs#L345
[ac-complete]: ../../../src/improvement.rs#L4
[ac-release]: ../../../src/channels.rs#L157
[ac-improvement]: ../../../docs/design/improvement.md#L15
[ac-memory]: ../../../docs/design/improvement.md#L58
[ac-stress]: ../../../docs/research/self-improvement-stress-test.md#L1
[ac-scope]: ../../../docs/research/service-scope-audit.md#L1
[ac-eval-types]: ../../../packages/sdk/src/evaluation/types.ts#L28
[ac-policy]: ../../../packages/sdk/src/evaluation/policy.ts#L4
[ac-policy-calc]: ../../../packages/sdk/src/evaluation/policy.ts#L619
[ac-twenty]: ../../../examples/self-improvement/twenty/run.ts#L219
[ac-feedback]: ../../../examples/self-improvement/twenty/feedback.ts#L13
[ac-receipts]: ../../../packages/sdk/src/types.ts#L300
[ac-native]: ../../../packages/sdk/src/internal/native-files.ts#L26
