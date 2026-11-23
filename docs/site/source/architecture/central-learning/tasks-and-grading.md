# Tasks and grading

**Status: built.** Follow-up work is listed in the [release plan](plan.md#after-the-first-release).

A task is one thing the agent is asked to do, plus how to judge the result. Tasks live in the service. Routes, tables and exact field names are in [API and data](api-and-data.md). The console steps are in [experience](experience.md).

## The task

```json
{
  "taskId": "refunds-oct-14",
  "input": { "messages": [{ "role": "user", "content": "My order arrived nine days late. Can I get a refund?" }] },
  "grader": {
    "type": "criteria",
    "reference": "Yes. Orders more than seven days late qualify for a full refund.",
    "criteria": [
      "Confirms the customer qualifies for a refund",
      "States the seven-day rule",
      "Does not ask for information the customer already gave"
    ]
  },
  "source": "import",
  "group": "import:5b1e…:conversation:112",
  "split": "evolve",
  "admission": "admitted"
}
```

| Field | Rule |
| --- | --- |
| `taskId` | Today's `case_id` format and values carry over, so memory attempts that name a case stay valid. |
| `input` | JSON, at most 64 KiB, the limit `job.expect()` and evolve cases use today. The `chat` harness accepts a string or a `{messages}` list ending with a user turn. Any other JSON is sent as one user message holding the JSON text. |
| `grader.type` | `exact` or `criteria`. A `check` script comes with the `codex` harness. |
| `grader.expected` | The expected JSON answer for `exact`. |
| `grader.reference` | Optional reference answer for `criteria`. |
| `grader.criteria` | One to ten plain-language statements, one behavior each. Required for `criteria`. |
| `source` | `import`, `console` or `outcome`. Set by the service, never by the caller's payload. The source file, row, author or reporting principal is stored beside it. |
| `group` | Set by the service. Tasks that share a source share a group. |
| `split` | `evolve` or `held-out`. Set by the service from the group at creation and never changed. |
| `admission` | `pending`, `admitted` or `set-aside` (with a reason). Only admitted tasks run in rounds. |

Edits and retirement are tracked by revision, the way evolve revisions work today. A task is a single agent turn over a fixed input. Simulated users are not in the first release.

## Turning material into tasks

The console and API accept a spreadsheet, CSV, JSONL or pasted conversations, up to 64 MiB and 10,000 material rows. XLSX entries together can expand to 256 MiB. A row with both an `input` and an `expected` field becomes an `exact` task at once, with no model call. A row larger than 64 KiB is set aside with the reason `too-large`. Conversion of the other rows runs as an executor job that calls the bundle's judge model through the gateway. It turns each row or conversation into a task card. This is conversion, not invention:

- The input and the reference answer are copied from the material. The model chooses where a conversation is cut and maps columns to fields.
- The model may draft criteria from the reference answer. A person sees every card before Start and can edit or delete it.
- The model does not create tasks that have no source row.
- A row with no usable answer and no criteria becomes a set-aside card with the reason `no-reference`.
- Criteria already in the row are used as they are. The model drafts criteria only for a row that has an answer and none of its own.
- A row the model cannot map after three attempts is set aside with the reason `not-converted`. The rest of the import continues.

Converted cards record the file, the row and the conversation they came from. That source is the task's group. The conversion model reads every row before the split is assigned. It is stateless and is not the optimizer.

## Graders

| Grader | How it scores | Where it runs |
| --- | --- | --- |
| `exact` | String expectations match the output text exactly. For other expectations the executor parses the output text as JSON and compares the resulting values recursively. Invalid JSON fails. Admission serializes non-string outputs to JSON text before applying the same comparison. | In the executor, with no model. |
| `criteria` | The judge answers pass or fail for each criterion, with a written reason. The rollout passes only if every criterion passes. Its score is the share of criteria met, so a reply that meets three of four criteria scores above one that meets none. | In the executor, through the gateway. |
| `check` (later) | A script exits 0 to pass. Its printed output is feedback. | In a separate grader sandbox. |

Rules for the judge:

- Each loop stores a `judge_model`, chosen from the workspace provider's allowed models. It must differ from the loop's task model, and the optimizer is configured separately for the deployment. The judge is pinned on the round.
- The judge reads the non-system task messages and the agent’s final reply, the criteria and the reference. Candidate instructions inside this evidence can still influence a model judge despite the separate system instruction.
- Each rollout is judged three times. It passes when at least two judgments pass every criterion. Its score is the share of criteria met, averaged over the three judgments. A task whose verdicts split often is flagged in the console.
- For evolve tasks, the judge's written reasons become the feedback the optimizer reads.

### Where the judge comes from

The SIM paper prints no judge prompt. Its workspace benchmarks use each benchmark's own rubric judge. [RRSI](https://github.com/google-research/rrsi) pins the one from [Harvey LAB](https://github.com/harveyai/harvey-labs): one call per criterion at temperature 0, shown the task title, the output and the criterion, answering pass or fail with a short reason as JSON. Acclimate's judge keeps that contract, a verdict and a written reason for each criterion. The table compares the two.

| | Harvey LAB judge | Acclimate judge |
| --- | --- | --- |
| Calls | One for each criterion. | One for all criteria of the task, at most ten. |
| Votes | One, at temperature 0. | Three, and the majority counts. Temperature is left to the provider. |
| Untrusted text | Placed in the same prompt as the instructions. | Sent as data in the user message, under a system instruction that names it as material to judge. |
| Task score | Criteria passed over criteria total. Harvey LAB's own scorer and APEX-Agents instead pass a task only when every criterion passes. | Both. The score is criteria passed over criteria total, and a rollout passes only when every criterion passes. |

A calibration set of 26 cases with known verdicts, 73 criteria in all, was judged three times each by `gpt-6-luna` and by `gpt-6.2-sol`. Twelve of the cases carry text aimed at the grader: a request to pass, a fake verdict, a fake system notice, a claim that the rubric was waived, an appeal, the same in other languages. No such text changed a verdict. `gpt-6-luna` returned all 219 criterion verdicts correctly and `gpt-6.2-sol` 218, and every task verdict was correct. The one miss was a loosely worded criterion, "mentions that the link expires", on an output that referred to the expiry without stating it. On the first 18 cases a per-criterion prompt in the Harvey LAB form scored the same as the Acclimate prompt, used three times the calls and tokens, and ran into the provider's rate limit, so the single call stays. The set is small. It shows that the prompt works on these models, not that a judge cannot be misled.

How rollout verdicts become a task score is in [loop](loop.md).

## The admission check

Every task passes this check before it counts, whatever its source. The executor runs it as [trials](executor.md), so it costs no round.

1. **The reference passes.** Grading the task's own reference gives a pass.
2. **An empty answer fails.** Grading an empty output gives a fail.
3. **The judge agrees with itself.** For `criteria` tasks, the three judgments of the reference give the same verdict, and so do the three judgments of the empty answer.

A task that fails is set aside with the reason shown: `reference-failed`, `empty-passed` or `judge-unstable`. A check whose rollouts fail twice on infrastructure is set aside with `check-failed`. Editing the task runs the check again. A `criteria` task with no reference skips step 1, so step 3 judges only the empty answer.

The check catches broken graders. It does not catch a task that is answerable but wrong, which is why a person reviews the cards before Start.

## The split

The service assigns the split. The developer never chooses it and can't move a task across it.

- **By group.** Tasks cut from the same conversation, the same imported row group or the same production job share a `group`, and the whole group lands on one side. Near-duplicate inputs found at import are merged into one group.
- **By hash.** The service uses a stable hash of the group to assign its split.
- **Permanent.** The group is derived from the source, not from a name the user can edit. Editing a task does not move it.
- **Evidence rule.** A held-out task needs a reference that came from a person: an expected answer present in the source material or outcome, or criteria a person wrote or confirmed in review. Import confirms a held-out task on its own only when its expected answer or reference answer is found in the source row and conversion did not draft its criteria. Any other imported held-out task stays `pending` until a person confirms it. That includes a row that has its own criteria and no reference. It does not move to evolve.

## Held-out custody

The held-out digest commitment goes away. Held-out tasks are stored in their own table, `learning_held_out_tasks`, with the same shape as `learning_tasks`. The split is assigned at creation, so a task is written straight to its table. These rules replace the commitment:

- **The optimizer never reads held-out.** It gets no content, task ids, gateway logs, judge reasons or per-task results. No optimizer code path queries `learning_held_out_tasks`, and a test asserts this. The round stores only the aggregate held-out score, for the chart and the alert.
- **The task model and the judge do read held-out tasks**, because that is how the tasks are scored. They read them statelessly, through the gateway, with server-side storage refused.
- **Machine tokens never receive held-out content.** A response to a machine token leaves out held-out task content, held-out trial logs and per-task held-out results. It carries counts and aggregate scores. An import returns drafted cards only to a person signed in to the console. A machine writer who already knows the exact input can infer held-out membership by reimporting it and checking the evolve listing.
- **People read held-out in the console**, with a session.
- **Rewriting retires.** A person who rewrites a held-out task into a new evolve task retires the held-out original.
- **Export.** A person can export held-out tasks, so the set is not locked into the service.

Held-out content is not encrypted. The paper requires that the optimizer never sees it, and the separate table plus the test gives that.

## The Start floor

Start and resume are refused until the loop has 20 admitted evolve tasks and 20 admitted held-out tasks. With a handful of held-out tasks, one flip swamps any real drop. While an edit to a previously admitted task is pending, the service waits for its admission result if that edit could restore the floor. Active rounds finish on their pinned revisions. If admitted tasks otherwise fall below the floor, the loop pauses with the reason `tasks-required`.

## Production outcomes

`job.expect()` stays. The application reports the correct answer for a real job, and the service turns it into a task.

- **Wire change.** `job.expect(expected, { input, output })` gains an optional `output`, the answer the agent gave.
- **No self-written references.** When `output` is supplied and equals `expected`, the outcome is rejected. The delivered agent never authors tasks, criteria or references.
- **Provenance.** The source is `outcome`, stored with the delivered version and the reporting principal.
- **Admission.** The outcome passes the same admission check as any other task.
- **Split.** The group is the job id, and the group hash decides the split. Outcomes therefore reach held-out as well as evolve. Every outcome carries a reference, so the evidence rule is met.
- **Right.** Submitting an outcome requires workspace write access.


## Editing and retiring

- **Edit.** An edit writes a new revision and runs the admission check again. The task id, group and split stay. A round pins the revision it started on and finishes on it.
- **Retire.** A retired task leaves future rounds. Its past results stay in history.
- **Scores.** A round's score is over the tasks it pinned. When the task set changes, the next round scores the incumbent again, and the console marks the chart so a jump caused by an edit is not read as learning. See [loop](loop.md).
- **Flagged tasks.** The console flags tasks that every candidate fails, tasks the judge splits on and tasks whose rollouts fail with errors. A flag is a prompt to a person. It changes nothing by itself.
