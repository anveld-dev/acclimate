# Experience

**Status: built.** Follow-up work is listed in the [release plan](plan.md#after-the-first-release).

This page walks the path a person takes to set up learning and live with it. Everything happens in the console. The API mirrors every step, so anything done here can be scripted, but no CLI, repository layout or MCP surface is needed. Routes are listed in [API and data](api-and-data.md).

The first release supports the `chat` harness: the bundle's instructions, skills and memory become the system prompt, and the task input is the conversation. Coding bundles come later. See [plan](plan.md).

## Setup

Steps 1 to 5 are the whole setup. The person acts in steps 1, 2, 3 and 5.

### 1. Connect a model provider

**Screen:** Workspace settings, Model provider. Two fields: an OpenAI-compatible base URL and a key.

**You do:** paste both, once per workspace.

**Automatic:** the service validates the endpoint and stores the key encrypted. Only the [gateway](executor.md) uses it, and it never appears in a task, a log or a sandbox. The provider's allowed models are listed here.

### 2. Turn on learning for a bundle

**Screen:** Bundle, Learning, Set up. It shows the bundle, the channel that will receive releases, the harness, the task model and the judge model.

**You do:** pick the channel. The task model and judge model have defaults from the provider's allowed models, and you can change them. They must differ.

**Automatic:** the harness follows from where the bundle is delivered, so the screen states it and does not ask.

### 3. Give it material

**Screen:** one box that accepts a spreadsheet, CSV, JSONL or pasted conversations.

**You do:** drop in what you already have, such as an export of real conversations with the replies a person gave.

**Automatic:** the service converts each row into a task card, using the judge model. A card has the input, plus an expected answer or plain-language criteria. Conversion only reshapes your material. It does not invent tasks, and every card records the row it came from. Rows it cannot convert are listed with the reason. Cards are shown to people signed in to the console. A machine token that imports gets counts only.

### 4. Admission check

**Screen:** a summary of admitted tasks and tasks set aside, each with its reason.

**Automatic:** every task runs the [admission check](tasks-and-grading.md) before it counts. A task is admitted only if its reference answer passes, an empty answer fails, and the judge gives the same verdict three times. A task that fails is set aside with the reason shown, for example "the judge disagreed with itself" or "an empty answer passed".

**You do:** nothing, unless you want to repair a task that was set aside. Editing it runs the check again.

### 5. Review, try, start

**Screen:** the task cards, the split count and two buttons.

- **Cards.** Each shows the input, the expected answer or criteria, its source and its split. You can edit or delete any card. A held-out card whose criteria were only drafted by conversion waits for you to confirm them before it is admitted.
- **Split.** The service assigns each task to evolve or held-out. It keeps tasks from the same source conversation or file on the same side. The screen states the count, for example "22 evolve, 22 held-out" (illustrative).
- **Try.** Runs one task as a trial on the executor against the current release. The panel shows the gateway log, the verdict and the judge's reasoning. A trial never counts toward learning. An infrastructure error is shown as an error, never as a failed task.
- **Start.** Enabled once there are 20 admitted evolve tasks and 20 admitted held-out tasks. Below that, the button says how many more each side needs.

**You do:** read the cards, try a few, fix what looks wrong and click Start once.

## Running

No one needs to be present after Start.

### 6. Rounds run on the service

**Screen:** Bundle, Learning, Rounds. A timeline with one row per round: what triggered it, the incumbent's evolve score, the outcome (adopted or kept the incumbent), the held-out score and the released version.

**Automatic:** the service runs each [round](loop.md). The executor runs every rollout in a fresh sandbox with no network, where the model is reachable only through the gateway, and grades it outside that sandbox. A winning candidate is released to the channel at once, and the adopted attempt is written to the bundle's shared memory. Rounds start when there is new evidence, and the loop idles when there is none. See [loop](loop.md) for the triggers and the daily cap.

**You can:** open a round to see its five candidates. Each has its diagnosis, its predicted tasks, the per-task results on evolve and the bundle diff. Any evolve cell opens the gateway log and the judge's reasoning.

### 7. Watch, fix, roll back

**Screen:** the same Learning page. The held-out chart sits above the round list, with usage (tokens and rounds per bundle) beside it.

- **Each release explains itself.** It names the round that produced it and shows the diff with the diagnosis in plain language. This replaces an approval step.
- **Flagged tasks.** The service flags tasks that drag scores: ones that fail for every candidate round after round, ones whose repeated rollouts disagree, and ones that error. A flagged task opens to its last gateway log and reasoning, and you can edit it inline, try it and save.
- **Held-out drop.** Any drop after a release raises a banner and emails workspace admins, linking the round. On a [clear drop](loop.md) the service also reverts the release on its own, and the loop continues from the restored version.
- **Roll back.** Every release has a Roll back button that re-releases the previous version. A version that was rolled back or reverted is blocked and cannot be adopted again.

**You do:** nothing in a normal week. You act when a task is flagged or an alert arrives.

### 8. Grow from production

**Screen:** the Tasks page shows where each task came from: imported, written in the console, or reported from production.

**You do, once:** call `job.expect(expected)` in your app when you know the correct answer for a real job. It needs a machine token with the `write` right.

**Automatic:** each outcome goes through the same admission check, is assigned to a split by its group and joins the task set. An outcome can land in held-out. New tasks are the evidence that triggers the next round. The delivered agent never writes tasks, criteria or references. An outcome is stored with its provenance.

## Who does what

| Step | Person | Service |
| --- | --- | --- |
| 1. Provider | Enters the URL, key and allowed models | Validates the configuration and encrypts the key |
| 2. Turn on | Picks the channel, accepts or changes the models | Chooses the harness |
| 3. Material | Uploads or pastes | Converts rows to task cards |
| 4. Admission | — | Checks every task, sets failures aside |
| 5. Review | Reads, tries, clicks Start | Assigns the split, enforces the minimum |
| 6. Rounds | — | Runs rounds, releases winners |
| 7. Watch | Fixes flagged tasks, rolls back if needed | Flags tasks, alerts on any drop, reverts on a clear drop |
| 8. Production | Adds `job.expect()` once | Admits outcomes as tasks |

## Month two

**A bad task is dragging scores.** The Tasks page shows it flagged, with the reason. Whoever notices opens it, reads the last gateway log and the judge's reasoning, edits the criteria, clicks Try and saves. Saving creates a new revision of the task, and the admission check runs again. The score chart marks the point where the task set changed, because scores on either side are not directly comparable. Retiring the task is one click.

**An auto-released change made things worse.** The held-out chart shows the drop and admins have an email linking the round. If the drop was clear, the service has already reverted the release. Otherwise a person opens the round, reads the diff and the diagnosis, and clicks Roll back. Either way the change is blocked from being adopted again, and the loop continues from the restored version. People signed in to the console can open held-out tasks and gateway logs to see what broke. The optimizer and machine tokens cannot. If the person decides to turn a held-out failure into a new evolve task, that task is retired from held-out.

**A teammate asks what changed and why.** The round timeline is the answer. Each release links to its round, and the round shows the diagnosis, the diff, the tasks it was predicted to fix and the tasks it did fix. Rollbacks and task edits appear on the same timeline with who made them.

## Later: a coding bundle

Not in the first release. The path is the same, with an environment added after step 2 and check-script grading as a third way to judge a task. The details are in [executor](executor.md#later-the-codex-harness-and-environments) and [plan](plan.md).
