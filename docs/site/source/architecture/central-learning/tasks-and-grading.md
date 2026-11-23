# Tasks and grading

**Status: proposed design. Not built yet.** The shipped loop is described in the [learning contract](../../../contracts/learning.md).

A task is one thing the agent is asked to do, plus how to judge the result. Tasks live in the service. They replace the evolve cases that `acclimate learn` synced from a file and the held-out cases that stayed in the application. Routes, tables and exact field names are in [API and data](api-and-data.md). The console steps are in [experience](experience.md).

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
| `input` | JSON, at most 64 KiB, the limit `job.expect()` and evolve cases use today. The `chat` harness accepts a string or a `{messages}` list ending with a user turn. Any other JSON is sent as one user message holding the JSON text, which is what the `openai()` adapter does today. |
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

The console and API accept a spreadsheet, CSV, JSONL or pasted conversations, up to 64 MiB. Conversion runs as an executor job that calls the bundle's judge model through the gateway. It turns each row or conversation into a task card. This is conversion, not invention:

- The input and the reference answer are copied from the material. The model chooses where a conversation is cut and maps columns to fields.
- The model may draft criteria from the reference answer. A person sees every card before Start and can edit or delete it.
- The model does not create tasks that have no source row.
- A row with no usable answer and no criteria becomes a set-aside card with the reason `no-reference`.

Converted cards record the file, the row and the conversation they came from. That source is the task's group. The conversion model reads every row before the split is assigned. It is stateless and is not the optimizer.

## Graders

| Grader | How it scores | Where it runs |
| --- | --- | --- |
| `exact` | The output deep-equals the reference as JSON, as today's `exact()` does. A string must match exactly. | In the executor, with no model. |
| `criteria` | The judge answers pass or fail for each criterion, with a written reason. The rollout passes only if every criterion passes. | In the executor, through the gateway. |
| `check` (later) | A script exits 0 to pass. Its printed output is feedback. | In a separate grader sandbox. |

Rules for the judge:

- Each loop stores a `judge_model`, chosen from the workspace provider's allowed models. It must differ from the loop's task model, and the optimizer is configured separately for the deployment. The judge is pinned on the round.
- The judge reads the rollout's [gateway log](executor.md), the criteria and the reference. It never reads the agent's own account of what it did.
- Each rollout is judged three times and the majority verdict counts. A task whose verdicts split often is flagged in the console.
- For evolve tasks, the judge's written reasons become the feedback the optimizer reads.

How rollout verdicts become a task score is in [loop](loop.md).

## The admission check

Every task passes this check before it counts, whatever its source. The executor runs it as [trials](executor.md), so it costs no round.

1. **The reference passes.** Grading the task's own reference gives a pass.
2. **An empty answer fails.** Grading an empty output gives a fail.
3. **The judge agrees with itself.** For `criteria` tasks, three judgments of the reference give the same verdict.

A task that fails is set aside with the reason shown: `reference-failed`, `empty-passed` or `judge-unstable`. Editing the task runs the check again. A `criteria` task with no reference skips step 1. It runs step 3 on an empty answer instead.

The check catches broken graders. It does not catch a task that is answerable but wrong, which is why a person reviews the cards before Start.

## The split

The service assigns the split. The developer never chooses it and can't move a task across it.

- **By group.** Tasks cut from the same conversation, the same imported row group or the same production job share a `group`, and the whole group lands on one side. Near-duplicate inputs found at import are merged into one group.
- **By hash.** Today `defineLoop` puts a case in held-out when `sha256(caseId)`, read as a 256-bit integer, is below `ceil(split × 2^256)`, with `split = 0.5`. The service keeps that rule and applies it to the group.
- **Permanent.** The group is derived from the source, not from a name the user can edit. Editing a task does not move it.
- **Evidence rule.** A held-out task needs a reference that came from a person: an expected answer present in the source material or outcome, or criteria a person wrote or confirmed in review. A held-out task whose criteria were only drafted by conversion stays `pending` until a person confirms them. It does not move to evolve.

## Held-out custody

The held-out digest commitment goes away. Held-out tasks are stored in their own table, `learning_held_out_tasks`, with the same shape as `learning_tasks`. The split is assigned at creation, so a task is written straight to its table. These rules replace the commitment:

- **The optimizer never reads held-out.** It gets no content, task ids, gateway logs, judge reasons or per-task results. No optimizer code path queries `learning_held_out_tasks`, and a test asserts this. The round stores only the aggregate held-out score, for the chart and the alert.
- **The task model and the judge do read held-out tasks**, because that is how the tasks are scored. They read them statelessly, through the gateway, with server-side storage refused.
- **Machine tokens never receive held-out content.** A response to a machine token leaves out held-out task content, held-out trial logs and per-task held-out results. It carries counts and aggregate scores. An import returns drafted cards only to a person signed in to the console.
- **People read held-out in the console**, with a session.
- **Rewriting retires.** A person who rewrites a held-out task into a new evolve task retires the held-out original.
- **Export.** A person can export held-out tasks, so the set is not locked into the service.

Held-out content is not encrypted. The paper requires that the optimizer never sees it, and the separate table plus the test gives that.

## The Start floor

Start is refused until the loop has 20 admitted evolve tasks and 20 admitted held-out tasks. Today a round starts with one live case. With a handful of held-out tasks, one flip swamps any real drop. If admitted tasks later fall below the floor, the loop pauses with the reason `tasks-required`. The floor is an [agreed decision](README.md#decisions).

## Production outcomes

`job.expect()` stays. The application reports the correct answer for a real job, and the service turns it into a task.

- **Wire change.** `job.expect(expected, { input, output })` gains an optional `output`, the answer the agent gave.
- **No self-written references.** When `output` is supplied and equals `expected`, the outcome is rejected. The delivered agent never authors tasks, criteria or references.
- **Provenance.** The source is `outcome`, stored with the delivered version and the reporting principal.
- **Admission.** The outcome passes the same admission check as any other task.
- **Split.** The group is the job id, and the group hash decides the split. Outcomes therefore reach held-out as well as evolve, which they never do today. Every outcome carries a reference, so the evidence rule is met.
- **Right.** `/outcomes` requires `evaluate` today. That right is removed, so the route moves to `write`.

Outcomes in held-out and the right change are recorded in [decisions](README.md#decisions).

## Editing and retiring

- **Edit.** An edit writes a new revision and runs the admission check again. The task id, group and split stay. A round pins the revision it started on and finishes on it.
- **Retire.** A retired task leaves future rounds. Its past results stay in history.
- **Scores.** A round's score is over the tasks it pinned. When the task set changes, the next round scores the incumbent again, and the console marks the chart so a jump caused by an edit is not read as learning. See [loop](loop.md).
- **Flagged tasks.** The console flags tasks that every candidate fails, tasks the judge splits on and tasks whose rollouts fail with errors. A flag is a prompt to a person. It changes nothing by itself.
