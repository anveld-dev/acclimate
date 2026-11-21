# Self-improvement memory: the memory store

This file defines how the improvement memory (the paper's SIM, arXiv 2611.18856) is stored, written, pinned and read. It covers the two memory tables, the record shapes, how an attempt's outcome is computed from the evolve evaluations of the incumbent and the adopted candidate, provenance, problem merging, the per-round pin, the append lock, the lifecycle, the operator read route and the tests. The names come from the [README](README.md#names). The binding decisions are in [decisions.md](decisions.md), mainly D3, D5 and D6.

| Topic | Owner |
| --- | --- |
| Round states, `learning_loops`, `learning_rounds`, the adopt transaction that calls `write_back` | [loop.md](loop.md) |
| The proposer output and `diagnosis`, `validate_diagnosis`, the scanner, where `improvementMemory` sits in the prompt, the eight rules | [optimizer.md](optimizer.md) |
| `learning_evaluations`, the evaluation report, `case_passes`, the `GET /memory` wire DTO, OpenAPI, SDK types and the console view | [evaluator-and-contracts.md](evaluator-and-contracts.md) |

## 1. What this file decides

| # | Rule |
| --- | --- |
| 1 | Memory is per workspace + bundle (`project_id`, `bundle_id`). One loop owns it. It starts empty, and nothing is imported or backfilled. |
| 2 | Only an adopted candidate writes memory. `memory::write_back` inserts exactly one attempt, inside the adopt transaction, while the `learning_loops` row is locked. Keep and failure append nothing. Stopping after adoption preserves the committed append. |
| 3 | Rows are append-only. A trigger refuses every `UPDATE` and `DELETE` on both tables. Memory is never rewound, by a keep, a stop, a setting change, a manual channel release or anything else. |
| 4 | `fixed`, `missed`, `passed` and `total` are computed once at write-back from two evaluations of the same round on the same `evolve_revision`: the `incumbent` evaluation and the adopted sample's `candidate` evaluation. A case passes with at least three passing rollouts. |
| 5 | Identical root-cause text, after whitespace is collapsed, is one problem (`root_cause_key`). There are no aliases and no fuzzy matching. |
| 6 | `render_memory` is a pure function of (bundle, revision). Every model call in a round renders the round's pinned `memory_revision` and must get the stored `memory_digest`. `GET /memory?revision=r` returns the same bytes and digest. |
| 7 | Memory holds no held-out data. The rendered provenance is the paper's domain, benchmark, policy model and round only, so the stored `heldOutDigest` never reaches the optimizer, and no held-out score, case ID or trace is ever read by this module. |
| 8 | Memory is never delivered to jobs. It is not part of `BundlePayload` and no payload, resolve or work route reads it. |
| 9 | The renderer includes every problem and attempt visible at the pinned revision. When the rendered input no longer fits the optimizer model, the round fails with `optimizer-context-too-large` ([optimizer.md](optimizer.md)). |

## 2. What it replaces

Connected learning supplied bounded per-connection prior-attempt summaries. The new loop stores append-only adopted attempts per bundle and renders same-setting round history independently. The old implementation is preserved at the pre-removal commit. [Prior-attempt history](https://github.com/anveld-dev/acclimate/blob/4096ff1b60098554b0cb932866a338cadf29601c/src/connected_learning_worker.rs#L503-L625)

Bundle files under `memory/` are part of the delivered harness and the proposer can edit them. Improvement memory lives outside the bundle.

## 3. Paper fields

The paper's Problem is `{id, root cause, opened_round, attempts}`. Its Attempt is `{round, sample, accepted, backfilled, what, files, predicted, fixed, missed, passed, total, domain}` with provenance for domain, benchmark, policy model and round (App. D.3).

| Paper | Stored | Rendered | Notes |
| --- | --- | --- | --- |
| Problem `id` | `learning_memory_problems.problem_id` | `id` | `P<n>`, from `P1`, per bundle |
| Root cause | `root_cause`, `root_cause_key` | `rootCause` | Normalized text (§7.1) |
| `opened_round` | `opened_round` | `openedRound` | Round number of the problem's first attempt. `opened_revision` orders problems and is not rendered. |
| `attempts` | Rows of `learning_memory_attempts` with this `problem_id` | `attempts` | Ordered by `revision` |
| `round` | `round` | `round` | `learning_rounds.number` |
| `sample` | `sample` | `sample` | The adopted sample, 1 to 5 |
| `accepted` | not stored | `true` | "the selector chose the edit in that round" (App. D.3). Only adopted candidates are written. |
| `backfilled` | `backfilled`, always `false` | `false` | Memory is never backfilled (D6). The stored field remains for paper fidelity. |
| `what` | `what` | `what` | `{rationale, changes}` (§5.1) |
| `files` | `files` | `files` | Paths the adopted version changed |
| `predicted` | `predicted` | `predicted` | From the candidate's `diagnosis`, written before evaluation |
| `fixed`, `missed` | `fixed`, `missed` | `fixed`, `missed` | §6 |
| `passed`, `total` | `passed`, `total` | `passed`, `total` | Passing and total rollouts in the candidate's evolve evaluation |
| `domain` | `domain` | `domain` | `setting.domain` of the round |
| Provenance | `provenance` | `provenance` with `domain`, `benchmark`, `policyModel` and `round` only | §5.2 |

## 4. Migration: memory part of `0020_learning_optimizer.sql`

`0020` also adds `learning_candidates` and `learning_optimizer_calls` ([optimizer.md](optimizer.md)), which must come first because attempts reference candidates. `learning_loops.memory_revision`, `learning_rounds.memory_revision` and `learning_rounds.memory_digest` are added by `0019` ([loop.md](loop.md)). This section adds no column to any other table.

```sql
CREATE TABLE learning_memory_problems (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    problem_id text NOT NULL CHECK (problem_id ~ '^P[1-9][0-9]{0,8}$'),
    root_cause text NOT NULL CHECK (octet_length(root_cause) BETWEEN 1 AND 1024),
    root_cause_key text NOT NULL CHECK (root_cause_key ~ '^[0-9a-f]{64}$'),
    opened_round integer NOT NULL CHECK (opened_round >= 1),
    opened_revision integer NOT NULL CHECK (opened_revision >= 1),
    PRIMARY KEY (project_id, bundle_id, problem_id),
    UNIQUE (project_id, bundle_id, root_cause_key),
    UNIQUE (project_id, bundle_id, opened_revision),          -- at most one problem per append
    FOREIGN KEY (project_id, bundle_id) REFERENCES learning_loops(project_id, bundle_id)
);

CREATE TABLE learning_memory_attempts (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision >= 1),
    problem_id text NOT NULL,
    round_id uuid NOT NULL UNIQUE REFERENCES learning_rounds(id),
    round integer NOT NULL CHECK (round >= 1),
    sample smallint NOT NULL CHECK (sample BETWEEN 1 AND 5),
    backfilled boolean NOT NULL DEFAULT false CHECK (NOT backfilled),
    what jsonb NOT NULL CHECK (jsonb_typeof(what) = 'object'),
    files text[] NOT NULL,
    predicted text[] NOT NULL,
    fixed text[] NOT NULL,
    missed text[] NOT NULL,
    passed integer NOT NULL CHECK (passed >= 0),
    total integer NOT NULL CHECK (total >= 1 AND passed <= total),
    domain text NOT NULL CHECK (octet_length(domain) BETWEEN 1 AND 256),
    provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
    PRIMARY KEY (project_id, bundle_id, revision),
    FOREIGN KEY (project_id, bundle_id, problem_id)
        REFERENCES learning_memory_problems(project_id, bundle_id, problem_id),
    FOREIGN KEY (project_id, bundle_id, round)
        REFERENCES learning_rounds(project_id, bundle_id, number),
    FOREIGN KEY (round_id, sample) REFERENCES learning_candidates(round_id, sample),
    CHECK (fixed <@ predicted AND missed <@ predicted
           AND cardinality(fixed) + cardinality(missed) = cardinality(predicted))
);

CREATE INDEX learning_memory_attempts_problem
    ON learning_memory_attempts (project_id, bundle_id, problem_id, revision);

CREATE FUNCTION learning_memory_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'improvement memory is append-only';
END;
$$;

CREATE TRIGGER learning_memory_problems_append_only
    BEFORE UPDATE OR DELETE ON learning_memory_problems
    FOR EACH ROW EXECUTE FUNCTION learning_memory_append_only();
CREATE TRIGGER learning_memory_attempts_append_only
    BEFORE UPDATE OR DELETE ON learning_memory_attempts
    FOR EACH ROW EXECUTE FUNCTION learning_memory_append_only();
```

The migration uses the following constraints.

- The append-only trigger follows `machine_token_events` ([0015](../../../migrations/0015_evaluator_machine_tokens.sql#L49-L57)).
- The `(project_id, bundle_id, round)` key makes an attempt name a round of its own bundle. `write_back` sets `round_id` and `round` from one round.
- The array checks make `fixed` and `missed` a partition of `predicted`. Case-ID arrays are stored sorted and without duplicates.
- No head table, no snapshot table and no `next_problem` counter are needed. The `learning_loops` row is the head, the pin plus append-only rows make a re-render exact, and the next problem number is the count of the bundle's problems plus one (problems are never deleted).
- No rows are created by the migration. Connected-learning rounds are gone after `0018` ([removal.md](removal.md)), so there is nothing to backfill even by accident.

## 5. Record shapes

### 5.1 `what` and `files`

```json
{
  "rationale": "<the adopted candidate's rationale, in full>",
  "changes": {
    "edits": [{"path": "AGENTS.md", "oldText": "…", "newText": "…"}],
    "files": [{"op": "write", "path": "skills/refunds/SKILL.md", "text": "…"}, {"op": "delete", "path": "notes/old.md"}]
  }
}
```

`what.rationale` is `learning_candidates.rationale` and `what.changes` is `learning_candidates.changes`, copied whole. Nothing is excerpted. The full new payload stays reachable through the round's `adopted_version_id`, which the operator route shows (§10).

`files` is the sorted list of paths from `proposal_edits::changed_files(parent, adopted)`, which phase 4 restores after phase 2 deletes it with its last caller ([current implementation](../../../src/proposal_edits.rs#L130)), where `parent` is the payload of `learning_rounds.parent_version_id` and `adopted` is the payload of the candidate's `version_id`. It lists paths whose text actually changed, including created and deleted files.

### 5.2 `provenance`

```json
{
  "domain": "customer-support",
  "benchmark": "refund-desk-v2",
  "policyModel": "gpt-6-luna",
  "round": 7,
  "evolveRevision": 12,
  "heldOutDigest": "sha256:…",
  "optimizerModel": "gpt-6.2-astra",
  "optimizerReasoningEffort": "high"
}
```

| Field | Source | Rendered |
| --- | --- | --- |
| `domain`, `benchmark`, `policyModel` | `learning_rounds.setting`, pinned by `start_round` | Yes |
| `round` | `learning_rounds.number` | Yes |
| `evolveRevision` | `learning_rounds.evolve_revision`. Both evaluations used to compute the outcome carry the same value (§6). | No |
| `heldOutDigest` | `learning_rounds.held_out.digest`, the commitment pinned for the round | No |
| `optimizerModel` | `learning_rounds.optimizer_model` | No |
| `optimizerReasoningEffort` | `learning_rounds.optimizer_reasoning_effort`, included when set | No |

Policy epochs, the dataset descriptor and the grader are provenance only (D7). The dataset is the evolve revision. A grader change is expressed by changing `setting.benchmark` through `PUT`, since the grader lives in the evaluator. Connection and runtime provenance are gone with connected learning (decisions.md, M2).

The rendered provenance is exactly the paper's: domain, benchmark, policy model and round (App. D.3). `evolveRevision`, `heldOutDigest`, `optimizerModel` and optional `optimizerReasoningEffort` are stored for operators and for the experiment's integrity checks, and `GET /memory` returns them in `records` (§10). Keeping `heldOutDigest` out of the rendered document also makes "no held-out bytes in optimizer input" a simple, testable rule. The stored values are the round's pins, not the loop's current values: `learning_rounds.held_out` is pinned at `start_round` ([loop.md](loop.md)), and a mid-round change to `heldOut` is refused.

### 5.3 The rendered document

`render_memory` returns this document, which is the `improvementMemory` prompt value and the `improvementMemory` property on the operator route.

```json
{
  "schemaVersion": 1,
  "memoryRevision": 1,
  "problems": [
    {
      "id": "P1",
      "rootCause": "The harness never tells the agent to check refund eligibility before quoting an amount.",
      "openedRound": 3,
      "attempts": [
        {
          "round": 3, "sample": 4, "accepted": true, "backfilled": false,
          "what": {"rationale": "…", "changes": {"edits": [], "files": []}},
          "files": ["AGENTS.md"],
          "predicted": ["case-07", "case-19"],
          "fixed": ["case-07"], "missed": ["case-19"],
          "passed": 112, "total": 150,
          "domain": "customer-support",
          "provenance": {"domain": "customer-support", "benchmark": "refund-desk-v2", "policyModel": "gpt-6-luna", "round": 3}
        }
      ]
    }
  ]
}
```

| Rule | |
| --- | --- |
| Rows | Problems with `opened_revision <= revision`, attempts with `revision <= revision` |
| Order | Problems by `opened_revision` (the same order as their numbers), attempts by `revision`, case IDs and paths in byte order |
| Empty | `{"memoryRevision":0,"problems":[],"schemaVersion":1}`. The key is always present in optimizer input. |
| Bytes | `serde_json::to_vec` of a `serde_json::Value`. The crate does not enable `preserve_order` in this build, so object keys serialize in sorted order. A unit test pins this. |
| Digest | `crate::digest` over those bytes ([digest](../../../src/lib.rs#L91)), giving `sha256:<hex>` |
| No retrieval | Every problem and attempt is rendered. Nothing is ranked, filtered by setting or summarized. Rules 2, 4 and 8 ask the model to weigh settings itself. |

The current round's own `setting` is not in this document, so that the document depends only on the revision. The eight rules compare each entry's provenance with the current setting, so [optimizer.md](optimizer.md) places the round's `setting` in the request beside `improvementMemory`.

## 6. Outcome derivation

`memory::attempt_outcome` is a pure function over two parsed evaluation reports and the prediction.

```rust
pub(super) struct AttemptOutcome {
    pub fixed: Vec<String>,     // sorted
    pub missed: Vec<String>,    // sorted
    pub passed: i32,
    pub total: i32,
}

/// `incumbent` and `candidate` are scored evolve reports of the same round,
/// on the same evolve revision. `predicted` is sorted and deduplicated.
pub(super) fn attempt_outcome(
    incumbent: &Report,
    candidate: &Report,
    predicted: &[String],
) -> Result<AttemptOutcome, &'static str>;
```

Let `before(c)` and `after(c)` be `evaluations::case_passes` for case `c` in the incumbent and candidate reports: true when at least three of its `ROLLOUTS_PER_CASE` (5) rollouts report `passed: true`.

| Output | Definition |
| --- | --- |
| `fixed` | Predicted cases with `!before(c) && after(c)` |
| `missed` | `predicted \ fixed`. It includes a predicted case the incumbent already passed, and one that still fails. |
| `passed` | Rollouts with `passed: true` in the candidate report |
| `total` | All rollouts in the candidate report: case count × 5 |

Each case is classified once from its 5 rollouts. `score` does not enter the classification. It stays in the evaluation and in `feedback`. The paper's Attempt has no regression field, so none is stored. The selector's `regressed` list for each evaluated candidate ([optimizer.md](optimizer.md)) uses the same `case_passes` classification and exists only in the `select` input.

`attempt_outcome` returns an error, and `write_back` fails the transaction, when:
- either report repeats an ID, both are empty, or the reports cover different case IDs,
- a case does not have exactly five rollouts,
- a predicted ID falls outside the reports, or the rollout totals overflow the stored integer range.

[evaluator-and-contracts.md](evaluator-and-contracts.md) only scores a complete report and [optimizer.md](optimizer.md) refuses predicted IDs outside the round's `evolve_revision`, so these errors mean a broken invariant, not a normal path.

Incidental fixes (a case that passes now but was not predicted) show only in `passed`. The paper records no such list (open question 1).

## 7. Problems and merging

### 7.1 Normalization and key

```rust
const ROOT_CAUSE_MAX_BYTES: usize = 1024;

/// Trim, collapse each run of `char::is_whitespace` to one space, reject any
/// `char::is_control`, then require 1..=ROOT_CAUSE_MAX_BYTES bytes.
pub(super) fn normalize_root_cause(text: &str) -> Option<String>;

/// hex(sha256("acclimate-root-cause-v1\n" || normalized))
fn root_cause_key(normalized: &str) -> String;
```

A root cause is a one-sentence hypothesis, and the rationale carries the argument, so 1024 bytes is a format limit, not a growth cap. `validate_diagnosis` ([optimizer.md](optimizer.md)) calls `normalize_root_cause` on `{new}` text, and a `None` result is a format error inside the call's one retry. The normalized text is what the scanner sees and what is stored. Matching is case-sensitive, with no Unicode normalization (the crate has no normalization dependency), so "identical" means the same characters after whitespace is collapsed.

### 7.2 `resolve_problem`

```rust
async fn resolve_problem(
    tx: &mut Tx<'_>, round: &Pins, problem: DiagnosisProblem, revision: i32,
) -> Result<String, sqlx::Error> // the problem_id
```

1. `{id: "P3"}`: `validate_diagnosis` already checked that `P3` is in the round's rendered memory. Problems are never deleted, so the row exists. Attach.
2. `{new: text}`: compute the key and `SELECT problem_id ... WHERE (project_id, bundle_id, root_cause_key) = ...`.
   - Found: attach to it. This is the paper's identical-text merge, and the existing root cause text is unchanged.
   - Not found: insert `P<n>` with `n = 1 + count(problems of the bundle)`, `opened_round = round`, `opened_revision = revision`.

A problem's text never changes. The paper's rule 5, revising a diagnosis, is a new `{new}` entry with the revised text. Root causes of losing samples stay on their `learning_candidates.diagnosis` rows and create no problem (D6).

## 8. Pinning, write-back and locking

### 8.1 Pin and render

| Step | Where | What memory does |
| --- | --- | --- |
| `start_round` | [loop.md](loop.md), under the bundle row lock | Copies `learning_loops.memory_revision` to `learning_rounds.memory_revision` |
| First `optimizer::enqueue` | under the loop row lock | Stores the digest of the pinned memory on the round |
| Each `propose`, `screen` and `select` call | outside any lock | Renders again at the pinned revision. A mismatch with the pinned memory digest or the full input digest fails the call with `provider-failed` and `error = 'input drift'` ([optimizer.md](optimizer.md)). |

The render needs no lock and no snapshot isolation. Rows at or below the pin are complete (a problem and its first attempt commit together) and immutable (§4). Because one loop owns the bundle and it has at most one active round, nothing appends between the pin and the round's own adopt. The pin still matters: it makes every call in the round, and every later read of that round, reproducible from the revision alone.

### 8.2 `write_back`

```rust
/// Called by `worker::advance::adopt` inside its transaction, after it has locked the
/// `learning_loops` row, checked `channel_revision`, written `selection`,
/// set `adopted_sample` and inserted the promotion. Returns the new revision.
pub(super) async fn write_back(tx: &mut Tx<'_>, round: &Pins) -> Result<i32, sqlx::Error>;
```

1. If an attempt with this `round_id` exists, return its revision. The adopt transaction is atomic, so this is only a guard.
2. `SELECT memory_revision FROM learning_loops WHERE (project_id, bundle_id) = ... FOR UPDATE`. The caller already holds this lock, so this re-lock is free. Refuse when it differs from `learning_rounds.memory_revision`.
3. Load the adopted candidate `(round_id, adopted_sample)`. Refuse unless `status = 'evaluated'`, `scan.clean` is true, and `version_id`, `evaluation_id` and `diagnosis` are set.
4. Load the round's `incumbent` evaluation and the candidate's evaluation. Refuse unless both are `scored`, `split = 'evolve'` and `evolve_revision = learning_rounds.evolve_revision`.
5. `revision = memory_revision + 1`.
6. `attempt_outcome(incumbent.report, candidate.report, diagnosis.predicted)`.
7. `resolve_problem(..., diagnosis.problem, round.number, revision)`.
8. Build `what`, `files` and `provenance` (§5) and insert the attempt.
9. `UPDATE learning_loops SET memory_revision = revision`.

Any refusal returns an error, so the whole adopt transaction rolls back: no `selection`, no release and no attempt. A refusal is an invariant failure and is logged with the round ID. [loop.md](loop.md) decides how the worker retries.

### 8.3 Lock order

The `learning_loops` row is the only lock memory relies on. `adopt` takes it first, then the learning channel row for the release. `write_back` only inserts memory rows and updates the loop row it already holds. No path locks a memory row, and no model call runs while the loop row is locked. `PUT`, `pause`, `stop` and `start_round` take the same row lock, so a stop that commits first makes `adopt` find the round `stopped`, and nothing is written.

## 9. Lifecycle

| Event | Memory |
| --- | --- |
| `PUT` enrolls a bundle | Empty, `memory_revision = 0` |
| A round is `kept`, `failed` or `stopped` | No write |
| A round is `adopted` | One attempt, and perhaps one problem, at `memory_revision + 1` |
| `PUT` changes `setting`, `heldOut`, `channel` or `appPrincipalId` | Nothing is rewritten. New attempts carry the new setting in provenance. This is how a Full SIM target run continues a source bundle's memory ([experiment.md](experiment.md)). |
| `pause`, `resume`, `stop`, then `PUT` again | Memory and the revision continue |
| An operator releases another version on the learning channel | No write and no rewind. Earlier attempts stay, including ones whose version is no longer on the channel. |
| An evolve case is retired | Attempts keep the case ID. New predictions are limited to the current evolve revision ([optimizer.md](optimizer.md)). |
| A new bundle, even with identical content | Empty memory. The product has no memory copy or import path. Operators can read a snapshot through the memory route. Harness Transfer and Cold Start are new bundles ([experiment.md](experiment.md)). |
| A later round shows an adopted change hurt | The attempt stays as written. Later attempts and the run history record what followed. |

There is no delete path. Purging memory would take a migration that drops the trigger (open question 3).

## 10. Operator read route

`GET /v1/workspaces/{workspaceId}/bundles/{bundleId}/learning/memory[?revision=r]` checks workspace `read` and denies the app principal with `403 denied`. `memory::get` uses `actor_tx` and calls `render_memory` at the requested or current revision. [Handler](../../../src/learning/memory.rs#L235)

The response has `{currentRevision, memoryRevision, memoryDigest, improvementMemory, records}`. A record is `{revision, problemId, roundId, round, versionId, provenance}`.

| Field | Meaning |
| --- | --- |
| `currentRevision` | `learning_loops.memory_revision` now |
| `memoryRevision` | The revision rendered: `?revision=` or the current one |
| `memoryDigest` | Digest of `improvementMemory`. It equals `learning_rounds.memory_digest` for every round that reached proposing with that revision, so an operator can check exactly what the optimizer saw. |
| `improvementMemory` | The exact document of §5.3 |
| `records` | One entry per attempt at or below the revision: its round ID, the adopted version (`learning_rounds.adopted_version_id`) and the stored `provenance` in full, with `evolveRevision`, `heldOutDigest`, `optimizerModel` and optional `optimizerReasoningEffort`. These are for operators and are never in optimizer input. |

Errors: a bundle that is not enrolled, or a `revision` above `currentRevision`, returns `404 not_found`. A `revision` that is not a nonnegative integer returns `400 invalid_content`.

## 11. Never delivered to jobs

- `BundlePayload` is `{schema_version, files}` ([types.rs](../../../src/types.rs#L23-L26)). Memory is not a bundle file and is never added to one.
- The payload, channel resolve, `GET /work` and evaluation routes never read the memory tables. `GET /work` sends the evaluator evaluation identities and pins. The start route provides evolve inputs and expected values.
- The `@acclimate/sdk` fetch, cache, verify and prepare paths have no memory field. The SDK clients provide a learning memory read method ([evaluator-and-contracts.md](evaluator-and-contracts.md)).

## 12. Code and tests

`worker::advance::adopt` calls `memory::write_back` before queuing retained evaluation, all in the release transaction. Local unit tests cover normalization, attempt outcomes and digest fixtures. The PostgreSQL integration tests exercise adoption, same-cause merging, historical memory reads and access control. There is no standalone `tests/learning_memory.rs` suite. [Adopt](../../../src/learning/worker/advance.rs#L292), [unit tests](../../../src/learning/memory.rs#L280), [integration tests](../../../tests/learning_loop/optimizer.rs)

## 13. Open questions

1. Should memory list unpredicted fixes as well as the rollout totals?
2. Should root-cause matching account for case or Unicode equivalents?
3. How should a future workspace purge handle append-only records and their associated run history?
